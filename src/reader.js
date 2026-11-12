// The live reader: shows the book, highlights what is being read and
// keeps the position saved.
import { getBook, getText, updateBook } from './db.js';
import { parseBook, speakable } from './text.js';
import { getSettings, setSettings, onSettingsChange } from './settings.js';
import { Player } from './player.js';
import { engineFor, engineLabel, unlockAudio } from './voice.js';
import { onNeuralProgress } from './tts/neural.js';
import { keepAlive } from './keepalive.js';
import { openSettings } from './settings-ui.js';
import { escapeHtml, formatDuration, setIcon, toast, icon } from './ui.js';

const $ = (id) => document.getElementById(id);
const scroller = $('r-scroll');
const textEl = $('r-text');
const playBtn = $('play-btn');
const seek = $('r-seek');

const player = new Player();
window.__lector = { player, keepAlive }; // handy for debugging and automated tests
let book = null;
let chunks = [];
let charsAfter = []; // characters remaining from each chunk to the end
let spans = [];
let activeIndex = -1;
let follow = true;
let saveTimer = 0;
let wakeLock = null;
let downloadPct = null; // neural model download progress, while the reader waits for it
let wordCursor = { index: -1, pos: 0 };
let programmaticScrollUntil = 0;

export function initReader({ back }) {
  $('back-btn').addEventListener('click', back);
  $('r-settings').addEventListener('click', () => openSettings(book?.lang || 'es'));
  playBtn.addEventListener('click', () => {
    if (!player.playing) unlockAudio();
    player.toggle();
  });
  window.addEventListener('lector:preview', () => player.pause());
  $('prev-btn').addEventListener('click', () => player.skip(-1));
  $('next-btn').addEventListener('click', () => player.skip(1));
  $('speed-btn').addEventListener('click', openSpeed);
  $('sleep-btn').addEventListener('click', openSleep);
  $('follow-btn').addEventListener('click', () => {
    follow = true;
    $('follow-btn').hidden = true;
    scrollToActive(true);
  });

  // Tap a sentence to read from there.
  textEl.addEventListener('click', (e) => {
    const span = e.target.closest('.chunk');
    if (!span || window.getSelection()?.toString()) return;
    follow = true;
    $('follow-btn').hidden = true;
    player.seek(Number(span.dataset.i));
  });

  // Manual scrolling pauses auto-follow until the user asks to go back.
  const stopFollow = () => {
    if (Date.now() < programmaticScrollUntil) return;
    follow = false;
    updateFollowButton();
  };
  scroller.addEventListener('wheel', stopFollow, { passive: true });
  scroller.addEventListener('touchmove', stopFollow, { passive: true });
  scroller.addEventListener('scroll', () => !follow && updateFollowButton(), { passive: true });

  seek.addEventListener('input', () => {
    const i = Number(seek.value);
    $('r-percent').textContent = `${percent(i)}%`;
    $('r-remaining').textContent = remainingText(i);
  });
  seek.addEventListener('change', () => {
    follow = true;
    player.seek(Number(seek.value));
  });

  player.addEventListener('index', (e) => onIndex(e.detail.index));
  player.addEventListener('state', (e) => onState(e.detail.playing));
  player.addEventListener('word', (e) => onWord(e.detail));
  player.addEventListener('loading', (e) => {
    playBtn.classList.toggle('loading', e.detail.loading);
    updateStatus();
  });
  player.addEventListener('error', (e) => toast(e.detail.message, 6000));
  player.addEventListener('finished', () => {
    toast('Fin del libro');
    savePosition(true);
  });
  player.addEventListener('sleep', (e) => {
    updateSleepChip();
    if (e.detail.fired) toast('Temporizador: lectura en pausa');
  });

  onNeuralProgress(({ loaded, total }) => {
    if (!total) return;
    downloadPct = loaded >= total ? null : Math.round((loaded / total) * 100);
    updateStatus();
  });

  onSettingsChange(async (s, patch) => {
    if (!book) return;
    const voiceKeys = ['engine', 'systemVoice', 'neuralVoice', 'rate', 'pitch'];
    if (voiceKeys.some((k) => k in patch)) {
      await applyEngine();
      if (!('rate' in patch) || engineLabel() === 'system') player.refresh();
    }
    if ('paragraphPause' in patch) player.paragraphPause = s.paragraphPause;
    if ('rate' in patch) {
      updateSpeedChip();
      onIndex(player.index);
      updatePositionState(true);
    }
    if ('keepAwake' in patch) updateWakeLock();
    if ('wordHighlight' in patch && !s.wordHighlight) clearWord();
    if ('fontSize' in patch || 'lineHeight' in patch || 'font' in patch) requestAnimationFrame(() => scrollToActive(false));
    updateStatus();
  });

  document.addEventListener('keydown', (e) => {
    if ($('reader').hidden || document.querySelector('dialog[open]')) return;
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'ArrowRight') player.skip(1);
    else if (e.key === 'ArrowLeft') player.skip(-1);
    else if (e.key === 'Escape') back();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition(true);
    else updateWakeLock();
  });
  window.addEventListener('pagehide', () => savePosition(true));

  setupMediaSession();
  updateSpeedChip();
  updateSleepChip();
}

let openRequest = 0;

/**
 * Open a book in the reader. Returns true when opened, false when the book
 * doesn't exist, or 'cancelled' if the user left before it finished opening.
 */
export async function openBook(id, { autoplay = false } = {}) {
  closeBook();
  const req = ++openRequest;
  const meta = await getBook(id);
  const text = meta && (await getText(id));
  if (req !== openRequest) return 'cancelled';
  if (!meta || text == null) {
    toast('No se encontró el libro');
    return false;
  }
  book = meta;
  ({ chunks } = parseBook(text, book.lang));
  charsAfter = new Array(chunks.length + 1).fill(0);
  for (let i = chunks.length - 1; i >= 0; i--) charsAfter[i] = charsAfter[i + 1] + chunks[i].text.length;
  const total = chunks.length;

  $('r-title').textContent = book.title;
  document.title = `${book.title} · Lector`;
  textEl.lang = book.lang || 'es';
  render();
  seek.max = Math.max(0, chunks.length - 1);

  const s = getSettings();
  player.paragraphPause = s.paragraphPause;
  player.load(chunks, Math.min(book.position || 0, chunks.length - 1));
  if (book.progress >= 0.999) player.ended = true; // pressing play starts over
  await applyEngine();
  if (req !== openRequest) return 'cancelled';
  follow = true;
  requestAnimationFrame(() => scrollToActive(false));
  await updateBook(id, { lastOpenedAt: Date.now(), totalChunks: total });
  if (req !== openRequest) return 'cancelled';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: 'Lector',
      album: 'Biblioteca',
      artwork: [
        { src: new URL('icon-192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  }
  if (autoplay) player.play();
  return true;
}

export function closeBook() {
  openRequest++; // cancels a book that is still opening
  if (!book) return;
  player.stop();
  player.setSleepTimer(0);
  savePosition(true);
  releaseWakeLock();
  clearWord();
  book = null;
  chunks = [];
  player.load([]); // so media keys can't start a book that is no longer on screen
  spans = [];
  activeIndex = -1;
  textEl.innerHTML = '';
  document.title = 'Lector TTS';
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
}

/** Reading, or a sleep timer is set: an automatic reload would lose it. */
export function isReading() {
  return player.playing || !!player.sleepAt;
}

export function currentBookLang() {
  return book?.lang || 'es';
}

let engineRequest = 0;
async function applyEngine() {
  // Loading system voices can take a moment; only the latest request wins.
  const req = ++engineRequest;
  const engine = await engineFor(book?.lang || 'es');
  if (req !== engineRequest) return;
  if (player.engine !== engine) player.setEngine(engine);
}

function render() {
  // One <p> per paragraph, one <span> per spoken chunk.
  let html = '';
  let p = -1;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.p !== p) {
      if (p >= 0) html += '</p>';
      html += '<p>';
      p = c.p;
    }
    html += `<span class="chunk" data-i="${i}">${escapeHtml(c.text)}</span>`;
  }
  if (p >= 0) html += '</p>';
  textEl.innerHTML = html;
  spans = Array.from(textEl.querySelectorAll('.chunk'));
}

function onIndex(i) {
  if (i !== activeIndex) {
    clearWord();
    spans[activeIndex]?.classList.remove('active');
    spans[i]?.classList.add('active');
    activeIndex = i;
    if (follow) scrollToActive(true);
    else updateFollowButton();
  }
  seek.value = i;
  $('r-percent').textContent = `${percent(i)}%`;
  $('r-remaining').textContent = remainingText(i);
  savePosition(false);
  // While paused there are few updates, so report every move (seek, notification seek).
  updatePositionState(!player.playing);
  updateStatus();
}

function percent(i) {
  if (!chunks.length) return 0;
  const total = charsAfter[0] || 1;
  return Math.floor(((total - charsAfter[i]) / total) * 100);
}

function remainingText(i) {
  if (!chunks.length) return '';
  return `quedan ${formatDuration(charsAfter[i], getSettings().rate)}`;
}

function onWord({ index, start, length }) {
  if (!getSettings().wordHighlight) return;
  const span = spans[index];
  if (!span) return;
  if (start < 0) return clearWord();
  // Offsets refer to the spoken text; find the same word in the displayed text.
  const original = chunks[index].text;
  const word = speakable(original).slice(start, start + length);
  if (!word.trim()) return;
  if (wordCursor.index !== index) wordCursor = { index, pos: 0 };
  const at = original.indexOf(word, wordCursor.pos);
  if (at < 0) return;
  wordCursor.pos = at + word.length;
  span.innerHTML = `${escapeHtml(original.slice(0, at))}<mark>${escapeHtml(word)}</mark>${escapeHtml(original.slice(at + word.length))}`;
}

function clearWord() {
  const span = spans[wordCursor.index];
  const chunk = chunks[wordCursor.index];
  if (span && chunk && span.firstElementChild) span.textContent = chunk.text;
  wordCursor = { index: -1, pos: 0 };
}

function scrollToActive(smooth) {
  const span = spans[activeIndex];
  if (!span) return;
  const box = scroller.getBoundingClientRect();
  const r = span.getBoundingClientRect();
  const top = r.top - box.top;
  // Only move when the sentence leaves the comfortable middle area.
  if (smooth && top > box.height * 0.15 && r.bottom - box.top < box.height * 0.7) return;
  programmaticScrollUntil = Date.now() + 800;
  scroller.scrollTo({
    top: scroller.scrollTop + top - box.height * 0.3,
    behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto',
  });
}

function updateFollowButton() {
  const span = spans[activeIndex];
  if (!span) return;
  const box = scroller.getBoundingClientRect();
  const r = span.getBoundingClientRect();
  const visible = r.bottom > box.top && r.top < box.bottom;
  if (visible && !follow) follow = true;
  $('follow-btn').hidden = follow || visible;
}

function onState(playing) {
  // Keep the page "playing" for the browser while the book is, so it keeps
  // running in the background and shows the media notification.
  if (playing) keepAlive.start();
  else keepAlive.stop();
  setIcon(playBtn, playing ? 'pause' : 'play');
  playBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Leer');
  if (!playing) playBtn.classList.remove('loading');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  updatePositionState(true);
  updateWakeLock();
  updateStatus();
  if (!playing) {
    savePosition(true);
    window.dispatchEvent(new Event('lector:idle'));
  }
}

function updateStatus() {
  if (!book) return;
  const s = getSettings();
  const voice = engineLabel() === 'neural' ? 'Voz neuronal' : 'Voz del dispositivo';
  const state = player.playing ? 'Leyendo' : 'En pausa';
  // While the neural voice is still generating (or downloading) the current sentence, say so.
  const engine = player.engine;
  const waiting = player.playing && engine?.supportsResume && engine.current && !engine.current.loaded;
  if (waiting) {
    $('r-status').textContent = downloadPct !== null ? `Descargando voz… ${downloadPct}%` : 'Preparando la voz…';
    return;
  }
  $('r-status').textContent = `${state} · ${voice} · ${s.rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}

let lastSave = 0;
let lastWrite = Promise.resolve();

/** Wait for the latest position write (used before reloading the page). */
export function flushPosition() {
  savePosition(true);
  return lastWrite;
}

function savePosition(now) {
  if (!book) return;
  const id = book.id;
  const write = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    lastSave = Date.now();
    if (!book || book.id !== id) return;
    const position = player.index;
    const progress = chunks.length > 1 ? (charsAfter[0] - charsAfter[position]) / charsAfter[0] : 0;
    // Keep the current sentence so the library can show it without re-reading the book.
    const snippet = (chunks[position]?.text || '').trim().slice(0, 240);
    lastWrite = updateBook(id, { position, progress: player.ended ? 1 : progress, snippet, lastOpenedAt: Date.now() }).catch(
      () => {},
    );
  };
  // Write right away when paused (a seek or a tap is a deliberate move) and in the
  // background (timers may not fire for a long time); otherwise at most every few
  // seconds while reading.
  if (now || !player.playing || document.hidden || Date.now() - lastSave > 5000) write();
  else if (!saveTimer) saveTimer = setTimeout(write, 1500);
}

// ---- Speed & sleep timer ----

const SPEEDS = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2];
const SLEEPS = [0, 10, 15, 20, 30, 45, 60, 90, 120];

function openSpeed() {
  const rate = getSettings().rate;
  $('speed-choices').innerHTML = SPEEDS.map(
    (v) => `<button value="${v}" class="${Math.abs(v - rate) < 0.01 ? 'on' : ''}">${v.toFixed(2).replace(/0$/, '')}×</button>`,
  ).join('');
  const dlg = $('speed-sheet');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    () => {
      const v = Number(dlg.returnValue);
      if (v) setSettings({ rate: v });
    },
    { once: true },
  );
}

function updateSpeedChip() {
  $('speed-btn').textContent = `${getSettings().rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}

function openSleep() {
  const active = player.sleepAt ? Math.ceil((player.sleepAt - Date.now()) / 60000) : 0;
  $('sleep-choices').innerHTML = SLEEPS.map(
    (m) => `<button value="${m || 'off'}" class="${!m && !active ? 'on' : ''}">${m ? `${m} min` : 'Apagado'}</button>`,
  ).join('');
  const dlg = $('sleep-sheet');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    () => {
      if (!dlg.returnValue || dlg.returnValue === 'close') return;
      const m = dlg.returnValue === 'off' ? 0 : Number(dlg.returnValue);
      player.setSleepTimer(m);
      if (m) toast(`Dejará de leer en ${m} min`);
    },
    { once: true },
  );
}

let sleepTick = 0;
function updateSleepChip() {
  const btn = $('sleep-btn');
  clearInterval(sleepTick);
  const paint = () => {
    const left = player.sleepAt ? Math.max(0, Math.ceil((player.sleepAt - Date.now()) / 60000)) : 0;
    btn.innerHTML = `${icon('moon')}${left ? `${left} min` : ''}`;
    btn.classList.toggle('on', !!left);
  };
  paint();
  if (player.sleepAt) sleepTick = setInterval(paint, 15000);
}

// ---- Screen wake lock & media keys ----

async function updateWakeLock() {
  const want = book && player.playing && getSettings().keepAwake && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      wakeLock = null;
    }
  } else if (!want) releaseWakeLock();
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, fn) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action */
    }
  };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('previoustrack', () => player.skip(-1));
  set('nexttrack', () => player.skip(1));
  set('seekbackward', () => player.skip(-3));
  set('seekforward', () => player.skip(3));
  set('stop', () => player.pause());
  // Dragging the bar in the notification jumps through the book.
  set('seekto', (d) => {
    if (!chunks.length || d.seekTime == null) return;
    // First chunk whose end lies past the requested time.
    const chars = d.seekTime * charsPerSecond();
    let i = chunks.length - 1;
    for (let j = 0; j < chunks.length; j++) {
      if (charsAfter[0] - charsAfter[j + 1] > chars + 0.01) {
        i = j;
        break;
      }
    }
    follow = true;
    player.seek(i);
  });
  keepAlive.onExternalPause = () => player.pause();
}

function charsPerSecond() {
  return 15 * (getSettings().rate || 1);
}

/** The notification's progress bar shows the whole book, not one sentence. */
let lastPositionUpdate = 0;
function updatePositionState(force) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState || !book || !chunks.length) return;
  if (!force && Date.now() - lastPositionUpdate < 3000) return;
  lastPositionUpdate = Date.now();
  const cps = charsPerSecond();
  const duration = Math.max(1, charsAfter[0] / cps);
  const position = Math.min(duration, (charsAfter[0] - charsAfter[player.index]) / cps);
  try {
    navigator.mediaSession.setPositionState({ duration, position, playbackRate: 1 });
  } catch {
    /* invalid state on some browsers: ignore */
  }
}
