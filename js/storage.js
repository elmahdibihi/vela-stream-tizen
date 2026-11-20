'use strict';
const S = (() => {
  const NS = 'iptv3_';
  const rd = (k,fb=null)=>{ try{const v=localStorage.getItem(NS+k);return v!==null?JSON.parse(v):fb;}catch(_){return fb;} };
  const wr = (k,v)=>{ try{localStorage.setItem(NS+k,JSON.stringify(v));}catch(e){} };
  const rm = k => localStorage.removeItem(NS+k);
  const seriesName = x => String((x&&x.seriesTitle)||((x&&x.title)||'').replace(/\s+S\d+\s*E\d+.*$/i,'')).trim().toLowerCase();
  const sameSeries = (a,b) => {
    if(!a||!b||a.type!=='series'||b.type!=='series') return false;
    const hasId=x=>x.seriesId!=null&&x.seriesId!=='';
    if(hasId(a)&&hasId(b)) return String(a.seriesId)===String(b.seriesId);
    return !!seriesName(a)&&seriesName(a)===seriesName(b);
  };
  return {
    get: rd, set: wr, del: rm,
    creds:{ save:(u,n,p)=>wr('creds',{url:u,user:n,pass:p}), load:()=>rd('creds'), clear:()=>rm('creds') },
    fav:{
      all: t=>rd('fav_'+t,[]),
      toggle(t,item){ const l=this.all(t),id=item.stream_id||item.series_id,i=l.findIndex(x=>(x.stream_id||x.series_id)===id); i===-1?l.unshift(item):l.splice(i,1); wr('fav_'+t,l); return i===-1; },
      is: (t,id)=>rd('fav_'+t,[]).some(x=>(x.stream_id||x.series_id)===id),
      clear: t=>rm('fav_'+t),
    },
    cont:{
      all: ()=>rd('cont',[]).filter(x=>x&&x.id!=null).sort((a,b)=>(Number(b.ts)||0)-(Number(a.ts)||0)),
      episode(type,id){ return this.all().find(x=>x.type===type&&String(x.id)===String(id))||null; },
      series(id,title){ return this.all().find(x=>sameSeries(x,{type:'series',seriesId:id,seriesTitle:title}))||null; },
      save(item){
        if(!item||item.id==null||!isFinite(item.pos)||item.pos<0) return;
        const l=this.all().filter(x=>item.type==='series'? !sameSeries(x,item)
          : !(x.type===item.type&&String(x.id)===String(item.id)));
        wr('cont',[{...item,ts:Date.now()},...l].slice(0,20));
      },
      clear: ()=>rm('cont'),
    },
    watch:{
      get: id=>rd('watch',{})[id]||0,
      inc(id){ const m=rd('watch',{}); m[id]=(m[id]||0)+1; wr('watch',m); },
      all: ()=>rd('watch',{}),
    },
    reminders:{
      all: ()=>rd('reminders',[]),
      add(r){ const l=this.all().filter(x=>x.id!==r.id); l.push(r); wr('reminders',l); },
      remove(id){ wr('reminders', this.all().filter(x=>x.id!==id)); },
      has(id){ return this.all().some(x=>x.id===id); },
      clear: ()=>rm('reminders'),
    },
    subs:{
      get: ()=>rd('subs',{size:22,color:'#ffffff',bg:'rgba(0,0,0,0.5)',offset:0}),
      set(p){ wr('subs',{...this.get(),...p}); },
    },
  };
})();
