import {TRAIL_SECONDS, SPECTRUM_MAX_HZ, SPECTRUM_BIN_HZ, SPECTRUM_MIN_DB, SPECTRUM_BINS} from './dsp.mjs';

const PALETTE = [[123,94,250],[102,156,255],[128,239,228],[225,248,156],[255,173,102]];
const MANIFOLD_PALETTE = [[104,84,245],[72,151,255],[66,227,147],[202,249,104],[255,190,79],[255,88,77],[239,70,158]];
const MANIFOLD_STOPS = [0,.14,.33,.47,.54,.65,1];
const FRAMES_PER_SECOND = 100;
const SPECTROGRAM_FLOOR = -80;
const SPECTROGRAM_PALETTE = [[28,31,55],[80,76,169],[54,170,208],[100,234,190],[255,216,115]];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function color(t, palette = PALETTE) {
  const at = clamp(t,0,1) * (palette.length - 1), i = Math.min(Math.floor(at), palette.length - 2);
  return palette[i].map((c, j) => Math.round(c + (palette[i + 1][j] - c) * (at - i)));
}
function manifoldColor(t) {
  const value = clamp(t,0,1);
  const high = Math.max(1,MANIFOLD_STOPS.findIndex(stop=>stop>=value));
  const low = high-1;
  const blend = (value-MANIFOLD_STOPS[low])/(MANIFOLD_STOPS[high]-MANIFOLD_STOPS[low]);
  return color((low+blend)/(MANIFOLD_PALETTE.length-1),MANIFOLD_PALETTE);
}
const rgb = (c, a) => 'rgba(' + c.join(',') + ',' + a + ')';
function line(ctx, a, b, stroke, width = 1) {
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
  ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke();
}
function circle(ctx, x, y, r, fill) {
  ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
}
function fit(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);
  return {ctx,w,h};
}

function poolSpectrum(data, columns, rows) {
  const cells = [];
  for (let column=0;column<columns;column++) {
    const firstFrame = Math.floor(column*data.n/columns), endFrame = Math.floor((column+1)*data.n/columns);
    for (let row=0;row<rows;row++) {
      const firstBin = Math.floor(row*SPECTRUM_BINS/rows), endBin = Math.floor((row+1)*SPECTRUM_BINS/rows);
      let level = -1, frame = firstFrame, bin = firstBin;
      for (let f=firstFrame;f<endFrame;f++) {
        for (let b=firstBin;b<endBin;b++) {
          const candidate = data.spectralLevels[f*SPECTRUM_BINS+b];
          if (candidate > level) {level=candidate;frame=f;bin=b;}
        }
      }
      cells.push({i:frame,hz:bin*SPECTRUM_BIN_HZ,db:level+SPECTRUM_MIN_DB,
        time:(firstFrame+endFrame-1)/(2*FRAMES_PER_SECOND),
        frequency:(firstBin+endBin-1)*SPECTRUM_BIN_HZ/2});
    }
  }
  return cells;
}

export function createPlot(canvas, onPick, startPaused = false) {
  let data, selected = null, mode = 'manifold', currentTime = 0, showingPlayhead = false, pending = 0;
  const manifoldCamera = {yaw:-.47,pitch:-.37,zoom:1};
  const spectrumCamera = {yaw:-.54,pitch:-.53,zoom:1};
  let camera = manifoldCamera, scale = 1, maxCentroid = 8000, peakMax = 10000;
  let hit = [], pointerStart = null, pinched = false, raster, completeLayer;
  let spectralGrid, spectralLayer;
  let manifold = 'animated', animationPaused = startPaused, audioPlaying = false;
  let previewTime = 0, previousTick = null, inspectedFrame = null, trailHead = null;
  const pointers = new Map();
  const is3d = () => mode==='manifold' || mode==='spectrogram';
  const highlight = time => !selected || selected.some(([start,end]) => time >= start && time <= end);
  const frameAt = time => clamp(Math.round(time * FRAMES_PER_SECOND),0,data.n-1);
  function nextPreviewTime(time) {
    const duration = data.n / FRAMES_PER_SECOND;
    const at = time >= duration+TRAIL_SECONDS ? 0 : time;
    if (!selected?.length || selected.some(([start,end]) => at >= start && at < end+TRAIL_SECONDS)) return at;
    return selected.find(([start]) => start > at)?.[0] ?? selected[0][0];
  }
  function draw(now) {
    pending = 0;
    const area = fit(canvas);
    hit = [];
    trailHead = null;
    if (!area || !data) { previousTick = null; return; }
    const preview = mode === 'manifold' && manifold === 'animated' && !animationPaused && !audioPlaying;
    if (preview && previousTick !== null) {
      previewTime = nextPreviewTime(previewTime + Math.min(.1,(now-previousTick)/1000));
    }
    previousTick = preview ? now : null;
    if (mode === 'spectrogram') drawSpectrogram(area);
    else if (mode === 'manifold') draw3d(area);
    else draw2d(area);
    if (preview) invalidate();
  }
  function invalidate() { pending ||= requestAnimationFrame(draw); }
  function redrawProjection() {
    completeLayer = null;
    spectralLayer = null;
    invalidate();
  }
  function project(x, y, z, w, h, padding = 1) {
    const {yaw,pitch,zoom} = camera;
    const co = Math.cos(yaw), si = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch);
    const ax = x * co - z * si, az = x * si + z * co, ay = y * cx - az * sx, d = y * sx + az * cx;
    const perspective = 4.4 / (4.4 + d);
    const s = Math.min(w * .42,h * .405) * zoom * perspective * padding;
    return {x:w*.51 + ax*s,y:h*.47 - ay*s,d};
  }
  function drawSpectrogram({ctx,w,h}) {
    if (!data.spectralLevels) return;
    const duration = Math.max(data.duration,.01);
    const xAt = time => -1.15 + 2.3*clamp(time/duration,0,1);
    const zAt = hz => -.8 + 1.6*hz/SPECTRUM_MAX_HZ;
    const height = db => clamp((db-SPECTROGRAM_FLOOR)/-SPECTROGRAM_FLOOR,0,1);
    const base = -.72, yAt = db => base + 1.6*height(db);
    const compact = w<440;
    const p = (x,y,z) => {
      const point=project(x,y,z,w,h,compact ? .77 : .91);
      point.x+=compact ? 8 : 0;
      point.y-=compact ? 14 : 0;
      return point;
    };
    const cols = Math.min(data.n,w<440 ? 84 : 144), rows = w<440 ? 56 : 72;
    if (!spectralGrid || spectralGrid.cols!==cols || spectralGrid.rows!==rows) {
      spectralGrid={cols,rows,cells:poolSpectrum(data,cols,rows)};
    }
    if (!spectralLayer || spectralLayer.w!==canvas.width || spectralLayer.h!==canvas.height) {
      const layer=document.createElement('canvas');
      layer.width=canvas.width; layer.height=canvas.height;
      const brush=layer.getContext('2d');
      brush.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);
      const points=spectralGrid.cells.map(cell=>({...cell,
        ...p(xAt(cell.time),yAt(cell.db),zAt(cell.frequency))}));
      const faces=[];
      for (let c=0;c<cols-1;c++) {
        const active=highlight((points[c*rows].time+points[(c+1)*rows].time)/2);
        for (let r=0;r<rows-1;r++) {
          const i=c*rows+r, a=points[i], b=points[i+rows], d=points[i+1], e=points[i+rows+1];
          const peak=Math.max(a.db,b.db,d.db,e.db);
          if (peak<=SPECTROGRAM_FLOOR) continue;
          const mean=(a.db+b.db+d.db+e.db)/4;
          faces.push({a,b,d,e,depth:(a.d+b.d+d.d+e.d)/4,level:.72*peak+.28*mean,active});
        }
      }
      faces.sort((a,b)=>b.depth-a.depth);
      for (const {a,b,d,e,level,active} of faces) {
        brush.beginPath();brush.moveTo(a.x,a.y);brush.lineTo(b.x,b.y);brush.lineTo(e.x,e.y);brush.lineTo(d.x,d.y);brush.closePath();
        brush.fillStyle=rgb(color(height(level),SPECTROGRAM_PALETTE),active ? .96 : .27);
        brush.fill();
      }
      // A very short selection can have just one time column.
      if (cols===1) {
        for (let r=1;r<rows;r++) {
          if (Math.max(points[r-1].db,points[r].db)>SPECTROGRAM_FLOOR)
            line(brush,points[r-1],points[r],rgb(color(height(points[r].db),SPECTROGRAM_PALETTE),.92),1.4);
        }
      }
      spectralLayer={layer,w:canvas.width,h:canvas.height,points:points.filter(point=>point.db>SPECTROGRAM_FLOOR)};
    }
    const divisions=w<440 ? 2 : 4;
    for (let i=0;i<=divisions;i++) {
      const x=xAt(duration*i/divisions), z=zAt(SPECTRUM_MAX_HZ*i/divisions);
      line(ctx,p(x,base,-.8),p(x,base,.8),'#355261',.75);
      line(ctx,p(-1.15,base,z),p(1.15,base,z),'#355261',.75);
    }
    ctx.drawImage(spectralLayer.layer,0,0,w,h);
    hit=spectralLayer.points;
    const origin=p(-1.15,base,-.8);
    line(ctx,origin,p(1.15,base,-.8),'#93b0bd');
    line(ctx,origin,p(-1.15,base,.8),'#93b0bd');
    line(ctx,origin,p(-1.15,yAt(0),-.8),'#93b0bd');
    ctx.font='10px monospace'; ctx.fillStyle='#b5cbd3';
    for (let i=0;i<=divisions;i++) {
      const time=duration*i/divisions, hz=SPECTRUM_MAX_HZ*i/divisions, db=SPECTROGRAM_FLOOR*(1-i/divisions);
      const a=p(xAt(time),base,-.8), b=p(-1.15,base,zAt(hz)), c=p(-1.15,yAt(db),-.8);
      ctx.textAlign='center';ctx.fillText(time.toFixed(1)+' s',a.x,a.y+15);
      if (i) {ctx.textAlign='right';ctx.fillText(hz/1000+' kHz',b.x-5,b.y+3);}
      ctx.textAlign=c.x<43?'left':'right';
      ctx.fillText(db+' dB',c.x+(c.x<43?6:-7),c.y-5);
    }
    ctx.textAlign='start';
    if (showingPlayhead) {
      const x=xAt(currentTime);
      line(ctx,p(x,base,-.86),p(x,base,.8),'#a8efd9',1.4);
      circle(ctx,p(x,base,-.86).x,p(x,base,-.86).y,2.8,'#a8efd9');
    }
  }
  function draw3d({ctx,w,h}) {
    const base = -1.01;
    const p = (x,y,z) => project(x,y,z,w,h);
    for (let i = -6; i <= 6; i++) {
      const k = i * .22;
      const stroke = i === 0 ? '#32504785' : '#30423a65';
      line(ctx,p(k,base,-1.32),p(k,base,1.32),stroke,.7);
      line(ctx,p(-1.32,base,k),p(1.32,base,k),stroke,.7);
    }
    const origin = p(-1.32,base,1.32);
    [[p(1.43,base,1.32),'PC1'],[p(-1.32,1.06,1.32),'PC2'],[p(-1.32,base,-1.45),'PC3']].forEach(([a,name]) => {
      line(ctx,origin,a,'#66857999',.85);
      ctx.fillStyle = '#819aa7'; ctx.font = '9px monospace'; ctx.fillText(name,a.x+3,a.y-4);
    });
    if (manifold === 'animated') {
      drawTrail(ctx,p,w,h);
      return;
    }
    if (!completeLayer || completeLayer.w !== w || completeLayer.h !== h) {
      const layer = document.createElement('canvas');
      layer.width = canvas.width;
      layer.height = canvas.height;
      const brush = layer.getContext('2d');
      brush.setTransform(canvas.width/w,0,0,canvas.height/h,0,0);
      completeLayer = {layer,w,h,points:drawComplete(brush,p,w,h)};
    }
    ctx.drawImage(completeLayer.layer,0,0,w,h);
    hit = completeLayer.points;
    if (showingPlayhead) {
      const a = projectFrame(frameAt(currentTime),p,w,h);
      if (a) {
        circle(ctx,a.x,a.y,5,'#f4fff8');
        ctx.strokeStyle='#9ef7d7b0'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(a.x,a.y,9,0,Math.PI*2); ctx.stroke();
      }
    }
  }
  function projectFrame(i,p,w,h) {
    const a = p(data.coords[i*3]/scale,data.coords[i*3+1]/scale,data.coords[i*3+2]/scale);
    if (a.d <= -4.2 || !(Math.abs(a.x)<=w*5 && Math.abs(a.y)<=h*5)) return null;
    const t = data.metadata[i*4], rms = data.metadata[i*4+1];
    const volume = Math.min(1,rms / Math.max(.00001,data.maxRms));
    return {...a,i,volume,c:manifoldColor(data.metadata[i*4+2]/maxCentroid),visible:highlight(t),
      size:.68 + 4.6 * Math.pow(volume,.75)};
  }
  function drawComplete(ctx,p,w,h) {
    const points = [];
    const opacity = Math.min(1,Math.sqrt(1600/data.n));
    let previous;
    for (let i=0;i<data.n;i++) {
      const a = projectFrame(i,p,w,h);
      if (!a) { previous = null; continue; }
      if (previous) {
        const distance = Math.hypot(previous.x-a.x,previous.y-a.y);
        const alpha = (a.visible && previous.visible ? .12 + a.volume*.26 : .035) * opacity;
        line(ctx,previous,a,rgb(a.c,alpha * Math.min(1,w*.32/Math.max(1,distance))),.65+a.volume*.48);
      }
      points.push(a);
      previous = a;
    }
    points.sort((a,b)=>b.d-a.d);
    for (const a of points) {
      if (a.visible && a.volume>.18) circle(ctx,a.x,a.y,a.size*2.4,rgb(a.c,(.036 + .10*a.volume)*opacity));
      circle(ctx,a.x,a.y,a.size,rgb(a.c,(a.visible ? .25 + .65*a.volume : .065)*opacity));
    }
    return points;
  }
  function drawTrail(ctx,p,w,h) {
    const step = w<440 ? 3 : 2;
    const first = Math.max(0,Math.ceil((previewTime-TRAIL_SECONDS)*FRAMES_PER_SECOND/step)*step);
    const last = Math.min(data.n-1,Math.floor(previewTime*FRAMES_PER_SECOND+1e-6));
    const points = [];
    let previous, latest;
    for (let i=first;i<=last;i+=step) {
      const point = projectFrame(i,p,w,h);
      if (!point?.visible) { previous=null; continue; }
      const age = Math.max(0,previewTime-i/FRAMES_PER_SECOND);
      const opacity = clamp(1-age/TRAIL_SECONDS,0,1) ** 1.7;
      const strength = data.recurrence?.[i] || 0;
      const swell = i%12===0 ? Math.min(1,strength/2.2)*(1-Math.exp(-age/.15)) : 0;
      const radius = .95+point.size*.56+6.5*swell;
      if (previous) {
        const distance = Math.hypot(previous.x-point.x,previous.y-point.y);
        const gain = Math.min(1,w*.29/Math.max(1,distance));
        line(ctx,previous,point,rgb(point.c,(.11+.52*Math.sqrt(point.volume))*opacity*gain),.75+point.volume);
      }
      if (opacity>.085) hit.push(point);
      points.push({...point,opacity,radius,swell});
      previous=point;
      latest=point;
    }
    points.sort((a,b)=>b.d-a.d);
    for (const a of points) {
      if (a.i%6!==0 && a.i!==latest?.i) continue;
      if (a.swell>.12) {
        circle(ctx,a.x,a.y,a.radius*2.9,rgb(a.c,.09*a.opacity*a.swell));
        circle(ctx,a.x,a.y,a.radius*1.65,rgb(a.c,.28*a.opacity*a.swell));
      }
      circle(ctx,a.x,a.y,a.radius,rgb(a.c,(.18+.63*Math.sqrt(a.volume)+.16*a.swell)*a.opacity));
      if (a.swell>.32) circle(ctx,a.x-a.radius*.18,a.y-a.radius*.21,a.radius*.37,'rgba(255,246,222,'+(.65*a.opacity*a.swell)+')');
    }
    const head = projectFrame(Math.max(0,last),p,w,h);
    const headAge = previewTime-last/FRAMES_PER_SECOND;
    if (head?.visible && last>=0 && headAge<.18) {
      const glow=1-headAge/.18;
      if (latest && last-latest.i<=step && latest.i!==last) line(ctx,latest,head,rgb(head.c,.65*glow),1.1);
      circle(ctx,head.x,head.y,2.1+head.size*.32,rgb(head.c,.94*glow));
      hit.push(head);
      trailHead=head.i;
    } else if (hit.length) trailHead=hit.at(-1).i;
    if (inspectedFrame !== null) {
      const point = projectFrame(inspectedFrame,p,w,h);
      if (point) {
        ctx.strokeStyle='#edfff6d9'; ctx.lineWidth=1.25; ctx.beginPath(); ctx.arc(point.x,point.y,8,0,Math.PI*2); ctx.stroke();
      }
    }
  }
  function draw2d({ctx,w,h}) {
    const left = 46, right = w - 17, top = 58, bottom = h - 45;
    const duration = Math.max(.01,data.n / 100);
    const x = time => left + time / duration * (right-left);
    const y = value => bottom - value * (bottom-top);
    ctx.font = '9px monospace';
    for (let k=0;k<=4;k++) {
      const yAt = y(k/4);
      line(ctx,{x:left,y:yAt},{x:right,y:yAt},'#324551');
      ctx.fillStyle='#a5b6bf';
      ctx.fillText(mode==='pitch' ? (k*peakMax/4000).toFixed(1)+'k' : (k/4).toFixed(2),10,yAt+3);
    }
    for (let k=0;k<=4;k++) {
      const xAt = x(k/4*duration);
      line(ctx,{x:xAt,y:top},{x:xAt,y:bottom},'#233945');
      ctx.fillStyle='#a5b6bf'; ctx.fillText((k/4*duration).toFixed(1)+'s',xAt-9,bottom+15);
    }
    if (mode==='pitch') {
      if (!raster) {
        const grid = document.createElement('canvas');
        grid.width = data.n; grid.height = 128;
        const brush = grid.getContext('2d'), pixels = brush.createImageData(grid.width,grid.height);
        const rowMap = Array.from({length:grid.height},(_, row) => {
          const hz = (1 - row / (grid.height-1)) * peakMax;
          return data.bandHz.reduce((best,f,i) => Math.abs(f-hz) < Math.abs(data.bandHz[best]-hz) ? i : best,0);
        });
        for (let col=0;col<grid.width;col++) for (let row=0;row<grid.height;row++) {
          const band = data.bands[col*64+rowMap[row]];
          const brightness = clamp((band - Math.max(data.minBand, data.maxBand - 17))/17,0,1);
          const rgb = color(.18+brightness*.82);
          const offset = (row*grid.width+col)*4;
          pixels.data.set([...rgb,Math.round(brightness ** 1.55 * 215)],offset);
        }
        brush.putImageData(pixels,0,0);
        raster=grid;
      }
      ctx.drawImage(raster,left,top,right-left,bottom-top);
    }
    if (selected) {
      ctx.fillStyle='#091119a9';
      let end = 0;
      for (const [a,b] of selected) { ctx.fillRect(x(end),top,Math.max(0,x(a)-x(end)),bottom-top); end=b; }
      ctx.fillRect(x(end),top,Math.max(0,x(duration)-x(end)),bottom-top);
    }
    hit = [];
    const stride = Math.max(1, Math.floor(data.n / 1000));
    for (let i=0;i<data.n;i+=stride) {
      const [t,rms,centroid,peak] = data.metadata.subarray(i*4,i*4+4);
      const a={x:x(t),y:y(clamp(mode==='pitch' ? peak/peakMax : rms/Math.max(.00001,data.maxRms),0,1)),i};
      hit.push(a);
      if (!highlight(t) || rms < data.maxRms*.035) continue;
      const hue = color(centroid/maxCentroid);
      if (mode==='energy') line(ctx,a,{x:a.x,y:bottom},rgb(hue,.28),1);
      circle(ctx,a.x,a.y,mode==='pitch' ? 1.15 : 1.6,rgb(hue,mode==='pitch' ? .68 : .92));
    }
    if (showingPlayhead) line(ctx,{x:x(currentTime),y:top},{x:x(currentTime),y:bottom},'#c4ffdf',1.4);
    ctx.fillStyle='#9ab2bf'; ctx.fillText(mode==='pitch' ? 'FREQUENCY (Hz)' : 'RELATIVE RMS',left,top-9);
  }
  function pick(event) {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let closest, distance = is3d() ? 23 : 65;
    for (const a of hit) {
      const d = is3d() ? Math.hypot(a.x-x,a.y-y) : Math.abs(a.x-x);
      if (d < distance) { closest = a; distance = d; }
    }
    onPick(closest?.i,mode==='spectrogram' ? closest : undefined);
  }
  function span() {
    const [a,b] = pointers.values();
    return Math.hypot(a.x-b.x,a.y-b.y);
  }
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (pointers.size===1) { pointerStart = {x:e.clientX,y:e.clientY}; pinched = false; }
    if (pointers.size===2) pinched = true;
  });
  canvas.addEventListener('pointermove',e => {
    const previous=pointers.get(e.pointerId);
    if (!previous || !is3d()) return;
    const oldSpan = pointers.size===2 ? span() : 0;
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if (oldSpan) camera.zoom=clamp(camera.zoom*span()/oldSpan,.55,2.7);
    else if (pointers.size===1) {
      camera.yaw+=(e.clientX-previous.x)*.009;
      camera.pitch=clamp(camera.pitch+(e.clientY-previous.y)*.009,-1.55,1.55);
    }
    redrawProjection();
  });
  canvas.addEventListener('pointerup',e => {
    pointers.delete(e.pointerId);
    if (!pointers.size && !pinched && pointerStart && Math.hypot(e.clientX-pointerStart.x,e.clientY-pointerStart.y)<7) pick(e);
  });
  canvas.addEventListener('pointercancel',e=>pointers.delete(e.pointerId));
  canvas.addEventListener('wheel',e => {
    if (!is3d()) return;
    e.preventDefault();
    camera.zoom=clamp(camera.zoom*Math.exp(-e.deltaY*.0015),.55,2.7);
    redrawProjection();
  },{passive:false});
  canvas.addEventListener('keydown',e => {
    if (e.key==='Escape') { onPick(); return; }
    if (e.key==='Enter' || e.key===' ') {
      e.preventDefault();
      if (data && mode==='spectrogram') {
        const frame=frameAt(currentTime);
        const point=hit.reduce((best,cell)=>{
          if (!best) return cell;
          const distance=Math.abs(cell.i-frame), nearest=Math.abs(best.i-frame);
          return distance<nearest || (distance===nearest && cell.db>best.db) ? cell : best;
        },null);
        onPick(point?.i,point);
      } else if (data) onPick(mode==='manifold' && manifold==='animated' ? trailHead ?? undefined : frameAt(currentTime));
      return;
    }
    if (!is3d()) return;
    const keys = {ArrowLeft:[-.15,0],ArrowRight:[.15,0],ArrowUp:[0,-.15],ArrowDown:[0,.15]};
    if (keys[e.key]) { e.preventDefault(); camera.yaw+=keys[e.key][0]; camera.pitch=clamp(camera.pitch+keys[e.key][1],-1.55,1.55); redrawProjection(); }
    if (e.key==='+' || e.key==='-') { camera.zoom=clamp(camera.zoom*(e.key==='+' ? 1.14 : .88),.55,2.7); redrawProjection(); }
  });
  new ResizeObserver(invalidate).observe(canvas);
  return {
    data(next) {
      data=next;
      raster=null;
      spectralGrid=null;
      previousTick=null;
      inspectedFrame=null;
      if (next) {
        previewTime=nextPreviewTime(currentTime);
        const magnitudes=Array.from({length:next.n},(_,i)=>Math.hypot(...next.coords.subarray(i*3,i*3+3))).sort((a,b)=>a-b);
        scale=Math.max(1,magnitudes[Math.floor((magnitudes.length-1)*.992)] / 1.08);
        maxCentroid=Math.max(1000,Math.ceil(next.maxCentroid/1000)*1000);
        peakMax=Math.max(4000,Math.min(16000,Math.ceil(maxCentroid/4000)*4000));
      }
      redrawProjection();
      return maxCentroid;
    },
    view(next) {mode=next;camera=next==='spectrogram'?spectrumCamera:manifoldCamera;previousTick=null;invalidate();},
    manifold(next) {manifold=next;previousTick=null;invalidate();},
    pauseAnimation(paused,index = null) {
      animationPaused=paused;
      inspectedFrame=paused ? index : null;
      previousTick=null;
      if (!paused && audioPlaying) previewTime=currentTime;
      if (!paused && !audioPlaying && data) previewTime=nextPreviewTime(previewTime);
      invalidate();
    },
    reset() {
      Object.assign(camera,mode==='spectrogram'?{yaw:-.54,pitch:-.53,zoom:1}:{yaw:-.47,pitch:-.37,zoom:1});
      redrawProjection();
    },
    selection(windows) {
      if (selected===windows) return;
      selected=windows;
      inspectedFrame=null;
      if (data && !audioPlaying) previewTime=nextPreviewTime(previewTime);
      redrawProjection();
    },
    seek(t) {
      previousTick=null;
      previewTime=t;
      inspectedFrame=animationPaused && data ? frameAt(t) : null;
      if (data && !audioPlaying && !animationPaused) previewTime=nextPreviewTime(t);
      invalidate();
    },
    time(t,visible,playing = false) {
      currentTime=t;
      showingPlayhead=visible;
      audioPlaying=playing;
      if (playing && !animationPaused) previewTime=t;
      invalidate();
    }
  };
}

export function drawWave(canvas, samples, fraction, windows) {
  const area=fit(canvas);
  if (!area || !samples) return;
  const {ctx,w,h}=area;
  const count=Math.max(20, Math.floor(w/3));
  const dur=samples.length/48000;
  for (let i=0;i<count;i++) {
    const x=(i+.5)*w/count, at=i/count;
    const start=Math.floor(i/count*samples.length), end=Math.floor((i+1)/count*samples.length);
    let peak=0;
    for (let j=start;j<end;j+=Math.max(1,Math.floor((end-start)/160))) peak=Math.max(peak,Math.abs(samples[j]));
    const size=Math.min(h-3,2+Math.sqrt(peak)*h*1.2);
    const active = windows?.some(([a,b])=>at*dur>=a&&at*dur<=b);
    line(ctx,{x,y:(h-size)/2},{x,y:(h+size)/2},at<=fraction?'#adefd7':active?'#78c0af':'#486571',1.25);
  }
}
