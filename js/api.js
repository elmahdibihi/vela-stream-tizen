'use strict';
const API = (() => {
  let _base='', _user='', _pass='';

  /* ── Web Worker for non-blocking XHR ──────── */
  const _wSrc = `
    self.onmessage = function(e){
      var d=e.data, xhr=new XMLHttpRequest();
      xhr.open('GET',d.url,true); xhr.timeout=d.timeout||20000;
      xhr.onload=function(){ self.postMessage({id:d.id,ok:xhr.status<300,status:xhr.status,text:xhr.responseText}); };
      xhr.onerror=function(){ self.postMessage({id:d.id,ok:false,err:'Network error'}); };
      xhr.ontimeout=function(){ self.postMessage({id:d.id,ok:false,err:'Timed out'}); };
      xhr.send();
    };`;
  let _worker=null, _pending={}, _seq=0;

  function _getWorker(){
    if(_worker) return _worker;
    try{
      const blob=new Blob([_wSrc],{type:'application/javascript'});
      _worker=new Worker(URL.createObjectURL(blob));
      _worker.onmessage=e=>{
        const p=_pending[e.data.id]; if(!p) return;
        clearTimeout(p.t); delete _pending[e.data.id];
        if(e.data.ok){
          try{p.resolve(JSON.parse(e.data.text));}
          catch(_){p.reject(new Error('Invalid JSON from server'));}
        }else{ p.reject(new Error(e.data.err||'HTTP '+e.data.status)); }
      };
      _worker.onerror=err=>{
        Object.values(_pending).forEach(p=>{ clearTimeout(p.t); p.reject(new Error('Worker error')); });
        _pending={}; _worker=null;
      };
      return _worker;
    }catch(e){ return null; }
  }

  function _fetch(url, timeout=20000){
    return new Promise((resolve,reject)=>{
      /* Tizen TVs can stall Blob Web Workers on large Xtream catalogue
         responses. Async XHR on the main thread is more reliable here. */
      const xhr=new XMLHttpRequest();
      let done=false;
      const finishError=(code,message)=>{
        if(done) return;
        done=true; clearTimeout(timer);
        try{xhr.abort();}catch(_){}
        const err=new Error(message); err.code=code; reject(err);
      };
      const timer=setTimeout(()=>{
        finishError('TIMEOUT','Server timed out');
      }, timeout+2000);
      xhr.open('GET',url,true);
      xhr.timeout=timeout;
      xhr.onreadystatechange=()=>{
        if(xhr.readyState!==4 || done) return;
        done=true; clearTimeout(timer);
        if(xhr.status<200 || xhr.status>=300){
          const err=new Error(xhr.status===0?'Network, DNS, CORS, or policy error':'HTTP '+xhr.status);
          err.code=xhr.status===0?'NETWORK_OR_POLICY':(xhr.status>=500?'HTTP_5XX':'HTTP_4XX');
          reject(err); return;
        }
        try{
          const text=String(xhr.responseText||'').replace(/^\uFEFF/,'').trim();
          if(!text) throw new Error('empty');
          resolve(JSON.parse(text));
        }
        catch(_){ const err=new Error('Invalid JSON from server'); err.code='BAD_JSON'; reject(err); }
      };
      xhr.onerror=()=>finishError('NETWORK_OR_POLICY','Network, DNS, CORS, or policy error');
      xhr.ontimeout=()=>finishError('TIMEOUT','Server timed out');
      try{xhr.send();}catch(e){ if(done)return; done=true; clearTimeout(timer); reject(e); }
    });
  }

  function norm(url){
    const u=String(url||'').trim().replace(/\/+$/,'');
    return !u?'':(/^https?:\/\//i.test(u)?u:'http://'+u);
  }
  function absUrl(url){
    if(!url) return '';
    const u=String(url).trim();
    if(!u) return '';
    if(/^https?:\/\//i.test(u)) return u;
    if(/^\/\//.test(u)) return ((_base.match(/^https:/i)?'https:':'http:')+u);
    if(u[0]==='/') return _base+u;
    return _base+'/'+u;
  }

  function _request(base,user,pass,params,timeout=20000){
    const query={username:user,password:pass};
    Object.keys(params||{}).forEach(k=>{ query[k]=params[k]; });
    const qs=new URLSearchParams(query).toString();
    return _fetch(`${norm(base)}/player_api.php?${qs}`,timeout);
  }

  function _get(params,timeout=20000){
    return _request(_base,_user,_pass,params,timeout);
  }

  function _apiError(code,message,base){
    const err=new Error(message);
    err.code=code;
    err.base=base||'';
    return err;
  }

  function _validateAuth(data,base){
    if(!data || typeof data!=='object' || !data.user_info){
      throw _apiError('BAD_API_SHAPE','Server did not return Xtream account data',base);
    }
    if(String(data.user_info.auth==null?'':data.user_info.auth)!=='1'){
      throw _apiError('AUTH_REJECTED','Wrong username or password',base);
    }
    const status=String(data.user_info.status||'').toLowerCase();
    if(status && status!=='active'){
      throw _apiError('ACCOUNT_INACTIVE','Account is '+status,base);
    }
    return {
      base:base,
      info:data.user_info,
      server:data.server_info||{},
      catchup:!!(data.server_info && String(data.server_info.catchup)==='1')
    };
  }

  async function probe(url,user,pass,timeout=8000){
    const base=norm(url);
    if(!base) throw _apiError('BAD_URL','Server URL is empty','');
    const started=Date.now();
    try{
      const authData=await _request(base,user,pass,{},timeout);
      const result=_validateAuth(authData,base);
      const categories=await _request(base,user,pass,{action:'get_live_categories'},Math.min(timeout,10000));
      if(!Array.isArray(categories)){
        throw _apiError('BAD_API_SHAPE','Live categories response is not a list',base);
      }
      result.categoryCount=categories.length;
      result.latency=Date.now()-started;
      return result;
    }catch(err){
      if(!err.code) err.code='PROBE_FAILED';
      err.base=base;
      throw err;
    }
  }

  function selectServer(urls,user,pass,options={}){
    const candidates=[];
    (urls||[]).forEach(url=>{
      const base=norm(url);
      if(base && candidates.indexOf(base)===-1) candidates.push(base);
    });
    const preferred=norm(options.preferred||'');
    const timeout=options.timeout||8000;
    const limit=Math.max(1,Math.min(4,options.concurrency||3));
    const failures=[];
    const notify=(name,...args)=>{
      try{ if(typeof options[name]==='function') options[name](...args); }catch(_){}
    };
    const attempt=base=>{
      notify('onAttempt',base);
      return probe(base,user,pass,timeout).then(result=>{
        notify('onResult',base,true,result);
        return result;
      },err=>{
        const failure={base:base,code:err.code||'PROBE_FAILED',message:err.message||'Connection failed'};
        failures.push(failure);
        notify('onResult',base,false,failure);
        throw err;
      });
    };
    const runPool=list=>new Promise((resolve,reject)=>{
      if(!list.length){
        const err=_apiError('NO_WORKING_SERVER','None of the configured servers is working','');
        err.failures=failures.slice(); reject(err); return;
      }
      let cursor=0,running=0,settled=false;
      const pump=()=>{
        if(settled) return;
        while(running<limit && cursor<list.length){
          const base=list[cursor++]; running++;
          attempt(base).then(result=>{
            running--;
            if(settled) return;
            settled=true; resolve(result);
          },()=>{
            running--;
            if(settled) return;
            if(cursor>=list.length && running===0){
              const err=_apiError('NO_WORKING_SERVER','None of the configured servers is working','');
              err.failures=failures.slice(); reject(err);
            }else pump();
          });
        }
      };
      pump();
    });

    if(preferred && candidates.indexOf(preferred)!==-1){
      return attempt(preferred).catch(()=>runPool(candidates.filter(base=>base!==preferred)));
    }
    return runPool(candidates);
  }

  /* Bounded concurrency pool — prevents 30+ parallel EPG calls from saturating the worker/XHR queue */
  function _pool(limit){
    let running=0; const q=[];
    const next=()=>{
      if(running>=limit || !q.length) return;
      running++;
      const {fn,res,rej}=q.shift();
      fn().then(v=>{running--;res(v);next();},e=>{running--;rej(e);next();});
    };
    return fn => new Promise((res,rej)=>{ q.push({fn,res,rej}); next(); });
  }
  const _epgPool = _pool(4);

  return {
    norm,
    base:()=>_base,
    setup(url,user,pass){ _base=norm(url);_user=user;_pass=pass; },
    probe,
    selectServer,
    async auth(url,user,pass){
      const result=await probe(url,user,pass,12000);
      this.setup(result.base,user,pass);
      return result;
    },
    getLiveCats:  ()    => _get({action:'get_live_categories'},10000),
    getLive:      ()    => _get({action:'get_live_streams'},   30000),
    getVodCats:   ()    => _get({action:'get_vod_categories'}, 10000),
    getVod:       ()    => _get({action:'get_vod_streams'},    30000),
    getSeriesCats:()    => _get({action:'get_series_categories'},10000),
    getSeries:    ()    => _get({action:'get_series'},         30000),
    getSeriesInfo:(id)  => _get({action:'get_series_info',series_id:id},15000),
    getVodInfo:   (id)  => _get({action:'get_vod_info',vod_id:id},15000),
    getShortEpg:  (id)  => _epgPool(()=>_get({action:'get_short_epg',stream_id:id,limit:2},8000)),
    getFullEpg:   (id)  => _epgPool(()=>_get({action:'get_simple_data_table',stream_id:id},15000)),

    /* Stream URLs */
    liveUrls(id){
      const preferred=(typeof S!=='undefined'&&S.get)?S.get('stream_fmt','m3u8'):'m3u8';
      const ordered=preferred?[preferred,'m3u8','ts','']:['m3u8','ts',''];
      const formats=[];
      ordered.forEach(fmt=>{ if(formats.indexOf(fmt)===-1) formats.push(fmt); });
      const root=`${_base}/live/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${encodeURIComponent(id)}`;
      return formats.map(fmt=>fmt?`${root}.${fmt}`:root);
    },
    vodUrl:   (id,ext)=>`${_base}/movie/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${encodeURIComponent(id)}.${encodeURIComponent(ext||'mp4')}`,
    serUrl:   (id,ext)=>`${_base}/series/${encodeURIComponent(_user)}/${encodeURIComponent(_pass)}/${encodeURIComponent(id)}.${encodeURIComponent(ext||'mp4')}`,
    absUrl,
    cuUrl(id,start,mins){
      const p=n=>String(n).padStart(2,'0'),d=start;
      const s=`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}:${p(d.getHours())}-${p(d.getMinutes())}`;
      const qs=new URLSearchParams({username:_user,password:_pass,stream:id,start:s,duration:mins}).toString();
      return `${_base}/streaming/timeshift.php?${qs}`;
    },
  };
})();
