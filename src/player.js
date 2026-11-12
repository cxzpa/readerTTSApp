// Reading loop: walks through the book chunk by chunk with the chosen voice,
// keeps the position, and handles pause, seeking and the sleep timer.
import { speakable } from './text.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.chunks = [];
    this.index = 0;
    this.playing = false;
    this.engine = null;
    this.paragraphPause = 350;
    this.token = 0;
    this.sleepAt = 0;
    this.sleepTimer = 0;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  load(chunks, index = 0) {
    this.stop();
    this.chunks = chunks;
    this.index = clamp(index, 0, Math.max(0, chunks.length - 1));
    this.emit('index', { index: this.index });
  }

  setEngine(engine) {
    const wasPlaying = this.playing;
    if (this.engine && this.engine !== engine) this.engine.stop();
    this.engine = engine;
    if (wasPlaying) this.#restart();
  }

  /** Re-apply settings mid-sentence (voice, speed): restart the current chunk. */
  refresh() {
    if (this.playing) this.#restart();
  }

  play() {
    if (!this.engine || !this.chunks.length) return;
    if (this.playing) return;
    if (this.index >= this.chunks.length) this.index = 0;
    this.playing = true;
    this.emit('state', { playing: true });
    if (this.engine.supportsResume && this.engine.isPausedMidChunk) {
      this.engine.resume();
      return;
    }
    this.#run(++this.token);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    if (this.engine?.supportsResume && this.engine.current) {
      this.engine.pause(); // resume later from the same point
    } else {
      this.token++;
      this.engine?.stop();
    }
    this.emit('state', { playing: false });
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  stop() {
    this.token++;
    this.playing = false;
    this.engine?.stop();
    this.emit('state', { playing: false });
  }

  seek(index) {
    const i = clamp(index, 0, this.chunks.length - 1);
    this.index = i;
    this.emit('index', { index: i, seek: true });
    if (this.playing) this.#restart();
    else this.engine?.stop();
  }

  skip(delta) {
    this.seek(this.index + delta);
  }

  #restart() {
    this.engine?.stop();
    this.#run(++this.token);
  }

  async #run(token) {
    while (this.playing && token === this.token && this.index < this.chunks.length) {
      const i = this.index;
      const chunk = this.chunks[i];
      const text = speakable(chunk.text);
      // Generate the next few chunks ahead of time (neural voice).
      const ahead = [];
      for (let j = i; j < Math.min(i + 4, this.chunks.length); j++) {
        const t = speakable(this.chunks[j].text);
        if (t) ahead.push(t);
      }
      this.engine.prefetch(ahead);
      this.emit('index', { index: i });

      if (text) {
        try {
          await this.engine.speak(text, {
            onWord: (start, length) => this.emit('word', { index: i, start, length }),
            onLoading: (loading) => this.emit('loading', { loading }),
          });
        } catch (err) {
          if (err?.cancelled) return;
          if (token !== this.token) return;
          this.playing = false;
          this.emit('state', { playing: false });
          this.emit('error', { message: err?.message || String(err) });
          return;
        }
      }
      if (token !== this.token || !this.playing) return;
      this.emit('word', { index: i, start: -1, length: 0 });

      const next = i + 1;
      if (next >= this.chunks.length) {
        this.index = this.chunks.length - 1;
        this.playing = false;
        this.emit('state', { playing: false });
        this.emit('finished', {});
        return;
      }
      this.index = next;
      if (this.chunks[next].p !== chunk.p && this.paragraphPause > 0) {
        await wait(this.paragraphPause / (this.engine.rate || 1));
        if (token !== this.token || !this.playing) return;
      }
    }
  }

  /** Stop reading after `minutes` (0 = off). The neural voice fades out gently. */
  setSleepTimer(minutes) {
    clearTimeout(this.sleepTimer);
    this.sleepAt = minutes ? Date.now() + minutes * 60000 : 0;
    if (minutes) {
      this.sleepTimer = setTimeout(() => this.#sleep(), minutes * 60000);
    }
    this.emit('sleep', { at: this.sleepAt });
  }

  async #sleep() {
    const engine = this.engine;
    if (engine?.setVolume && this.playing) {
      for (let v = 1; v >= 0; v -= 0.1) {
        engine.setVolume(Math.max(0, v));
        await wait(400);
      }
    }
    this.pause();
    engine?.setVolume?.(1);
    this.sleepAt = 0;
    this.emit('sleep', { at: 0, fired: true });
  }
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
