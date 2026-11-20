'use strict';
const Player = (() => {
  let _item=null, _playing=false, _pos=0, _dur=0;
  let _pollId=null, _hideId=null, _prepared=false, _retryId=null, _lastSave=0;
  let _urlQ=[], _urlI=0, _panelOpen=null, _panelReturn=null;
  let _useAV=false;
  let _playGen=0, _serverFailoverPending=false, _failedServers=[];
  let _subTracks=[], _audioTracks=[], _curSubIdx=-1, _curAudIdx=-1;
  let _externalSubUrl=null;
  let _h5SubCues=[], _h5SubTrackActive=false;
  let _subtitleEnabled=false, _subtitleChoiceMade=false, _subtitleEpoch=0, _subtitleEnableId=null, _pendingSubIdx=null;
  let _returnFocus=null;   /* element to refocus when playback ends */
  let _suspended=false;
  let _resumeTarget=0, _resumePending=false, _resumeAttempts=0, _resumeRetryAt=0;
  let _seekPending=false, _seekSerial=0, _scrub=null, _scrubHold=null;
  let _onlineTrack=null, _onlineActive=false, _onlineRequest=0, _onlineTimer=null, _onlineDelay=0;

  const HIDE = 5000;
  const OSD_HIDE = 4500;
  const SAVE_EVERY = 10000; // throttle continue-watching writes
  const surface = () => document.getElementById('avplay');
  const av   = () => window.webapis && window.webapis.avplay;
  const ov   = () => document.getElementById('player-overlay');
  const ctrl = () => document.getElementById('player-controls');
  const osd  = () => document.getElementById('player-osd');
  let _osdHideId = null;

  function _hasAV(){ try{return !!surface()&&!!av()&&typeof av().open==='function';}catch(_){return false;} }

  function showCtrl(){
    const c=ctrl(); if(c) c.classList.remove('hidden');
    clearTimeout(_hideId);
    _hideId=setTimeout(()=>{ const c=ctrl();if(c&&!_panelOpen&&!_scrub&&!_seekPending)c.classList.add('hidden'); },HIDE);
  }

  function _hideOsd(){ const o=osd(); if(o) o.classList.add('hidden'); }

  function _showOsd(){
    if(!_item || _item.type!=='live') return;
    const o=osd(); if(!o) return;
    const ch = (App.cache.live||[]).find(c=>c.stream_id===_item.sid) || {};
    const chNum = ch.num || '';
    const icon  = _item.cover || ch.stream_icon || '';
    const title = _item.title || ch.name || '';
    o.classList.remove('hidden');
    o.innerHTML = `
      <div class="osd-head">
        <div class="osd-num">${esc(chNum||'')}</div>
        <img class="osd-logo" src="${esc(icon)}" onerror="this.style.display='none'"/>
        <div class="osd-title">${esc(title)}</div>
        ${_item.catchup?'<div class="osd-chip cu">Catch-up</div>':'<div class="osd-chip live">● LIVE</div>'}
      </div>
      <div class="osd-rows">
        <div class="osd-row osd-now"><span class="osd-label">Now</span><span class="osd-prog" id="osd-now">Loading…</span><span class="osd-time" id="osd-now-t"></span></div>
        <div class="osd-row osd-nxt"><span class="osd-label">Next</span><span class="osd-prog" id="osd-nxt">—</span><span class="osd-time" id="osd-nxt-t"></span></div>
      </div>
      <div class="osd-progress"><div class="osd-fill" id="osd-fill" style="width:0%"></div></div>
      <div class="osd-hint">INFO / DOWN to hide · CH +/− to change</div>`;
    clearTimeout(_osdHideId);
    _osdHideId = setTimeout(_hideOsd, OSD_HIDE);

    // Populate EPG async
    const sidAtCall = _item.sid;
    try{
      App.getShortEpg(sidAtCall).then(list=>{
        if(!_item || _item.sid !== sidAtCall) return;
        const nowEl=document.getElementById('osd-now');
        const nowT =document.getElementById('osd-now-t');
        const nxtEl=document.getElementById('osd-nxt');
        const nxtT =document.getElementById('osd-nxt-t');
        const fill =document.getElementById('osd-fill');
        if(!nowEl) return; // OSD hidden
        const now = Date.now();
        const arr = (list||[]).sort((a,b)=>parseInt(a.start_timestamp)-parseInt(b.start_timestamp));
        const cur = arr.find(p=>parseInt(p.start_timestamp)*1000<=now && now<parseInt(p.stop_timestamp)*1000);
        const nxt = arr.find(p=>parseInt(p.start_timestamp)*1000>now);
        if(cur){
          nowEl.textContent = EPG.dec(cur.title) || 'On air';
          nowT.textContent  = EPG.fmt(cur.start_timestamp)+'–'+EPG.fmt(cur.stop_timestamp);
          fill.style.width  = EPG.pct(cur.start_timestamp,cur.stop_timestamp)+'%';
        } else {
          nowEl.textContent = 'On air';
          nowT.textContent  = '';
          fill.style.width  = '100%';
        }
        if(nxt){
          nxtEl.textContent = EPG.dec(nxt.title) || '—';
          nxtT.textContent  = EPG.fmt(nxt.start_timestamp);
        } else {
          nxtEl.textContent = '—';
        }
      }).catch(()=>{});
    }catch(_){}
  }

  function showOsd(){ _showOsd(); }
  function _clearPoll(){ clearInterval(_pollId);_pollId=null; }

  function _clearSubtitleOverlay(){
    const so=document.getElementById('sub-overlay');
    if(so){ so.textContent=''; so.style.display='none'; }
  }

  /* Subtitle payloads are not consistent across Xtream providers. AVPlay and
     external SRT/VTT files may contain HTML entities, JSON escaped slashes,
     Unicode escapes, or ASS line-break/positioning codes. Decode only those
     explicit encodings; never reinterpret already-valid Unicode bytes. */
  function _subtitleCodePoint(hex,original){
    const cp=parseInt(hex,16);
    if(!isFinite(cp) || cp<0 || cp>0x10ffff) return original;
    if(cp<=0xffff) return String.fromCharCode(cp);
    const n=cp-0x10000;
    return String.fromCharCode(0xd800+(n>>10),0xdc00+(n&0x3ff));
  }
  function _stripSubtitleMarkup(text){
    return text
      .replace(/<br\s*\/?>/gi,'\n')
      .replace(/<\/?(?:b|i|u|font|span|ruby|rt|c|v)(?:\s[^>]*)?>/gi,'');
  }
  function _decodeSubtitleEntities(text){
    if(!/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(text)) return text;
    const decoder=document.createElement('textarea');
    let out=text;
    /* Two passes cover commonly double-escaped feeds (for example &amp;#233;)
       while leaving ordinary ampersands and multilingual text untouched. */
    for(let i=0;i<2;i++){
      decoder.innerHTML=out;
      const next=decoder.value;
      if(next===out) break;
      out=next;
    }
    return out;
  }
  function _decodeSubtitleText(value){
    let text=String(value==null?'':value)
      .replace(/^\ufeff/,'')
      .replace(/\u0000/g,'')
      .replace(/\r\n?/g,'\n');
    text=_stripSubtitleMarkup(text)
      .replace(/\{\\[^}]*\}/g,'')
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi,(m,h)=>_subtitleCodePoint(h,m))
      .replace(/\\u([0-9a-f]{4})/gi,(m,h)=>_subtitleCodePoint(h,m))
      .replace(/\\\//g,'/')
      .replace(/\\[Nn]/g,'\n')
      .replace(/\/[Nn](?=$|[^a-z])/g,'\n')
      .replace(/\\h/g,'\u00a0');
    text=_stripSubtitleMarkup(_decodeSubtitleEntities(text));
    return text.replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').trim();
  }

  function _invalidateSubtitleOutput(){
    _onlineActive=false;
    clearInterval(_onlineTimer); _onlineTimer=null;
    _onlineRequest++;
    _subtitleEpoch++;
    clearTimeout(_subtitleEnableId); _subtitleEnableId=null;
    _subtitleEnabled=false;
    _pendingSubIdx=null;
    _clearSubtitleOverlay();
    return _subtitleEpoch;
  }

  function _continueSnapshot(item){
    return {
      id:item.sid,
      title:item.title,
      cover:item.cover||'',
      pos:_pos,
      dur:_dur,
      type:item.type,
      ext:item.ext,
      seriesId:item.seriesId,
      seriesTitle:item.seriesTitle,
      season:item.season,
      episode:item.episode,
      episodeTitle:item.episodeTitle
    };
  }

  function _saveContinue(){
    if(_item&&_item.type!=='live'&&!_item.catchup&&_item.sid!=null&&_prepared&&!_resumePending&&!_seekPending&&_pos>0&&isFinite(_dur)&&_dur>0){
      S.cont.save(_continueSnapshot(_item));
    }
  }

  function _episodeQueueState(){
    if(!_item||_item.type!=='series'||!Array.isArray(_item.episodeQueue)) return null;
    let index=Number(_item.episodeIndex);
    if(!Number.isInteger(index)||index<0||String((_item.episodeQueue[index]||{}).sid)!==String(_item.sid)){
      index=_item.episodeQueue.findIndex(entry=>String(entry.sid)===String(_item.sid));
      _item.episodeIndex=index;
    }
    if(index<0||index+1>=_item.episodeQueue.length) return null;
    return {queue:_item.episodeQueue,index:index,next:_item.episodeQueue[index+1]};
  }

  function _syncNextButton(){
    const button=document.getElementById('pc-next');
    if(!button) return;
    const state=_episodeQueueState();
    button.style.display=state?'flex':'none';
    if(state) button.textContent='Next S'+state.next.season+'E'+state.next.episode;
  }

  function _hydrateEpisodeQueue(item,gen){
    if(!item||item.type!=='series') return;
    if(Array.isArray(item.episodeQueue)){ _syncNextButton(); return; }
    if(!item.seriesId){ _syncNextButton(); return; }
    App.getSeriesEpisodeQueue(item.seriesId,item.seriesTitle||item.title,item.cover||'').then(queue=>{
      if(gen!==_playGen||_item!==item) return;
      item.episodeQueue=queue;
      item.episodeIndex=queue.findIndex(entry=>String(entry.sid)===String(item.sid));
      const current=queue[item.episodeIndex];
      if(current){ item.season=current.season; item.episode=current.episode; item.episodeTitle=current.episodeTitle; }
      _syncNextButton();
    }).catch(()=>_syncNextButton());
  }

  function playNextEpisode(){
    const state=_episodeQueueState();
    if(!state){ App.toast('No next episode'); return; }
    const next=state.next;
    _saveContinue();
    _playGen++;
    _invalidateSubtitleOutput();
    _serverFailoverPending=false;
    _clearPoll(); clearTimeout(_hideId); clearTimeout(_retryId); clearTimeout(_osdHideId);
    if(_useAV) _avStop(); else _h5Stop();
    _playing=_prepared=false;
    _item=null; _suspended=false; _panelOpen=null;
    _scrub=null; _scrubHold=null; _seekPending=false; _seekSerial++;
    const gen=_playGen;
    App.toast('Loading S'+next.season+'E'+next.episode+'...');
    _retryId=setTimeout(()=>{ if(gen===_playGen) play({...next,episodeQueue:state.queue,episodeIndex:state.index+1}); },120);
  }

  /* ── PUBLIC: play ─────────────────────────────── */
  function play(item){
    if(_item){ _saveContinue(); _clearPoll(); if(_useAV) _avStop(); else _h5Stop(); }
    const gen=++_playGen;
    clearTimeout(_retryId);
    _serverFailoverPending=false; _failedServers=[];
    /* Remember what was focused so BACK from the player lands you on the
       exact card/channel you launched from (only on first open, not zaps). */
    if(!isActive()){
      const ae=document.activeElement;
      _returnFocus = (ae && ae !== document.body && ae.dataset && ae.dataset.f==='1') ? ae : null;
    }
    _item=item; _pos=0; _dur=0; _playing=false; _prepared=false; _panelOpen=null;
    _scrub=null; _scrubHold=null; _seekPending=false; _seekSerial++;
    const saved=S.cont.all().find(x=>x.type===item.type&&String(x.id)===String(item.sid));
    const checkpoint=Object.prototype.hasOwnProperty.call(item,'resumePos')?Number(item.resumePos):Number(saved&&saved.pos);
    const checkpointDuration=Number(saved&&saved.dur);
    _resumeTarget=!item.startOver&&item.type!=='live'&&isFinite(checkpoint)&&checkpoint>0&&
      (!checkpointDuration||checkpoint<checkpointDuration-5000)?checkpoint:0;
    _resumePending=_resumeTarget>0; _resumeAttempts=0; _resumeRetryAt=0;
    _subTracks=[]; _audioTracks=[]; _curSubIdx=-1; _curAudIdx=-1;
    _externalSubUrl = item.subUrl || null;
    _h5SubCues=[]; _h5SubTrackActive=false;
    _onlineTrack=null; _onlineDelay=0;
    _subtitleChoiceMade=false;
    _invalidateSubtitleOutput();
    _lastSave=Date.now();

    if(item.type==='live'&&!item.catchup){
      _urlQ=API.liveUrls(item.sid); _urlI=0;
    } else {
      _urlQ=[item.url]; _urlI=0;
    }

    document.body.classList.add('player-active');
    ov().style.display='block';

    const c=ctrl();
    if(c){
      const cu=c.querySelector('.ctrl-catchup'); if(cu) cu.style.display=item.catchup?'inline-flex':'none';
      c.querySelector('.ctrl-title').textContent=item.title||'';
      c.querySelector('.ctrl-meta').textContent=item.sub||'';
      _syncSeek(); _syncFav(); _syncNextButton();
      const sb=document.getElementById('pc-subs'); if(sb) sb.textContent='CC Off';
    }
    if(item.type==='live') _showOsd(); else _hideOsd();
    showCtrl();
    _hydrateEpisodeQueue(item,gen);
    /* Move focus into the player immediately so the first keypress acts on
       the controls instead of the page hidden behind the overlay. */
    setTimeout(()=>{
      const pp=document.getElementById('pc-pp');
      if(gen===_playGen && pp && isActive()) Focus.select(pp);
    }, 60);

    _useAV=_hasAV();
    if(_useAV) _avOpen(_urlQ[_urlI],gen);
    else       _h5Open(_urlQ[_urlI],gen);
  }

  /* ── AVPlay backend ───────────────────────────── */
  function _avOpen(url,gen){
    if(gen!==_playGen || !_item) return;
    let attemptClosed=false, prepareSettled=false;
    const attemptActive=()=>gen===_playGen && !attemptClosed && !!_item;
    const el=av(), view=surface();
    if(!el||!view) return;
    console.log('[AV] opening stream');
    try{
      const W=1920, H=1080;

      view.style.position='fixed'; view.style.top='0'; view.style.left='0';
      view.style.width=W+'px'; view.style.height=H+'px';
      view.style.zIndex='8999'; view.style.display='block';

      el.open(url);
      el.setDisplayRect(0, 0, W, H);
      el.setDisplayMethod('PLAYER_DISPLAY_MODE_FULL_SCREEN');

      el.setListener({
        onbufferingstart:   ()=>App.toast('Buffering…'),
        onbufferingcomplete:()=>App.toast(''),
        oncurrentplaytime:  t=>{ if(attemptActive()) _pos=t; },
        onStreamCompleted:  ()=>{ if(attemptActive()) _doStop(); },
        onstreamcompleted:  ()=>{ if(attemptActive()) _doStop(); },
        ontrackchange:      ()=>{ if(attemptActive()) _refreshTracks(); },
        onsubtitlechange:   (d,t,c,a)=>{
          if(!attemptActive() || !_subtitleEnabled || _onlineActive) return;
          const elSub=document.getElementById('sub-overlay');
          const text=_decodeSubtitleText(t);
          if(elSub){ elSub.textContent=text; elSub.style.display=text?'block':'none'; }
        },
        onerror: code=>{
          if(!attemptActive() || _serverFailoverPending) return;
          attemptClosed=true;
          console.warn('[AV] error',code);
          _urlI++;
          if(_item && _item.type==='live'&&!_item.catchup&&_urlI<_urlQ.length){
            App.toast('Trying format '+(_urlI+1)+'/'+_urlQ.length+'…');
            try{el.stop();}catch(_){} try{el.close();}catch(_){}
            clearTimeout(_retryId);
            _retryId=setTimeout(()=>{ if(gen===_playGen) _avOpen(_urlQ[_urlI],gen); },400);
            return;
          }
          _recoverServer('Stream error ('+_humanAvErr(code)+')',gen);
        },
      });

      // External subtitle for VOD — call BEFORE prepare()
      if(_externalSubUrl){
        try{ el.setExternalSubtitlePath(_externalSubUrl); }catch(e){ console.warn('[AV ext sub]',e.message); }
      }

      const onPrepared=()=>{
      if(!attemptActive() || prepareSettled) return;
      prepareSettled=true;
      _prepared=true;
      _playing=true; _updatePlayBtn();
      el.play();
      App.confirmPlaybackServer(App.server);

      // Duration + track info need a beat after prepare
      setTimeout(()=>{
        if(!attemptActive() || !_prepared) return;
        try{ _dur=el.getDuration()||0; }catch(_){}
        _refreshTracks();
        if(_externalSubUrl && _curSubIdx===-1 && !_subtitleChoiceMade) _avSetSub('external',false);
        _syncSubButton();
        _tryResume();
        _syncSeek();
      },300);

      // Retry track enumeration — many streams expose subtitle/audio tracks late
      [1500, 3500, 6000].forEach(delay=>{
        setTimeout(()=>{
          if(!attemptActive() || !_prepared) return; // stream already stopped
          if(_subTracks.length && _audioTracks.length) return; // already found
          _refreshTracks();
          _syncSubButton();
        }, delay);
      });

      _startPoll(()=>{
        if(!attemptActive()||_seekPending) return;
        try{_pos=el.getCurrentTime()||_pos;}catch(_){}
        if(!_dur){ try{_dur=el.getDuration()||0;}catch(_){} }
      });
      };
      const onPrepareError=code=>{
        if(!attemptActive() || prepareSettled || _serverFailoverPending) return;
        prepareSettled=true; attemptClosed=true;
        console.warn('[AV prepare]',code);
        _urlI++;
        if(_item && _item.type==='live'&&!_item.catchup&&_urlI<_urlQ.length){
          try{el.stop();}catch(_){} try{el.close();}catch(_){}
          clearTimeout(_retryId);
          _retryId=setTimeout(()=>{ if(gen===_playGen) _avOpen(_urlQ[_urlI],gen); },400);
          return;
        }
        _recoverServer('Failed to prepare stream',gen);
      };
      if(typeof el.prepareAsync==='function') el.prepareAsync(onPrepared,onPrepareError);
      else { el.prepare(); onPrepared(); }
    }catch(e){
      if(!attemptActive()) return;
      attemptClosed=true;
      console.error('[AV]',e.message);
      _urlI++;
      if(_item && _item.type==='live'&&!_item.catchup&&_urlI<_urlQ.length){
        try{el.close();}catch(_){}
        clearTimeout(_retryId);
        _retryId=setTimeout(()=>{ if(gen===_playGen) _avOpen(_urlQ[_urlI],gen); },400);
      } else {
        _recoverServer('Failed to open stream',gen);
      }
    }
  }
  function _humanAvErr(code){
    const m={
      PLAYER_ERROR_INVALID_PARAMETER:'Bad parameter',
      PLAYER_ERROR_CONNECTION_FAILED:'Connection failed',
      PLAYER_ERROR_NOT_SUPPORTED_FILE:'Unsupported format',
      PLAYER_ERROR_INVALID_URI:'Invalid URL',
      PLAYER_ERROR_DRM_EXPIRED:'DRM expired',
      PLAYER_ERROR_NOT_PERMITTED:'Blocked',
    };
    return m[code]||code||'unknown';
  }
  function _recoverServer(reason,gen){
    if(gen!==_playGen || _serverFailoverPending) return;
    const retryable=_item && !_item.catchup &&
      (_item.type==='live' || _item.type==='movie' || _item.type==='series');
    if(!retryable){ App.toast(reason||'Stream error'); _doStop(); return; }
    _serverFailoverPending=true;
    const failed=API.norm(App.server||API.base());
    if(failed && _failedServers.indexOf(failed)===-1) _failedServers.push(failed);
    const itemAtFailure=_item;
    if(_pos>0&&!_resumePending){ _resumeTarget=_pos; _resumePending=true; }
    _resumeAttempts=0; _resumeRetryAt=0; _seekPending=false; _seekSerial++;
    _scrub=null; _scrubHold=null;
    _clearPoll(); clearTimeout(_retryId);
    if(_useAV) _avStop(); else _h5Stop();
    _prepared=_playing=false; _updatePlayBtn();
    App.toast('Stream unavailable - trying another server...');
    App.failoverPlaybackServer(_failedServers.slice()).then(result=>{
      if(gen!==_playGen || _item!==itemAtFailure) return;
      App.activatePlaybackServer(result);
      _serverFailoverPending=false;
      if(_item.type==='live') _urlQ=API.liveUrls(_item.sid);
      else if(_item.type==='series') _urlQ=[API.serUrl(_item.sid,_item.ext)];
      else _urlQ=[API.vodUrl(_item.sid,_item.ext)];
      _urlI=0; _useAV=_hasAV();
      if(_useAV) _avOpen(_urlQ[0],gen); else _h5Open(_urlQ[0],gen);
    }).catch(()=>{
      if(gen!==_playGen) return;
      _serverFailoverPending=false;
      App.toast('No server could play this stream');
      _doStop();
    });
  }

  function _avStop(){
    const el=av(),view=surface();
    if(el){ try{el.setListener({});}catch(_){} try{el.stop();}catch(_){} try{el.close();}catch(_){} }
    if(view){ view.style.zIndex='-1'; view.style.display='none'; }
  }
  function _avPause(){ if(!_prepared||_seekPending)return; try{_playing?av().pause():av().play();}catch(_){} }
  function _avAspect(m){ try{av().setDisplayMethod(m);}catch(e){console.warn('[AV aspect]',e.message);} }

  /* Track info — uses modern Tizen API (getTotalTrackInfo), falls back to legacy */
  function _addExternalSubTrack(){
    if(_onlineTrack&&!_subTracks.some(t=>t.online)) _subTracks.unshift({index:'online',label:_onlineTrack.language+' (online)',online:true});
    if(_externalSubUrl && !_subTracks.some(t=>t.external)){
      _subTracks.unshift({index:'external',label:'External subtitles',lang:'',external:true});
    }
  }

  function _refreshTracks(){
    if(_seekPending) return;
    const prevSubIdx=_curSubIdx, prevAudIdx=_curAudIdx;
    _subTracks=[]; _audioTracks=[]; _curSubIdx=-1; _curAudIdx=-1;
    try{
      const el=av();
      if(typeof el.getTotalTrackInfo==='function'){
        const tracks=el.getTotalTrackInfo()||[];
        tracks.forEach(t=>{
          const info = (()=>{ try{return t.extra_info?JSON.parse(t.extra_info):{};}catch(_){return{};} })();
          const lang = info.language || info.lang || info.track_lang || info.sub_lang || '';
          const label = lang || ('Track '+t.index);
          if(t.type==='TEXT')  _subTracks.push({index:t.index,label:label,lang:lang});
          if(t.type==='AUDIO') _audioTracks.push({index:t.index,label:label,lang:lang});
        });
        // current selection
        try{
          const sel = (typeof el.getCurrentStreamInfo==='function' ? el.getCurrentStreamInfo() : []) || [];
          sel.forEach(s=>{
            if(s.type==='TEXT')  _curSubIdx = s.index;
            if(s.type==='AUDIO') _curAudIdx = s.index;
          });
        }catch(_){}
      }
    }catch(e){ console.warn('[AV tracks]',e.message); }
    // Legacy fallback for subtitles
    if(!_subTracks.length){
      try{
        const avEl=av();
        const langs = (avEl && typeof avEl.getSubtitleLanguageList==='function' ? avEl.getSubtitleLanguageList() : []) || [];
        langs.forEach((l,i)=> _subTracks.push({index:i, label:l, lang:l, legacy:true}));
      }catch(_){}
    }
    _addExternalSubTrack();
    if(_onlineActive) _curSubIdx='online';
    else if(_pendingSubIdx!==null) _curSubIdx=_pendingSubIdx;
    else if(_subtitleChoiceMade && !_subtitleEnabled) _curSubIdx=-1;
    else if(_curSubIdx===-1 && _subTracks.some(t=>t.index===prevSubIdx)) _curSubIdx=prevSubIdx;
    if(!_subtitleChoiceMade && _curSubIdx!==-1) _subtitleEnabled=true;
    if(_curAudIdx===-1 && _audioTracks.some(t=>t.index===prevAudIdx)) _curAudIdx=prevAudIdx;
  }
  function _avSetSub(idx,userChoice=true){
    if(idx==='online'){_enableOnline();return;}
    if(userChoice) _subtitleChoiceMade=true;
    const epoch=_invalidateSubtitleOutput();
    try{
      const el=av();
      const t=_subTracks.find(x=>x.index===idx);
      if(!t){
        // Off
        if(typeof el.setSilentSubtitle==='function'){ el.setSilentSubtitle(true); }
        _curSubIdx=-1; return;
      }
      _pendingSubIdx=idx;
      /* Mute before selecting so a queued cue from the previous track cannot
         flash after the user changes tracks. The epoch also cancels an older
         delayed unmute when users switch quickly. */
      if(typeof el.setSilentSubtitle==='function'){ el.setSilentSubtitle(true); }
      if(t.external){
        if(_externalSubUrl && typeof el.setExternalSubtitlePath==='function'){
          try{ el.setExternalSubtitlePath(_externalSubUrl); }catch(_){}
        }
      }else if(t.legacy){
        el.setSubtitleLanguage(t.lang);
      }else{
        el.setSelectTrack('TEXT', idx);
      }
      _curSubIdx=idx;
      _subtitleEnableId=setTimeout(()=>{
        if(epoch!==_subtitleEpoch || !_item || !_useAV) return;
        try{ if(typeof el.setSilentSubtitle==='function') el.setSilentSubtitle(false); }catch(_){}
        _subtitleEnabled=true;
        _pendingSubIdx=null;
      },80);
    }catch(e){
      _curSubIdx=-1;
      _invalidateSubtitleOutput();
      console.warn('[AV sub]',e.message); App.toast('Could not change subtitle');
    }
  }
  function _avSetAudio(idx){
    try{
      av().setSelectTrack('AUDIO', idx);
      _curAudIdx=idx;
    }catch(e){ console.warn('[AV aud]',e.message); App.toast('Could not change audio track'); }
  }

  /* ── HTML5 fallback ───────────────────────────── */
  function _h5Open(url,gen){
    if(gen!==_playGen || !_item) return;
    let attemptClosed=false;
    const attemptActive=()=>gen===_playGen && !attemptClosed && !!_item;
    console.log('[H5] opening stream');
    const view=surface(); if(view) view.style.zIndex='-1';
    let v=document.getElementById('h5vid');
    if(!v){
      v=document.createElement('video');
      v.id='h5vid';
      v.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;background:#000;';
      v.setAttribute('playsinline','');
      const c=ctrl(); if(c) ov().insertBefore(v,c); else ov().appendChild(v);
    }
    // Clear out old subtitle state
    [...v.querySelectorAll('track')].forEach(t=>t.remove());
    _h5SubCues=[]; _h5SubTrackActive=false;
    v.style.display='block'; v.src=url; v.currentTime=0;

    if(_externalSubUrl){
      _loadExternalSubCues(_externalSubUrl,gen);
    }

    v.onloadedmetadata=()=>{
      if(!attemptActive() || v!==document.getElementById('h5vid')) return;
      _dur=isFinite(v.duration)?Math.round(v.duration*1000):0; _prepared=true;
      v.play().catch(()=>{}); _tryResume();
      // Populate sub tracks from HTML5 textTracks
      _subTracks=[];
      for(let i=0;i<v.textTracks.length;i++){
        const t=v.textTracks[i];
        _subTracks.push({index:i,label:t.label||t.language||('Track '+(i+1)),lang:t.language||'',html5:true});
      }
      _addExternalSubTrack();
      if(_externalSubUrl && _curSubIdx===-1 && !_subtitleChoiceMade) _h5SetSub('external',false);
      _syncSubButton();
      // Audio tracks (rarely exposed in HTML5)
      _audioTracks=[];
      if(v.audioTracks){
        for(let i=0;i<v.audioTracks.length;i++){
          const t=v.audioTracks[i];
          _audioTracks.push({index:i,label:t.label||t.language||('Audio '+(i+1)),lang:t.language||''});
        }
      }
    };
    v.ontimeupdate=()=>{ if(attemptActive()){ _pos=Math.round(v.currentTime*1000); _renderH5Sub(); } };
    v.onplaying=()=>{ if(attemptActive()){ _playing=true; _updatePlayBtn(); App.confirmPlaybackServer(App.server); App.toast(''); } };
    v.onwaiting=()=>App.toast('Buffering…');
    v.onended=()=>{ if(attemptActive()) _doStop(); };
    v.onerror=()=>{
      if(!attemptActive() || _serverFailoverPending) return;
      attemptClosed=true;
      _urlI++;
      if(_item&&_item.type==='live'&&!_item.catchup&&_urlI<_urlQ.length){
        App.toast('Trying format '+(_urlI+1)+'/'+_urlQ.length+'...');
        try{v.pause();v.removeAttribute('src');v.load();}catch(_){}
        clearTimeout(_retryId);
        _retryId=setTimeout(()=>{ if(gen===_playGen) _h5Open(_urlQ[_urlI],gen); },300);
        return;
      }
      _recoverServer('Stream error',gen);
    };
    _playing=false; _prepared=false;
    _startPoll(()=>{ if(attemptActive()&&!_seekPending){ _pos=Math.round(v.currentTime*1000); if(!_dur&&isFinite(v.duration))_dur=Math.round(v.duration*1000); } });
  }
  function _h5Stop(){
    const v=document.getElementById('h5vid');
    if(v){
      v.onloadedmetadata=v.ontimeupdate=v.onplaying=v.onwaiting=v.onended=v.onerror=null;
      try{v.pause();v.removeAttribute('src');v.load();}catch(_){}
      v.remove();
    }
  }
  function _h5Pause(){ const v=document.getElementById('h5vid');if(v){_playing?v.pause():v.play().catch(()=>{});} }
  function _h5SetSub(idx,userChoice=true){
    if(idx==='online'){_enableOnline();return;}
    const v=document.getElementById('h5vid'); if(!v) return;
    if(userChoice) _subtitleChoiceMade=true;
    _invalidateSubtitleOutput();
    _h5SubTrackActive = idx === 'external';
    for(let i=0;i<v.textTracks.length;i++){ v.textTracks[i].mode = (i===idx ? 'showing' : 'disabled'); }
    _curSubIdx=idx;
    _subtitleEnabled=idx!==-1;
    if(_h5SubTrackActive){
      _renderH5Sub();
    }
  }

  function _loadExternalSubCues(url,gen){
    const xhr=new XMLHttpRequest();
    xhr.open('GET',url,true); xhr.timeout=12000;
    xhr.onload=()=>{
      if(gen!==_playGen || xhr.status>=300) return;
      _h5SubCues = _parseSubtitles(xhr.responseText||'');
      _addExternalSubTrack();
      _syncSubButton();
    };
    xhr.onerror=()=>{};
    xhr.ontimeout=()=>{};
    try{xhr.send();}catch(_){}
  }

  function _parseSubtitles(text){
    const src=String(text||'').replace(/\r/g,'').trim();
    if(!src) return [];
    const blocks=src.replace(/^WEBVTT[^\n]*\n+/i,'').split(/\n{2,}/);
    const cues=[];
    blocks.forEach(block=>{
      const lines=block.split('\n').filter(Boolean);
      const ti=lines.findIndex(l=>/-->/.test(l));
      if(ti<0) return;
      const parts=lines[ti].split('-->');
      const start=_parseCueTime(parts[0]);
      const end=_parseCueTime((parts[1]||'').trim().split(/\s+/)[0]);
      if(!isFinite(start)||!isFinite(end)||end<=start) return;
      cues.push({start,end,text:_decodeSubtitleText(lines.slice(ti+1).join('\n'))});
    });
    return cues.sort((a,b)=>a.start-b.start);
  }

  function _parseCueTime(t){
    const s=String(t||'').trim().replace(',', '.');
    const p=s.split(':').map(Number);
    if(p.some(n=>isNaN(n))) return NaN;
    if(p.length===3) return ((p[0]*3600)+(p[1]*60)+p[2])*1000;
    if(p.length===2) return ((p[0]*60)+p[1])*1000;
    return p[0]*1000;
  }

  function _renderH5Sub(){
    if(!_subtitleEnabled || !_h5SubTrackActive) return;
    const so=document.getElementById('sub-overlay'); if(!so) return;
    const cue=_h5SubCues.find(c=>c.start<=_pos && _pos<c.end);
    so.textContent=cue?cue.text:'';
    so.style.display=cue&&cue.text?'block':'none';
  }

  /* ── Shared helpers ───────────────────────────── */
  function _canSeek(){
    return !!_item&&(_item.type!=='live'||_item.catchup)&&_prepared&&isFinite(_dur)&&_dur>1000;
  }
  function _seekLimit(ms){ return Math.max(0,Math.min(_dur-1000,Number(ms)||0)); }
  function _seekTo(ms,done){
    if(!_canSeek()||_seekPending) return false;
    const target=_seekLimit(ms),gen=_playGen,serial=++_seekSerial;
    _seekPending=true;
    _clearSubtitleOverlay();
    const finish=ok=>{
      if(gen!==_playGen||serial!==_seekSerial) return;
      _seekPending=false;
      if(ok){ _pos=target; _renderH5Sub(); }
      if(done) done(ok);
      _syncSeek();
    };
    try{
      if(_useAV){
        // AVPlay forbids overlapping API operations until this callback.
        av().seekTo(Math.max(100,target),()=>finish(true),()=>finish(false));
      }else{
        const v=document.getElementById('h5vid');
        if(!v){ finish(false); return false; }
        v.currentTime=target/1000;
        finish(true);
      }
    }catch(e){ console.warn('[Seek]',e.message); finish(false); }
    return true;
  }
  function _tryResume(){
    if(!_resumePending||!_canSeek()||_seekPending||_resumeAttempts>=3||Date.now()<_resumeRetryAt) return;
    _resumeAttempts++;
    _seekTo(_resumeTarget,ok=>{
      if(ok){ _resumePending=false; _lastSave=Date.now(); App.toast('Resumed from '+EPG.fmtMs(_pos)); }
      else{
        _resumeRetryAt=Date.now()+1500;
        if(_resumeAttempts>=3) App.toast('Resume unavailable. Your saved position is kept.');
      }
    });
  }
  function _startPoll(read){
    _clearPoll();
    _pollId=setInterval(()=>{
      read(); _tryResume(); _syncSeek();
      if(_item&&_item.type!=='live'&&!_item.catchup&&_item.sid){
        const now=Date.now();
        if(now-_lastSave > SAVE_EVERY){
          _lastSave=now;
          _saveContinue();
        }
      }
    },1000);
  }

  /* ── Public controls ──────────────────────────── */
  function _doStop(){
    _scrub=null; _scrubHold=null;
    // A seek still in flight must not overwrite the previous checkpoint.
    _saveContinue();
    _playGen++;
    _seekPending=false; _seekSerial++;
    _invalidateSubtitleOutput();
    _serverFailoverPending=false;
    _clearPoll(); clearTimeout(_hideId); clearTimeout(_retryId); clearTimeout(_osdHideId);
    _hideOsd();
    _playing=_prepared=false;
    if(_useAV)_avStop(); else _h5Stop();
    _item=null; _suspended=false;
    _clearSubtitleOverlay();
    ov().style.display='none';
    document.body.classList.remove('player-active');
    document.dispatchEvent(new CustomEvent('playback-stopped'));
    /* Hand focus back to the element that launched playback */
    const rf=_returnFocus; _returnFocus=null;
    setTimeout(()=>{
      if(rf && document.contains(rf)) Focus.select(rf);
      else Focus.restore && Focus.restore();
    }, 50);
  }
  function stop(){ _doStop(); }

  /* ── Multitasking (Samsung cert): release AV on hide ── */
  function suspend(){
    if(!_item || _suspended) return;
    _cancelScrub();
    _saveContinue();
    _suspended=true;
    try{
      if(_useAV && _prepared && typeof av().suspend==='function'){ av().suspend(); return; }
    }catch(_){}
    /* Fallback: fully stop — safest way to release the decoder */
    _doStop();
  }
  function resume(){
    if(!_suspended) return;
    _suspended=false;
    try{
      if(_useAV && _prepared && typeof av().restore==='function'){ av().restore(); return; }
    }catch(_){}
  }

  function togglePause(){
    if(!_item||!_prepared||_seekPending) return;
    if(_scrub){ _commitScrub(); return; }
    if(_useAV)_avPause(); else _h5Pause();
    _playing=!_playing; _updatePlayBtn(); showCtrl();
  }
  function seek(ms){
    if(!_canSeek()) return;
    _seekTo(_pos+ms,ok=>{
      if(ok){ _resumePending=false; _saveContinue(); }
      else App.toast('This stream could not seek to that position');
    });
    showCtrl();
  }
  function _setPlaying(playing){
    if(!_prepared||_seekPending) return;
    try{
      if(_useAV){ playing?av().play():av().pause(); }
      else{
        const v=document.getElementById('h5vid');
        if(v){ if(playing) v.play().catch(()=>{}); else v.pause(); }
      }
      _playing=playing; _updatePlayBtn();
    }catch(_){}
  }
  function _focusTimeline(){
    if(!_canSeek()) return false;
    showCtrl(); Focus.clearCache(); Focus.select(document.getElementById('pc-seek'));
    return true;
  }
  function _beginScrub(){
    if(!_canSeek()||_seekPending) return false;
    if(!_scrub){
      _scrub={pos:_seekLimit(_resumePending?_resumeTarget:_pos),wasPlaying:_playing};
      if(_playing) _setPlaying(false);
    }
    _focusTimeline(); _syncSeek();
    return true;
  }
  function _moveScrub(direction){
    if(!_beginScrub()) return;
    const now=Date.now();
    if(!_scrubHold||_scrubHold.direction!==direction||now-_scrubHold.last>550){
      _scrubHold={direction:direction,start:now,last:now};
    }
    const held=now-_scrubHold.start;
    // Single presses are precise; holding crosses a long film quickly.
    const step=held>=3000?120000:held>=1800?60000:held>=800?30000:10000;
    _scrubHold.last=now;
    _scrub.pos=_seekLimit(_scrub.pos+direction*step);
    _syncSeek(); showCtrl();
  }
  function _cancelScrub(){
    if(!_scrub) return false;
    const playing=_scrub.wasPlaying;
    _scrub=null; _scrubHold=null;
    _setPlaying(playing); _syncSeek(); showCtrl();
    return true;
  }
  function _commitScrub(){
    if(!_scrub||_seekPending) return;
    const state=_scrub;
    _scrub=null; _scrubHold=null;
    _seekTo(state.pos,ok=>{
      if(ok){ _resumePending=false; _resumeTarget=0; _saveContinue(); }
      else App.toast('This stream could not seek to that position');
      _setPlaying(state.wasPlaying); showCtrl();
    });
    _syncSeek(); showCtrl();
  }
  function switchChannel(delta){
    if(!_item||_item.type!=='live'||_item.catchup) return;
    const streams=App.cache.live||[];
    if(!streams.length) return;
    const i = streams.findIndex(c=>c.stream_id===_item.sid);
    if(i<0) return;
    const ni = (i + delta + streams.length) % streams.length;
    const next = streams[ni];
    _doStop();
    setTimeout(()=>{
      Player.play({url:null,title:next.name,sub:'Live',sid:next.stream_id,type:'live',cover:next.stream_icon||''});
    }, 150);
  }

  /* ── UI sync ──────────────────────────────────── */
  function _updatePlayBtn(){ const b=document.getElementById('pc-pp');if(b)b.textContent=_playing?'⏸ Pause':'▶ Play'; }
  function _syncSeek(){
    const bar=document.getElementById('pc-seek'),fill=document.querySelector('.seek-fill'),time=document.getElementById('pc-time');
    if(!fill||!time) return;
    const live=!_item||(_item.type==='live'&&!_item.catchup),enabled=_canSeek();
    const displayPos=_scrub?_scrub.pos:_pos;
    const p=!live&&_dur>0?Math.min(100,Math.max(0,(displayPos/_dur)*100)).toFixed(2):0;
    fill.style.width=(live?100:p)+'%';
    time.textContent=live?'LIVE':EPG.fmtMs(displayPos)+' / '+EPG.fmtMs(_dur);
    if(bar){
      bar.dataset.f=enabled?'1':'0';
      bar.classList.toggle('scrubbing',!!_scrub);
      bar.classList.toggle('disabled',!enabled);
      bar.setAttribute('aria-disabled',String(!enabled));
      bar.setAttribute('aria-valuemax',String(Math.max(0,Math.round(_dur/1000))));
      bar.setAttribute('aria-valuenow',String(Math.round(displayPos/1000)));
      bar.setAttribute('aria-valuetext',time.textContent);
      const preview=bar.querySelector('.seek-preview');
      if(preview){ preview.style.left=p+'%'; preview.textContent=EPG.fmtMs(displayPos); }
    }
    const hint=document.getElementById('pc-seek-hint');
    if(hint) hint.textContent=live?'Live broadcast':_seekPending?'Seeking...':_scrub?'Left / right to move · hold to move faster · OK to play here · Back to cancel':enabled?'Up to timeline · left / right to choose a position':'Loading timeline...';
  }
  function _syncFav(){
    const b=document.getElementById('pc-fav');if(!b||!_item)return;
    const f=S.fav.is(_item.type,_item.sid);
    b.textContent=f?'★ Favorited':'☆ Favorite'; b.classList.toggle('active',f);
  }
  function _syncSubButton(){
    const b=document.getElementById('pc-subs'); if(!b) return;
    if(_curSubIdx===-1) b.textContent='CC Off';
    else{
      const t=_subTracks.find(x=>x.index===_curSubIdx);
      b.textContent='CC '+((t&&t.label)||'On');
    }
  }

  /* ── Aspect / Subs / Audio panels ─────────────── */
  const ASPECTS=[
    {l:'Fit',       m:'PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO', h5:'contain'},
    {l:'Letterbox', m:'PLAYER_DISPLAY_MODE_LETTER_BOX',        h5:'contain'},
    {l:'Stretch',   m:'PLAYER_DISPLAY_MODE_FULL_SCREEN',       h5:'fill'},
  ];
  let _aspectI=0;

  function _openPanel(which){
    if(_seekPending) return;
    _cancelScrub();
    const origin=Focus.get();
    _closePanel(false); _panelOpen=which;
    _panelReturn=origin;
    const ap=document.getElementById('pc-aspect-panel');
    const sp=document.getElementById('pc-subs-panel');
    const aup=document.getElementById('pc-aud-panel');

    if(which==='aspect'){
      if(!ap) return;
      ap.innerHTML='';
      ASPECTS.forEach((a,i)=>{
        const b=_mkBtn(a.l+(i===_aspectI?' ✓':''),()=>{
          _aspectI=i;
          if(_useAV)_avAspect(a.m);
          else{ const v=document.getElementById('h5vid');if(v)v.style.objectFit=a.h5; }
          document.getElementById('pc-aspect').textContent='⛶ '+a.l;
          _closePanel();
        });
        if(i===_aspectI) b.classList.add('active');
        ap.appendChild(b);
      });
      ap.style.display='flex';
      Focus.clearCache();
      Focus.select(ap.querySelector('[data-f]'));
    } else if(which==='subs'){
      if(!sp) return;
      if(_useAV) _refreshTracks();
      sp.classList.remove('online-results');
      sp.innerHTML='';
      // "Off" option
      const offBtn=_mkBtn('Off'+(_curSubIdx===-1?' ✓':''),()=>{
        if(_useAV)_avSetSub(-999); else _h5SetSub(-1);
        _curSubIdx=-1;
        _syncSubButton();
        _closePanel();
      });
      if(_curSubIdx===-1) offBtn.classList.add('active');
      sp.appendChild(offBtn);

      if(!_subTracks.length){
        const n=document.createElement('span');
        n.style.cssText='color:var(--text-md);font-size:13px;padding:10px 12px;align-self:center';
        n.textContent='No subtitle tracks';
        sp.appendChild(n);
      }else{
        _subTracks.forEach(t=>{
          const b=_mkBtn(t.label+(t.index===_curSubIdx?' ✓':''),()=>{
            if(_useAV) _avSetSub(t.index); else _h5SetSub(t.index);
            _syncSubButton();
            _closePanel();
          });
          if(t.index===_curSubIdx) b.classList.add('active');
          sp.appendChild(b);
        });
      }
      sp.style.display='flex';
      if(_item&&(_item.type==='movie'||_item.type==='series')){
        sp.appendChild(_mkBtn('Find online',_findOnline));
      }
      if(_onlineActive){
        sp.appendChild(_mkBtn('Earlier −0.5s',()=>{_onlineDelay=Math.max(-60000,_onlineDelay-500);App.toast('Subtitle delay: '+(_onlineDelay/1000).toFixed(1)+'s');_renderOnline();}));
        sp.appendChild(_mkBtn('Later +0.5s',()=>{_onlineDelay=Math.min(60000,_onlineDelay+500);App.toast('Subtitle delay: '+(_onlineDelay/1000).toFixed(1)+'s');_renderOnline();}));
      }
      Focus.clearCache();
      Focus.select(sp.querySelector('[data-f]'));
    } else if(which==='aud'){
      if(!aup) return;
      _refreshTracks();
      aup.innerHTML='';
      if(!_audioTracks.length){
        const n=document.createElement('span');
        n.style.cssText='color:var(--text-md);font-size:13px;padding:10px 12px;align-self:center';
        n.textContent='No audio tracks';
        aup.appendChild(n);
      }else{
        _audioTracks.forEach(t=>{
          const b=_mkBtn(t.label+(t.index===_curAudIdx?' ✓':''),()=>{
            if(_useAV) _avSetAudio(t.index);
            document.getElementById('pc-aud').textContent='🔊 '+(t.label||'Audio');
            _closePanel();
          });
          if(t.index===_curAudIdx) b.classList.add('active');
          aup.appendChild(b);
        });
      }
      aup.style.display='flex';
      Focus.clearCache();
      Focus.select(aup.querySelector('[data-f]'));
    }
    showCtrl();
  }
  function _closePanel(refocus=true){
    _onlineRequest++;
    _panelOpen=null;
    ['pc-aspect-panel','pc-subs-panel','pc-aud-panel'].forEach(id=>{
      const e=document.getElementById(id); if(e) e.style.display='none';
    });
    Focus.clearCache();
    if(refocus&&_panelReturn&&document.documentElement.contains(_panelReturn)){
      Focus.select(_panelReturn);
    }
    if(refocus) _panelReturn=null;
  }
  function _mkBtn(label,onClick){
    const b=document.createElement('div');
    b.className='ctrl-btn f'; b.dataset.f='1'; b.dataset.zone='player-panel'; b.dataset.axis='h';
    b.textContent=label; b.addEventListener('click',onClick); return b;
  }

  function _renderOnline(){
    if(!_onlineActive||!_subtitleEnabled||!_onlineTrack||_seekPending) return;
    let position=_pos;
    try{if(_useAV) position=av().getCurrentTime();else{const v=document.getElementById('h5vid');if(v)position=v.currentTime*1000;}}catch(_){}
    const at=position-_onlineDelay;
    const cue=_onlineTrack.cues.find(c=>c.start<=at&&at<c.end);
    const el=document.getElementById('sub-overlay');
    if(el){el.textContent=cue?cue.text:'';el.style.display=cue&&cue.text?'block':'none';}
  }
  function _enableOnline(){
    if(!_onlineTrack) return;
    _invalidateSubtitleOutput();
    _subtitleChoiceMade=true;
    _h5SubTrackActive=false;
    try{if(_useAV) av().setSilentSubtitle(true);else{const v=document.getElementById('h5vid');if(v)for(let i=0;i<v.textTracks.length;i++)v.textTracks[i].mode='disabled';}}catch(_){}
    _onlineActive=_subtitleEnabled=true;_curSubIdx='online';
    _addExternalSubTrack();_syncSubButton();_renderOnline();
    _onlineTimer=setInterval(_renderOnline,150);
  }
  function _findOnline(){
    if(!OnlineSubtitles.ready()){App.toast('Add your OpenSubtitles API key in Settings',5000);return;}
    const sp=document.getElementById('pc-subs-panel');
    const gen=_playGen,request=++_onlineRequest;
    const valid=()=>gen===_playGen&&request===_onlineRequest&&_panelOpen==='subs';
    sp.innerHTML='';sp.classList.add('online-results');
    sp.appendChild(_mkBtn('Back to subtitles',()=>_openPanel('subs')));
    const status=document.createElement('div');status.className='online-sub-status';status.textContent='Searching OpenSubtitles…';sp.appendChild(status);
    Focus.clearCache();Focus.select(sp.querySelector('[data-f]'));
    OnlineSubtitles.search(_item).then(results=>{
      if(!valid()) return;
      status.textContent=results.length?'Choose a release. Timing can be adjusted after loading.':'No matching subtitles in your selected language.';
      results.forEach(result=>{
        const button=_mkBtn(result.language+' · '+result.label,()=>{
          if(!valid()) return;
          const ticket=++_onlineRequest,epoch=_subtitleEpoch;
          status.textContent='Downloading subtitles…';
          OnlineSubtitles.download(result.fileId).then(text=>{
            if(gen!==_playGen||ticket!==_onlineRequest||epoch!==_subtitleEpoch||_panelOpen!=='subs') return;
            const cues=_parseSubtitles(text);
            if(!cues.length) throw new Error('This file has no readable subtitle cues');
            _onlineTrack={cues:cues,language:result.language};_onlineDelay=0;
            _enableOnline();_closePanel();App.toast('Online subtitles enabled');
          }).catch(error=>{
            if(gen!==_playGen||ticket!==_onlineRequest||_panelOpen!=='subs') return;
            _openPanel('subs');App.toast(error.message,5000);
          });
        });
        button.dataset.axis='both';button.classList.add('online-sub-result');sp.appendChild(button);
      });
      Focus.clearCache();
      const first=sp.querySelector('.online-sub-result');if(first)Focus.select(first);
    }).catch(error=>{if(valid())status.textContent=error.message;});
    showCtrl();
  }

  /* ── Controls HTML ─────────────────────────────── */
  function _buildCtrl(){
    return `
      <div class="ctrl-catchup">⏪ CATCH-UP</div>
      <div class="ctrl-title"></div>
      <div class="ctrl-meta"></div>
      <div class="timeline-row">
        <div class="seek-bar f" id="pc-seek" data-f="1" data-zone="controls" role="slider" tabindex="-1" aria-label="Playback position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
          <div class="seek-fill" style="width:0%"><div class="seek-knob"></div></div>
          <span class="seek-preview">0:00</span>
        </div>
        <span id="pc-time" class="ctrl-time">--:-- / --:--</span>
      </div>
      <div id="pc-seek-hint" class="ctrl-hint">Up to timeline · left / right to choose a position</div>
      <div class="ctrl-row">
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-back">← Back</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-pp">⏸ Pause</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-next" style="display:none">Next Episode</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-fav">☆ Favorite</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-aspect">⛶ Fit</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-subs">CC Off</div>
        <div class="ctrl-btn f" data-f="1" data-zone="controls" data-axis="h" id="pc-aud">🔊 Audio</div>
      </div>
      <div id="pc-aspect-panel" class="panel-row" style="display:none"></div>
      <div id="pc-subs-panel"   class="panel-row" style="display:none"></div>
      <div id="pc-aud-panel"    class="panel-row" style="display:none"></div>`;
  }

  function init(){
    const c=ctrl(); if(!c) return;
    c.innerHTML=_buildCtrl();
    c.addEventListener('click',e=>e.stopPropagation());
    // Channel OSD banner (live only)
    if(!document.getElementById('player-osd')){
      const o=document.createElement('div');
      o.id='player-osd';
      o.className='player-osd hidden';
      ov().appendChild(o);
    }
    // Subtitle overlay — shown when AVPlay emits onsubtitlechange
    if(!document.getElementById('sub-overlay')){
      const so=document.createElement('div');
      so.id='sub-overlay';
      so.style.cssText=`
        position:absolute; left:50%; transform:translateX(-50%);
        max-width:70%; padding:10px 22px;
        text-align:center; border-radius:8px; display:none; z-index:9002;
        text-shadow:0 2px 8px rgba(0,0,0,.9); line-height:1.35; font-weight:600;
        white-space:pre-line; unicode-bidi:plaintext;`;
      so.setAttribute('dir','auto');
      ov().appendChild(so);
      _applySubStyle();
    }
    document.getElementById('pc-back').addEventListener('click',stop);
    document.getElementById('pc-pp').addEventListener('click',togglePause);
    document.getElementById('pc-seek').addEventListener('click',e=>{
      if(!_canSeek()||_seekPending) return;
      if(e.detail>0){
        const rect=e.currentTarget.getBoundingClientRect();
        if(_beginScrub()){
          _scrub.pos=_seekLimit((e.clientX-rect.left)/rect.width*_dur);
          _commitScrub();
        }
      }else if(_scrub) _commitScrub(); else _beginScrub();
    });
    document.addEventListener('keyup',e=>{
      const k=normaliseKey(e.keyCode);
      if(k==='LEFT'||k==='RIGHT'||k==='FF'||k==='RW') _scrubHold=null;
    });
    document.getElementById('pc-next').addEventListener('click',playNextEpisode);
    document.getElementById('pc-fav').addEventListener('click',()=>{
      if(!_item)return;
      const added=S.fav.toggle(_item.type,{stream_id:_item.sid,name:_item.title,stream_icon:_item.cover||''});
      _syncFav(); App.toast(added?'Added to Favorites':'Removed from Favorites');
    });
    document.getElementById('pc-aspect').addEventListener('click',()=>{
      if(_panelOpen==='aspect')_closePanel(); else _openPanel('aspect');
    });
    document.getElementById('pc-subs').addEventListener('click',()=>{
      if(_panelOpen==='subs')_closePanel(); else _openPanel('subs');
    });
    document.getElementById('pc-aud').addEventListener('click',()=>{
      if(_panelOpen==='aud')_closePanel(); else _openPanel('aud');
    });
    ov().addEventListener('click',()=>{ if(_panelOpen){_closePanel();}else{showCtrl();} });
  }

  /* ── Remote keys ──────────────────────────────── */
  function handleKey(k){
    if(!isActive()) return false;
    const cv=ctrl()&&!ctrl().classList.contains('hidden');
    switch(k){
      case 'BACK':
        if(_cancelScrub()) return true;
        if(_panelOpen){_closePanel();return true;}
        stop();return true;
      case 'STOP': stop();return true;
      case 'PLAY': case 'PAUSE': case 'PLAY_PAUSE': togglePause();return true;
      case 'ENTER':
        if(_scrub){_commitScrub();return true;}
        if(!cv){showCtrl();Focus.clearCache();Focus.select(document.getElementById('pc-pp'));return true;}
        Focus.click();return true;
      case 'LEFT':
        if(_scrub||(!cv&&_canSeek())||(!_panelOpen&&Focus.get()===document.getElementById('pc-seek'))){_moveScrub(-1);return true;}
        if(cv){showCtrl();Focus.handle('LEFT');return true;}
        showCtrl();Focus.select(document.getElementById('pc-pp'));return true;
      case 'RIGHT':
        if(_scrub||(!cv&&_canSeek())||(!_panelOpen&&Focus.get()===document.getElementById('pc-seek'))){_moveScrub(1);return true;}
        if(cv){showCtrl();Focus.handle('RIGHT');return true;}
        showCtrl();Focus.select(document.getElementById('pc-pp'));return true;
      case 'FF': _moveScrub(1);return true;
      case 'RW': _moveScrub(-1);return true;
      case 'CH_UP': if(_item&&_item.type==='series') playNextEpisode(); else switchChannel(+1); return true;
      case 'CH_DOWN': switchChannel(-1); return true;
      case 'INFO': {
        const o=osd();
        if(o && !o.classList.contains('hidden')) _hideOsd();
        else _showOsd();
        return true;
      }
      case 'RED': {
        if(!_item)return true;
        const added=S.fav.toggle(_item.type,{stream_id:_item.sid,name:_item.title,stream_icon:_item.cover||''});
        _syncFav(); App.toast(added?'Added to Favorites':'Removed from Favorites');
        return true;
      }
      case 'GREEN': _openPanel('subs'); showCtrl(); return true;
      case 'YELLOW': _openPanel('aud'); showCtrl(); return true;
      case 'BLUE': _openPanel('aspect'); showCtrl(); return true;
      case 'UP':
        if(!cv){showCtrl();Focus.clearCache();Focus.select(document.getElementById('pc-pp'));return true;}
        if(_panelOpen){showCtrl();Focus.handle('UP');return true;}
        _focusTimeline();return true;
      case 'DOWN':
        if(_panelOpen){if(document.getElementById('pc-subs-panel').classList.contains('online-results'))Focus.handle('DOWN');else _closePanel();showCtrl();return true;}
        if(_scrub||Focus.get()===document.getElementById('pc-seek')){
          _cancelScrub();showCtrl();Focus.select(document.getElementById('pc-pp'));return true;
        }
        if(cv){_closePanel();ctrl().classList.add('hidden');}
        _hideOsd();
        return true;
    }
    return false;
  }

  /* play() sets display='block'; _doStop()/error paths set 'none'. The
     overlay is created with NO inline display ('' ≠ 'none'), so testing
     !== 'none' wrongly reported the player active from boot. */
  function isActive(){ const o=ov();return !!o&&o.style.display==='block'; }

  function _applySubStyle(){
    const so=document.getElementById('sub-overlay'); if(!so) return;
    let p; try{ p=S.subs.get(); }catch(_){ p={size:22,color:'#fff',bg:'rgba(0,0,0,0.78)',offset:0}; }
    so.style.fontSize=(p.size||22)+'px';
    so.style.color=p.color||'#fff';
    so.style.background=p.bg||'rgba(0,0,0,0.78)';
    so.style.bottom=(200+(+p.offset||0))+'px';
  }
  function applySubStyle(){ _applySubStyle(); }

  return{play,stop,togglePause,seek,playNextEpisode,handleKey,isActive,init,showCtrl,showOsd,switchChannel,applySubStyle,suspend,resume};
})();
