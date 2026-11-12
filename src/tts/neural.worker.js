// Runs the Piper neural voice off the main thread so reading stays smooth.
import { TtsSession, stored, remove, PATH_MAP, HF_BASE } from '@mintplex-labs/piper-tts-web';

// The library saves models in OPFS, but some browsers (older Safari) can't
// write files there and it fails silently. In that case keep the downloaded
// models in Cache Storage instead, so they still work offline.
const MODEL_CACHE = 'lector-models';
const opfsWritable = typeof FileSystemFileHandle !== 'undefined' && 'createWritable' in FileSystemFileHandle.prototype;
if (!opfsWritable && typeof caches !== 'undefined') {
  const realFetch = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith(HF_BASE)) return realFetch(input, init);
    const cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return hit;
    const res = await realFetch(input, init);
    if (res.ok) cache.put(url, res.clone()).catch(() => {});
    return res;
  };
}

async function storedVoices() {
  if (opfsWritable) return stored();
  if (typeof caches === 'undefined') return [];
  const keys = new Set((await (await caches.open(MODEL_CACHE)).keys()).map((r) => r.url));
  return Object.keys(PATH_MAP).filter((id) => keys.has(`${HF_BASE}/${PATH_MAP[id]}`));
}

async function removeVoice(voiceId) {
  if (opfsWritable) return remove(voiceId);
  const cache = await caches.open(MODEL_CACHE);
  const path = `${HF_BASE}/${PATH_MAP[voiceId]}`;
  await Promise.all([cache.delete(path), cache.delete(`${path}.json`)]);
}

let session = null;
let sessionVoice = null;
let baseUrl = '';

function wasmPaths() {
  return {
    onnxWasm: new URL('vendor/ort/', baseUrl).href,
    piperData: new URL('vendor/piper/piper_phonemize.data', baseUrl).href,
    piperWasm: new URL('vendor/piper/piper_phonemize.wasm', baseUrl).href,
  };
}

async function load(voiceId) {
  if (session && sessionVoice === voiceId) return;
  // The library keeps a singleton; reset it so a new voice really loads its own model.
  TtsSession._instance = null;
  session = null;
  sessionVoice = null;
  const s = await TtsSession.create({
    voiceId,
    wasmPaths: wasmPaths(),
    progress: (p) => {
      if (p.url && p.url.startsWith('tts://')) return;
      self.postMessage({ type: 'progress', voiceId, loaded: p.loaded, total: p.total });
    },
  });
  session = s;
  sessionVoice = voiceId;
}

// Handle one message at a time: loading a voice while another is synthesizing would clash.
let chain = Promise.resolve();
self.onmessage = (e) => {
  if (e.data.type === 'stored' || e.data.type === 'init') handle(e.data); // quick, read-only
  else chain = chain.then(() => handle(e.data));
};

async function handle(msg) {
  try {
    if (msg.type === 'init') {
      baseUrl = msg.baseUrl;
      self.postMessage({ type: 'inited' });
    } else if (msg.type === 'load') {
      await load(msg.voiceId);
      self.postMessage({ type: 'ready', id: msg.id, voiceId: msg.voiceId });
    } else if (msg.type === 'synth') {
      await load(msg.voiceId);
      const blob = await session.predict(msg.text);
      self.postMessage({ type: 'audio', id: msg.id, blob });
    } else if (msg.type === 'stored') {
      self.postMessage({ type: 'stored', id: msg.id, voices: await storedVoices() });
    } else if (msg.type === 'remove') {
      await removeVoice(msg.voiceId);
      if (sessionVoice === msg.voiceId) {
        TtsSession._instance = null;
        session = null;
        sessionVoice = null;
      }
      self.postMessage({ type: 'removed', id: msg.id });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
}
