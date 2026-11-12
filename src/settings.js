// Reader preferences, kept in localStorage (per device).

const KEY = 'lector-tts:settings';

export const DEFAULTS = {
  engine: 'system', // 'system' | 'neural'
  systemVoice: null, // voiceURI of the chosen system voice
  neuralVoice: 'es_MX-claude-high',
  rate: 1,
  pitch: 1,
  paragraphPause: 350, // ms of silence between paragraphs
  fontSize: 20,
  lineHeight: 1.75,
  font: 'serif', // 'serif' | 'sans'
  theme: 'auto', // 'auto' | 'light' | 'sepia' | 'dark'
  keepAwake: false,
  wordHighlight: true,
};

let current = load();
const listeners = new Set();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSettings() {
  return current;
}

export function setSettings(patch) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((fn) => fn(current, patch));
}

export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
