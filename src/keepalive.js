// Background playback anchor.
//
// Mobile browsers only keep a page running in the background, and only show
// the media notification (play/pause on the lock screen and in the
// notification shade), while a media element is audibly playing. Sentences
// are short separate clips (or system speech, which isn't a media element at
// all), so this plays a long, practically inaudible loop for exactly as long
// as the book is playing.
//
// It also tells us when the system pauses audio on its own (a phone call,
// another app starting music, headphones unplugged) so the reader can show
// "paused" instead of pretending to play.

const SECONDS = 12;
const RATE = 8000;

function quietWavUrl() {
  const n = SECONDS * RATE;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  // A tiny dither (±2 of 32768): not digital silence, which some systems
  // treat as "not playing", but far below anything audible.
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    v.setInt16(44 + i * 2, (seed % 5) - 2, true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

class KeepAlive {
  constructor() {
    this.audio = null;
    this.wanted = false;
    this.onExternalPause = null;
  }

  #element() {
    if (!this.audio && typeof Audio !== 'undefined') {
      const a = new Audio();
      a.src = quietWavUrl();
      a.loop = true;
      a.preload = 'auto';
      a.volume = 0.05;
      a.setAttribute('aria-hidden', 'true');
      a.addEventListener('pause', () => {
        // Paused by the system, not by us: tell the reader.
        if (this.wanted) {
          this.wanted = false;
          this.onExternalPause?.();
        }
      });
      this.audio = a;
    }
    return this.audio;
  }

  /** Start (call it inside a tap the first time, so mobile browsers allow it). */
  start() {
    const a = this.#element();
    if (!a) return;
    this.wanted = true;
    if (!a.paused) return;
    a.play().catch(() => {
      // Not allowed or not supported: reading still works, just without the
      // notification / background support.
      this.wanted = false;
    });
  }

  stop() {
    this.wanted = false;
    if (this.audio && !this.audio.paused) this.audio.pause();
  }

  /** Prime the element inside a user gesture for a play that starts later. */
  unlock() {
    const a = this.#element();
    if (!a || this.unlocked || !a.paused) return;
    this.unlocked = true;
    a.play().then(
      () => {
        if (!this.wanted) a.pause();
      },
      () => (this.unlocked = false),
    );
  }
}

export const keepAlive = new KeepAlive();
