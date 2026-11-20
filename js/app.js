'use strict';

/* ═════════════════════════════════════════════════
   IPTV Stream — Main Application
═════════════════════════════════════════════════ */

/* HTML-escape any provider/user-supplied string before interpolating into innerHTML.
   Covers text, attribute values (both quotes), and URL contexts well enough for our use. */
function esc(s){
  return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

/* Replacement for double-rAF focus/layout timing (Chromium 63 rAF is unreliable) */
function afterRender(fn){ setTimeout(fn,50); }
function setInitialFocus(zone){
  const active=document.activeElement;
  const editing=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA');
  if(active&&active.dataset&&active.dataset.f==='1'&&document.documentElement.contains(active)) return;
  /* A fast user/IME can focus search before delayed layout settles. */
  if(!editing) Focus.selectFirst(zone);
}

/* Search helpers shared by every catalogue page. Normalising once per item
   keeps filtering responsive on TV CPUs, and token matching makes searches
   such as "bbc news" reliable even when the words are separated. */
const _searchTextCache = typeof WeakMap!=='undefined' ? new WeakMap() : null;
function normaliseSearch(value){
  let text=String(value==null?'':value).toLowerCase();
  try{ if(text.normalize) text=text.normalize('NFD').replace(/[\u0300-\u036f]/g,''); }catch(_){}
  return text.replace(/\s+/g,' ').trim();
}
function itemSearchText(item,fields){
  const key=fields.join('|');
  if(_searchTextCache && item && typeof item==='object'){
    const hit=_searchTextCache.get(item);
    if(hit && hit[key]!=null) return hit[key];
    const text=normaliseSearch(fields.map(f=>item[f]).join(' '));
    const next=hit||{}; next[key]=text; _searchTextCache.set(item,next);
    return text;
  }
  return normaliseSearch(fields.map(f=>item&&item[f]).join(' '));
}
function matchesSearch(item,query,fields){
  const q=normaliseSearch(query);
  if(!q) return true;
  const text=itemSearchText(item,fields);
  return q.split(' ').every(term=>text.indexOf(term)!==-1);
}
function findSearchResults(items,query,fields,limit){
  const out=[];
  for(let i=0;i<items.length;i++){
    if(matchesSearch(items[i],query,fields)){
      out.push(items[i]);
      if(limit && out.length>=limit) break;
    }
  }
  return out;
}
function schedulePageSearch(owner,page,fn){
  clearTimeout(owner._searchTimer);
  /* Invalidate an incremental render immediately; waiting for the debounce
     must never allow an older batch to keep appending obsolete results. */
  if(typeof owner._renderToken==='number') owner._renderToken++;
  owner._searchTimer=setTimeout(()=>{
    owner._searchTimer=null;
    if(App.page===page) fn();
  },150);
}

/* Commit the current query before leaving the keyboard. A queued debounce
   must not replace the focused result just after Done/Back is pressed. */
let _editingSearch=null;
function bindSearchExit(input,commit,target){
  input.setAttribute('type','search');
  input.setAttribute('enterkeyhint','search');
  input._commitSearch=commit;
  input._searchTarget=target;
  input.addEventListener('focus',()=>{ _editingSearch=input; });
  input.addEventListener('blur',()=>{ input._searchBlurAt=Date.now(); });
}
function finishSearch(input){
  if(!input || !document.documentElement.contains(input) || !input._commitSearch) return false;
  _editingSearch=null;
  input._commitSearch();
  input.blur();
  Focus.clearCache();
  const target=input._searchTarget&&input._searchTarget();
  if(target) Focus.select(target);
  else {
    const fallback=document.querySelector('.cat-item.active, #sidenav .nav-item.active, #sidenav .nav-item');
    if(fallback) Focus.select(fallback);
  }
  return true;
}
function bindCatalogueSearch(input,owner,page,render,results){
  input.addEventListener('input',()=>{
    owner._q=input.value;
    schedulePageSearch(owner,page,render);
  });
  bindSearchExit(input,()=>{
    clearTimeout(owner._searchTimer); owner._searchTimer=null;
    owner._q=input.value;
    render();
  },()=>document.querySelector(results+' [data-f="1"]') ||
    document.querySelector('.content-panel .sort-pill.active, .cat-item.active'));
}

/* Native lazy image loading is ignored by the Chromium M63 engine used on
   older Tizen TVs. IntersectionObserver is available there, so defer poster
   and logo requests ourselves and keep a direct-src fallback. */
const LazyImages=(function(){
  let observer=null;
  function load(img){
    if(!img) return;
    const src=img.getAttribute('data-lazy-src');
    if(!src) return;
    img.removeAttribute('data-lazy-src');
    try{ if(observer) observer.unobserve(img); }catch(_){}
    img.src=src;
  }
  function getObserver(){
    if(observer || typeof IntersectionObserver==='undefined') return observer;
    observer=new IntersectionObserver(entries=>{
      entries.forEach(entry=>{ if(entry.isIntersecting || entry.intersectionRatio>0) load(entry.target); });
    },{root:null,rootMargin:'360px 240px',threshold:0.01});
    return observer;
  }
  return {
    watch(img,src){
      if(!img) return;
      if(!src){ img.style.display='none'; return; }
      img.setAttribute('data-lazy-src',String(src));
      const io=getObserver();
      if(io){ try{io.observe(img);}catch(_){load(img);} }
      else load(img);
    },
    forget(root){
      if(!root || !observer) return;
      const imgs=root.querySelectorAll('img[data-lazy-src]');
      for(let i=0;i<imgs.length;i++){ try{observer.unobserve(imgs[i]);}catch(_){} }
    },
    reset(){
      if(observer){ try{observer.disconnect();}catch(_){} observer=null; }
    },
  };
})();

/* Users enter their own Xtream Codes server URL and credentials on-device. */
const SERVER_URLS=Object.freeze([]);
const DEFAULT_SERVER='';

const App = {
  page: 'boot',
  prevPage: null,
  currentRoute: null,
  catchup: false,
  server: null,
  serverAttempts: [],
  account: null,
  subscreen: null,
  history: [],
  cache: { liveCats:null, live:null, vodCats:null, vod:null, serCats:null, ser:null, epgShort:{} },
  epgShortPromises: {},
  _digitBuf: '',
  _digitT: null,
  _renderGen: 0,
  _connectPromise: null,
  _exitArmedUntil: 0,
  _connectionError: null,
  _pendingPlaybackServer: null,

  async init(){
    /* Build player overlay */
    if(!document.getElementById('player-overlay')){
      const o=document.createElement('div'); o.id='player-overlay';
      const c=document.createElement('div'); c.id='player-controls';
      o.appendChild(c); document.body.appendChild(o);
    }
    Player.init();

    /* Apply saved theme */
    this._applyTheme(S.get('theme','dark'));

    /* Global key handler */
    document.body.onkeydown = e => this._key(e);
    document.addEventListener('visibilitychange',()=>{
      try{ document.hidden?Player.suspend():Player.resume(); }catch(_){}
    });


    /* Reminder watcher — notifies ~1 min before start */
    setInterval(()=>this._checkReminders(), 30000);
    setTimeout(()=>this._checkReminders(), 2000);

    this.page='connection';
    const account=this._accountConfig();
    if(!account.complete){
      this._removeSplash();
      const main=renderShell('settings');
      SettingsPage._loginForm(main,true);
      return;
    }
    await this._connectServers('home',false);
  },

  _setConnectStatus(message){
    const tag=document.querySelector('#splash .splash-tag');
    if(tag) tag.textContent=message;
    const status=document.getElementById('connection-status');
    if(status) status.textContent=message;
  },

  _removeSplash(){
    const splash=document.getElementById('splash');
    if(splash) splash.remove();
  },

  buildSeriesEpisodeQueue(series,info){
    const details=(info&&info.info)||{};
    const title=(series&&series.name)||details.name||'Series';
    const poster=(series&&series.cover)||details.cover||details.movie_image||'';
    const seriesId=(series&&series.series_id)!=null?series.series_id:details.series_id;
    const seasons=Object.keys((info&&info.episodes)||{}).sort((a,b)=>Number(a)-Number(b));
    const queue=[];
    seasons.forEach(season=>{
      const eps=(info.episodes[season]||[]).slice();
      eps.sort((a,b)=>Number(a.episode_num)-Number(b.episode_num));
      eps.forEach(ep=>{
        const ext=ep.container_extension||'mp4';
        const episode=ep.episode_num;
        const episodeTitle=ep.title||('Episode '+episode);
        queue.push({
          url:API.serUrl(ep.id,ext),
          title:title,
          sub:'S'+season+'E'+episode+' · '+episodeTitle,
          sid:ep.id,
          type:'series',
          ext:ext,
          cover:poster,
          seriesId:seriesId,
          seriesTitle:title,
          season:String(season),
          episode:episode,
          episodeTitle:episodeTitle
        });
      });
    });
    return queue;
  },

  async getSeriesEpisodeQueue(seriesId,seriesTitle,cover){
    const info=await API.getSeriesInfo(seriesId);
    const details=(info&&info.info)||{};
    const series={series_id:seriesId,name:seriesTitle||details.name||'Series',cover:cover||details.cover||details.movie_image||''};
    return this.buildSeriesEpisodeQueue(series,info);
  },

  _clearCatalogCache(){
    this.cache={liveCats:null,live:null,vodCats:null,vod:null,serCats:null,ser:null,epgShort:{}};
    this.epgShortPromises={};
    S.del('cache_live'); S.del('cache_vod'); S.del('cache_ser');
  },

  _accountConfig(){
    const saved=S.creds.load()||{};
    const complete=!!(saved.url&&saved.user&&saved.pass);
    const user=complete?saved.user:'';
    const pass=complete?saved.pass:'';
    const urls=[];
    const add=url=>{ const base=API.norm(url); if(base&&urls.indexOf(base)===-1) urls.push(base); };
    add(saved.url);
    add(S.get('last_server',''));
    add(DEFAULT_SERVER);
    SERVER_URLS.forEach(add);
    return {complete,user,pass,urls};
  },

  _renderConnecting(){
    this.page='connection';
    Focus.reset();
    document.getElementById('app').innerHTML=`
      <div class="connection-screen">
        <div class="connection-card">
          <div class="splash-logo">VELA STREAM</div>
          <div class="connection-title">Finding a working server</div>
          <div id="connection-status" class="connection-status">Testing your saved server first...</div>
          <div class="splash-dots"><span></span><span></span><span></span></div>
        </div>
      </div>`;
  },

  async _connectServers(returnPage='home',force=false){
    if(this._connectPromise) return this._connectPromise;
    const work=(async()=>{
      const account=this._accountConfig();
      if(!account.complete){
        this._removeSplash();
        this.page='settings';
        const main=renderShell('settings');
        SettingsPage._loginForm(main,true);
        return null;
      }
      this.account={user:account.user,pass:account.pass};
      this.serverAttempts=[];
      this._setConnectStatus('Finding a working server...');
      try{
        const result=await API.selectServer(account.urls,account.user,account.pass,{
          preferred:force?'':S.get('last_server',''),
          timeout:8000,
          concurrency:3,
          onAttempt:base=>this._setConnectStatus('Testing '+base.replace(/^https?:\/\//,'')),
          onResult:(base,ok,detail)=>{
            this.serverAttempts.push({base,ok,code:ok?'OK':(detail.code||'FAILED')});
          }
        });
        API.setup(result.base,account.user,account.pass);
        const profile=result.base+'|'+account.user;
        if(S.get('cache_profile','')!==profile) this._clearCatalogCache();
        S.set('cache_profile',profile);
        S.set('last_server',result.base);
        S.set('last_server_health',{ok:true,checkedAt:Date.now(),latency:result.latency||0});
        S.creds.save(result.base,account.user,account.pass);
        this.server=result.base;
        this._connectionError=null;
        this._pendingPlaybackServer=null;
        this.catchup=!!result.catchup;
        S.set('last_catchup',this.catchup);
        this._removeSplash();
        this.go(returnPage,{replace:true,root:returnPage==='home'});
        return result;
      }catch(err){
        this.catchup=!!S.get('last_catchup',false);
        S.set('last_server_health',{ok:false,checkedAt:Date.now(),code:err.code||'FAILED'});
        this._removeSplash();
        this._renderConnectionError(err);
        return null;
      }
    })();
    this._connectPromise=work;
    work.then(()=>{ if(this._connectPromise===work) this._connectPromise=null; },()=>{ if(this._connectPromise===work) this._connectPromise=null; });
    return work;
  },

  async failoverPlaybackServer(excluded=[]){
    const account=this._accountConfig();
    const blocked=(Array.isArray(excluded)?excluded:[excluded]).map(API.norm);
    const urls=account.urls.filter(url=>blocked.indexOf(API.norm(url))===-1);
    if(!urls.length){
      const err=new Error('No untried server aliases remain');
      err.code='NO_WORKING_SERVER';
      throw err;
    }
    const result=await API.selectServer(urls,account.user,account.pass,{
      timeout:7000,
      concurrency:3,
      onResult:(base,ok,detail)=>{
        this.serverAttempts.push({base:base,ok:ok,code:ok?'OK':((detail&&detail.code)||'FAILED')});
      }
    });
    result.authUser=account.user;
    result.authPass=account.pass;
    return result;
  },

  activatePlaybackServer(result){
    if(!result || !result.base || !result.authUser || !result.authPass) throw new Error('Invalid server candidate');
    API.setup(result.base,result.authUser,result.authPass);
    this.server=result.base;
    this.catchup=!!result.catchup;
    this.account={user:result.authUser,pass:result.authPass};
    this._pendingPlaybackServer=result;
  },

  confirmPlaybackServer(base){
    const result=this._pendingPlaybackServer;
    if(!result || API.norm(base)!==API.norm(result.base)) return;
    S.set('cache_profile',result.base+'|'+result.authUser);
    S.set('last_server',result.base);
    S.set('last_server_health',{ok:true,checkedAt:Date.now(),latency:result.latency||0,media:true});
    S.creds.save(result.base,result.authUser,result.authPass);
    S.set('last_catchup',!!result.catchup);
    this._pendingPlaybackServer=null;
  },

  retestServers(returnPage='settings'){
    this._renderConnecting();
    return this._connectServers(returnPage,true);
  },

  _renderConnectionError(err){
    this.page='connection';
    this.subscreen=null;
    this._connectionError=err||this._connectionError;
    Focus.reset();
    const attempted=this.serverAttempts.map(x=>`<div class="server-attempt"><span>${esc(x.base.replace(/^https?:\/\//,''))}</span><span class="${x.ok?'server-ok':'server-bad'}">${esc(x.code)}</span></div>`).join('');
    document.getElementById('app').innerHTML=`
      <div class="connection-screen">
        <div class="connection-card">
          <div class="connection-title">No working server found</div>
          <div class="connection-status">${esc(err&&err.message||'Check the network and try again.')}</div>
          <div class="server-attempts">${attempted}</div>
          <div class="connection-actions">
            <div id="server-retry" class="btn f" data-f="1" data-zone="main" data-axis="h">Retry all servers</div>
            <div id="server-account" class="btn ghost f" data-f="1" data-zone="main" data-axis="h">Account settings</div>
          </div>
        </div>
      </div>`;
    document.getElementById('server-retry').addEventListener('click',()=>this.retestServers('home'));
    document.getElementById('server-account').addEventListener('click',()=>{
      const main=renderShell('settings'); SettingsPage._loginForm(main);
    });
    afterRender(()=>Focus.select(document.getElementById('server-retry')));
  },
  _checkReminders(){
    try{
      const now = Math.floor(Date.now()/1000);
      const due = S.reminders.all().filter(r => r.start - now <= 60 && r.stop > now);
      due.forEach(r=>{
        this.toast(`🔔 Starting now: ${r.chName} — ${r.title}`, 6000);
        S.reminders.remove(r.id);
      });
    }catch(_){}
  },

  go(page, opts={}){
    const nextRoute={page:page,arg:opts.arg};
    const cur=this.currentRoute;
    const same=cur&&cur.page===page&&cur.arg===opts.arg;
    if(!opts.replace && cur && !same){
      this.history.push(cur);
      if(this.history.length>20) this.history.shift();
    }
    if(opts.root || page==='home') this.history=[];
    this.subscreen=null;
    /* Full reset on page transition — drops cache AND zone memory.
       In-page re-renders keep using clearCache() so memory survives. */
    Focus.reset();
    this.prevPage=this.page;
    this.page=page;
    this.currentRoute=nextRoute;
    const P={home:HomePage,search:SearchPage,live:LivePage,epg:EpgPage,catchup:CatchupPage,
             movies:MoviesPage,series:SeriesPage,favorites:FavPage,settings:SettingsPage,
             seriesDetail:SeriesDetailPage,movieDetail:MovieDetailPage};
    if(P[page]){
      try{
        this._renderGen++;
        const rendered=P[page].render(opts.arg);
        if(rendered&&typeof rendered.catch==='function') rendered.catch(e=>{
          console.error('[Render async]',e); App.toast(e.message||'Error loading page');
        });
      }catch(e){
        console.error('[Render]',e);
        App.toast('Error loading page');
      }
    }
  },

  back(){
    if(this.page==='connection'){
      if(this.subscreen==='account'){
        this.subscreen=null;
        this._renderConnectionError(this._connectionError);
        return;
      }
      const now=Date.now();
      if(now<this._exitArmedUntil){ try{window.tizen.application.getCurrentApplication().exit();}catch(_){} return; }
      this._exitArmedUntil=now+2000;
      this.toast('Press Back again to exit');
      return;
    }
    if(this.subscreen==='account'||this.subscreen==='subtitles'){ SettingsPage.render(); return; }
    if(this.history.length){
      const prev=this.history.pop();
      this.go(prev.page,{replace:true,arg:prev.arg});
      return;
    }
    if(this.page!=='home'){ this.go('home',{replace:true,root:true}); return; }
    const now=Date.now();
    if(now<this._exitArmedUntil){ try{window.tizen.application.getCurrentApplication().exit();}catch(_){} return; }
    this._exitArmedUntil=now+2000;
    this.toast('Press Back again to exit');
  },

  toast(msg,dur=2600){
    const t=document.getElementById('toast'); if(!t) return;
    if(!msg){t.className='toast hidden';return;}
    t.textContent=msg; t.className='toast visible';
    clearTimeout(t._t); t._t=setTimeout(()=>{t.className='toast hidden';},dur);
  },

  logout(){
    S.creds.clear();
    this.cache={liveCats:null,live:null,vodCats:null,vod:null,serCats:null,ser:null,epgShort:{}};
    this.history=[];
    this.go('settings',{replace:true});
  },

  _applyTheme(t){
    document.documentElement.setAttribute('data-theme',t);
  },

  _key(e){
    const k=normaliseKey(e.keyCode);
    if(!k) return;
    const active=document.activeElement;
    const editable=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA');
    if(e.isComposing || e.keyCode===229) return;
    if(editable){
      if(active._commitSearch && (k==='ENTER'||k==='IME_DONE'||k==='IME_CANCEL'||k==='BACK')){
        e.preventDefault();
        finishSearch(active);
        return;
      }
      if(k==='BACK'){
        e.preventDefault(); active.blur();
        afterRender(()=>{
          const zone=active.dataset&&active.dataset.zone;
          const fallback=document.querySelector(`[data-f="1"][data-zone="${zone||'main'}"]:not(input):not(textarea)`);
          fallback?Focus.select(fallback):Focus.selectFirst('sidebar');
        });
      }
      return;
    }
    if(k==='IME_DONE'||k==='IME_CANCEL'){
      /* Samsung can blur the input before dispatching the IME Done key. */
      if(_editingSearch && Date.now()-(_editingSearch._searchBlurAt||0)<500){
        e.preventDefault(); finishSearch(_editingSearch);
      }
      return;
    }
    e.preventDefault();

    /* Digit keys — let input fields consume them; otherwise channel number jump */
    if(k.startsWith('DIGIT_')){
      this._digitInput(k.slice(6));
      return;
    }

    /* Player takes everything when visible */
    if(Player.isActive()){ Player.handleKey(k); return; }

    if(k==='BACK'){
      this.back();
      return;
    }

    if(k==='ENTER'){ Focus.click(); return; }
    if(k==='UP')   { Focus.handle('UP');    return; }
    if(k==='DOWN') { Focus.handle('DOWN');  return; }
    if(k==='LEFT') { Focus.handle('LEFT');  return; }
    if(k==='RIGHT'){ Focus.handle('RIGHT'); return; }

    /* Color shortcuts */
    if(k==='RED')    { this.go('favorites'); return; }
    if(k==='GREEN')  { this.go('epg'); return; }
    if(k==='YELLOW') { this.go('catchup'); return; }
    if(k==='BLUE')   { this.go('settings'); return; }
    if(k==='PLAY'||k==='PLAY_PAUSE')   { /* play top continue-watching if on home */
      const c=S.cont.all()[0];
      if(c) resumeWatching(c);
      return;
    }
  },

  _digitInput(d){
    this._digitBuf += d;
    clearTimeout(this._digitT);
    App.toast('Channel: '+this._digitBuf,1500);
    this._digitT=setTimeout(()=>{
      const num=parseInt(this._digitBuf,10);
      this._digitBuf='';
      App.toast('');
      if(!num) return;
      const streams=App.cache.live||[];
      if(!streams.length){ this.go('live'); return; }
      // Exact provider channel-number match; fall back to ordinal only when no provider num exists
      const hasProviderNums = streams.some(c=>c.num!=null);
      const ch = streams.find(c=>parseInt(c.num,10)===num) || (!hasProviderNums ? streams[num-1] : null);
      if(ch) playLive(ch);
      else App.toast('Channel '+num+' not found');
    }, 1200);
  },

  /**
   * Safe localStorage cache helper.
   * Strips heavy fields (plot, cast, icon URLs) to keep size small.
   * Never writes more than ~1MB per key. Fails silently.
   */
  _safeCache(key,cats,items,keepFields){
    this._cacheWriteTimers=this._cacheWriteTimers||{};
    clearTimeout(this._cacheWriteTimers[key]);
    const source=items.slice(0,4000),slim=[];
    const profile=S.get('cache_profile','');
    let cursor=0;
    const finish=()=>{
      if(S.get('cache_profile','')!==profile) return;
      try{
        const payload=JSON.stringify({ts:Date.now(),cats:cats,items:slim});
        if(payload.length>1500000){
          const p2=JSON.stringify({ts:Date.now(),cats:cats,items:slim.slice(0,1500)});
          if(p2.length<1500000) localStorage.setItem('iptv3_'+key,p2);
          return;
        }
        localStorage.setItem('iptv3_'+key,payload);
      }catch(_){ /* Storage is an optional performance cache. */ }
    };
    const copyBatch=()=>{
      if(S.get('cache_profile','')!==profile) return;
      try{
        const end=Math.min(cursor+250,source.length);
        for(;cursor<end;cursor++){
          const item=source[cursor],o={};
          for(let i=0;i<keepFields.length;i++){
            const field=keepFields[i];
            if(item[field]!==undefined) o[field]=item[field];
          }
          slim.push(o);
        }
        if(cursor<source.length) setTimeout(copyBatch,0);
        else finish();
      }catch(_){ /* Skip caching rather than block navigation. */ }
    };
    const delay=key==='cache_live'?650:key==='cache_vod'?950:1250;
    this._cacheWriteTimers[key]=setTimeout(()=>{
      delete this._cacheWriteTimers[key];
      copyBatch();
    },delay);
  },

  _safeCacheSync(key, cats, items, keepFields){
    try{
      /* Strip each item to only essential fields to keep localStorage small */
      const slim = items.slice(0, 4000).map(item => {
        const o = {};
        for(const f of keepFields){ if(item[f] !== undefined) o[f] = item[f]; }
        return o;
      });
      const payload = JSON.stringify({ts:Date.now(), cats:cats, items:slim});
      /* Safety: don't write if over ~1.5MB (Tizen localStorage is typically 5MB total) */
      if(payload.length > 1500000){
        /* Try with fewer items */
        const smaller = slim.slice(0, 1500);
        const p2 = JSON.stringify({ts:Date.now(), cats:cats, items:smaller});
        if(p2.length < 1500000) localStorage.setItem('iptv3_'+key, p2);
        return;
      }
      localStorage.setItem('iptv3_'+key, payload);
    }catch(_){
      /* localStorage full or write failed — just skip caching */
    }
  },

  async ensureLive(){
    if(this.cache.live) return;
    const persisted = S.get('cache_live', null);
    if(persisted && (Date.now()-persisted.ts) < 15*60*1000){
      this.cache.liveCats = persisted.cats;
      this.cache.live     = persisted.items;
      return;
    }
    const pair=await Promise.all([API.getLiveCats(),API.getLive()]);
    const cats=pair[0],items=pair[1];
    if(!Array.isArray(cats)||!Array.isArray(items)) throw new Error('Invalid live catalogue');
    this.cache.liveCats=cats;
    this.cache.live=items;
    if(items.length){
      this._safeCache('cache_live', cats, items,
        ['stream_id','name','stream_icon','category_id','num','epg_channel_id']);
    }
  },
  async ensureVod(){
    if(this.cache.vod) return;
    const persisted = S.get('cache_vod', null);
    if(persisted && (Date.now()-persisted.ts) < 15*60*1000){
      this.cache.vodCats = persisted.cats;
      this.cache.vod     = persisted.items;
      return;
    }
    const pair=await Promise.all([API.getVodCats(),API.getVod()]);
    const cats=pair[0],items=pair[1];
    if(!Array.isArray(cats)||!Array.isArray(items)) throw new Error('Invalid movie catalogue');
    this.cache.vodCats=cats;
    this.cache.vod=items;
    if(items.length){
      this._safeCache('cache_vod', cats, items,
        ['stream_id','name','stream_icon','category_id','container_extension','rating','added','genre']);
    }
  },
  async ensureSer(){
    if(this.cache.ser) return;
    const persisted = S.get('cache_ser', null);
    if(persisted && (Date.now()-persisted.ts) < 15*60*1000){
      this.cache.serCats = persisted.cats;
      this.cache.ser     = persisted.items;
      return;
    }
    const pair=await Promise.all([API.getSeriesCats(),API.getSeries()]);
    const cats=pair[0],items=pair[1];
    if(!Array.isArray(cats)||!Array.isArray(items)) throw new Error('Invalid series catalogue');
    this.cache.serCats=cats;
    this.cache.ser=items;
    if(items.length){
      this._safeCache('cache_ser', cats, items,
        ['series_id','name','cover','category_id','rating','genre','releaseDate']);
    }
  },

  /* Short EPG with per-channel caching */
  getShortEpg(sid){
    if(App.cache.epgShort[sid]) return Promise.resolve(App.cache.epgShort[sid]);
    if(App.epgShortPromises[sid]) return App.epgShortPromises[sid];
    App.epgShortPromises[sid] = API.getShortEpg(sid).then(d=>{
      const list = (d && d.epg_listings) || [];
      App.cache.epgShort[sid] = list;
      delete App.epgShortPromises[sid];
      return list;
    }).catch(()=>{ delete App.epgShortPromises[sid]; return []; });
    return App.epgShortPromises[sid];
  },
};

/* ═══════════════════════════════════════════════
   UI HELPERS
═══════════════════════════════════════════════ */
const NAV=[
  {id:'home',     icon:'home', label:'Home'},
  {id:'search',   icon:'search', label:'Search'},
  {id:'live',     icon:'live', label:'Live TV'},
  {id:'epg',      icon:'guide', label:'Guide'},
  {id:'catchup',  icon:'history', label:'Catch-up'},
  {id:'movies',   icon:'movie', label:'Movies'},
  {id:'series',   icon:'series', label:'Series'},
  {id:'favorites',icon:'heart', label:'Favorites'},
  {id:'settings', icon:'settings', label:'Settings'},
];
function uiIcon(name){
  const paths={
    home:'<path d="M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3Z"/>',
    search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    live:'<rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 22h8M9 1l3 4 3-4"/>',
    guide:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12M9 15h12"/>',
    history:'<path d="M3 11a9 9 0 1 1 2.2 7M3 4v7h7M12 7v5l3 2"/>',
    movie:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
    series:'<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M6 3h12M8 11h8M8 16h5"/>',
    heart:'<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
    settings:'<path d="M4 6h7m4 0h5M4 12h2m4 0h10M4 18h10m4 0h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    power:'<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
    play:'<path d="m7 3 14 9-14 9Z"/>'
  };
  return '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.play)+'</svg>';
}

let _shellObs=null;
function renderShell(active){
  if(_shellObs){ try{_shellObs.disconnect();}catch(_){} _shellObs=null; }
  const app=document.getElementById('app');
  LazyImages.forget(app);
  app.innerHTML=`
    <div id="layout">
      <aside id="sidebar">
        <div class="logo"><span class="logo-mark">${uiIcon('play')}</span><span class="logo-text">VELA</span></div>
        <nav id="sidenav"></nav>
        <div class="sidebar-spacer"></div>
        <div class="nav-item f" id="nav-out" data-f="1" data-zone="sidebar" data-axis="v">
          <span class="nav-bar"></span>
          <span class="nav-icon">${uiIcon('power')}</span><span class="nav-label">Logout</span>
        </div>
      </aside>
      <main id="main"></main>
    </div>
    <div class="color-hints">
      <span class="chint-red">Favorites</span>
      <span class="chint-green">Guide</span>
      <span class="chint-yellow">Catch-up</span>
      <span class="chint-blue">Settings</span>
    </div>`;
  const nav=document.getElementById('sidenav');
  NAV.forEach(n=>{
    const d=document.createElement('div');
    d.className=`nav-item f${n.id===active?' active':''}`;
    d.dataset.f='1'; d.dataset.zone='sidebar'; d.dataset.axis='v';
    d.innerHTML=`<span class="nav-bar"></span><span class="nav-icon">${uiIcon(n.icon)}</span><span class="nav-label">${n.label}</span>`;
    d.addEventListener('click',()=>App.go(n.id));
    d.addEventListener('mouseenter',()=>document.getElementById('sidebar').classList.add('expanded'));
    nav.appendChild(d);
  });
  const sb=document.getElementById('sidebar');
  sb.addEventListener('mouseleave',()=>sb.classList.remove('expanded'));
  // Expand sidebar when any sidebar item is focused
  sb.addEventListener('focusin',()=>sb.classList.add('expanded'));
  // Fallback: observe class changes on sidebar items
  const expandOnFocus = ()=>{
    const sel = sb.querySelector('.nav-item.sel');
    if(sel) sb.classList.add('expanded'); else sb.classList.remove('expanded');
  };
  _shellObs = new MutationObserver(expandOnFocus);
  [...sb.querySelectorAll('.nav-item')].forEach(el=>{
    _shellObs.observe(el,{attributes:true,attributeFilter:['class']});
  });

  document.getElementById('nav-out').addEventListener('click',()=>App.logout());
  /* Focus is set by each page after it builds content —
     don't auto-focus sidebar here, let pages choose the best initial target */
  return document.getElementById('main');
}

function mkCard({title,cover,meta,meta2,badge,progress,wide,onClick,zone='grid'}){
  const d=document.createElement('div');
  d.className='card f'+(wide?' card-wide':'');
  d.dataset.f='1'; d.dataset.zone=zone; d.dataset.axis='both';
  d.innerHTML=`
    <img alt="" onerror="this.style.display='none'"/>
    ${badge?`<div class="card-badge${badge.live?' live':''}">${esc(badge.text||badge)}</div>`:''}
    ${progress!=null?`<div class="card-progress"><div class="fill" style="width:${Number(progress)||0}%"></div></div>`:''}
    <div class="card-body">
      <div class="card-title">${esc(title)}</div>
      ${meta?`<div class="card-meta">${esc(meta)}</div>`:''}
      ${meta2?`<div class="card-meta card-meta2">${esc(meta2)}</div>`:''}
    </div>`;
  if(onClick) d.addEventListener('click',onClick);
  LazyImages.watch(d.querySelector('img'),cover||'');
  return d;
}

/** Build a rich metadata string for a movie item */
function movieMeta(m){
  const parts=[];
  if(m.added){ const yr=new Date(m.added*1000).getFullYear(); if(yr>1900) parts.push(String(yr)); }
  if(m.genre) parts.push(m.genre);
  if(m.container_extension) parts.push(m.container_extension.toUpperCase());
  return parts.join(' · ');
}

/** Build a rich metadata string for a series item */
function seriesMeta(s){
  const parts=[];
  if(s.genre) parts.push(s.genre);
  if(s.num) parts.push(s.num+' episodes');
  if(s.last_modified){ const yr=new Date(s.last_modified*1000).getFullYear(); if(yr>1900) parts.push(String(yr)); }
  return parts.join(' · ');
}

function mkChCard({ch,zone='grid',meta}){
  const d=document.createElement('div');
  d.className='card card-wide f';
  d.dataset.f='1'; d.dataset.zone=zone; d.dataset.axis='both';
  d.innerHTML=`
    <img style="object-fit:contain;background:var(--bg-3);padding:30px" onerror="this.style.display='none'"/>
    <div class="card-badge live">● LIVE</div>
    <div class="card-body">
      <div class="card-title">${esc(ch.name)}</div>
      <div class="card-meta" data-epg="${esc(ch.stream_id)}">${esc(meta||'Loading…')}</div>
    </div>`;
  d.addEventListener('click',()=>playLive(ch));
  LazyImages.watch(d.querySelector('img'),ch.stream_icon||'');
  // Populate EPG "now playing" asynchronously
  App.getShortEpg(ch.stream_id).then(list=>{
    const nowProg = list.find(p => {
      const s=parseInt(p.start_timestamp||p.start)*1000, e=parseInt(p.stop_timestamp||p.end)*1000;
      return s<=Date.now() && Date.now()<e;
    }) || list[0];
    const meta=d.querySelector('[data-epg]');
    if(meta) meta.textContent = nowProg ? EPG.dec(nowProg.title) : 'Live now';
  });
  return d;
}

function mkCatPanel(cats, activeId, onSelect){
  const panel=document.createElement('div');
  panel.className='cat-panel';
  panel.innerHTML=`
    <div class="cat-search"><span class="chrome-icon">${uiIcon('search')}</span><input placeholder="Search categories…" id="cat-search-inp"/></div>
    <div class="cat-list" id="cat-list"></div>`;
  const list=panel.querySelector('#cat-list');
  const inp =panel.querySelector('#cat-search-inp');
  inp.className='f'; inp.dataset.f='1'; inp.dataset.zone='cat'; inp.dataset.axis='v';

  function buildCats(q){
    list.innerHTML='';
    const filtered=cats.filter(c=>!q||(c.category_name||'').toLowerCase().includes(q.toLowerCase()));
    const frag=document.createDocumentFragment();
    [{category_id:null,category_name:'All'},...filtered].forEach(cat=>{
      const item=document.createElement('div');
      item.className=`cat-item f${String(cat.category_id)===String(activeId)?' active':''}`;
      item.dataset.f='1'; item.dataset.zone='cat'; item.dataset.axis='v';
      item.textContent=cat.category_name;
      item.addEventListener('click',()=>{
        list.querySelectorAll('.cat-item').forEach(x=>x.classList.remove('active'));
        item.classList.add('active');
        activeId=cat.category_id==null?null:cat.category_id;
        onSelect(activeId);
        Focus.enterContent();
      });
      frag.appendChild(item);
    });
    list.appendChild(frag);
    Focus.clearCache();
  }

  let catSearchTimer=null;
  inp.addEventListener('input',e=>{
    const q=e.target.value; clearTimeout(catSearchTimer);
    catSearchTimer=setTimeout(()=>buildCats(q),120);
  });
  bindSearchExit(inp,()=>{
    clearTimeout(catSearchTimer); catSearchTimer=null;
    buildCats(inp.value);
  },()=>((inp.value.trim() && list.querySelector('.cat-item:nth-child(2)')) ||
    list.querySelector('.cat-item.active') || list.querySelector('.cat-item')));
  buildCats('');
  return panel;
}

function filterItems(items, catId, search, fields=['name']){
  const catStr = catId != null ? String(catId) : null;
  return items.filter(i=>{
    if(catStr){
      /* Handle providers that use comma-separated category_ids */
      const ids = String(i.category_id||'').split(',').map(s=>s.trim());
      if(!ids.includes(catStr)) return false;
    }
    return matchesSearch(i,search,fields);
  });
}

function spinner(msg='Loading…'){ return `<div class="spinner">${msg}</div>`; }

function skeletonRow(wide=false){
  const cls = wide ? 'sk-card-wide' : 'sk-card';
  return `<div class="sk-row">${Array.from({length:6},()=>`<div class="sk ${cls}"></div>`).join('')}</div>`;
}

function emptyState(icon,msg){
  return `<div class="empty"><div class="empty-icon">${icon}</div>${msg}</div>`;
}

function playLive(ch){
  Player.play({url:null,title:ch.name,sub:'Live',sid:ch.stream_id,type:'live',cover:ch.stream_icon||''});
}
function playVod(m){
  try{ S.watch.inc('m:'+m.stream_id); }catch(_){}
  Player.play({url:API.vodUrl(m.stream_id,m.container_extension||'mp4'),title:m.name,
    sub:m.rating?`⭐ ${parseFloat(m.rating).toFixed(1)}`:'',
    sid:m.stream_id,type:'movie',ext:m.container_extension||'mp4',cover:m.stream_icon||''});
}

function seriesDisplayTitle(item){
  const explicit=String((item&&item.seriesTitle)||'').trim();
  if(explicit) return explicit;
  return String((item&&item.title)||'Series').replace(/\s+S\d+\s*E\d+.*$/i,'').trim()||'Series';
}

function seriesEpisodeLabel(item){
  if(item&&item.season!=null&&item.episode!=null) return 'S'+item.season+'E'+item.episode;
  const match=String((item&&item.title)||'').match(/\bS\d+\s*E\d+/i);
  return match?match[0].replace(/\s+/g,''):'';
}

function continuePlaybackItem(item){
  const isSeries=item&&item.type==='series';
  const seriesTitle=isSeries?seriesDisplayTitle(item):'';
  const episodeLabel=isSeries?seriesEpisodeLabel(item):'';
  return {
    url:item.type==='live'?null:item.type==='series'?API.serUrl(item.id,item.ext):API.vodUrl(item.id,item.ext),
    title:isSeries?seriesTitle:item.title,
    sub:isSeries?[episodeLabel,item.episodeTitle].filter(Boolean).join(' · '):'',
    sid:item.id,
    resumePos:Math.max(0,Number(item.pos)||0),
    type:item.type,
    ext:item.ext,
    cover:item.cover||'',
    seriesId:item.seriesId,
    seriesTitle:seriesTitle,
    season:item.season,
    episode:item.episode,
    episodeTitle:item.episodeTitle
  };
}

let _resumeLaunch=0;
async function resumeWatching(saved){
  const ticket=++_resumeLaunch,gen=App._renderGen;
  const latest=saved.type==='series'?S.cont.series(saved.seriesId,seriesDisplayTitle(saved)):S.cont.episode(saved.type,saved.id);
  const item=latest?{...saved,...latest}:saved;
  const playback=continuePlaybackItem(item);
  if(item.type==='series'&&item.seriesId!=null&&item.dur>0&&item.pos>=item.dur-5000){
    try{
      const queue=await App.getSeriesEpisodeQueue(item.seriesId,item.seriesTitle||item.title,item.cover);
      if(ticket!==_resumeLaunch||gen!==App._renderGen||Player.isActive()) return;
      const index=queue.findIndex(ep=>String(ep.sid)===String(item.id));
      if(index>=0&&queue[index+1]){Player.play({...queue[index+1],resumePos:0,episodeQueue:queue,episodeIndex:index+1});return;}
    }catch(_){if(ticket!==_resumeLaunch||gen!==App._renderGen||Player.isActive())return;}
  }
  Player.play(playback);
}

/* ═══════════════════════════════════════════════
   HOME PAGE
═══════════════════════════════════════════════ */
const HomePage={
  _heroTimer: null,
  _heroItems: [],
  _heroIdx: 0,

  async render(){
    const _gen=App._renderGen;
    const main=renderShell('home');
    const h=new Date().getHours();
    const greet = h<12?'Good morning':h<18?'Good afternoon':'Good evening';
    main.innerHTML=`
      <div id="h-qa"></div>
      <div id="h-cont"></div>
      <div id="h-hero-slot"></div>
      <div id="h-live"></div>
      <div id="h-rec"></div>
      <div id="h-mov"></div>
      <div id="h-ser"></div>
    `;

    // Quick actions row
    const qa=document.getElementById('h-qa');
    qa.innerHTML=`<div class="page-title">Watch</div><div class="page-sub">${greet}. Pick up where you left off.</div><div class="qa-row" id="qa-row"></div>`;
    const actions=[
      {icon:'▶', title:'Live TV',   sub:'Watch now',       goto:'live'},
      {icon:'▤', title:'TV Guide',  sub:'Schedule',        goto:'epg'},
      {icon:'⟲', title:'Catch-up',  sub:'Watch later',     goto:'catchup'},
      {icon:'★', title:'Favorites', sub:'Your picks',      goto:'favorites'},
    ];
    const qaRow=document.getElementById('qa-row');
    actions.forEach(a=>{
      const d=document.createElement('div');
      d.className='qa-card f';
      d.dataset.f='1'; d.dataset.zone='grid'; d.dataset.axis='both';
      d.innerHTML=`<div class="qa-icon">${a.icon}</div><div class="qa-text"><div class="qa-title">${a.title}</div><div class="qa-sub">${a.sub}</div></div>`;
      d.addEventListener('click',()=>App.go(a.goto));
      qaRow.appendChild(d);
    });

    afterRender(()=>{
      Focus.clearCache();
      const qa=document.querySelector('#cw-row .card')||document.querySelector('#qa-row .qa-card');
      if(qa){ Focus.select(qa); return; }
      const sb=document.querySelector('#sidebar .nav-item.active')||document.querySelector('#sidebar [data-f]');
      if(sb) Focus.select(sb);
    });
    // Hero loading (skeleton while we fetch live data)
    document.getElementById('h-hero-slot').innerHTML = '';

    // Continue Watching row (sync — from localStorage)
    this._renderContinueWatching();

    // Async data for hero + live row
    try{
      await Promise.all([App.ensureLive().catch(()=>{}), App.ensureVod().catch(()=>{}), App.ensureSer().catch(()=>{})]);
    }catch(_){}
    if(_gen!==App._renderGen) return;
    this._renderContinueWatching();

    this._renderHero();
    this._renderFavoriteChannels();
    this._renderRecentMovies();
    this._renderFavoriteMovies();
    this._renderFavoriteSeries();

    Focus.refreshSoon();
  },

  _renderContinueWatching(){
    const slot=document.getElementById('h-cont');
    if(!slot) return;
    const focused=Focus.get();
    const restoreKey=focused&&slot.contains(focused)?focused.getAttribute('data-resume-key'):null;
    const restoreSeries=restoreKey?focused.getAttribute('data-series-id'):null;
    const raw=S.cont.all();
    const seen=new Set();
    const cont=[];
    raw.forEach(saved=>{
      let item={...saved};
      if(item.type==='series'){
        const title=seriesDisplayTitle(item);
        if(!item.seriesId){
          const match=(App.cache.ser||[]).find(s=>String(s.name||'').trim().toLowerCase()===title.toLowerCase());
          if(match) item={...item,seriesId:match.series_id,seriesTitle:match.name,cover:item.cover||match.cover||''};
        }
      }
      const key=item.type==='series'?'series:'+((item.seriesId!=null&&item.seriesId!=='')?item.seriesId:seriesDisplayTitle(item).toLowerCase()):item.type+':'+item.id;
      if(seen.has(key)) return;
      seen.add(key);
      cont.push(item);
    });
    if(!cont.length){ slot.innerHTML=''; return; }
    const rowId='cw-row';
    slot.innerHTML=`<div class="section-hd">Continue Watching</div><div class="card-row" id="${rowId}"></div>`;
    const row=document.getElementById(rowId);
    cont.forEach(item=>{
      const pct=item.dur>0?item.pos/item.dur*100:0;
      const remaining=(item.dur||0)-(item.pos||0);
      const isSeries=item.type==='series';
      const episodeMeta=isSeries?[seriesEpisodeLabel(item),item.episodeTitle].filter(Boolean).join(' · '):'';
      const card=mkCard({
        title:isSeries?seriesDisplayTitle(item):item.title,
        cover:item.cover,
        wide:true,
        meta:remaining>0?EPG.fmtMs(remaining)+' left':'Resume',
        meta2:episodeMeta,
        progress:pct,
        onClick:()=>resumeWatching(item)
      });
      card.setAttribute('data-resume-key',item.type+':'+item.id);
      if(isSeries&&item.seriesId!=null) card.setAttribute('data-series-id',String(item.seriesId));
      row.appendChild(card);
    });
    Focus.clearCache();
    if(restoreKey){
      const target=Array.from(row.children).find(el=>el.getAttribute('data-resume-key')===restoreKey||restoreSeries&&el.getAttribute('data-series-id')===restoreSeries)||row.firstElementChild;
      if(target) Focus.select(target);
    }
  },

  _renderHero(){
    const slot=document.getElementById('h-hero-slot');
    // Collect hero candidates: favorite movies, top-rated movies, newest movies
    const cand=[];
    const favM=S.fav.all('movie');
    favM.slice(0,3).forEach(m=>cand.push({type:'movie',item:m,label:'From Your Favorites'}));
    const vod=(App.cache.vod||[]).filter(m=>m.stream_icon&&(m.rating||0)>=7).sort((a,b)=>(b.added||0)-(a.added||0));
    vod.slice(0,5).forEach(m=>cand.push({type:'movie',item:m,label:'Trending Now'}));
    const newest=(App.cache.vod||[]).filter(m=>m.stream_icon).sort((a,b)=>(b.added||0)-(a.added||0));
    newest.slice(0,3).forEach(m=>cand.push({type:'movie',item:m,label:'New Release'}));
    // Deduplicate
    const seen=new Set();
    this._heroItems = cand.filter(c=>{ const id=c.item.stream_id||c.item.series_id; if(seen.has(id))return false; seen.add(id); return true; }).slice(0,5);

    if(!this._heroItems.length){
      slot.innerHTML='';
      return;
    }

    slot.innerHTML=`
      <div class="hero">
        <div class="hero-bg" id="hero-bg"></div>
        <div class="hero-grad"></div>
        <div class="hero-inner">
          <div class="hero-pill" id="hero-pill"></div>
          <div class="hero-title" id="hero-title"></div>
          <div class="hero-meta" id="hero-meta"></div>
          <div class="hero-desc" id="hero-desc"></div>
          <div class="hero-actions">
            <div class="hero-btn primary f" data-f="1" data-zone="main" data-axis="both" id="hero-play">▶ Play</div>
            <div class="hero-btn ghost f" data-f="1" data-zone="main" data-axis="both" id="hero-info">More Info</div>
          </div>
        </div>
        <div class="hero-dots" id="hero-dots"></div>
      </div>`;

    this._heroIdx=0;
    this._heroUpdate();
    clearInterval(this._heroTimer);
    this._heroTimer=null;

    document.getElementById('hero-play').addEventListener('click',()=>{
      const c=this._heroItems[this._heroIdx]; if(!c) return;
      if(c.type==='movie') playVod(c.item);
    });
    document.getElementById('hero-info').addEventListener('click',()=>{
      const c=this._heroItems[this._heroIdx]; if(!c) return;
      if(c.type==='movie'){ App.go('movieDetail',{arg:c.item}); }
    });
  },
  _heroUpdate(){
    const c=this._heroItems[this._heroIdx]; if(!c) return;
    const m=c.item;
    const bg=document.getElementById('hero-bg');
    const img = m.stream_icon || m.cover || '';
    // Use two layers & crossfade
    if(bg){
      bg.style.backgroundImage = `linear-gradient(90deg, rgba(7,7,10,.2), transparent), url('${img}')`;
      bg.style.backgroundPosition='center top';
      bg.style.backgroundSize='cover';
      bg.style.filter='none';
    }
    document.getElementById('hero-pill').textContent = c.label || 'Featured';
    document.getElementById('hero-title').textContent = m.name || '';
    const meta=[];
    if(m.rating) meta.push('<span>⭐ '+parseFloat(m.rating).toFixed(1)+'</span>');
    if(m.releaseDate) meta.push('<span>'+esc((m.releaseDate||'').slice(0,4))+'</span>');
    else if(m.added) meta.push('<span>'+new Date(m.added*1000).getFullYear()+'</span>');
    if(m.genre) meta.push('<span>'+esc(m.genre)+'</span>');
    document.getElementById('hero-meta').innerHTML = meta.join('<span class="dot">·</span>');
    document.getElementById('hero-desc').textContent = m.plot || '';
    const dots=document.getElementById('hero-dots');
    dots.innerHTML = this._heroItems.map((_,i)=>`<span class="${i===this._heroIdx?'active':''}"></span>`).join('');
  },

  _renderFavoriteChannels(){
    const slot=document.getElementById('h-live');
    const fl=S.fav.all('live');
    const streams=App.cache.live||[];

    let channels = [];
    if(fl.length){
      channels = fl.slice(0,10);
    } else if(streams.length){
      // Fallback: show first 10 channels as "Popular" if no favorites
      channels = streams.slice(0,10);
    }
    if(!channels.length){ slot.innerHTML=''; return; }
    slot.innerHTML=`<div class="section-hd">${fl.length?'Favorite Channels':'Popular Channels'}</div><div class="card-row" id="fav-ch-row"></div>`;
    const row=document.getElementById('fav-ch-row');
    channels.forEach(ch=>row.appendChild(mkChCard({ch})));
  },

  _renderRecentMovies(){
    const slot=document.getElementById('h-rec');
    const vod=App.cache.vod||[];
    if(!vod.length){ slot.innerHTML=''; return; }
    const recent=[...vod].filter(m=>m.added).sort((a,b)=>b.added-a.added).slice(0,14);
    if(!recent.length){ slot.innerHTML=''; return; }
    slot.innerHTML=`<div class="section-hd">Recently Added Movies</div><div class="card-row" id="rec-row"></div>`;
    const row=document.getElementById('rec-row');
    recent.forEach(m=>row.appendChild(mkCard({
      title:m.name,cover:m.stream_icon,
      meta: movieMeta(m),
      badge: m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,
      onClick:()=>App.go('movieDetail',{arg:m})
    })));
  },

  _renderFavoriteMovies(){
    const slot=document.getElementById('h-mov');
    const fm=S.fav.all('movie');
    if(!fm.length){ slot.innerHTML=''; return; }
    slot.innerHTML=`<div class="section-hd">Favorite Movies</div><div class="card-row" id="fav-mov-row"></div>`;
    const row=document.getElementById('fav-mov-row');
    fm.slice(0,14).forEach(m=>row.appendChild(mkCard({title:m.name,cover:m.stream_icon,meta:movieMeta(m),badge:m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,onClick:()=>App.go('movieDetail',{arg:m})})));
  },

  _renderFavoriteSeries(){
    const slot=document.getElementById('h-ser');
    const fs=S.fav.all('series');
    const ser=App.cache.ser||[];
    let items = fs.length ? fs.slice(0,14) : (ser.length ? ser.slice(0,14) : []);
    if(!items.length){ slot.innerHTML=''; return; }
    slot.innerHTML=`<div class="section-hd">${fs.length?'Favorite Series':'Popular Series'}</div><div class="card-row" id="fav-ser-row"></div>`;
    const row=document.getElementById('fav-ser-row');
    items.forEach(s=>row.appendChild(mkCard({title:s.name,cover:s.cover||s.stream_icon,meta:seriesMeta(s),badge:s.rating?{text:'⭐ '+parseFloat(s.rating).toFixed(1)}:null,onClick:()=>App.go('seriesDetail',{arg:s})})));
  },
};

/* ═══════════════════════════════════════════════
   LIVE TV
═══════════════════════════════════════════════ */
const LivePage={
  _cat:null, _q:'', _renderToken:0,
  async render(){
    const _gen=App._renderGen;
    const main=renderShell('live');
    main.style.padding='0';
    main.innerHTML=spinner('Loading channels…');
    await App.ensureLive();
    if(_gen!==App._renderGen) return;
    const cats=App.cache.liveCats||[], streams=App.cache.live||[];
    this._cat=null; this._q='';
    this._build(main,cats,streams);
  },
  _build(main,cats,streams){
    const self=this;
    main.innerHTML='';
    const tp=document.createElement('div'); tp.className='two-panel';
    const cp=mkCatPanel(cats,null,id=>{ self._cat=id; self._renderList(streams); });
    tp.appendChild(cp);
    const content=document.createElement('div'); content.className='content-panel';
    content.innerHTML=`
      <div class="search-wrap" style="max-width:100%">
        <span class="chrome-icon">${uiIcon('search')}</span><input id="live-q" class="f" data-f="1" data-zone="main" data-axis="both" placeholder="Search channels…"/>
      </div>
      <div class="ch-list" id="ch-list"></div>`;
    tp.appendChild(content);
    main.appendChild(tp);
    bindCatalogueSearch(document.getElementById('live-q'),self,'live',()=>self._renderList(streams),'#ch-list');
    this._renderList(streams);
    afterRender(()=>setInitialFocus('cat'));
  },
  _renderList(streams){
    const f=filterItems(streams,this._cat,this._q,['name']);
    const list=document.getElementById('ch-list'); if(!list) return;
    LazyImages.forget(list);
    list.innerHTML='';
    if(!f.length){ list.innerHTML=emptyState('📺','No channels found'); return; }
    const items=f.slice(0,500);
    const token = ++this._renderToken;
    const BATCH = 60;
    let rendered = 0;
    const renderBatch = () => {
      if(token !== this._renderToken) return; // superseded by newer render
      const frag=document.createDocumentFragment();
      const end = Math.min(rendered + BATCH, items.length);
      for(let idx=rendered; idx<end; idx++){
        const ch=items[idx];
        const item=document.createElement('div');
        item.className='ch-item f'; item.dataset.f='1'; item.dataset.zone='list'; item.dataset.axis='v';
        item.innerHTML=`
          <span class="ch-num">${esc(ch.num||idx+1)}</span>
          <img class="ch-logo" onerror="this.style.display='none'"/>
          <span class="ch-name">${esc(ch.name)}</span>
          <span class="ch-epg" data-epg="${esc(ch.stream_id)}"><span class="live-dot"></span>Loading…</span>
          <span class="ch-badge">LIVE</span>`;
        LazyImages.watch(item.querySelector('img'),ch.stream_icon||'');
        item.addEventListener('click',()=>playLive(ch));
        frag.appendChild(item);
        // Lazy-populate EPG only for the first batch (visible area); rest stays "Live now"
        if(idx<12){
          App.getShortEpg(ch.stream_id).then(epg=>{
            const nowProg = (epg||[]).find(p => {
              const s=parseInt(p.start_timestamp||p.start)*1000, e=parseInt(p.stop_timestamp||p.end)*1000;
              return s<=Date.now() && Date.now()<e;
            });
            const meta=item.querySelector('[data-epg]');
            if(meta) meta.innerHTML = `<span class="live-dot"></span>${esc(nowProg?EPG.dec(nowProg.title):'Live now')}`;
          });
        } else {
          const meta=item.querySelector('[data-epg]'); if(meta) meta.innerHTML=`<span class="live-dot"></span>Live now`;
        }
      }
      list.appendChild(frag);
      rendered = end;
      if(rendered===items.length || rendered===BATCH) Focus.clearCache();
      if(rendered < items.length){
        afterRender(renderBatch);
      }
    };
    renderBatch();
  },
};

/* ═══════════════════════════════════════════════
   EPG GUIDE
═══════════════════════════════════════════════ */
const EpgPage={
  _di:1, _cache:{}, _loadGen:0,
  async render(){
    const _gen=App._renderGen;
    const main=renderShell('epg');
    main.innerHTML=spinner('Loading EPG…');
    await App.ensureLive();
    if(_gen!==App._renderGen) return;
    this._di=1; this._cache={}; this._loadGen=0;
    const streams=(App.cache.live||[]).slice(0,80);
    const days=EPG.days();
    main.innerHTML=`
      <div class="page-title" style="margin-bottom:16px">TV Guide</div>
      <div class="page-sub">Browse what's on now and next</div>
      <div class="epg-toolbar" id="epg-tb"></div>
      <div class="epg-scroll" id="epg-sc"><div class="epg-wrap" id="epg-w"></div></div>`;
    const tb=document.getElementById('epg-tb');
    days.forEach((d,i)=>{
      const btn=document.createElement('div');
      btn.className=`day-btn f${i===this._di?' active':''}`;
      btn.dataset.f='1'; btn.dataset.zone='pills'; btn.dataset.axis='h';
      btn.textContent=d.label;
      btn.addEventListener('click',()=>{
        tb.querySelectorAll('.day-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
        this._di=i; this._build(streams,days[i]);
      });
      tb.appendChild(btn);
    });
    this._build(streams,days[this._di]);
    setTimeout(()=>{
      const now=new Date(),m=now.getHours()*60+now.getMinutes();
      const sc=document.getElementById('epg-sc');
      if(sc) sc.scrollLeft=Math.max(0,220+m*EPG.PX-400);
    },300);
    afterRender(()=>Focus.selectFirst('pills'));
  },
  _build(streams,day){
    const wrap=document.getElementById('epg-w'); if(!wrap) return;
    const gen = ++this._loadGen;
    const slots=EPG.slots(), SW=120, CW=220, W=CW+slots.length*SW;
    wrap.innerHTML=`
      <div class="epg-header" style="width:${W}px">
        <div class="epg-ch-hdr">Channel</div>
        ${slots.map(s=>`<div class="epg-slot" style="width:${SW}px">${s}</div>`).join('')}
      </div>`;
    let epgRowIndex=0;
    for(const ch of streams){
      const epgRow='r'+(epgRowIndex++);
      const row=document.createElement('div'); row.className='epg-row'; row.style.width=W+'px';
      const cell=document.createElement('div'); cell.className='epg-ch-cell f';
      cell.dataset.f='1'; cell.dataset.zone='list'; cell.dataset.axis='v'; cell.dataset.epgRow=epgRow;
      cell.innerHTML=`<img class="epg-ch-logo" src="${esc(ch.stream_icon||'')}" onerror="this.style.display='none'"/><span class="epg-ch-name">${esc(ch.name)}</span>`;
      cell.addEventListener('click',()=>playLive(ch));
      row.appendChild(cell);
      const progs=document.createElement('div'); progs.className='epg-progs'; progs.style.cssText=`width:${slots.length*SW}px;position:relative`;
      if(this._di===1){
        const l=document.createElement('div'); l.className='epg-nowline';
        l.style.left=(new Date().getHours()*60+new Date().getMinutes())*EPG.PX+'px';
        progs.appendChild(l);
      }
      const ck=String(ch.stream_id);
      if(!this._cache[ck]){
        this._cache[ck] = API.getFullEpg(ch.stream_id)
          .then(d=>(d && d.epg_listings)||[]).catch(()=>[]);
      }
      this._cache[ck].then(all=>{
        const ds=day.date.getTime()/1000,de=ds+86400;
        const list=all.filter(p=>parseInt(p.stop_timestamp)>ds&&parseInt(p.start_timestamp)<de);
        if(gen!==this._loadGen) return;
        if(!document.getElementById('epg-w')) return;
        list.forEach(p=>{
          const past=EPG.past(p.stop_timestamp),now=EPG.now(p.start_timestamp,p.stop_timestamp);
          const upcoming = !past && !now;
          const title=EPG.dec(p.title);
          const remId=`${ch.stream_id}:${p.start_timestamp}`;
          const reminded=upcoming && S.reminders.has(remId);
          const el=document.createElement('div');
          el.className=`epg-prog${now?' now':''}${past?' past':''}${reminded?' reminded':''} f`;
          el.dataset.f='1'; el.dataset.zone='epg'; el.dataset.axis='both'; el.dataset.epgRow=epgRow;
          el.dataset.remId=remId;
          el.style.left=EPG.left(day.date,p.start_timestamp)+'px';
          el.style.width=EPG.width(p.start_timestamp,p.stop_timestamp)+'px';
          const badges = (past?'<span class="prog-cu">Catch-up</span>':'') + (reminded?'<span class="prog-rem">🔔</span>':'');
          el.innerHTML=`<div class="prog-title">${esc(title)}</div><div class="prog-time">${esc(EPG.fmt(p.start_timestamp))}–${esc(EPG.fmt(p.stop_timestamp))}</div>${badges}`;
          if(now){ const pct=document.createElement('div'); pct.className='epg-prog-pct'; pct.style.width=EPG.pct(p.start_timestamp,p.stop_timestamp)+'%'; el.appendChild(pct); }
          el.addEventListener('click',()=>{
            if(past&&App.catchup){
              const sd=new Date(parseInt(p.start_timestamp)*1000);
              Player.play({url:API.cuUrl(ch.stream_id,sd,EPG.mins(p.start_timestamp,p.stop_timestamp)),
                title:`${ch.name} — ${title}`, sub:'Catch-up',
                sid:ch.stream_id,type:'live',catchup:true,cover:ch.stream_icon||''});
            }
            else if(upcoming){
              if(S.reminders.has(remId)){
                S.reminders.remove(remId);
                el.classList.remove('reminded');
                const r=el.querySelector('.prog-rem'); if(r) r.remove();
                App.toast('Reminder removed');
              } else {
                S.reminders.add({id:remId,sid:ch.stream_id,chName:ch.name,title,start:+p.start_timestamp,stop:+p.stop_timestamp});
                el.classList.add('reminded');
                const b=document.createElement('span'); b.className='prog-rem'; b.textContent='🔔'; el.appendChild(b);
                App.toast('Reminder set for '+title);
              }
            }
            else playLive(ch);
          });
          progs.appendChild(el);
        });
        Focus.refreshSoon();
      });
      row.appendChild(progs); wrap.appendChild(row);
    }
    Focus.clearCache();
  },
};

/* ═══════════════════════════════════════════════
   CATCH-UP — modern timeline layout
═══════════════════════════════════════════════ */
const CatchupPage={
  _ch:null, _di:1, _q:'', _loadGen:0,

  async render(){
    const _gen=App._renderGen;
    const main=renderShell('catchup');
    main.style.padding='0';
    main.innerHTML=spinner('Loading channels…');
    await App.ensureLive();
    if(_gen!==App._renderGen) return;
    const streams=App.cache.live||[];
    this._q='';
    if(!this._ch || !streams.find(c=>c.stream_id===this._ch.stream_id)){
      this._ch = S.fav.all('live')[0] || streams[0] || null;
    }
    this._build(main, streams);
  },

  _build(main, streams){
    const self=this;
    main.innerHTML=`
      <div class="cu-layout">
        <div class="cu-chpanel">
          <div class="cu-chpanel-hd">Channels</div>
          <div class="cu-chpanel-search">
            <div class="search-wrap"><span class="chrome-icon">${uiIcon('search')}</span><input id="cu-q" class="f" data-f="1" data-zone="list" data-axis="v" placeholder="Search channels…"/></div>
          </div>
          <div class="cu-chlist" id="cu-chlist"></div>
        </div>
        <div class="cu-main" id="cu-main"></div>
      </div>`;

    bindCatalogueSearch(document.getElementById('cu-q'),self,'catchup',()=>self._renderChs(streams),'#cu-chlist');
    document.getElementById('cu-q').dataset.zone='cu-channels';

    self._renderChs(streams);
    self._renderMain();

    afterRender(()=>setInitialFocus('cu-channels'));
  },

  _renderChs(streams){
    const filtered=findSearchResults(streams,this._q,['name'],400);
    const list=document.getElementById('cu-chlist'); if(!list) return;
    LazyImages.forget(list);
    list.innerHTML='';
    const frag=document.createDocumentFragment();
    filtered.slice(0,this._q?400:180).forEach((ch,idx)=>{
      const active = this._ch && this._ch.stream_id===ch.stream_id;
      const item=document.createElement('div');
      item.className=`cu-chitem f${active?' active':''}`;
      item.dataset.f='1'; item.dataset.zone='cu-channels'; item.dataset.axis='v';
      item.innerHTML=`
        <span class="ch-num">${esc(ch.num||idx+1)}</span>
        <img class="ch-logo" onerror="this.style.display='none'"/>
        <span class="cu-chname">${esc(ch.name)}</span>`;
      LazyImages.watch(item.querySelector('img'),ch.stream_icon||'');
      item.addEventListener('click',()=>{
        if(this._ch && this._ch.stream_id===ch.stream_id) return;
        this._ch=ch;
        list.querySelectorAll('.cu-chitem').forEach(x=>x.classList.remove('active'));
        item.classList.add('active');
        this._renderMain();
      });
      frag.appendChild(item);
    });
    list.appendChild(frag);
    Focus.clearCache();
  },

  async _renderMain(){
    const box=document.getElementById('cu-main'); if(!box) return;
    const ch=this._ch;
    const days=EPG.days();
    if(!ch){ box.innerHTML=emptyState('⟲','Select a channel to see catch-up'); return; }

    box.innerHTML=`
      <div class="cu-header">
        <img class="cu-big-logo" src="${esc(ch.stream_icon||'')}" onerror="this.style.display='none'"/>
        <div>
          <div class="cu-title">${esc(ch.name)}</div>
          <div class="cu-sub">${App.catchup?'Catch-up up to 7 days':'Browse schedule (catch-up may be unavailable)'}</div>
        </div>
      </div>
      <div class="cu-days" id="cu-days">
        ${days.map((d,i)=>`<div class="day-btn f${i===this._di?' active':''}" data-f="1" data-zone="pills" data-axis="h" data-di="${i}">${d.label}</div>`).join('')}
      </div>
      <div id="cu-progs">${spinner('Loading schedule…')}</div>`;

    document.querySelectorAll('#cu-days .day-btn').forEach(btn=>{
      btn.dataset.zone='cu-days';
      btn.addEventListener('click',()=>{
        document.querySelectorAll('#cu-days .day-btn').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        this._di=+btn.dataset.di;
        this._loadProgs();
      });
    });
    this._loadProgs();
  },

  async _loadProgs(){
    const ch=this._ch; if(!ch) return;
    const days=EPG.days(); const day=days[this._di];
    const box=document.getElementById('cu-progs'); if(!box) return;
    const gen = ++this._loadGen;
    box.innerHTML=spinner('Loading schedule…');
    let progs=[];
    try{
      const d=await API.getFullEpg(ch.stream_id);
      const ls=(d && d.epg_listings)||[];
      const ds=day.date.getTime()/1000, de=ds+86400;
      progs=ls.filter(p=>parseInt(p.stop_timestamp)>ds && parseInt(p.start_timestamp)<de);
    }catch(e){
      if(gen===this._loadGen) box.innerHTML=emptyState('⚠','Could not load schedule — check your connection');
      return;
    }
    if(gen!==this._loadGen) return;
    if(!progs.length){ box.innerHTML=emptyState('📅','No schedule for this day'); return; }

    box.innerHTML='<div class="cu-timeline" id="cu-tl"></div>';
    const tl=document.getElementById('cu-tl');
    const frag=document.createDocumentFragment();
    let nowEl=null;

    progs.forEach(p=>{
      const past=EPG.past(p.stop_timestamp), now=EPG.now(p.start_timestamp,p.stop_timestamp), future=!past&&!now;
      const title=EPG.dec(p.title);
      const desc =EPG.dec(p.description||'');
      const row=document.createElement('div');
      row.className=`cu-prog f${now?' now':''}${future?' future':''}`;
      row.dataset.f='1'; row.dataset.zone='cu-programs'; row.dataset.axis='v';
      const dur = EPG.mins(p.start_timestamp,p.stop_timestamp);
      const tags=[];
      if(now)   tags.push('<span class="cu-tag live">● LIVE</span>');
      if(past && App.catchup) tags.push('<span class="cu-tag cu">Catch-up</span>');
      if(future) tags.push('<span class="cu-tag future">Upcoming</span>');

      row.innerHTML=`
        <div class="cu-time">
          <div class="cu-t1">${esc(EPG.fmt(p.start_timestamp))}</div>
          <div class="cu-t2">${esc(EPG.fmt(p.stop_timestamp))}</div>
          <div class="cu-dur">${Number(dur)||0} min</div>
        </div>
        <div class="cu-body">
          <div class="cu-progtitle">${esc(title)}</div>
          ${desc?`<div class="cu-progdesc">${esc(desc)}</div>`:''}
          <div class="cu-tags">${tags.join('')}</div>
        </div>
        <div class="cu-play">▶</div>`;

      row.addEventListener('click',()=>{
        if(future){ App.toast('This hasn\'t aired yet'); return; }
        if(past && !App.catchup){ App.toast('Catch-up not available from provider'); return; }
        const sd=new Date(parseInt(p.start_timestamp)*1000);
        Player.play({
          url: past ? API.cuUrl(ch.stream_id,sd,EPG.mins(p.start_timestamp,p.stop_timestamp)) : null,
          title: `${ch.name} — ${title}`,
          sub: `${past?'Catch-up':'Live'} · ${EPG.fmt(p.start_timestamp)}–${EPG.fmt(p.stop_timestamp)}`,
          sid: ch.stream_id, type:'live', catchup:past, cover: ch.stream_icon||''
        });
      });

      if(now) nowEl=row;
      frag.appendChild(row);
    });
    tl.appendChild(frag);
    Focus.clearCache();

    // Scroll to "now" if on today
    setTimeout(()=>{
      if(nowEl){ try{ nowEl.scrollIntoView({block:'center'}); }catch(_){} }
    },60);
  },
};

/* ═══════════════════════════════════════════════
   MOVIES
═══════════════════════════════════════════════ */
const SORT_MODES=[
  {id:'default',label:'Default'},
  {id:'az',label:'A–Z'},
  {id:'newest',label:'Newest'},
  {id:'rating',label:'Rating'},
  {id:'watched',label:'Most watched'},
];
function sortItems(items,mode,kind){
  if(!mode||mode==='default') return items;
  const arr=items.slice();
  if(mode==='az') arr.sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  else if(mode==='newest') arr.sort((a,b)=>(+b.added||0)-(+a.added||0));
  else if(mode==='rating') arr.sort((a,b)=>(parseFloat(b.rating)||0)-(parseFloat(a.rating)||0));
  else if(mode==='watched'){
    const prefix=kind==='series'?'s:':'m:';
    const keyOf=i=>prefix+(i.stream_id||i.series_id);
    arr.sort((a,b)=>S.watch.get(keyOf(b))-S.watch.get(keyOf(a)));
  }
  return arr;
}
function mkSortBar(current,onChange){
  const bar=document.createElement('div'); bar.className='sort-bar';
  SORT_MODES.forEach(m=>{
    const p=document.createElement('div');
    p.className=`sort-pill f${m.id===current?' active':''}`;
    p.dataset.f='1'; p.dataset.zone='pills'; p.dataset.axis='h';
    p.textContent=m.label;
    p.addEventListener('click',()=>{
      bar.querySelectorAll('.sort-pill').forEach(x=>x.classList.remove('active'));
      p.classList.add('active');
      onChange(m.id);
    });
    bar.appendChild(p);
  });
  return bar;
}

const MoviesPage={
  _cat:null, _q:'', _renderToken:0, _sort:'default',
  async render(){
    const _gen=App._renderGen;
    const main=renderShell('movies');
    main.style.padding='0';
    main.innerHTML=spinner('Loading movies…');
    if(!App.cache.vod||!App.cache.vod.length){ App.cache.vodCats=null;App.cache.vod=null; }
    await App.ensureVod();
    if(_gen!==App._renderGen) return;
    const cats=App.cache.vodCats||[], vod=App.cache.vod||[];
    if(!vod.length){
      main.style.padding='56px 64px';
      main.innerHTML=`<div class="page-title">Movies</div>${emptyState('⚠','Could not load movies')}<div style="text-align:center"><div class="btn f" id="mv-retry" data-f="1" data-zone="main" data-axis="both" style="margin-top:20px">Retry</div></div>`;
      const rb=document.getElementById('mv-retry');
      if(rb){rb.addEventListener('click',()=>MoviesPage.render()); Focus.select(rb);}
      return;
    }
    this._cat=null;this._q='';
    this._build(main,cats,vod);
  },
  _build(main,cats,vod){
    const self=this;
    main.innerHTML='';
    const tp=document.createElement('div'); tp.className='two-panel';
    const cp=mkCatPanel(cats,null,id=>{self._cat=id;self._renderGrid(vod);});
    tp.appendChild(cp);
    const content=document.createElement('div'); content.className='content-panel';
    content.innerHTML=`
      <div class="search-wrap"><span class="chrome-icon">${uiIcon('search')}</span><input id="vod-q" class="f" data-f="1" data-zone="main" data-axis="both" placeholder="Search movies…"/></div>
      <div id="vod-sort-mount"></div>
      <div class="vod-grid" id="vod-grid"></div>`;
    tp.appendChild(content);
    main.appendChild(tp);
    content.querySelector('#vod-sort-mount').appendChild(mkSortBar(self._sort,m=>{self._sort=m;self._renderGrid(vod);}));
    bindCatalogueSearch(document.getElementById('vod-q'),self,'movies',()=>self._renderGrid(vod),'#vod-grid');
    this._renderGrid(vod);
    afterRender(()=>setInitialFocus('cat'));
  },
  _renderGrid(vod){
    let f=filterItems(vod,this._cat,this._q,['name']);
    f=sortItems(f,this._sort,'movie');
    const g=document.getElementById('vod-grid');if(!g)return;
    LazyImages.forget(g);
    g.innerHTML='';
    if(!f.length){ g.innerHTML=emptyState('🎬','No movies found'); return; }
    const items=f.slice(0,300);
    const token=++this._renderToken;
    const BATCH=40;
    let rendered=0;
    const renderBatch=()=>{
      if(token!==this._renderToken) return;
      const frag=document.createDocumentFragment();
      const end=Math.min(rendered+BATCH,items.length);
      for(let idx=rendered;idx<end;idx++){
        const m=items[idx];
        frag.appendChild(mkCard({title:m.name,cover:m.stream_icon,meta:movieMeta(m),
          badge:m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,
          onClick:()=>App.go('movieDetail',{arg:m})}));
      }
      g.appendChild(frag);
      rendered=end;
      if(rendered===items.length || rendered===BATCH) Focus.clearCache();
      if(rendered<items.length) afterRender(renderBatch);
    };
    renderBatch();
  },
};

/* ═══════════════════════════════════════════════
   SERIES
═══════════════════════════════════════════════ */
const SeriesPage={
  _cat:null, _q:'', _renderToken:0, _sort:'default',
  async render(){
    const _gen=App._renderGen;
    const main=renderShell('series');
    main.style.padding='0';
    main.innerHTML=spinner('Loading series…');
    if(!App.cache.ser||!App.cache.ser.length){App.cache.serCats=null;App.cache.ser=null;}
    await App.ensureSer();
    if(_gen!==App._renderGen) return;
    const cats=App.cache.serCats||[], ser=App.cache.ser||[];
    if(!ser.length){
      main.style.padding='56px 64px';
      main.innerHTML=`<div class="page-title">Series</div>${emptyState('⚠','Could not load series')}<div style="text-align:center"><div class="btn f" id="ser-retry" data-f="1" data-zone="main" data-axis="both" style="margin-top:20px">Retry</div></div>`;
      const rb=document.getElementById('ser-retry');
      if(rb){rb.addEventListener('click',()=>SeriesPage.render()); Focus.select(rb);}
      return;
    }
    this._cat=null;this._q='';
    this._build(main,cats,ser);
  },
  _build(main,cats,ser){
    const self=this;
    main.innerHTML='';
    const tp=document.createElement('div'); tp.className='two-panel';
    const cp=mkCatPanel(cats,null,id=>{self._cat=id;self._renderGrid(ser);});
    tp.appendChild(cp);
    const content=document.createElement('div'); content.className='content-panel';
    content.innerHTML=`
      <div class="search-wrap"><span class="chrome-icon">${uiIcon('search')}</span><input id="ser-q" class="f" data-f="1" data-zone="main" data-axis="both" placeholder="Search series…"/></div>
      <div id="ser-sort-mount"></div>
      <div class="vod-grid" id="ser-grid"></div>`;
    tp.appendChild(content);
    main.appendChild(tp);
    content.querySelector('#ser-sort-mount').appendChild(mkSortBar(self._sort,m=>{self._sort=m;self._renderGrid(ser);}));
    bindCatalogueSearch(document.getElementById('ser-q'),self,'series',()=>self._renderGrid(ser),'#ser-grid');
    this._renderGrid(ser);
    afterRender(()=>setInitialFocus('cat'));
  },
  _renderGrid(ser){
    let f=filterItems(ser,this._cat,this._q,['name']);
    f=sortItems(f,this._sort,'series');
    const g=document.getElementById('ser-grid');if(!g)return;
    LazyImages.forget(g);
    g.innerHTML='';
    if(!f.length){g.innerHTML=emptyState('📺','No series found');return;}
    const items=f.slice(0,300);
    const token=++this._renderToken;
    const BATCH=40;
    let rendered=0;
    const renderBatch=()=>{
      if(token!==this._renderToken) return;
      const frag=document.createDocumentFragment();
      const end=Math.min(rendered+BATCH,items.length);
      for(let idx=rendered;idx<end;idx++){
        const s=items[idx];
        frag.appendChild(mkCard({title:s.name,cover:s.cover,meta:seriesMeta(s),
          badge:s.rating?{text:'⭐ '+parseFloat(s.rating).toFixed(1)}:null,
          onClick:()=>App.go('seriesDetail',{arg:s})}));
      }
      g.appendChild(frag);
      rendered=end;
      if(rendered===items.length || rendered===BATCH) Focus.clearCache();
      if(rendered<items.length) afterRender(renderBatch);
    };
    renderBatch();
  },
};

const SeriesDetailPage={
  async render(series){
    const _gen=App._renderGen;
    if(!series){ App.go('series'); return; }
    const main=document.getElementById('main');
    if(!main){ renderShell('series'); return this.render(series); }
    main.style.padding='56px 64px';
    main.innerHTML=spinner();
    let info;
    try{info=await API.getSeriesInfo(series.series_id);}
    catch(e){App.toast('Failed to load series');return;}
    if(_gen!==App._renderGen) return;
    const seasons=Object.keys(info.episodes||{}).sort((a,b)=>+a-+b);
    const episodeQueue=App.buildSeriesEpisodeQueue(series,info);
    const saved=S.cont.series(series.series_id,series.name);
    const savedIndex=saved?episodeQueue.findIndex(ep=>String(ep.sid)===String(saved.id)):-1;
    const completed=saved&&saved.dur>0&&saved.pos>=saved.dur-5000;
    const resumeIndex=savedIndex>=0?(completed&&savedIndex+1<episodeQueue.length?savedIndex+1:savedIndex):0;
    const resumeEpisode=episodeQueue[resumeIndex];
    let activeSeason=resumeEpisode?String(resumeEpisode.season):(seasons[0]||'1');
    const launchEpisode=index=>{
      const current=episodeQueue[index];
      if(!current) return;
      const latest=S.cont.episode('series',current.sid);
      const progress=latest?Number(latest.pos)||0:0;
      Player.play({...current,resumePos:progress,episodeQueue:episodeQueue,episodeIndex:index});
    };

    function renderEps(){
      const eps=(info.episodes[activeSeason]||[]).slice().sort((a,b)=>Number(a.episode_num)-Number(b.episode_num));
      const list=document.getElementById('ep-list'); list.innerHTML='';
      const frag=document.createDocumentFragment();
      eps.forEach(ep=>{
        const item=document.createElement('div');
        item.className='ep-item f'; item.dataset.f='1'; item.dataset.zone='list'; item.dataset.axis='v';
        item.dataset.episodeId=String(ep.id);
        if(resumeEpisode&&String(ep.id)===String(resumeEpisode.sid)) item.classList.add('active');
        item.innerHTML=`<span class="ep-num">E${esc(ep.episode_num)}</span><span class="ep-title">${esc(ep.title||'Episode '+ep.episode_num)}</span><span class="ep-dur">${(ep.info && ep.info.duration_secs)?Math.round(ep.info.duration_secs/60)+'m':''}</span>`;
        item.addEventListener('click',()=>{
          const index=episodeQueue.findIndex(entry=>String(entry.sid)===String(ep.id));
          launchEpisode(index);
        });
        frag.appendChild(item);
      });
      list.appendChild(frag);
      if(!eps.length) list.innerHTML=emptyState('📺','No episodes');
      Focus.clearCache();
    }

    main.innerHTML=`
      <div class="back-btn f" id="sd-back" data-f="1" data-zone="main" data-axis="both">← Back</div>
      <div class="series-hero">
        <img class="series-poster" src="${esc(series.cover||'')}" onerror="this.style.display='none'"/>
        <div class="series-info">
          <div class="page-title">${esc(series.name)}</div>
          <div class="page-sub">${esc(series.genre||'')}${series.releaseDate?' · '+esc(series.releaseDate):''}${series.rating?` · ⭐ ${parseFloat(series.rating).toFixed(1)}`:''}</div>
          ${(info.info && info.info.plot)?`<div class="series-plot">${esc(info.info.plot)}</div>`:''}
          ${resumeEpisode?`<div class="md-actions"><div class="btn f" id="sd-resume" data-f="1" data-zone="main" data-axis="both">${savedIndex>=0?(completed?'Play':'Resume'):'Play'} ${esc('S'+resumeEpisode.season+'E'+resumeEpisode.episode)}</div></div>`:''}
          <div class="pills" id="season-pills"></div>
          <div style="max-height:440px;overflow-y:auto"><div class="ch-list" id="ep-list"></div></div>
        </div>
      </div>`;

    document.getElementById('sd-back').addEventListener('click',()=>App.back());
    const resumeButton=document.getElementById('sd-resume');
    if(resumeButton) resumeButton.addEventListener('click',()=>launchEpisode(resumeIndex));
    const pc=document.getElementById('season-pills');
    seasons.forEach(s=>{
      const p=document.createElement('div'); p.className=`pill f${s===activeSeason?' active':''}`;
      p.dataset.f='1'; p.dataset.zone='pills'; p.dataset.axis='h'; p.textContent='Season '+s;
      p.addEventListener('click',()=>{pc.querySelectorAll('.pill').forEach(x=>x.classList.remove('active'));p.classList.add('active');activeSeason=s;renderEps();});
      pc.appendChild(p);
    });
    renderEps();
    afterRender(()=>Focus.select(resumeButton||document.getElementById('sd-back')));
  },
};

/* ═══════════════════════════════════════════════
   MOVIE DETAIL
═══════════════════════════════════════════════ */
const MovieDetailPage={
  async render(movie){
    const _gen=App._renderGen;
    if(!movie){ App.go('movies'); return; }
    const main=renderShell('movies');
    main.style.padding='0';
    main.innerHTML=`
      <div class="md-bg" id="md-bg"></div>
      <div class="md-scrim"></div>
      <div class="md-content">
        <div class="back-btn f" id="md-back" data-f="1" data-zone="main" data-axis="both">← Back</div>
        <div class="md-hero">
          <img class="md-poster" src="${esc(movie.stream_icon||'')}" onerror="this.style.display='none'"/>
          <div class="md-info">
            <div class="md-title" id="md-title">${esc(movie.name||'')}</div>
            <div class="md-meta" id="md-meta"></div>
            <div class="md-plot" id="md-plot">Loading…</div>
            <div class="md-actions">
              <div class="btn f" id="md-play" data-f="1" data-zone="main" data-axis="both">▶ Play</div>
              <div class="btn ghost f" id="md-fav" data-f="1" data-zone="main" data-axis="both">☆ Favorite</div>
              <div class="btn ghost f md-hidden" id="md-trailer" data-f="1" data-zone="main" data-axis="both">▶ Trailer</div>
            </div>
          </div>
        </div>
        <div id="md-related"></div>
      </div>`;
    // Backdrop from poster
    const bg=document.getElementById('md-bg');
    if(movie.stream_icon){
      bg.style.backgroundImage=`url('${esc(movie.stream_icon)}')`;
    }

    document.getElementById('md-back').addEventListener('click',()=>App.back());
    document.getElementById('md-play').addEventListener('click',()=>playVod(movie));

    const favBtn=document.getElementById('md-fav');
    const refreshFav=()=>{
      const f=S.fav.is('movie', movie.stream_id);
      favBtn.textContent = f?'★ Favorited':'☆ Favorite';
      favBtn.classList.toggle('active',f);
    };
    refreshFav();
    favBtn.addEventListener('click',()=>{
      S.fav.toggle('movie',{stream_id:movie.stream_id,name:movie.name,stream_icon:movie.stream_icon||'',
        rating:movie.rating,category_id:movie.category_id,container_extension:movie.container_extension});
      refreshFav();
      App.toast(S.fav.is('movie', movie.stream_id)?'Added to Favorites':'Removed from Favorites');
    });

    // Meta from what we already have
    const metaEl=document.getElementById('md-meta');
    const yearGuess = movie.releaseDate ? String(movie.releaseDate).slice(0,4)
                    : movie.added ? String(new Date(movie.added*1000).getFullYear()) : '';
    const parts=[];
    if(movie.rating) parts.push('<span>⭐ '+parseFloat(movie.rating).toFixed(1)+'</span>');
    if(yearGuess)    parts.push('<span>'+esc(yearGuess)+'</span>');
    if(movie.genre)  parts.push('<span>'+esc(movie.genre)+'</span>');
    metaEl.innerHTML = parts.join('<span class="dot">·</span>');

    // Plot — show what's on the grid record immediately, then refine with get_vod_info
    const plotEl=document.getElementById('md-plot');
    plotEl.textContent = movie.plot || '';

    // Related row (same category)
    this._renderRelated(movie);

    afterRender(()=>Focus.select(document.getElementById('md-play')));

    // Fetch richer info
    try{
      const info = await API.getVodInfo(movie.stream_id);
      if(_gen!==App._renderGen) return;
      const i = (info && info.info)||{}, md = (info && info.movie_data)||{};
      const realYear = i.releasedate || i.releaseDate || yearGuess;
      const realDur  = i.duration || (i.duration_secs?Math.round(i.duration_secs/60)+'m':'');
      const realRate = i.rating ? parseFloat(i.rating).toFixed(1) : (movie.rating?parseFloat(movie.rating).toFixed(1):'');
      const realGen  = i.genre || movie.genre;
      const p2=[];
      if(realRate) p2.push('<span>⭐ '+realRate+'</span>');
      if(realYear) p2.push('<span>'+esc(String(realYear).slice(0,4))+'</span>');
      if(realDur)  p2.push('<span>'+esc(realDur)+'</span>');
      if(realGen)  p2.push('<span>'+esc(realGen)+'</span>');
      if(i.cast)   p2.push('<span>Cast: '+esc(i.cast)+'</span>');
      metaEl.innerHTML = p2.join('<span class="dot">·</span>');
      if(i.plot || i.description){
        plotEl.textContent = i.plot || i.description;
      } else if(!plotEl.textContent){
        plotEl.textContent = 'No synopsis available.';
      }
      if(i.cover_big || i.backdrop_path || (Array.isArray(i.backdrop_path)&&i.backdrop_path[0])){
        const bd = i.cover_big || (Array.isArray(i.backdrop_path)?i.backdrop_path[0]:i.backdrop_path);
        if(bd) bg.style.backgroundImage=`url('${esc(bd)}')`;
      }
      if(i.youtube_trailer){
        const tb=document.getElementById('md-trailer');
        if(tb){
          tb.classList.remove('md-hidden');
          tb.addEventListener('click',()=>App.toast('Trailer playback not supported on TV'));
        }
      }
    }catch(_){
      if(!plotEl.textContent) plotEl.textContent = 'No synopsis available.';
    }
  },

  _renderRelated(movie){
    const vod = App.cache.vod||[];
    if(!vod.length || !movie.category_id) return;
    const catIds = String(movie.category_id||'').split(',').map(s=>s.trim());
    const related = vod.filter(m => {
      if(m.stream_id===movie.stream_id) return false;
      const mCats = String(m.category_id||'').split(',').map(s=>s.trim());
      return catIds.some(c => mCats.includes(c));
    }).slice(0,14);
    if(!related.length) return;
    const slot=document.getElementById('md-related');
    slot.innerHTML=`<div class="section-hd">More like this</div><div class="card-row" id="md-rel-row"></div>`;
    const row=document.getElementById('md-rel-row');
    related.forEach(m=>row.appendChild(mkCard({
      title:m.name, cover:m.stream_icon,
      meta: movieMeta(m),
      badge: m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,
      onClick: ()=>App.go('movieDetail',{arg:m})
    })));
  },
};

/* ═══════════════════════════════════════════════
   FAVORITES
═══════════════════════════════════════════════ */
const FavPage={
  render(){
    const main=renderShell('favorites');
    const fl=S.fav.all('live'), fm=S.fav.all('movie'), fs=S.fav.all('series');
    if(!fl.length&&!fm.length&&!fs.length){
      main.innerHTML=`<div class="page-title">Favorites</div><div class="page-sub">Press ☆ while watching to save here</div>${emptyState('★','No favorites yet')}`;
      return;
    }
    main.innerHTML='<div class="page-title">Favorites</div><div class="page-sub">Your saved channels, movies, and series</div><div id="fav-l"></div><div id="fav-m"></div><div id="fav-s"></div>';
    if(fl.length){
      const s=document.getElementById('fav-l'); s.innerHTML='<div class="section-hd">Channels</div>';
      const row=document.createElement('div'); row.className='card-row';
      fl.forEach(ch=>row.appendChild(mkChCard({ch})));
      s.appendChild(row);
    }
    if(fm.length){
      const s=document.getElementById('fav-m'); s.innerHTML='<div class="section-hd">Movies</div>';
      const row=document.createElement('div'); row.className='card-row';
      fm.forEach(m=>row.appendChild(mkCard({title:m.name,cover:m.stream_icon,meta:movieMeta(m),badge:m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,onClick:()=>App.go('movieDetail',{arg:m})})));
      s.appendChild(row);
    }
    if(fs.length){
      const s=document.getElementById('fav-s'); s.innerHTML='<div class="section-hd">Series</div>';
      const row=document.createElement('div'); row.className='card-row';
      fs.forEach(s2=>row.appendChild(mkCard({title:s2.name,cover:s2.cover||s2.stream_icon,meta:seriesMeta(s2),badge:s2.rating?{text:'⭐ '+parseFloat(s2.rating).toFixed(1)}:null,onClick:()=>App.go('seriesDetail',{arg:s2})})));
      s.appendChild(row);
    }
    afterRender(()=>Focus.selectFirst('grid'));
  },
};

/* ═══════════════════════════════════════════════
   GLOBAL SEARCH
═══════════════════════════════════════════════ */
const SearchPage={
  _q:'', _tab:'all', _t:null,
  async render(){
    const main=renderShell('search');
    main.style.padding='56px 64px';
    main.innerHTML=`
      <div class="page-title">Search</div>
      <div class="page-sub">Find channels, movies and series</div>
      <div class="search-wrap" style="max-width:640px;margin-bottom:18px">
        <span class="chrome-icon">${uiIcon('search')}</span>
        <input id="gs-q" class="f" data-f="1" data-zone="main" data-axis="both" placeholder="Type to search…" autofocus/>
      </div>
      <div class="sort-bar" id="gs-tabs"></div>
      <div id="gs-results" style="margin-top:18px"></div>`;
    const tabs=document.getElementById('gs-tabs');
    [['all','All'],['live','Live TV'],['movie','Movies'],['series','Series']].forEach(([id,label])=>{
      const p=document.createElement('div');
      p.className=`sort-pill f${id===this._tab?' active':''}`;
      p.dataset.f='1'; p.dataset.zone='pills'; p.dataset.axis='h';
      p.textContent=label;
      p.addEventListener('click',()=>{
        tabs.querySelectorAll('.sort-pill').forEach(x=>x.classList.remove('active'));
        p.classList.add('active'); this._tab=id; this._run();
      });
      tabs.appendChild(p);
    });
    // Prime caches in background
    const searchGen=App._renderGen;
    Promise.all([App.ensureLive().catch(()=>null),App.ensureVod().catch(()=>null),App.ensureSer().catch(()=>null)])
      .then(()=>{
        if(searchGen===App._renderGen && App.page==='search') this._run();
      });
    const inp=document.getElementById('gs-q');
    inp.value=this._q;
    inp.addEventListener('input',e=>{
      this._q=e.target.value;
      clearTimeout(this._t);
      this._t=setTimeout(()=>this._run(),120);
    });
    bindSearchExit(inp,()=>{
      clearTimeout(this._t); this._t=null;
      this._q=inp.value;
      this._run();
    },()=>document.querySelector('#gs-results [data-f="1"]') || document.querySelector('#gs-tabs .active'));
    this._run();
    afterRender(()=>{ try{inp.focus();}catch(_){ } Focus.select(inp); });
  },
  _run(){
    const box=document.getElementById('gs-results'); if(!box) return;
    const active=document.activeElement;
    const focusedKey=active&&box.contains(active)&&active.dataset.searchKey;
    LazyImages.forget(box);
    const q=normaliseSearch(this._q);
    if(!q){ box.innerHTML=emptyState('🔍','Start typing to search'); return; }
    const live=findSearchResults(App.cache.live||[],q,['name','num'],40);
    const mov =findSearchResults(App.cache.vod ||[],q,['name','genre'],40);
    const ser =findSearchResults(App.cache.ser ||[],q,['name','genre'],40);
    const show=this._tab;
    box.innerHTML='';
    const total=(show==='all'?live.length+mov.length+ser.length:
                 show==='live'?live.length:show==='movie'?mov.length:ser.length);
    if(!total){ box.innerHTML=emptyState('∅','No results'); Focus.clearCache(); return; }

    if((show==='all'||show==='live') && live.length){
      const hd=document.createElement('div'); hd.className='section-hd'; hd.textContent=`Live (${live.length})`; box.appendChild(hd);
      const list=document.createElement('div'); list.className='ch-list';
      live.forEach(ch=>{
        const item=document.createElement('div');
        item.className='ch-item f'; item.dataset.f='1'; item.dataset.zone='list'; item.dataset.axis='v';
        item.dataset.searchKey='live:'+ch.stream_id;
        item.innerHTML=`<span class="ch-num">${esc(ch.num||'')}</span>
          <img class="ch-logo" onerror="this.style.display='none'"/>
          <span class="ch-name">${esc(ch.name)}</span>
          <span class="ch-badge">LIVE</span>`;
        LazyImages.watch(item.querySelector('img'),ch.stream_icon||'');
        item.addEventListener('click',()=>playLive(ch));
        list.appendChild(item);
      });
      box.appendChild(list);
    }
    if((show==='all'||show==='movie') && mov.length){
      const hd=document.createElement('div'); hd.className='section-hd'; hd.textContent=`Movies (${mov.length})`; box.appendChild(hd);
      const g=document.createElement('div'); g.className='vod-grid';
      mov.forEach(m=>{
        const yr=m.added?new Date(m.added*1000).getFullYear():'';
        const card=mkCard({title:m.name,cover:m.stream_icon,meta:yr,
          badge:m.rating?{text:'⭐ '+parseFloat(m.rating).toFixed(1)}:null,
          onClick:()=>App.go('movieDetail',{arg:m})});
        card.dataset.searchKey='movie:'+m.stream_id;
        g.appendChild(card);
      });
      box.appendChild(g);
    }
    if((show==='all'||show==='series') && ser.length){
      const hd=document.createElement('div'); hd.className='section-hd'; hd.textContent=`Series (${ser.length})`; box.appendChild(hd);
      const g=document.createElement('div'); g.className='vod-grid';
      ser.forEach(s=>{
        const card=mkCard({title:s.name,cover:s.cover,meta:s.genre||'',
          badge:s.rating?{text:'⭐ '+parseFloat(s.rating).toFixed(1)}:null,
          onClick:()=>App.go('seriesDetail',{arg:s})});
        card.dataset.searchKey='series:'+s.series_id;
        g.appendChild(card);
      });
      box.appendChild(g);
    }
    Focus.clearCache();
    if(focusedKey){
      const restored=Array.from(box.querySelectorAll('[data-search-key]')).find(el=>el.dataset.searchKey===focusedKey);
      if(restored) Focus.select(restored);
      else Focus.select(document.querySelector('#gs-tabs .active'));
    }
  },
};

/* ═══════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════ */
const SettingsPage={
  render(){
    App.subscreen=null;
    const main=renderShell('settings');
    const creds=S.creds.load()||{};
    const theme=S.get('theme','dark');
    const fmt=S.get('stream_fmt','m3u8');
    const mac = this._getMac();

    main.innerHTML=`
      <div class="page-title">Settings</div>
      <div class="page-sub">Account, playback and storage</div>

      <div class="settings-block">
        <div class="settings-block-title">Account</div>
        <div class="settings-row"><span class="settings-key">Server</span><span class="settings-val">${esc(creds.url||'—')}</span></div>
        <div class="settings-row f" id="s-retest" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Retest server list</span>
          <span class="settings-val">Find fastest working alias</span>
        </div>
        <div class="settings-row"><span class="settings-key">Username</span><span class="settings-val">${esc(creds.user||'—')}</span></div>
        <div class="settings-row"><span class="settings-key">Catch-up</span><span class="settings-val">${App.catchup?'Available':'Unavailable'}</span></div>
        <div class="settings-row f" id="s-chg" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Change account</span>
          <span class="settings-val" style="color:var(--accent-2)">→</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-block-title">Appearance</div>
        <div class="settings-row f" id="s-theme" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key" id="s-theme-lbl">Theme</span>
          <span class="settings-val" id="s-theme-val">${theme==='light'?'Light':'Dark'}</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-block-title">Playback</div>
        <div class="settings-row f" id="s-fmt" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Live stream format</span>
          <span class="settings-val" id="s-fmt-val">${fmt?fmt.toUpperCase():'AUTO'}</span>
        </div>
        <div class="settings-row f" id="s-cc" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Clear continue watching</span>
          <span class="settings-val" id="s-cc-val">${S.cont.all().length} items</span>
        </div>
        <div class="settings-row f" id="s-cf" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Clear all favorites</span>
          <span class="settings-val" id="s-cf-val">${S.fav.all('live').length+S.fav.all('movie').length+S.fav.all('series').length} items</span>
        </div>
        <div class="settings-row f" id="s-cache" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Reload channel lists</span>
          <span class="settings-val">Clears cache</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-block-title">Subtitles</div>
        <div class="settings-row f" id="s-online-sub" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Find subtitles online</span>
          <span class="settings-val">${OnlineSubtitles.ready()?'OpenSubtitles configured':'Set up OpenSubtitles'}</span>
        </div>
        <div class="settings-row f" id="s-sub-size" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Size</span>
          <span class="settings-val" id="s-sub-size-val">${S.subs.get().size}px</span>
        </div>
        <div class="settings-row f" id="s-sub-color" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Text color</span>
          <span class="settings-val" id="s-sub-color-val">${esc(S.subs.get().color)}</span>
        </div>
        <div class="settings-row f" id="s-sub-bg" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Background</span>
          <span class="settings-val" id="s-sub-bg-val">${(()=>{const b=S.subs.get().bg; return b&&b!=='transparent'?'On':'Off';})()}</span>
        </div>
        <div class="settings-row f" id="s-sub-off" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Vertical offset</span>
          <span class="settings-val" id="s-sub-off-val">${S.subs.get().offset}px</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-block-title">Reminders</div>
        <div class="settings-row f" id="s-rem-clr" data-f="1" data-zone="list" data-axis="v">
          <span class="settings-key">Clear all reminders</span>
          <span class="settings-val" id="s-rem-val">${S.reminders.all().length} items</span>
        </div>
      </div>

      <div class="settings-block">
        <div class="settings-block-title">About</div>
        <div class="settings-row"><span class="settings-key">Version</span><span class="settings-val">4.4</span></div>
        <div class="settings-row"><span class="settings-key">Device MAC</span><span class="settings-val">${esc(mac)}</span></div>
      </div>`;

    document.getElementById('s-chg').addEventListener('click',()=>this._loginForm(main));
    document.getElementById('s-online-sub').addEventListener('click',()=>this._subtitleForm(main));
    document.getElementById('s-retest').addEventListener('click',()=>App.retestServers('settings'));
    document.getElementById('s-theme').addEventListener('click',()=>{
      const next=S.get('theme','dark')==='dark'?'light':'dark';
      S.set('theme',next); App._applyTheme(next);
      document.getElementById('s-theme-val').textContent=next==='light'?'Light':'Dark';
      App.toast('Theme: '+(next==='light'?'Light':'Dark'));
    });
    document.getElementById('s-fmt').addEventListener('click',()=>{
      const fmts=['m3u8','ts',''];
      const next=fmts[(fmts.indexOf(S.get('stream_fmt','m3u8'))+1)%fmts.length];
      S.set('stream_fmt',next);
      document.getElementById('s-fmt-val').textContent=next?next.toUpperCase():'AUTO';
      App.toast('Format: '+(next||'AUTO'));
    });
    document.getElementById('s-cc').addEventListener('click',()=>{
      S.cont.clear(); document.getElementById('s-cc-val').textContent='0 items'; App.toast('Continue watching cleared');
    });
    document.getElementById('s-cf').addEventListener('click',()=>{
      ['live','movie','series'].forEach(t=>S.fav.clear(t));
      document.getElementById('s-cf-val').textContent='0 items'; App.toast('Favorites cleared');
    });
    document.getElementById('s-cache').addEventListener('click',()=>{
      App.cache={liveCats:null,live:null,vodCats:null,vod:null,serCats:null,ser:null,epgShort:{}};
      S.del('cache_live'); S.del('cache_vod'); S.del('cache_ser');
      App.toast('Cache cleared — will reload on next visit');
    });
    const SIZES=[18,22,26,30,36,42];
    const COLORS=['#ffffff','#ffd54a','#a1f0ff','#a1ffb3'];
    const BGS=[{k:'rgba(0,0,0,0.78)',l:'On'},{k:'rgba(0,0,0,0.4)',l:'Dim'},{k:'transparent',l:'Off'}];
    const OFFS=[0,40,80,120,-40,-80];
    document.getElementById('s-sub-size').addEventListener('click',()=>{
      const cur=S.subs.get().size||22, next=SIZES[(SIZES.indexOf(cur)+1+SIZES.length)%SIZES.length] || SIZES[0];
      S.subs.set({size:next}); document.getElementById('s-sub-size-val').textContent=next+'px'; Player.applySubStyle();
    });
    document.getElementById('s-sub-color').addEventListener('click',()=>{
      const cur=S.subs.get().color||'#ffffff', i=COLORS.indexOf(cur), next=COLORS[(i+1+COLORS.length)%COLORS.length] || COLORS[0];
      S.subs.set({color:next}); document.getElementById('s-sub-color-val').textContent=next; Player.applySubStyle();
    });
    document.getElementById('s-sub-bg').addEventListener('click',()=>{
      const cur=S.subs.get().bg, i=BGS.findIndex(b=>b.k===cur), next=BGS[(i+1+BGS.length)%BGS.length] || BGS[0];
      S.subs.set({bg:next.k}); document.getElementById('s-sub-bg-val').textContent=next.l; Player.applySubStyle();
    });
    document.getElementById('s-sub-off').addEventListener('click',()=>{
      const cur=S.subs.get().offset||0, i=OFFS.indexOf(cur), next=OFFS[(i+1+OFFS.length)%OFFS.length];
      S.subs.set({offset:next}); document.getElementById('s-sub-off-val').textContent=next+'px'; Player.applySubStyle();
    });
    document.getElementById('s-rem-clr').addEventListener('click',()=>{
      S.reminders.clear(); document.getElementById('s-rem-val').textContent='0 items'; App.toast('Reminders cleared');
    });
    afterRender(()=>Focus.selectFirst('list'));
  },

  _subtitleForm(main){
    App.subscreen='subtitles';
    const saved=S.get('online_subtitles',{})||{};
    const langs=[['en','English'],['fr','French'],['ar','Arabic'],['es','Spanish'],['de','German'],['it','Italian'],['pt','Portuguese'],['pt-br','Portuguese (Brazil)'],['nl','Dutch'],['tr','Turkish']];
    let language=saved.language||'en';
    const label=()=>{const lang=langs.find(x=>x[0]===language);return lang?lang[1]:language;};
    main.innerHTML=`<div class="back-btn f" id="os-back" data-f="1" data-zone="main">← Back</div>
      <div class="page-title">Online subtitles</div>
      <div class="page-sub">Find subtitles through OpenSubtitles, then choose the release that matches your video.</div>
      <div style="max-width:760px">
        <p class="series-plot">Create a free API key in your OpenSubtitles.com account under API Consumers. Downloads are subject to their daily limit.</p>
        <div class="input-group"><label>OpenSubtitles API key</label><input id="os-key" type="password" class="f" data-f="1" data-zone="main" autocomplete="off"/></div>
        <div class="settings-row f" id="os-language" data-f="1" data-zone="main"><span class="settings-key">Language</span><span class="settings-val" id="os-language-val"></span></div>
        <div class="md-actions"><div class="btn f" id="os-save" data-f="1" data-zone="main">Save</div><div class="btn ghost f" id="os-remove" data-f="1" data-zone="main">Remove key</div></div>
        <p class="page-sub">Your key is saved on this TV. During playback, open CC and choose Find online.</p>
      </div>`;
    const key=document.getElementById('os-key');key.value=saved.apiKey||'';
    document.getElementById('os-language-val').textContent=label();
    document.getElementById('os-language').onclick=()=>{language=langs[(langs.findIndex(x=>x[0]===language)+1)%langs.length][0];document.getElementById('os-language-val').textContent=label();};
    document.getElementById('os-save').onclick=()=>{S.set('online_subtitles',{apiKey:key.value.trim(),language:language});this.render();App.toast('Subtitle settings saved');};
    document.getElementById('os-remove').onclick=()=>{S.del('online_subtitles');this.render();App.toast('OpenSubtitles key removed');};
    document.getElementById('os-back').onclick=()=>this.render();
    key.addEventListener('keydown',e=>{if(e.keyCode===13||e.keyCode===65376){e.preventDefault();e.stopPropagation();key.blur();Focus.select(document.getElementById('os-save'));}});
    Focus.clearCache();afterRender(()=>Focus.select(document.getElementById('os-language')));
  },

  _getMac(){
    try{
      return (window.webapis && window.webapis.network && window.webapis.network.getMac()) || '—';
    }catch(_){ return '—'; }
  },

  _loginForm(main,initial=false){
    App.subscreen='account';
    main.innerHTML=`
      <div class="back-btn f" id="lf-back" data-f="1" data-zone="main" data-axis="both">← Back</div>
      <div class="page-title">${initial?'Connect Account':'Change Account'}</div>
      <div class="page-sub">Enter new Xtream Codes credentials</div>
      <div style="max-width:540px">
        <div class="input-group"><label>Server URL</label><input id="n-url" class="f" data-f="1" data-zone="main" data-axis="both" type="text" placeholder="http://server:port" autocomplete="off"/></div>
        <div class="input-group"><label>Username</label><input id="n-user" class="f" data-f="1" data-zone="main" data-axis="both" type="text" autocomplete="off"/></div>
        <div class="input-group"><label>Password</label><input id="n-pass" class="f" data-f="1" data-zone="main" data-axis="both" type="password"/></div>
        <div class="btn f" id="n-go" data-f="1" data-zone="main" data-axis="both" style="margin-top:12px">Connect</div>
        <div id="n-log" style="margin-top:16px;font-size:13px;color:var(--text-md);min-height:18px;font-family:monospace"></div>
      </div>`;
    const saved=S.creds.load()||{};
    document.getElementById('n-url').value=saved.url||DEFAULT_SERVER;
    document.getElementById('n-user').value=saved.user||'';
    document.getElementById('n-pass').value=saved.pass||'';
    Focus.clearCache();
    document.getElementById('lf-back').addEventListener('click',()=>this.render());
    document.getElementById('n-go').addEventListener('click',()=>this._doConnect());
    afterRender(()=>Focus.select(document.getElementById('n-go')));
  },

  async _doConnect(){
    const url=(document.getElementById('n-url')||{}).value||'';
    const user=(document.getElementById('n-user')||{}).value||'';
    const pass=(document.getElementById('n-pass')||{}).value||'';
    const btn=document.getElementById('n-go'), log=document.getElementById('n-log');
    if(!url||!user||!pass){App.toast('Fill in all fields');return;}
    if(btn) btn.textContent='Connecting…';
    if(log) log.textContent='Connecting to '+url+'…';
    try{
      const urls=[];
      const add=candidate=>{const base=API.norm(candidate);if(base&&urls.indexOf(base)===-1)urls.push(base);};
      add(url); add(DEFAULT_SERVER); SERVER_URLS.forEach(add);
      const r=await API.selectServer(urls,user,pass,{
        preferred:url,timeout:8000,concurrency:3,
        onAttempt:base=>{if(log)log.textContent='Testing '+base.replace(/^https?:\/\//,'')+'...';}
      });
      const profile=r.base+'|'+user;
      if(S.get('cache_profile','')!==profile) App._clearCatalogCache();
      S.set('cache_profile',profile);
      S.creds.save(r.base,user,pass);
      S.set('last_server',r.base);
      API.setup(r.base,user,pass);
      App.server=r.base;
      App.catchup=r.catchup; S.set('last_catchup',r.catchup);
      App.account={user,pass};
      if(log) log.textContent='✓ Connected';
      App.toast('Connected!');
      setTimeout(()=>{App.subscreen=null;App.go('home',{root:true});},700);
    }catch(e){
      if(log) log.textContent='✗ '+e.message;
      if(btn) btn.textContent='Retry';
      App.toast(e.message);
    }
  },
};

/* ── Bootstrap ──────────────────────────────── */
document.addEventListener('playback-stopped',()=>{
  setTimeout(()=>{
    if(Player.isActive()) return;
    if(App.page==='home') HomePage._renderContinueWatching();
    else if(App.page==='seriesDetail'&&App.currentRoute&&App.currentRoute.arg) SeriesDetailPage.render(App.currentRoute.arg);
  },120);
});
document.addEventListener('DOMContentLoaded',()=>{
  App.init().catch(e=>{
    console.error(e);
    App.toast('Init error: '+e.message);
  });
});
