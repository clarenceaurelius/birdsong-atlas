const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const ACOUSTIC = 'https://huggingface.co/tphakala/BirdNET-v2.4/resolve/main/';
const GEO = 'https://huggingface.co/tphakala/BirdNET-Geomodel/resolve/main/';
const RATE = 48000, WINDOW = 3 * RATE, STEP = 1.5 * RATE, THRESHOLD = .26;
const nonBirdName = /(?:frog|toad|squirrel|cricket|katydid|cicada|chipmunk|marmot|monkey|gibbon|bat|deer|fox|wolf|coyote|jackal|seal|raccoon|opossum|marten|whale|dolphin)(?:s)?$/i;
const ignore = /^(?:human(?:\s|$)|noise(?:\s|$)|no.?call(?:\s|$)|non.?event(?:\s|$)|dog(?:\s|$)|cat(?:\s|$)|engine(?:\s|$)|vehicle(?:\s|$)|environment(?:\s|$)|fireworks(?:\s|$)|gun(?:\s|$)|siren(?:\s|$)|thunder(?:\s|$)|rain(?:\s|$)|wind(?:\s|$)|silence(?:\s|$)|insect(?:\s|$)|other(?:\s|$))/i;
let runtime, acoustic, geo, detections, occurrence, active = Promise.resolve();

function getRuntime() {
  runtime ??= import(RUNTIME + 'ort.wasm.min.mjs').then(ort => {
    ort.env.wasm.wasmPaths = RUNTIME;
    ort.env.wasm.numThreads = 1;
    return ort;
  }).catch(error => { runtime = null; throw error; });
  return runtime;
}
async function getLabels(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load model labels.');
  const raw = await response.text();
  return raw.trim().split(/\r?\n/).map(line => {
    const [sci, ...rest] = line.trim().split('_');
    return {sci, name:rest.join('_') || sci};
  });
}
async function load(base, model, labels) {
  const [ort, vocabulary] = await Promise.all([getRuntime(), getLabels(base + labels)]);
  // Fetch model bytes explicitly so file-download or redirect failures surface as such.
  const response = await fetch(base + model);
  if (!response.ok) throw new Error('Could not download the BirdNET model.');
  const session = await ort.InferenceSession.create(await response.arrayBuffer(), {executionProviders:['wasm'], graphOptimizationLevel:'all'});
  return {ort, vocabulary, session};
}
const sigmoid = x => 1 / (1 + Math.exp(-x));
function addWindow(entry, start, end) {
  const last = entry.windows.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else entry.windows.push([start, end]);
}

async function identify(signal, id) {
  self.postMessage({id, stage:'Loading BirdNET model…'});
  acoustic ??= load(ACOUSTIC, 'BirdNET_v2.4_fp32_foldconv.onnx', 'labels.txt')
    .catch(error => { acoustic = null; throw error; });
  const {ort, vocabulary, session} = await acoustic;
  const found = new Map();
  const lastStart = Math.max(0, signal.length - WINDOW);
  const starts = [];
  for (let start = 0; start < lastStart; start += STEP) starts.push(start);
  starts.push(lastStart);
  for (const [position, start] of starts.entries()) {
    self.postMessage({id, stage:'Identifying birds… ' + Math.round(100 * position / starts.length) + '%'});
    const clip = new Float32Array(WINDOW);
    clip.set(signal.subarray(start, start + WINDOW));
    if (!clip.some(x => Math.abs(x) > 1e-4)) continue;
    const tensor = new ort.Tensor('float32', clip, [1, WINDOW]);
    const out = await session.run({[session.inputNames[0]]:tensor});
    const prediction = out[session.outputNames[0]];
    if (prediction.data.length !== vocabulary.length) throw new Error('BirdNET vocabulary does not match the model.');
    for (let i = 0; i < prediction.data.length; i++) {
      const logit = prediction.data[i];
      if (logit < -1.047 || !Number.isFinite(logit)) continue;
      const score = sigmoid(logit);
      const bird = vocabulary[i];
      if (score < THRESHOLD || !/^[A-Z][a-z]+ [a-z]/.test(bird.sci) || ignore.test(bird.name) || nonBirdName.test(bird.name)) continue;
      const entry = found.get(i) || {...bird, score:0, windows:[]};
      entry.score = Math.max(entry.score, score);
      addWindow(entry, start / RATE, Math.min(signal.length, start + WINDOW) / RATE);
      found.set(i, entry);
    }
    tensor.dispose();
    prediction.dispose();
  }
  detections = [...found.values()];
  return rank(null);
}

async function rank(coords) {
  if (!detections) return {birds:[], used:false};
  let byName, geoError = false;
  if (coords && detections.length) {
    try {
      const key = [coords.lat, coords.lon, coords.week].join(',');
      if (occurrence?.key !== key) {
        geo ??= load(GEO, 'birdnet-geomodel-v3.0.4-fp32-b1.onnx', 'birdnet-geomodel-v3.0.4-labels-b1.txt')
          .catch(error => { geo = null; throw error; });
        const {ort, vocabulary, session} = await geo;
        const values = new ort.Tensor('float32', Float32Array.of(coords.lat, coords.lon, coords.week), [1, 3]);
        const out = await session.run({[session.inputNames[0]]:values});
        const prediction = out[session.outputNames[0]];
        if (prediction.data.length !== vocabulary.length) throw new Error('Geomodel vocabulary does not match the model.');
        byName = new Map(vocabulary.map((bird, i) => [bird.sci, prediction.data[i]]));
        occurrence = {key, byName};
        values.dispose();
        prediction.dispose();
      } else byName = occurrence.byName;
    } catch {
      geoError = true;
    }
  }
  let used = false;
  const birds = detections.map(bird => {
    const local = byName?.get(bird.sci);
    if (Number.isFinite(local)) {
      used = true;
      return {...bird, local, rank:bird.score * (.76 + .24 * Math.sqrt(Math.max(0, local)))};
    }
    return {...bird, rank:bird.score};
  }).sort((a,b) => b.rank - a.rank);
  return {birds, used, geoError};
}

self.onmessage = ({data}) => {
  active = active.catch(() => {}).then(async () => {
    try {
      const result = data.signal ? await identify(data.signal, data.id) : await rank(data.coords);
      self.postMessage({id:data.id, locationVersion:data.locationVersion, ...result});
    } catch (error) {
      self.postMessage({id:data.id, locationVersion:data.locationVersion, error:error.message});
    }
  });
};
