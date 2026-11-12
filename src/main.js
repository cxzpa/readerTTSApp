import { hydrateIcons } from './ui.js';
import { getSettings, onSettingsChange } from './settings.js';
import { initLibrary, refreshLibrary } from './library.js';
import { initReader, openBook, closeBook, currentBookLang } from './reader.js';
import { openSettings } from './settings-ui.js';

const $ = (id) => document.getElementById(id);

function applyAppearance(s) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--reading-size', `${s.fontSize}px`);
  root.style.setProperty('--reading-lh', s.lineHeight);
  root.style.setProperty('--reading-font', s.font === 'sans' ? 'var(--sans)' : 'var(--serif)');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
}

// ---- Navigation (hash based so the back button works) ----

let pendingAutoplay = false;

function go(hash, opts = {}) {
  pendingAutoplay = !!opts.autoplay;
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  const m = location.hash.match(/^#\/leer\/([\w-]+)/);
  if (m) {
    const autoplay = pendingAutoplay;
    pendingAutoplay = false;
    $('library').hidden = true;
    $('reader').hidden = false;
    const ok = await openBook(m[1], { autoplay });
    if (ok === false) go('#/');
  } else {
    closeBook();
    $('reader').hidden = true;
    $('library').hidden = false;
    await refreshLibrary();
  }
}

hydrateIcons();
applyAppearance(getSettings());
onSettingsChange((s) => applyAppearance(s));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(getSettings()));

initLibrary({ open: (id, opts) => go(`#/leer/${id}`, opts) });
initReader({ back: () => (history.length > 1 && location.hash.startsWith('#/leer') ? history.back() : go('#/')) });
$('lib-settings').addEventListener('click', () => openSettings(currentBookLang()));

window.addEventListener('hashchange', route);
route();

// Offline support (only in the built app, so development always shows fresh code).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
