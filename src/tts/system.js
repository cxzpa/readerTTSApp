// System voices through the Web Speech API (speechSynthesis).
// Each chunk is spoken as its own utterance: short utterances avoid the
// Chrome cut-off bug and let the reader highlight sentence by sentence.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

export function systemTtsAvailable() {
  return !!synth && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** Resolve the voice list, which some browsers load asynchronously. */
export function getSystemVoices() {
  if (!synth) return Promise.resolve([]);
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = () => resolve(synth.getVoices());
    synth.addEventListener('voiceschanged', finish, { once: true });
    setTimeout(finish, 1500);
  });
}

// Names that usually mean a natural-sounding voice, best first.
const QUALITY_HINTS = [/natural/i, /neural/i, /premium/i, /enhanced|mejorad/i, /siri/i, /google/i, /online/i, /wavenet/i];

function score(voice, lang) {
  let s = 0;
  const vl = voice.lang.toLowerCase().replace('_', '-');
  if (vl.startsWith(lang)) s += 100;
  if (lang === 'es' && /es-(mx|us|419)/.test(vl)) s += 5; // Latin American Spanish first
  QUALITY_HINTS.forEach((re, i) => {
    if (re.test(voice.name)) s += 40 - i * 3;
  });
  if (voice.localService) s += 8; // works offline
  if (/compact|espeak|robot/i.test(voice.name)) s -= 30;
  return s;
}

/** Voices sorted so the most pleasant ones for the book's language come first. */
export function rankVoices(voices, lang) {
  return [...voices].sort((a, b) => score(b, lang) - score(a, lang) || a.name.localeCompare(b.name));
}

export class SystemEngine {
  constructor() {
    this.voice = null;
    this.rate = 1;
    this.pitch = 1;
    this.lang = 'es';
    this.current = null;
    this.supportsResume = false;
  }

  configure({ voice, rate, pitch, lang }) {
    if (voice !== undefined) this.voice = voice;
    if (rate !== undefined) this.rate = rate;
    if (pitch !== undefined) this.pitch = pitch;
    if (lang !== undefined) this.lang = lang;
  }

  prefetch() {}

  /**
   * Speak text. Resolves when finished; rejects with {cancelled:true} if stopped.
   * onWord(charIndex, charLength) is called on word boundaries when supported.
   */
  speak(text, { onWord } = {}) {
    this.stop();
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) {
        u.voice = this.voice;
        u.lang = this.voice.lang;
      } else u.lang = this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;
      const entry = { u, resolve, reject, settled: false };
      const settle = (fn, value) => {
        if (entry.settled) return;
        entry.settled = true;
        if (this.current === entry) this.current = null;
        fn(value);
      };
      entry.settle = settle;
      u.onend = () => settle(resolve);
      u.onerror = (e) => {
        // Our own stop() settles first, so reaching here means someone else cancelled the speech.
        if (e.error === 'interrupted' || e.error === 'canceled') settle(reject, { cancelled: true, external: true });
        else settle(reject, new Error(friendlyError(e.error)));
      };
      u.onboundary = (e) => {
        if (onWord && e.name === 'word') onWord(e.charIndex, e.charLength || wordLengthAt(text, e.charIndex));
      };
      this.current = entry; // keep a reference: Chrome may garbage-collect it otherwise
      synth.speak(u);
      // Some Android engines never fire onstart/onend for empty-ish text.
      if (!text.trim()) settle(resolve);
    });
  }

  /** Call inside a tap: iOS only allows speech that a user gesture started first. */
  unlock() {
    if (this.unlocked || !synth) return;
    this.unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  }

  stop() {
    const entry = this.current;
    this.current = null;
    if (entry) entry.settle(entry.reject, { cancelled: true });
    if (synth && (synth.speaking || synth.pending)) synth.cancel();
  }
}

function wordLengthAt(text, index) {
  const m = /^[\p{L}\p{N}'’-]+/u.exec(text.slice(index));
  return m ? m[0].length : 1;
}

function friendlyError(code) {
  if (code === 'synthesis-failed' || code === 'voice-unavailable' || code === 'language-unavailable') {
    return synth.getVoices().length
      ? 'La voz del dispositivo falló. Prueba otra voz o la voz neuronal en Ajustes.'
      : 'Este dispositivo no tiene voces instaladas. Elige la voz neuronal en Ajustes.';
  }
  if (code === 'not-allowed') return 'El navegador bloqueó la voz. Toca el botón de reproducir.';
  return `Error de voz (${code || 'desconocido'})`;
}
