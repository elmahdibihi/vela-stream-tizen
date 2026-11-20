'use strict';
/* Optional OpenSubtitles integration. Keys stay in this TV's local storage. */
const OnlineSubtitles=(()=>{
  const BASE='https://api.opensubtitles.com/api/v1';
  const config=()=>S.get('online_subtitles',{})||{};
  const ready=()=>!!String(config().apiKey||'').trim();
  function request(url,body,api=true){
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();
      xhr.open(body?'POST':'GET',url,true); xhr.timeout=15000;
      if(api){
        xhr.setRequestHeader('Api-Key',String(config().apiKey||'').trim());
        xhr.setRequestHeader('X-User-Agent','VelaStream v4.4.0');
        xhr.setRequestHeader('Accept','application/json');
        if(body) xhr.setRequestHeader('Content-Type','application/json');
      }else xhr.overrideMimeType('text/plain; charset=utf-8');
      xhr.onprogress=e=>{ if(e.loaded>2*1024*1024){xhr.abort();reject(new Error('Subtitle file is too large'));} };
      xhr.onload=()=>{
        if(xhr.status<200||xhr.status>=300){
          const message=xhr.status===401||xhr.status===403?'Check your OpenSubtitles API key in Settings':xhr.status===406||xhr.status===429?'OpenSubtitles download limit reached. Try again later':'Subtitle service unavailable ('+xhr.status+')';
          reject(new Error(message));return;
        }
        if(xhr.responseText.length>2*1024*1024){reject(new Error('Subtitle file is too large'));return;}
        try{resolve(api?JSON.parse(xhr.responseText):xhr.responseText);}catch(_){reject(new Error('Invalid subtitle response'));}
      };
      xhr.onerror=()=>reject(new Error('Cannot reach OpenSubtitles. Check your connection'));
      xhr.ontimeout=()=>reject(new Error('Subtitle request timed out'));
      try{xhr.send(body?JSON.stringify(body):null);}catch(_){reject(new Error('Could not request subtitles'));}
    });
  }
  async function search(item){
    if(!ready()) throw new Error('Add your OpenSubtitles API key in Settings');
    if(!item||!['movie','series'].includes(item.type)) throw new Error('Online subtitles are available for movies and episodes');
    const series=item.type==='series';
    let title=String(series?item.seriesTitle||item.title:item.title||'').trim();
    const q={languages:config().language||'en',order_by:'download_count',order_direction:'desc',query:title,type:series?'episode':'movie'};
    if(series){
      if(item.season==null||item.episode==null||!Number.isInteger(Number(item.season))||!Number.isInteger(Number(item.episode))) throw new Error('Open this episode from its series page to find matching subtitles');
      q.season_number=Number(item.season); q.episode_number=Number(item.episode);
    }else{
      const year=title.match(/\((19\d{2}|20\d{2})\)/);
      if(year){q.year=year[1];q.query=title.replace(year[0],'').trim();}
    }
    const query=Object.keys(q).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(q[k]).replace(/%20/g,'+')).join('&');
    const result=await request(BASE+'/subtitles?'+query);
    const matches=[];
    (Array.isArray(result.data)?result.data:[]).forEach(record=>{
      const a=record.attributes||{},f=a.feature_details||{};
      if(a.language!==q.languages) return;
      if(series&&(Number(f.season_number)!==q.season_number||Number(f.episode_number)!==q.episode_number)) return;
      (Array.isArray(a.files)?a.files:[]).forEach(file=>{
        if(!Number.isInteger(Number(file.file_id))||Number(file.file_id)<=0||matches.length>=12) return;
        const release=String(a.release||file.file_name||f.movie_name||title).slice(0,180);
        matches.push({fileId:Number(file.file_id),label:release,release:release,language:a.language,downloads:Number(a.download_count)||0});
      });
    });
    return matches;
  }
  async function download(fileId){
    if(!ready()) throw new Error('Add your OpenSubtitles API key in Settings');
    if(!Number.isInteger(Number(fileId))||Number(fileId)<=0) throw new Error('Invalid subtitle selection');
    const result=await request(BASE+'/download',{file_id:Number(fileId),sub_format:'srt'});
    let url;
    try{url=new URL(result.link);}catch(_){throw new Error('Subtitle download link unavailable');}
    if(url.protocol!=='https:'||url.username||url.password) throw new Error('Invalid subtitle download link');
    // The CDN request deliberately carries no API or IPTV credentials.
    return request(url.href,null,false);
  }
  return {ready,search,download};
})();
