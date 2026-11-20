'use strict';
const EPG = {
  dec:  b64=>{ try{return atob(b64)||'';}catch(_){return b64||'';} },
  ts:   ts => new Date(parseInt(ts,10)*1000),
  past: s  => parseInt(s)*1000 < Date.now(),
  now:  (s,e)=>{ const n=Date.now(); return parseInt(s)*1000<=n&&n<parseInt(e)*1000; },
  pct:  (s,e)=>Math.min(100,Math.max(0,(Date.now()-parseInt(s)*1000)/(parseInt(e)*1000-parseInt(s)*1000)*100)),
  mins: (s,e)=>Math.round((parseInt(e)-parseInt(s))/60),
  fmt:  ts=>EPG.ts(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),
  fmtMs(ms){ const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),mm=String(m%60).padStart(2,'0'),ss=String(s%60).padStart(2,'0'); return h>0?`${h}:${mm}:${ss}`:`${mm}:${ss}`; },
  PX: 4, /* px per minute */
  width:(s,e)=>Math.max(40,EPG.mins(s,e)*EPG.PX),
  left:(day,s)=>Math.max(0,(parseInt(s)-day.getTime()/1000)/60*EPG.PX),
  days(){
    return[-1,0,1,2].map(i=>{ const d=new Date(); d.setDate(d.getDate()+i); d.setHours(0,0,0,0); return{label:['Yesterday','Today','Tomorrow',d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})][i+1],date:d}; });
  },
  slots(){
    const a=[]; for(let h=0;h<24;h++) for(let m=0;m<60;m+=30) a.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`); return a;
  },
};
