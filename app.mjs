import {RATE,demoBirds,makeWav,analyze,makeDemo} from './dsp.mjs';
import {createPlot,drawWave} from './plot.mjs';

const $ = id => document.getElementById(id);
const svg = id => '<svg aria-hidden="true"><use href="#i-' + id + '"/></svg>';
const colors = ['#a8eed6','#bbb2ff','#ffc586','#a3d7f9','#efa3c2'];
const limit = 60;
const photos = {
  'Turdus merula': {file:'blackbird.jpg', path:'7/76/Merle_noir_male.jpg/250px-Merle_noir_male.jpg', author:'Annick Bregain', name:'Merle noir male.jpg', license:'4.0', position:'52% 27%'},
  'Erithacus rubecula': {file:'robin.jpg', path:'b/ba/European_robin_%28erithacus_rubecula%29.jpg/330px-European_robin_%28erithacus_rubecula%29.jpg', author:'Charles J. Sharp', name:'European robin (erithacus rubecula).jpg', license:'3.0', position:'52% 39%'},
  'Parus major': {file:'great-tit.jpg', path:'3/3c/Great_tit_%28Parus_major%29_male.jpg/960px-Great_tit_%28Parus_major%29_male.jpg', author:'Charles J. Sharp', name:'Great tit (Parus major) male.jpg', license:'4.0', position:'53% 37%'}
};
const players = new Audio();
players.preload = 'auto';
const preview = new Audio();
let clip, previewUrl;
const state = {id:0, recording:null, status:'demo', birds:demoBirds, selected:null, duration:0, source:'Demo soundscape', view:'manifold', manifold:'animated', animationPaused:window.matchMedia('(prefers-reduced-motion: reduce)').matches, coords:null, geoState:null};
let dspWorker, modelWorker, objectUrl, playFrame, noticeTimer, locationVersion=0;
const graph = createPlot($('visual'), inspectPoint, state.animationPaused);

function notice(message, error=false, persist=false) {
  clearTimeout(noticeTimer);
  $('notice').hidden=!message;
  $('notice').textContent=message;
  $('notice').dataset.error=String(error);
  if (message && !persist) noticeTimer=setTimeout(()=>{$('notice').hidden=true;},8500);
}
function clock(value, precise=false) {
  const finite=Math.max(0, Number.isFinite(value) ? value : 0);
  const time=precise ? Math.round(finite*10)/10 : finite;
  const seconds=precise ? (time%60).toFixed(1).padStart(4,'0') : String(Math.floor(time%60)).padStart(2,'0');
  return Math.floor(time/60)+':'+seconds;
}
function selectedBird() {return state.birds.find(bird=>bird.sci===state.selected);}
function wave() {drawWave($('wave'),state.signal,players.currentTime/Math.max(.001,state.duration),selectedBird()?.windows);}
function renderTransport() {
  const paused=players.paused;
  const label=paused?'Play audio':'Pause audio';
  if ($('play').ariaLabel!==label) {
    $('play').innerHTML=svg(paused?'play':'pause');
    $('play').ariaLabel=label;
    $('play').title=label;
  }
  $('play').disabled=!state.signal;
  $('seek').disabled=!state.signal;
  $('replay').disabled=!state.signal;
  $('seek').max=state.duration;
  $('seek').value=players.currentTime || 0;
  $('elapsed').textContent=clock(players.currentTime);
  $('duration').textContent=clock(state.duration);
  graph.time(players.currentTime,players.currentTime>0 || !paused,!paused);
  wave();
}
function refreshPlay() {
  renderTransport();
  if (!players.paused) playFrame=requestAnimationFrame(refreshPlay);
}
players.addEventListener('play',()=>{cancelAnimationFrame(playFrame);refreshPlay();});
players.addEventListener('pause',()=>{cancelAnimationFrame(playFrame);renderTransport();});
players.addEventListener('ended',()=>{
  players.currentTime=0;
  if (!state.animationPaused) graph.seek(state.duration);
  renderTransport();
});
players.addEventListener('seeked',renderTransport);
$('play').onclick=()=>players.paused ? players.play().catch(()=>notice('Playback could not start. Try playing again.',true)) : players.pause();
$('replay').onclick=()=>{
  players.currentTime=0;
  graph.seek(0);
  players.play().catch(()=>notice('Playback could not start. Try playing again.',true));
};
$('seek').oninput=()=>{
  players.currentTime=+$('seek').value;
  graph.seek(players.currentTime);
  inspectPoint(null);
  renderTransport();
};
new ResizeObserver(wave).observe($('wave'));
function setRecording(signal, analysis) {
  if (signal) {
    players.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl=URL.createObjectURL(makeWav(signal));
    players.src=objectUrl;
    state.signal=signal;
    state.duration=signal.length/RATE;
  }
  state.analysis=analysis;
  const top=graph.data(analysis);
  if (signal) graph.seek(state.status==='demo' ? Math.min(4.7,state.duration*.4) : 0);
  renderAnimationControl();
  $('rangeHigh').textContent=top/1000+' kHz';
  renderTransport();
}
function inspectPoint(index) {
  const point=$('point');
  if (index==null || !state.analysis) {point.hidden=true;return;}
  const [time,rms,centroid,peak]=state.analysis.metadata.subarray(index*4,index*4+4);
  point.replaceChildren();
  const rows=[clock(time,true)+' · '+(20*Math.log10(Math.max(rms,.000001))).toFixed(1)+' dBFS RMS',
    'Centroid '+(centroid/1000).toFixed(2)+' kHz',
    'Dominant '+(peak/1000).toFixed(2)+' kHz'];
  if (state.analysis.recurrence?.[index] >= .4) rows.push('Similar frequency heard recently');
  for (const row of rows) {const div=document.createElement('div');div.textContent=row;point.append(div);}
  point.hidden=false;
  if (state.signal) players.currentTime=Math.min(time,state.duration);
  if (state.view==='manifold' && state.manifold==='animated') {
    graph.seek(time);
    pauseAnimation(true,index);
  }
  renderTransport();
}
function refreshSelection() {
  const bird=selectedBird();
  graph.selection(bird?.windows || null);
  $('sessionLabel').textContent=bird ? bird.name.toUpperCase() : state.source.toUpperCase();
  $('species').querySelectorAll('button').forEach(button=>button.ariaPressed=String(button.dataset.sci===state.selected));
  wave();
}
function renderResults() {
  $('count').textContent=state.birds.length;
  $('resultSubtitle').textContent=state.status==='demo' ? 'Illustrative detections in the demo' :
    state.status==='review' ? 'Ready to analyze' :
    state.status==='analyzing' ? 'Analyzing your recording' :
    state.status==='failed' ? 'Bird identification unavailable' :
    state.geoState==='used' ? 'Ranked with location and season' : 'From your current recording';
  const list=$('species');
  list.replaceChildren();
  if (!state.birds.length) {
    const empty=document.createElement('p');
    empty.className='empty';
    empty.textContent=state.status==='review' ? 'Analyze your selection to identify birds.' : state.status==='analyzing' ? 'The sound explorer is ready as soon as the audio analysis finishes.' :
      state.status==='failed' ? 'You can still play the audio and explore its shape. Try importing the file again when the model can be downloaded.' :
      'No species passed the confidence threshold in this recording.';
    list.append(empty);
  }
  state.birds.forEach((bird,i)=>{
    const card=document.createElement('button');
    card.type='button';card.className='species-card';
    card.dataset.sci=bird.sci;card.style.setProperty('--accent',colors[i%colors.length]);
    card.innerHTML='<span class="portrait">'+svg('bird')+'</span><span><span class="bird-name"></span><span class="sci"></span><span class="window"></span></span><span class="score"><span></span><small>'+ (state.status==='demo'?'demo score':'confidence')+'</small><span class="mini-bar"><span></span></span></span>';
    card.querySelector('.bird-name').textContent=bird.name;
    card.querySelector('.sci').textContent=bird.sci;
    const [start,end]=bird.windows[0];
    card.querySelector('.window').textContent=clock(start,true)+'–'+clock(end,true)+(bird.windows.length>1?' · +'+(bird.windows.length-1):'');
    card.querySelector('.score > span').textContent=Math.round(bird.score*100)+'%';
    card.querySelector('.mini-bar > span').style.width=Math.round(bird.score*100)+'%';
    card.onclick=()=>{
      const select=state.selected!==bird.sci;
      state.selected=select ? bird.sci : null;
      if (select && state.signal) players.currentTime=start;
      inspectPoint(null);
      refreshSelection();
      if (select) graph.seek(start);
      renderTransport();
    };
    const photo=photos[bird.sci];
    if (photo) {
      const img=document.createElement('img');
      img.alt='';img.decoding='async';img.referrerPolicy='no-referrer';
      img.style.objectPosition=photo.position;
      img.onerror=()=>{img.onerror=()=>img.remove();img.src='https://thumb.wikimedia.org/wikipedia/commons/thumb/'+photo.path;};
      img.src='./assets/'+photo.file;
      card.querySelector('.portrait').append(img);
    }
    list.append(card);
  });
  if (!selectedBird()) state.selected=null;
  refreshSelection();
}
function renderLocation() {
  const has=!!state.coords;
  $('locationText').textContent=has ? 'Location enabled' : 'Enable location';
  $('clearLocation').hidden=!has;
  if (has) $('locationDetails').textContent=Math.abs(state.coords.lat).toFixed(2)+'° '+(state.coords.lat<0?'S':'N')+', '+Math.abs(state.coords.lon).toFixed(2)+'° '+(state.coords.lon<0?'W':'E');
  $('locationNote').textContent=state.geoState==='used' ? 'Location and season refine the ranking. The displayed scores are acoustic.' :
    state.geoState==='failed' ? 'The location model was unavailable. Acoustic results are shown.' :
    state.geoState==='pending' ? 'Checking species likelihood for your location and season…' :
    has ? 'Location is enabled for this session.' : 'Enable location to refine real detections by season and region.';
}
function rankDetections() {
  if (!modelWorker || state.status!=='done') return;
  state.geoState=state.coords ? 'pending' : null;
  renderLocation();
  modelWorker.postMessage({id:state.id, coords:state.coords, locationVersion:++locationVersion});
}
$('location').onclick=()=>{$('locationDialog').showModal();};
$('findLocation').onclick=()=>{
  const button=$('findLocation');
  if (!navigator.geolocation) {$('locationDetails').textContent='Location is unavailable in this browser.';return;}
  button.disabled=true;
  $('locationDetails').textContent='Requesting your device location…';
  navigator.geolocation.getCurrentPosition(({coords})=>{
    const date=new Date();
    const week=date.getMonth()*4+Math.min(4,Math.ceil(date.getDate()/7));
    state.coords={lat:Math.round(coords.latitude*100)/100,lon:Math.round(coords.longitude*100)/100,week};
    button.disabled=false;
    renderLocation();
    rankDetections();
    $('locationDialog').close();
  },error=>{
    button.disabled=false;
    $('locationDetails').textContent=error.code===1 ? 'Location permission is off. You can change it in your browser settings.' : 'Your device could not get a location. Try again outdoors or with location services on.';
  },{enableHighAccuracy:false,timeout:10000,maximumAge:300000});
};
$('clearLocation').onclick=()=>{
  state.coords=null;state.geoState=null;
  $('locationDetails').textContent='Location is off.';
  renderLocation();
  rankDetections();
};

function runDsp(signal,demo=false) {
  dspWorker?.terminate();
  const id=state.id;
  return new Promise((resolve,reject)=>{
    if (typeof Worker==='undefined') {
      const input=demo?makeDemo():signal;
      resolve({signal:demo?input:undefined,result:analyze(input)});
      return;
    }
    let worker;
    try {worker=new Worker(new URL('./dsp-worker.mjs',import.meta.url),{type:'module'});}
    catch (error) {reject(error);return;}
    dspWorker=worker;
    const close=()=>{worker.terminate();if(dspWorker===worker)dspWorker=null;};
    worker.onmessage=({data})=>{close();if (data.error) reject(new Error(data.error));else resolve(data);};
    worker.onerror=e=>{close();reject(new Error(e.message||'Sound analysis failed.'));};
    worker.postMessage(demo ? {demo:true} : {signal});
  }).catch(error=>{
    if (id!==state.id) throw error;
    const input=demo?makeDemo():signal;
    return {signal:demo?input:undefined,result:analyze(input)};
  }).then(data=>{if (id===state.id) setRecording(data.signal,data.result);return data;});
}
function getModelWorker() {
  if (modelWorker) return modelWorker;
  modelWorker=new Worker(new URL('./model-worker.mjs',import.meta.url),{type:'module'});
  modelWorker.onmessage=({data})=>{
    if (data.id!==state.id || state.status==='demo') return;
    if (data.locationVersion!==undefined && data.locationVersion!==locationVersion) return;
    if (data.stage) {notice(data.stage,false,true);return;}
    if (data.error) {
      state.status='failed';state.geoState=null;
      renderResults();renderLocation();
      notice('BirdNET could not load or finish. The sound explorer can still display your recording.',true,true);
      return;
    }
    const first=state.status==='analyzing';
    state.status='done';
    state.birds=data.birds;
    state.geoState=data.used?'used':data.geoError?'failed':null;
    renderResults();renderLocation();
    if (first) {
      notice(null);
      if (state.coords && state.birds.length) rankDetections();
    }
  };
  modelWorker.onerror=()=>{
    modelWorker?.terminate();
    modelWorker=null;
    if (state.status!=='analyzing') return;
    state.status='failed';renderResults();
    notice('BirdNET could not start. The sound explorer can still display your recording.',true,true);
  };
  return modelWorker;
}
function newSession(status,source) {
  state.id++;
  players.pause();
  Object.assign(state,{status,source,selected:null,birds:status==='demo'?demoBirds:[],geoState:null});
  stopClipPreview();
  $('clipEditor').hidden=status!=='review';
  $('editClip').hidden=!clip || status==='review';
  $('loadDemo').hidden=status==='demo';
  inspectPoint(null);
  graph.reset();
  renderResults();renderLocation();
}
async function loadDemo() {
  if (state.recording) return;
  clip=null;
  newSession('demo','Demo soundscape');
  notice(null);
  try {await runDsp(null,true);}
  catch {notice('The demo soundscape could not start. Refresh to try again.',true);}
}
$('loadDemo').onclick=loadDemo;

async function decode(blob) {
  const AudioContext=window.AudioContext || window.webkitAudioContext;
  const context=new AudioContext();
  try {
    const audio=await context.decodeAudioData(await blob.arrayBuffer());
    const frames=Math.min(audio.length,Math.round(audio.sampleRate*limit));
    const channels=Array.from({length:audio.numberOfChannels},(_,i)=>audio.getChannelData(i));
    const offline=new OfflineAudioContext(1,Math.max(1,Math.round(frames*RATE/audio.sampleRate)),RATE);
    const mono=offline.createBuffer(1,frames,audio.sampleRate);
    const mixed=mono.getChannelData(0);
    for (const channel of channels) for (let i=0;i<frames;i++) mixed[i]+=channel[i]/channels.length;
    const source=offline.createBufferSource();source.buffer=mono;source.connect(offline.destination);source.start();
    const resampled=await offline.startRendering();
    return {signal:resampled.getChannelData(0), clipped:audio.duration>limit+.05};
  } finally {context.close().catch(()=>{});}
}
async function processAudio(blob,label) {
  const token=state.id;
  $('record').disabled=true;$('upload').disabled=true;$('loadDemo').disabled=true;
  notice('Reading audio…',false,true);
  let decoded;
  try {decoded=await decode(blob);}
  catch {notice('This audio could not be opened. Try a WAV, MP3, or M4A file.',true);return;}
  finally {$('record').disabled=false;$('upload').disabled=false;$('loadDemo').disabled=false;}
  if (token!==state.id) return;
  const {signal,clipped}=decoded;
  if (signal.length<RATE*.2) {notice('That recording is too short. Try recording for at least three seconds.',true);return;}
  clip={signal,label,clipped,start:0,end:signal.length};
  reviewClip();
}
function stopClipPreview() {
  preview.pause();
  if (!previewUrl) return;
  preview.removeAttribute('src');
  preview.load();
  URL.revokeObjectURL(previewUrl);
  previewUrl=null;
}
function drawClip() {
  if (state.status!=='review') return;
  const {signal,start,end}=clip;
  for (const [id,frame] of [['clipStart',start],['clipEnd',end]]) {
    const control=$(id);
    control.max=signal.length;
    control.value=frame;
    control.step='any';
    const time=clock(frame/RATE,true);
    control.setAttribute('aria-valuetext',time);
    $(id+'Time').textContent=time;
  }
  drawWave($('clipWave'),signal,-1,[[start/RATE,end/RATE]]);
}
function reviewClip() {
  if (!clip || state.recording || $('record').disabled) return;
  newSession('review',clip.label);
  $('vizHeading').title='';
  setRecording(clip.signal,null);
  drawClip();
  notice(clip.clipped?'Reviewing the first 60 seconds of this file.':'');
  $('clipEditor').scrollIntoView({block:'nearest'});
}
function adjustClip(boundary,value) {
  stopClipPreview();
  const frame=Math.round(Number(value)), minimum=Math.round(.2*RATE);
  if (boundary==='start') clip.start=Math.max(0,Math.min(frame,clip.end-minimum));
  else clip.end=Math.min(clip.signal.length,Math.max(frame,clip.start+minimum));
  drawClip();
}
$('clipStart').oninput=e=>adjustClip('start',e.currentTarget.value);
$('clipEnd').oninput=e=>adjustClip('end',e.currentTarget.value);
$('clipReset').onclick=()=>{
  stopClipPreview();
  clip.start=0;
  clip.end=clip.signal.length;
  drawClip();
};
$('clipPreview').onclick=()=>{
  if (!preview.paused) {stopClipPreview();return;}
  players.pause();
  stopClipPreview();
  previewUrl=URL.createObjectURL(makeWav(clip.signal.subarray(clip.start,clip.end)));
  preview.src=previewUrl;
  preview.play().catch(()=>notice('Preview could not start. Try again.',true));
};
preview.addEventListener('play',()=>{$('clipPreview').textContent='Stop preview';});
preview.addEventListener('pause',()=>{$('clipPreview').textContent='Replay selection';});
preview.addEventListener('ended',stopClipPreview);
players.addEventListener('play',stopClipPreview);
$('editClip').onclick=reviewClip;
$('clipAnalyze').onclick=()=>{
  const {signal,label,clipped,start,end}=clip;
  analyzeClip(signal.slice(start,end),label,clipped,start!==0 || end!==signal.length);
};
new ResizeObserver(drawClip).observe($('clipWave'));
function analyzeClip(signal,label,clipped,cropped) {
  newSession('analyzing',cropped ? label+' · cropped' : label);
  const id=state.id;
  $('vizHeading').title=clipped?'Only the first 60 seconds of this file were analyzed.':'';
  if (clipped && !cropped) state.source=label+' · first 60 s';
  setRecording(signal,null);
  refreshSelection();
  notice(clipped?'Analyzing the first 60 seconds…':'Analyzing recording…',false,true);
  runDsp(signal).catch(()=>{if (state.id===id) notice('The sound visualization could not be computed.',true);});
  try {getModelWorker().postMessage({id,signal});}
  catch {
    state.status='failed';renderResults();
    notice('Bird identification is unavailable in this browser.',true,true);
  }
}
$('upload').onclick=()=>$('file').click();
$('file').onchange=()=>{
  const file=$('file').files[0];
  $('file').value='';
  if (!file) return;
  if (file.size>150*1024*1024) {notice('Choose an audio file under 150 MB.',true);return;}
  processAudio(file,'Imported audio');
};
$('record').onclick=async()=>{
  if (state.recording) {if (state.recording.recorder.state==='recording') state.recording.recorder.stop();return;}
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    notice('Microphone recording needs a supported browser and a secure connection. You can import audio here.',true);
    return;
  }
  $('record').disabled=true;
  let stream;
  try {
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    players.pause();
    stopClipPreview();
    const recorder=new MediaRecorder(stream);
    const parts=[];
    const started=Date.now();
    let tick;
    const stopUI=()=>{
      clearInterval(tick);
      stream.getTracks().forEach(track=>track.stop());
      state.recording=null;
      $('record').classList.remove('recording');
      $('record').innerHTML=svg('mic')+'<span>Record</span>';
      $('upload').disabled=false;$('loadDemo').disabled=false;
    };
    recorder.ondataavailable=e=>{if (e.data.size) parts.push(e.data);};
    recorder.onerror=()=>{stopUI();notice('Microphone recording stopped unexpectedly. Try again or import audio.',true);};
    recorder.onstop=()=>{
      stopUI();
      if (parts.length) processAudio(new Blob(parts,{type:recorder.mimeType}),'Microphone recording');
      else notice('The microphone did not capture any audio. Try again.',true);
    };
    recorder.start();
    state.recording={recorder};
    $('record').classList.add('recording');
    $('upload').disabled=true;$('loadDemo').disabled=true;
    const update=()=>{
      const elapsed=(Date.now()-started)/1000;
      $('record').innerHTML=svg('stop')+'<span>Stop · '+clock(elapsed)+'</span>';
      if (elapsed>=limit && recorder.state==='recording') recorder.stop();
    };
    update();tick=setInterval(update,250);
    notice('Listening. Tap Stop to review your recording.',false,true);
  } catch(error) {
    stream?.getTracks().forEach(track=>track.stop());
    notice(error.name==='NotAllowedError'?'Microphone permission is off. You can enable it in your browser or import audio.':'The microphone is unavailable. You can import an audio file instead.',true);
  } finally {$('record').disabled=false;}
};
const descriptions={manifold:'40 MFCCs → 3 principal components',pitch:'Mel spectrogram and dominant frequency',energy:'Relative RMS amplitude over time'};
function renderAnimationControl() {
  const control=$('animationControl');
  control.hidden=state.manifold!=='animated';
  control.disabled=!state.analysis;
  const label=state.animationPaused?'Resume animation':'Pause animation';
  control.innerHTML=svg(state.animationPaused?'play':'pause')+'<span>'+label+'</span>';
}
function pauseAnimation(paused,index) {
  state.animationPaused=paused;
  graph.pauseAnimation(paused,index);
  renderAnimationControl();
}
function describePlot() {
  $('visual').ariaLabel=state.view!=='manifold'
    ? descriptions[state.view]+'. Click to inspect a frame.'
    : state.manifold==='animated'
      ? 'Fading 3D sound trail. Use arrow keys to rotate or press Enter to inspect the current node.'
      : 'Complete 3D sound trajectory. Use arrow keys to rotate or click a point to inspect it.';
}
const manifoldButtons=document.querySelectorAll('[data-manifold]');
manifoldButtons.forEach(button=>button.onclick=()=>{
  state.manifold=button.dataset.manifold;
  manifoldButtons.forEach(item=>item.ariaPressed=String(item===button));
  inspectPoint(null);
  renderAnimationControl();
  describePlot();
  graph.manifold(state.manifold);
});
$('animationControl').onclick=()=>{
  if (state.animationPaused) inspectPoint(null);
  pauseAnimation(!state.animationPaused);
};
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{
  state.view=button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(item=>item.ariaPressed=String(item===button));
  $('vizSubtitle').textContent=descriptions[state.view];
  $('plotHint').hidden=state.view!=='manifold';
  $('plot').dataset.view=state.view;
  $('manifoldControls').hidden=state.view!=='manifold';
  describePlot();
  $('visual').style.touchAction=state.view==='manifold'?'none':'pan-y';
  inspectPoint(null);
  graph.view(state.view);
});
$('reset').onclick=()=>{inspectPoint(null);graph.reset();};
function expand() {
  const expanded=$('explorer').classList.toggle('expanded');
  $('expand').innerHTML=svg(expanded?'close':'full');
  $('expand').ariaLabel=expanded?'Close expanded explorer':'Expand explorer';
  $('expand').title=$('expand').ariaLabel;
}
$('expand').onclick=expand;
document.addEventListener('keydown',e=>{
  if (e.key==='Escape' && !$('locationDialog').open && $('explorer').classList.contains('expanded')) expand();
});
function route() {
  const method=location.hash==='#method';
  $('method').hidden=!method;$('listen').hidden=method;
  if (method) {
    $('navMethod').setAttribute('aria-current','page');
    $('navListen').removeAttribute('aria-current');
    if ($('explorer').classList.contains('expanded')) expand();
  } else {
    $('navListen').setAttribute('aria-current','page');
    $('navMethod').removeAttribute('aria-current');
  }
  window.scrollTo(0,0);
}
window.addEventListener('hashchange',route);
const credits=$('photoCredits');
credits.append('Bird photographs, displayed cropped · ');
Object.values(photos).forEach((photo,index)=>{
  if (index) credits.append(' · ');
  const link=document.createElement('a');
  link.href='https://commons.wikimedia.org/wiki/File:'+encodeURIComponent(photo.name.replaceAll(' ','_'));
  link.target='_blank';link.rel='noreferrer';
  link.textContent=photo.author;
  const license=document.createElement('a');
  license.href='https://creativecommons.org/licenses/by-sa/'+photo.license+'/';
  license.target='_blank';license.rel='noreferrer';license.textContent='CC BY-SA '+photo.license;
  credits.append(link,' (',license,')');
});
route();
renderAnimationControl();
renderTransport();
loadDemo();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
