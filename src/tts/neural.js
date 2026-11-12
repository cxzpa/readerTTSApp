// Neural voice (Piper) running locally in a Web Worker.
// The model is downloaded once and then kept in the browser (OPFS), so it
// works offline afterwards.

export const NEURAL_VOICES = [
  { id: 'es_MX-claude-high', name: 'Claude', lang: 'es', region: 'México', quality: 'alta', mb: 63 },
  { id: 'es_MX-ald-medium', name: 'Ald', lang: 'es', region: 'México', quality: 'media', mb: 63 },
  { id: 'es_ES-davefx-medium', name: 'Davefx', lang: 'es', region: 'España', quality: 'media', mb: 63 },
  { id: 'es_ES-sharvard-medium', name: 'Sharvard', lang: 'es', region: 'España', quality: 'media', mb: 77 },
  { id: 'es_ES-carlfm-x_low', name: 'Carlfm (ligera)', lang: 'es', region: 'España', quality: 'baja', mb: 28 },
  { id: 'en_US-hfc_female-medium', name: 'HFC Female', lang: 'en', region: 'EE. UU.', quality: 'media', mb: 63 },
  { id: 'en_US-amy-medium', name: 'Amy', lang: 'en', region: 'EE. UU.', quality: 'media', mb: 63 },
  { id: 'en_US-lessac-medium', name: 'Lessac', lang: 'en', region: 'EE. UU.', quality: 'media', mb: 63 },
  { id: 'en_GB-jenny_dioco-medium', name: 'Jenny', lang: 'en', region: 'Reino Unido', quality: 'media', mb: 63 },
  { id: 'en_GB-alba-medium', name: 'Alba', lang: 'en', region: 'Reino Unido', quality: 'media', mb: 63 },
];

export function neuralTtsAvailable() {
  return typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined' && !!navigator.storage?.getDirectory;
}

let worker = null;
let nextId = 1;
const pending = new Map();
const progressListeners = new Set();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./neural.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        progressListeners.forEach((fn) => fn(msg));
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Error al iniciar la voz neuronal');
      pending.forEach((p) => p.reject(err));
      pending.clear();
    };
    worker.postMessage({ type: 'init', baseUrl: new URL('./', document.baseURI).href });
  }
  return worker;
}

function call(msg) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id });
  });
}

export function onNeuralProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}

export async function downloadedNeuralVoices() {
  if (!neuralTtsAvailable()) return [];
  try {
    return (await call({ type: 'stored' })).voices || [];
  } catch {
    return [];
  }
}

export function loadNeuralVoice(voiceId) {
  return call({ type: 'load', voiceId });
}

export function removeNeuralVoice(voiceId) {
  return call({ type: 'remove', voiceId });
}

export async function synthesize(voiceId, text) {
  return (await call({ type: 'synth', voiceId, text })).blob;
}

/**
 * Plays chunks with the neural voice. Audio for the next chunks is generated
 * ahead of time while the current one plays, so there are no gaps.
 */
export class NeuralEngine {
  constructor() {
    this.voiceId = NEURAL_VOICES[0].id;
    this.rate = 1;
    this.supportsResume = true;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.cache = new Map(); // text -> Promise<Blob>
    this.queue = []; // texts waiting for synthesis, in priority order
    this.busy = false;
    this.current = null;
    this.paused = false;
    this.onExternalPause = null;
    // The system can pause the element itself (a call, another app's audio).
    this.audio.addEventListener('pause', () => {
      // Our own pause()/stop() fire this event later (asynchronously): skip it.
      if (this.ownPause) {
        this.ownPause = false;
        return;
      }
      const entry = this.current;
      if (entry?.loaded && !this.paused && !this.audio.ended) {
        this.paused = true;
        this.onExternalPause?.();
      }
    });
    this.audio.addEventListener('play', () => {
      // Resumed by the system while the reader is paused: stop it again.
      if (this.paused && this.current) this.#pauseAudio();
    });
  }

  configure({ voiceId, rate }) {
    if (voiceId && voiceId !== this.voiceId) {
      this.voiceId = voiceId;
      this.queue.forEach((job) => job.reject({ cancelled: true }));
      this.cache.clear();
      this.queue = [];
    }
    if (rate !== undefined) {
      this.rate = rate;
      this.audio.playbackRate = rate;
    }
  }

  /**
   * Make sure the given texts are generated (first = most urgent).
   * Anything outside this window is dropped: queued jobs are cancelled and
   * their cache entries removed, so a later request always starts fresh.
   */
  prefetch(texts) {
    const keep = new Set(texts);
    const dropped = this.queue.filter((q) => !keep.has(q.text));
    this.queue = this.queue.filter((q) => keep.has(q.text));
    dropped.forEach((job) => {
      if (this.cache.get(job.text) === job.promise) this.cache.delete(job.text);
      job.reject({ cancelled: true });
    });
    for (const key of [...this.cache.keys()]) if (!keep.has(key)) this.cache.delete(key);
    texts.forEach((t) => this.#get(t));
    // Keep the queue in the requested order (current chunk first).
    const order = new Map(texts.map((t, i) => [t, i]));
    this.queue.sort((a, b) => order.get(a.text) - order.get(b.text));
  }

  #get(text) {
    if (this.cache.has(text)) return this.cache.get(text);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.done = false;
    promise.then(
      () => (promise.done = true),
      () => {
        promise.done = true;
        if (this.cache.get(text) === promise) this.cache.delete(text);
      },
    );
    this.cache.set(text, promise);
    this.queue.push({ text, resolve, reject, promise, voiceId: this.voiceId });
    this.#pump();
    return promise;
  }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        job.resolve(await synthesize(job.voiceId, job.text));
      } catch (err) {
        job.reject(err);
      }
    }
    this.busy = false;
  }

  /** Speak text; onWord gets an estimated position since Piper has no word timings. */
  speak(text, { onWord, onLoading } = {}) {
    this.stop();
    this.paused = false;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, settled: false, raf: 0, url: null };
      const settle = (fn, value) => {
        if (entry.settled) return;
        entry.settled = true;
        cancelAnimationFrame(entry.raf);
        if (this.current === entry) this.current = null;
        fn(value);
      };
      entry.settle = settle;
      this.current = entry;

      const job = this.#get(text);
      // Move this chunk to the front of the queue if it hasn't started yet.
      const idx = this.queue.findIndex((q) => q.text === text);
      if (idx > 0) this.queue.unshift(...this.queue.splice(idx, 1));

      if (!job.done) onLoading?.(true);
      job.then(
        (blob) => {
          if (entry.settled) return;
          const a = this.audio;
          if (entry.url) URL.revokeObjectURL(entry.url);
          entry.url = URL.createObjectURL(blob);
          // Loading a new source drops any 'pause' event still queued from stop().
          this.ownPause = false;
          a.src = entry.url;
          a.playbackRate = this.rate;
          a.preservesPitch = true;
          a.onended = () => {
            URL.revokeObjectURL(entry.url);
            this.cache.delete(text);
            settle(resolve);
          };
          a.onerror = () => settle(reject, new Error('No se pudo reproducir el audio'));
          entry.loaded = true;
          onLoading?.(false);
          if (!this.paused) a.play().catch((err) => settle(reject, playError(err)));
          if (onWord) {
            const words = wordStarts(text);
            let last = -1;
            const tick = () => {
              if (entry.settled) return;
              if (a.duration && !a.paused) {
                const pos = Math.floor((a.currentTime / a.duration) * text.length);
                let w = last;
                while (w + 1 < words.length && words[w + 1][0] <= pos) w++;
                if (w !== last && w >= 0) {
                  last = w;
                  onWord(words[w][0], words[w][1]);
                }
              }
              entry.raf = requestAnimationFrame(tick);
            };
            entry.raf = requestAnimationFrame(tick);
          }
        },
        (err) => {
          onLoading?.(false);
          settle(reject, err?.cancelled ? err : new Error(`No se pudo generar la voz: ${err?.message || err}`));
        },
      );
    });
  }

  pause() {
    this.paused = true;
    this.#pauseAudio();
  }

  #pauseAudio() {
    if (!this.audio.paused) {
      this.ownPause = true;
      this.audio.pause();
    }
  }

  resume() {
    this.paused = false;
    const entry = this.current;
    if (entry?.loaded) this.audio.play().catch((err) => entry.settle(entry.reject, playError(err)));
    // If the audio is still being generated, it starts playing as soon as it's ready.
  }

  get isPausedMidChunk() {
    return !!this.current && this.paused;
  }

  stop() {
    const entry = this.current;
    this.current = null;
    this.#pauseAudio();
    this.audio.onended = null;
    if (entry) {
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.settle(entry.reject, { cancelled: true });
    }
  }

  setVolume(v) {
    this.audio.volume = v;
  }

  /**
   * Call synchronously inside a tap: iOS only lets an audio element play
   * later (after the voice is generated) if it was started by a user gesture.
   */
  unlock() {
    if (this.unlocked || this.current) return;
    this.unlocked = true;
    const a = this.audio;
    a.src = SILENT_WAV;
    a.play().then(
      () => {
        if (!this.current) a.pause();
      },
      () => (this.unlocked = false),
    );
  }
}

// 0.05 s of silence, used to unlock audio playback on iOS.
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function playError(err) {
  if (err?.name === 'NotAllowedError') return new Error('El navegador bloqueó el audio. Toca el botón de reproducir.');
  return err instanceof Error ? err : new Error(String(err));
}

function wordStarts(text) {
  const out = [];
  const re = /[\p{L}\p{N}'’-]+/gu;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m[0].length]);
  return out;
}
