import {trackCalls} from './call-tracks.mjs';

export const RATE = 48000;
const FFT_SIZE = 2048, HOP = 480, MEL_COUNT = 64, MFCC_COUNT = 40;
export const TRAIL_SECONDS = 5.5;
export const SPECTRUM_MAX_HZ = 16000;
export const SPECTRUM_BIN_HZ = RATE / FFT_SIZE;
export const SPECTRUM_MIN_DB = -100;
export const SPECTRUM_BINS = Math.floor(SPECTRUM_MAX_HZ / SPECTRUM_BIN_HZ) + 1;
const PITCH_RATIO = 2 ** (.85 / 12);
const TAU = 2 * Math.PI;
const hann = Float64Array.from({length: FFT_SIZE}, (_, i) => .5 - .5 * Math.cos(TAU * i / (FFT_SIZE - 1)));
const fftAmplitudeScale = 2 / hann.reduce((sum,value)=>sum+value,0);
const dct = Array.from({length: MFCC_COUNT}, (_, k) => Float64Array.from({length: MEL_COUNT}, (_, j) =>
  Math.cos(Math.PI * k * (j + .5) / MEL_COUNT) * Math.sqrt((k ? 2 : 1) / MEL_COUNT)));
const toMel = hz => 2595 * Math.log10(1 + hz / 700);
const fromMel = mel => 700 * (10 ** (mel / 2595) - 1);
const edges = Array.from({length: MEL_COUNT + 2}, (_, i) =>
  fromMel(toMel(100) + (toMel(16000) - toMel(100)) * i / (MEL_COUNT + 1)));
const melBank = Array.from({length:MEL_COUNT}, (_, m) => {
  const [lo, mid, hi] = edges.slice(m, m + 3);
  const bins = [];
  for (let bin = Math.ceil(lo * FFT_SIZE / RATE); bin * RATE / FFT_SIZE < hi; bin++) {
    const hz = bin * RATE / FFT_SIZE;
    bins.push([bin, hz < mid ? (hz - lo) / (mid - lo) : (hi - hz) / (hi - mid)]);
  }
  return bins;
});
const reverse = Uint16Array.from({length:FFT_SIZE}, (_, i) => {
  let j = 0;
  for (let bit = 1; bit < FFT_SIZE; bit *= 2) { j = j * 2 + (i & 1); i >>= 1; }
  return j;
});
const twiddles = [];
for (let size = 2; size <= FFT_SIZE; size *= 2) {
  const half = size / 2;
  twiddles.push([size,
    Float64Array.from({length: half}, (_, k) => Math.cos(-TAU * k / size)),
    Float64Array.from({length: half}, (_, k) => Math.sin(-TAU * k / size))]);
}
function spectrum(signal, offset, real, imag, power) {
  let energy = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    const sample = signal[offset + i] || 0;
    energy += sample * sample;
    real[reverse[i]] = sample * hann[i];
  }
  imag.fill(0);
  for (const [size, cos, sin] of twiddles) {
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const a = start + k, b = a + size / 2;
        const r = real[b] * cos[k] - imag[b] * sin[k];
        const im = real[b] * sin[k] + imag[b] * cos[k];
        real[b] = real[a] - r;
        imag[b] = imag[a] - im;
        real[a] += r;
        imag[a] += im;
      }
    }
  }
  let total = 0, totalPower = 0, weighted = 0, peak = 0;
  for (let bin = 0; bin < power.length; bin++) {
    power[bin] = real[bin] ** 2 + imag[bin] ** 2;
    if (!bin) continue;
    const magnitude = Math.sqrt(power[bin]);
    total += magnitude;
    totalPower += power[bin];
    weighted += bin * magnitude;
    if (power[bin] > power[peak] || peak === 0) peak = bin;
  }
  let nearPeak = 0;
  for (let bin = Math.max(1,peak-2); bin <= Math.min(power.length-1,peak+2); bin++) nearPeak += power[bin];
  const hzPerBin = RATE / FFT_SIZE;
  return {rms: Math.sqrt(energy / FFT_SIZE), centroid: total ? weighted / total * hzPerBin : 0,
    peak: total ? peak * hzPerBin : 0, tonalShare: totalPower ? nearPeak / totalPower : 0};
}

function pitchRecurrence(metadata, tonalShare, maxRms) {
  const pitch = Float32Array.from(tonalShare,(share,i) => {
    const rms = metadata[i*4+1], peak = metadata[i*4+3];
    return share >= .18 && rms >= Math.max(.0002,maxRms*.028) && peak >= 280 ? peak : 0;
  });
  const history = Math.round(TRAIL_SECONDS * RATE / HOP);
  const step = 3;
  const scores = new Float32Array(pitch.length);
  for (let i=0;i<pitch.length;i++) {
    if (!pitch[i]) continue;
    const tolerance = Math.max(RATE/FFT_SIZE, pitch[i]*(PITCH_RATIO-1));
    let gap = 0, score = 0;
    // A run of matching frames is one note. Count older matches only across a gap.
    for (let j=i-step;j>=Math.max(0,i-history);j-=step) {
      if (!pitch[j] || Math.abs(pitch[i]-pitch[j]) > tolerance) {
        gap += step;
        continue;
      }
      if (gap >= 9) {
        score += 2 ** (-(i-j)/400);
        if (score >= 3) break;
      }
      gap = 0;
    }
    scores[i] = Math.min(3,score);
  }
  return scores;
}

export function projectPca(matrix, rowCount, dims = MFCC_COUNT) {
  const mean = new Float64Array(dims);
  for (let row = 0; row < rowCount; row++) {
    for (let j = 0; j < dims; j++) mean[j] += matrix[row * dims + j] / rowCount;
  }
  const cov = Array.from({length:dims}, () => new Float64Array(dims));
  const centered = new Float64Array(dims);
  for (let row = 0; row < rowCount; row++) {
    for (let j = 0; j < dims; j++) centered[j] = matrix[row * dims + j] - mean[j];
    for (let j = 0; j < dims; j++) {
      for (let k = 0; k <= j; k++) cov[j][k] += centered[j] * centered[k] / Math.max(1, rowCount - 1);
    }
  }
  for (let j = 0; j < dims; j++) for (let k = 0; k < j; k++) cov[k][j] = cov[j][k];
  const trace = cov.reduce((total, row, i) => total + row[i], 0);
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const vectors = [], variances = [];
  for (let axis = 0; axis < 3; axis++) {
    let vector = Float64Array.from({length:dims}, (_, i) => Math.sin((i + 1) * (axis + 1.5)) + .15);
    const initialNorm = Math.hypot(...vector);
    vector = vector.map(value => value / initialNorm);
    for (let step = 0; step < 180; step++) {
      const next = Float64Array.from(cov, row => dot(row, vector));
      for (const prev of vectors) {
        const overlap = dot(next, prev);
        for (let i = 0; i < dims; i++) next[i] -= overlap * prev[i];
      }
      const length = Math.hypot(...next);
      if (length < 1e-13) { vector.fill(0); break; }
      for (let i = 0; i < dims; i++) next[i] /= length;
      const aligned = Math.abs(dot(next, vector)) > 1 - 1e-11;
      vector = next;
      if (aligned) break;
    }
    const largest = vector.reduce((index, v, i) => Math.abs(v) > Math.abs(vector[index]) ? i : index, 0);
    if (vector[largest] < 0) vector = vector.map(v => -v);
    vectors.push(vector);
    variances.push(Math.max(0, dot(vector, Float64Array.from(cov, row => dot(row, vector)))));
  }
  const coords = new Float32Array(rowCount * 3);
  for (let row = 0; row < rowCount; row++) {
    for (let j = 0; j < dims; j++) centered[j] = matrix[row * dims + j] - mean[j];
    vectors.forEach((vector, axis) => { coords[row * 3 + axis] = dot(vector, centered); });
  }
  return {coords, explained: trace ? variances.map(v => v / trace) : [0, 0, 0]};
}

export function analyze(signal) {
  const n = Math.max(1, Math.ceil(signal.length / HOP));
  const mfcc = new Float32Array(n * MFCC_COUNT);
  const bands = new Float32Array(n * MEL_COUNT);
  const spectralLevels = new Uint8Array(n * SPECTRUM_BINS);
  const metadata = new Float32Array(n * 4);
  const tonal = new Float32Array(n);
  const real = new Float64Array(FFT_SIZE), imag = new Float64Array(FFT_SIZE);
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  let maxRms = 0, minBand = Infinity, maxBand = -Infinity, maxCentroid = 0;
  for (let frame = 0; frame < n; frame++) {
    const {rms, centroid, peak, tonalShare} = spectrum(signal, frame * HOP - FFT_SIZE / 2, real, imag, power);
    for (let bin=0;bin<SPECTRUM_BINS;bin++) {
      const amplitude=Math.sqrt(power[bin])*fftAmplitudeScale*(bin===0 ? .5 : 1);
      const level=20*Math.log10(amplitude);
      spectralLevels[frame*SPECTRUM_BINS+bin]=Math.round(Math.max(SPECTRUM_MIN_DB,Math.min(0,level))-SPECTRUM_MIN_DB);
    }
    metadata.set([frame * HOP / RATE, rms, centroid, peak], frame * 4);
    tonal[frame] = tonalShare;
    maxRms = Math.max(maxRms, rms);
    maxCentroid = Math.max(maxCentroid, centroid);
    for (let m = 0; m < MEL_COUNT; m++) {
      let sum = 0;
      for (const [bin, weight] of melBank[m]) sum += power[bin] * weight;
      const value = Math.log(Math.max(sum, 1e-8));
      bands[frame * MEL_COUNT + m] = value;
      minBand = Math.min(minBand, value);
      maxBand = Math.max(maxBand, value);
    }
    for (let c = 0; c < MFCC_COUNT; c++) {
      let sum = 0;
      for (let m = 0; m < MEL_COUNT; m++) sum += bands[frame * MEL_COUNT + m] * dct[c][m];
      mfcc[frame * MFCC_COUNT + c] = sum;
    }
  }
  return {n, duration:signal.length/RATE, spectralLevels, ...projectPca(mfcc, n), metadata, mfcc, bands, recurrence: pitchRecurrence(metadata,tonal,maxRms), maxRms, minBand, maxBand,
    maxCentroid, bandHz: edges.slice(1, -1),
    callTracks:trackCalls(spectralLevels,n,SPECTRUM_BINS,SPECTRUM_BIN_HZ,SPECTRUM_MIN_DB,HOP/RATE)};
}

export const demoBirds = [
  {name:'Common Blackbird', sci:'Turdus merula', score:.98, windows:[[.9,3.8],[6.6,9.7],[12.3,15.2]]},
  {name:'European Robin', sci:'Erithacus rubecula', score:.91, windows:[[3.2,6.1],[8.6,11.3],[15.1,18.2]]},
  {name:'Great Tit', sci:'Parus major', score:.84, windows:[[5.5,8.2],[10.7,13.5],[16.2,18.4]]}
];
export function makeDemo() {
  const signal = new Float32Array(Math.floor(18.6 * RATE));
  let seed = 14937, ambience = 0, air = 0;
  const noise = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  for (let i = 0; i < signal.length; i++) {
    ambience = .972 * ambience + .028 * noise();
    air = .35 * air + .65 * noise();
    signal[i] = .04 * ambience + .0015 * air;
  }
  function chirp(start, length, f0, f1, timbre, strength, contour) {
    let phase = noise() * TAU;
    const offset = Math.floor(start * RATE), count = Math.round(length * RATE);
    for (let n = 0; n < count && offset + n < signal.length; n++) {
      const u = n / count;
      const f = f0 + (f1 - f0) * u + contour * Math.sin(Math.PI * u * (timbre === 1 ? 2 : 1));
      phase += TAU * f / RATE;
      const envelope = Math.sin(Math.PI * u) ** .7 * (.89 + .11 * Math.cos(TAU * u * 3));
      signal[offset + n] += strength * envelope * (Math.sin(phase) +
        (.17 + .09 * Math.sin(TAU * u)) * Math.sin(2 * phase) + .05 * Math.sin((timbre + 3) * phase) + .045 * noise());
    }
  }
  demoBirds.forEach((bird, index) => bird.windows.forEach(([start, end], phrase) => {
    let at = start + .08;
    let i = 0;
    while (at + .14 < end) {
      const length = (index === 0 ? .23 : index === 1 ? .11 : .16) + .06 * (noise() + 1);
      const base = index === 0 ? 1330 + 390 * Math.sin(i + phrase) : index === 1 ? 3300 + 570 * Math.sin(1.7 * i + phrase) : i % 2 ? 3860 : 4950;
      const strength = (index === 0 ? .22 : index === 1 ? .13 : .115) * (.81 + .17 * noise());
      chirp(at, Math.min(length, end - at), base, base + (index === 1 ? 970 : 350) * noise(), index, strength, 410 * noise());
      at += length + (index === 0 ? .1 : .036) + .035 * (noise() + 1);
      i++;
    }
  }));
  return signal;
}

export function makeWav(signal) {
  const bytes = new ArrayBuffer(44 + signal.length * 2), view = new DataView(bytes);
  const word = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  word(0,'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); word(8,'WAVE');
  word(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,RATE,true); view.setUint32(28,RATE * 2,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  word(36,'data'); view.setUint32(40,signal.length * 2,true);
  for (let i = 0; i < signal.length; i++) view.setInt16(44 + 2 * i, Math.round(Math.max(-1,Math.min(1,signal[i])) * 32767), true);
  return new Blob([bytes], {type:'audio/wav'});
}
