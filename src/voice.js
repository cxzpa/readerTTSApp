// Picks and configures the voice engine according to the user's settings.
import { getSettings } from './settings.js';
import { SystemEngine, getSystemVoices, rankVoices, systemTtsAvailable } from './tts/system.js';
import { NeuralEngine, neuralTtsAvailable } from './tts/neural.js';

export const systemEngine = new SystemEngine();
export const neuralEngine = new NeuralEngine();

/** Returns the configured engine for a book in `lang`. */
export async function engineFor(lang) {
  const s = getSettings();
  if ((s.engine === 'neural' && neuralTtsAvailable()) || !systemTtsAvailable()) {
    neuralEngine.configure({ voiceId: s.neuralVoice, rate: s.rate });
    return neuralEngine;
  }
  const voice = await pickSystemVoice(lang);
  systemEngine.configure({ voice, rate: s.rate, pitch: s.pitch, lang });
  return systemEngine;
}

export async function pickSystemVoice(lang) {
  const voices = await getSystemVoices();
  const s = getSettings();
  return voices.find((v) => v.voiceURI === s.systemVoice) || rankVoices(voices, lang)[0] || null;
}

export function engineLabel() {
  const s = getSettings();
  return s.engine === 'neural' && neuralTtsAvailable() ? 'neural' : 'system';
}

/** Must run synchronously in a tap so mobile browsers allow audio that starts later. */
export function unlockAudio() {
  if (engineLabel() === 'neural') neuralEngine.unlock();
  else if (systemTtsAvailable()) systemEngine.unlock();
}
