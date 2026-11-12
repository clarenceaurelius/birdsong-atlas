// Samples are [frequency in Hz, level in dBFS, slope in Hz/s, track ID].
export const CALL_POINT_STRIDE = 4;
const PEAK_LIMIT = 8;
const MIN_TRACK_FRAMES = 4;

function findPeaks(levels, offset, bins, binHz, minDb) {
  const spectrum=levels.subarray(offset,offset+bins);
  let strongest=0;
  for (const level of spectrum) strongest=Math.max(strongest,level);
  const threshold=Math.max(-78-minDb,strongest-34);
  const peaks=[];
  for (let b=2;b<bins-1;b++) {
    const level=spectrum[b], left=spectrum[b-1], right=spectrum[b+1];
    if (level<threshold || level<left || level<=right) continue;
    let leftFloor=level, rightFloor=level;
    for (let k=1;k<=5;k++) {
      leftFloor=Math.min(leftFloor,spectrum[Math.max(0,b-k)]);
      rightFloor=Math.min(rightFloor,spectrum[Math.min(bins-1,b+k)]);
    }
    if (level-Math.max(leftFloor,rightFloor)<5) continue;
    const bend=left-2*level+right;
    const fraction=bend ? .5*(left-right)/bend : 0;
    peaks.push({hz:(b+fraction)*binHz,db:Math.min(0,level+minDb-.25*(left-right)*fraction)});
  }
  return peaks.sort((a,b)=>b.db-a.db).slice(0,PEAK_LIMIT);
}

function matchPeaks(active, peaks, binHz) {
  const costs=active.map(track=>{
    const last=track.samples.at(-1);
    const velocity=last.hz-(track.samples.at(-2)?.hz ?? last.hz);
    const range=Math.max(180,last.hz*.035)+Math.min(320,1.4*Math.abs(velocity));
    return peaks.map(peak=>{
      const distance=Math.abs(peak.hz-last.hz-velocity);
      return distance<=range ? distance+3*Math.abs(peak.db-last.db) : Infinity;
    });
  });
  function unambiguous(costs) {
    let index=-1, best=Infinity, next=Infinity;
    costs.forEach((cost,i)=>{
      if (cost<best) {next=best;best=cost;index=i;}
      else if (cost<next) next=cost;
    });
    return next-best>1.25*binHz ? index : -1;
  }
  const matches=costs.map(row=>unambiguous(row));
  matches.forEach((peak,track)=>{
    if (peak>=0 && unambiguous(costs.map(row=>row[peak]))!==track) matches[track]=-1;
  });
  const crossed=new Set();
  for (let a=0;a<matches.length;a++) {
    if (matches[a]<0) continue;
    for (let b=a+1;b<matches.length;b++) {
      if (matches[b]<0) continue;
      const before=active[a].samples.at(-1).hz-active[b].samples.at(-1).hz;
      const after=peaks[matches[a]].hz-peaks[matches[b]].hz;
      if (before*after<=0) {crossed.add(a);crossed.add(b);}
    }
  }
  for (const i of crossed) matches[i]=-1;
  return matches;
}

export function trackCalls(levels, frameCount, bins, binHz, minDb, frameSeconds) {
  const tracks=[];
  let active=[];
  for (let frame=0;frame<frameCount;frame++) {
    const peaks=findPeaks(levels,frame*bins,bins,binHz,minDb);
    const matches=matchPeaks(active,peaks,binHz);
    const continued=new Map(matches.flatMap((peak,i)=>peak<0?[]:[[peak,active[i]]]));
    active=peaks.map((peak,index)=>{
      const previous=continued.get(index);
      if (previous) {
        previous.samples.push(peak);
        return previous;
      }
      const track={start:frame,samples:[peak]};
      tracks.push(track);
      return track;
    });
  }

  const offsets=new Uint32Array(frameCount+1);
  tracks.forEach(({start,samples})=>{
    if (samples.length<MIN_TRACK_FRAMES) return;
    samples.forEach((_,i)=>offsets[start+i+1]++);
  });
  for (let i=1;i<offsets.length;i++) offsets[i]+=offsets[i-1];
  const points=new Float32Array(offsets.at(-1)*CALL_POINT_STRIDE);
  const positions=offsets.slice(0,-1);
  let maxSlope=0;
  tracks.forEach(({start,samples},id)=>{
    if (samples.length<MIN_TRACK_FRAMES) return;
    samples.forEach(({hz,db},i)=>{
      // Local linear fit over up to five frames reduces bin-to-bin jitter.
      const low=Math.max(0,i-2), high=Math.min(samples.length-1,i+2);
      const mid=(low+high)/2;
      let covariance=0, variance=0;
      for (let j=low;j<=high;j++) {
        const centered=j-mid;
        covariance+=centered*(samples[j].hz-hz);
        variance+=centered*centered;
      }
      const slope=covariance/(variance*frameSeconds);
      maxSlope=Math.max(maxSlope,Math.abs(slope));
      const offset=positions[start+i]++*CALL_POINT_STRIDE;
      points.set([hz,db,slope,id],offset);
    });
  });
  return {points,offsets,maxSlope};
}
