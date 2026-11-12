import {analyze, makeDemo, createLivePca} from './dsp.mjs';
let livePca;
self.onmessage = ({data}) => {
  try {
    if (data.inputRate) {livePca=createLivePca(data.inputRate);return;}
    if (data.live) {
      const result=livePca(data.live,data.startSample);
      self.postMessage({result},result?[result.coords.buffer,result.metadata.buffer,result.active.buffer]:[]);
      return;
    }
    const signal = data.demo ? makeDemo() : data.signal;
    const result = analyze(signal);
    const transfer = [result.coords.buffer, result.metadata.buffer, result.mfcc.buffer, result.bands.buffer, result.recurrence.buffer, result.spectralLevels.buffer];
    transfer.push(result.callTracks.points.buffer,result.callTracks.offsets.buffer);
    if (data.demo) transfer.push(signal.buffer);
    self.postMessage({result, ...(data.demo && {signal})}, transfer);
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
