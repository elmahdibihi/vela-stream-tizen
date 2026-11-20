'use strict';
/* Samsung Tizen TV remote — standard arrow key codes */
const KEY = {
  UP:13637, DOWN:13638, LEFT:13636, RIGHT:13639,
  ENTER:13, BACK:10009, EXIT:10182,
  PLAY:415, PAUSE:19, PLAY_PAUSE:10252, STOP:413, FF:417, RW:412,
  RED:403, GREEN:404, YELLOW:405, BLUE:406,
  CH_UP:427, CH_DOWN:428,
  INFO:457, MENU:18,
  N0:48,N1:49,N2:50,N3:51,N4:52,N5:53,N6:54,N7:55,N8:56,N9:57,
  A_UP:38, A_DOWN:40, A_LEFT:37, A_RIGHT:39,
};

function normaliseKey(kc){
  if(kc===38||kc===13637) return 'UP';
  if(kc===40||kc===13638) return 'DOWN';
  if(kc===37||kc===13636) return 'LEFT';
  if(kc===39||kc===13639) return 'RIGHT';
  if(kc===13)  return 'ENTER';
  if(kc===10009||kc===27) return 'BACK'; /* 27 = Esc for browser testing */
  /* 10182 is Exit/long-Back. Leave it to the platform instead of walking
     through application history. */
  if(kc===10182) return null;
  if(kc===65376) return 'IME_DONE';
  if(kc===65385) return 'IME_CANCEL';
  if(kc===415) return 'PLAY';
  if(kc===19)  return 'PAUSE';
  if(kc===10252) return 'PLAY_PAUSE';
  if(kc===413) return 'STOP';
  if(kc===417) return 'FF';
  if(kc===412) return 'RW';
  if(kc===403) return 'RED';
  if(kc===404) return 'GREEN';
  if(kc===405) return 'YELLOW';
  if(kc===406) return 'BLUE';
  if(kc===427) return 'CH_UP';
  if(kc===428) return 'CH_DOWN';
  if(kc===457) return 'INFO';
  if(kc>=48&&kc<=57) return 'DIGIT_'+(kc-48);
  return null;
}

(function registerKeys(){
  try{
    const dev = window.tizen && window.tizen.tvinputdevice;
    if(!dev) return;
    ['MediaPlay','MediaPause','MediaPlayPause','MediaStop','MediaFastForward','MediaRewind',
     'ColorF0Red','ColorF1Green','ColorF2Yellow','ColorF3Blue',
     'ChannelUp','ChannelDown','Info',
     '0','1','2','3','4','5','6','7','8','9'].forEach(k=>{ try{dev.registerKey(k);}catch(_){} });
  }catch(e){ console.warn('[Keys]',e.message); }
})();
