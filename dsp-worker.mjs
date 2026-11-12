import {analyze, makeDemo} from './dsp.mjs';
self.onmessage = ({data}) => {
  try {
    const signal = data.demo ? makeDemo() : data.signal;
    const result = analyze(signal);
    const transfer = [result.coords.buffer, result.metadata.buffer, result.mfcc.buffer, result.bands.buffer, result.recurrence.buffer, result.spectralLevels.buffer];
    if (data.demo) transfer.push(signal.buffer);
    self.postMessage({result, ...(data.demo && {signal})}, transfer);
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
