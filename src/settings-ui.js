// The settings sheet: voice choice, speed and reading comfort options.
import { getSettings, setSettings } from './settings.js';
import { getSystemVoices, rankVoices, systemTtsAvailable } from './tts/system.js';
import {
  NEURAL_VOICES,
  neuralTtsAvailable,
  downloadedNeuralVoices,
  loadNeuralVoice,
  removeNeuralVoice,
  onNeuralProgress,
  synthesize,
} from './tts/neural.js';
import { icon, toast, escapeHtml } from './ui.js';
import { busyStart, busyEnd } from './busy.js';

const $ = (id) => document.getElementById(id);
const dialog = $('settings');
let currentLang = 'es';
let downloaded = new Set();
const downloading = new Map(); // voiceId -> percent
let previewAudio = null;

const SAMPLE = {
  es: 'Había una vez, en un lugar tranquilo, alguien que disfrutaba escuchar historias antes de dormir.',
  en: 'Once upon a time, in a quiet place, someone loved listening to stories before falling asleep.',
  pt: 'Era uma vez, num lugar tranquilo, alguém que adorava ouvir histórias antes de dormir.',
  fr: 'Il était une fois, dans un endroit calme, quelqu’un qui aimait écouter des histoires avant de dormir.',
};

export function openSettings(lang = 'es') {
  currentLang = lang;
  render();
  dialog.showModal();
}

function render() {
  const s = getSettings();
  const neuralOk = neuralTtsAvailable();
  const systemOk = systemTtsAvailable();
  dialog.querySelectorAll('input[name="engine"]').forEach((r) => {
    r.checked = r.value === s.engine;
    r.disabled = (r.value === 'neural' && !neuralOk) || (r.value === 'system' && !systemOk);
  });
  const useNeural = (s.engine === 'neural' && neuralOk) || !systemOk;
  $('system-voice-box').hidden = useNeural;
  $('neural-voice-box').hidden = !useNeural;
  $('pitch-field').hidden = useNeural;
  if (useNeural) renderNeural();
  else renderSystem();

  setRange('rate', s.rate, (v) => `${Number(v).toFixed(2)}×`);
  setRange('pitch', s.pitch, (v) => Number(v).toFixed(2));
  setRange('pause', s.paragraphPause, (v) => `${(v / 1000).toFixed(2)} s`);
  setRange('font-size', s.fontSize, (v) => `${v} px`);
  setRange('line-height', s.lineHeight, (v) => Number(v).toFixed(2));
  dialog.querySelectorAll('input[name="font"]').forEach((r) => (r.checked = r.value === s.font));
  dialog.querySelectorAll('input[name="theme"]').forEach((r) => (r.checked = r.value === s.theme));
  $('word-hl').checked = s.wordHighlight;
  $('keep-awake').checked = s.keepAwake;
  $('keep-awake').closest('label').hidden = !('wakeLock' in navigator);
}

function setRange(id, value, fmt) {
  const el = $(id);
  el.value = value;
  $(`${id}-out`).textContent = fmt(value);
  el._fmt = fmt;
}

async function renderSystem() {
  const select = $('system-voice');
  const voices = rankVoices(await getSystemVoices(), currentLang);
  const s = getSettings();
  const best = voices[0];
  const isGood = (v) => /natural|neural|premium|enhanced|mejorad|siri|google|online|wavenet/i.test(v.name);
  const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(currentLang));
  const others = voices.filter((v) => !v.lang.toLowerCase().startsWith(currentLang));
  const opt = (v) =>
    `<option value="${escapeHtml(v.voiceURI)}">${isGood(v) ? '★ ' : ''}${escapeHtml(v.name)} (${escapeHtml(v.lang)})${
      v.localService ? '' : ' · en línea'
    }</option>`;
  select.innerHTML =
    (sameLang.length ? `<optgroup label="Idioma del libro">${sameLang.map(opt).join('')}</optgroup>` : '') +
    (others.length ? `<optgroup label="Otros idiomas">${others.map(opt).join('')}</optgroup>` : '');
  select.value = s.systemVoice && voices.some((v) => v.voiceURI === s.systemVoice) ? s.systemVoice : best?.voiceURI || '';
  if (!voices.length) {
    select.innerHTML = '<option value="">No hay voces disponibles</option>';
    $('system-help').textContent = 'Este navegador no ofrece voces. Prueba la voz neuronal.';
  }
}

async function renderNeural() {
  const list = $('neural-list');
  downloaded = new Set(await downloadedNeuralVoices());
  const s = getSettings();
  const sorted = [...NEURAL_VOICES].sort((a, b) => (b.lang === currentLang) - (a.lang === currentLang));
  list.innerHTML = sorted
    .map((v) => {
      const selected = v.id === s.neuralVoice;
      const pct = downloading.get(v.id);
      const isDown = downloaded.has(v.id);
      const status = pct !== undefined ? `Descargando… ${pct}%` : isDown ? 'Descargada' : `${v.mb} MB`;
      const action = isDown
        ? `<button type="button" class="icon-btn" data-preview="${v.id}" aria-label="Probar ${v.name}">${icon('play')}</button>
           <button type="button" class="icon-btn danger" data-remove="${v.id}" aria-label="Borrar ${v.name}">${icon('trash')}</button>`
        : pct === undefined
          ? `<button type="button" class="icon-btn" data-download="${v.id}" aria-label="Descargar ${v.name}">${icon('download')}</button>`
          : '';
      return `<li class="neural-item${selected ? ' selected' : ''}" data-voice="${v.id}">
        <div class="meta">
          <strong>${escapeHtml(v.name)}${selected ? ' ✓' : ''}</strong>
          <small>${v.lang === 'es' ? 'Español' : 'Inglés'} · ${v.region} · calidad ${v.quality} · ${status}</small>
          ${pct !== undefined ? `<div class="progress bar"><span style="width:${pct}%"></span></div>` : ''}
        </div>
        ${action}
      </li>`;
    })
    .join('');
}

function download(voiceId) {
  if (downloading.has(voiceId) || downloaded.has(voiceId)) return Promise.resolve();
  downloading.set(voiceId, 0);
  busyStart(`download:${voiceId}`);
  renderNeural();
  return loadNeuralVoice(voiceId)
    .then(() => {
      downloading.delete(voiceId);
      downloaded.add(voiceId);
      toast('Voz lista para usar sin internet');
    })
    .catch((err) => {
      downloading.delete(voiceId);
      toast(`No se pudo descargar la voz: ${err.message}`, 6000);
    })
    .finally(() => {
      busyEnd(`download:${voiceId}`);
      if (dialog.open) renderNeural();
    });
}

onNeuralProgress(({ voiceId, loaded, total }) => {
  if (!total) return;
  const pct = Math.min(99, Math.round((loaded / total) * 100));
  if (downloading.get(voiceId) === pct) return;
  downloading.set(voiceId, pct);
  if (!dialog.open) return;
  const item = dialog.querySelector(`[data-voice="${voiceId}"]`);
  const bar = item?.querySelector('.progress span');
  if (bar) {
    bar.style.width = `${pct}%`;
    item.querySelector('small').textContent = item.querySelector('small').textContent.replace(/Descargando… \d+%/, `Descargando… ${pct}%`);
  } else renderNeural();
});

async function preview(text, voiceId) {
  stopPreview();
  window.dispatchEvent(new Event('lector:preview')); // the reader pauses so voices don't overlap
  const s = getSettings();
  if (voiceId) {
    try {
      const blob = await synthesize(voiceId, text);
      previewAudio = new Audio(URL.createObjectURL(blob));
      previewAudio.playbackRate = s.rate;
      previewAudio.play();
    } catch (err) {
      toast(`No se pudo probar la voz: ${err.message}`);
    }
    return;
  }
  const voices = await getSystemVoices();
  const u = new SpeechSynthesisUtterance(text);
  const v = voices.find((x) => x.voiceURI === $('system-voice').value);
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  }
  u.rate = s.rate;
  u.pitch = s.pitch;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function stopPreview() {
  if (previewAudio) {
    previewAudio.pause();
    URL.revokeObjectURL(previewAudio.src);
    previewAudio = null;
  }
}

function sampleFor(voiceId) {
  const lang = voiceId ? NEURAL_VOICES.find((v) => v.id === voiceId)?.lang : currentLang;
  return SAMPLE[lang] || SAMPLE.es;
}

// ---- Bindings ----

dialog.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'engine') {
    setSettings({ engine: t.value });
    render();
    if (t.value === 'neural') {
      const id = getSettings().neuralVoice;
      if (!downloaded.has(id)) download(id);
    }
  } else if (t.name === 'font') setSettings({ font: t.value });
  else if (t.name === 'theme') setSettings({ theme: t.value });
  else if (t.id === 'system-voice') setSettings({ systemVoice: t.value || null });
  else if (t.id === 'word-hl') setSettings({ wordHighlight: t.checked });
  else if (t.id === 'keep-awake') setSettings({ keepAwake: t.checked });
  else if (t.type === 'range') commitRange(t);
});

dialog.addEventListener('input', (e) => {
  const t = e.target;
  if (t.type !== 'range') return;
  $(`${t.id}-out`).textContent = t._fmt(t.value);
  // Typography updates live while dragging; voice settings apply on release.
  if (t.id === 'font-size' || t.id === 'line-height') commitRange(t);
});

function commitRange(t) {
  const v = Number(t.value);
  const key = { rate: 'rate', pitch: 'pitch', pause: 'paragraphPause', 'font-size': 'fontSize', 'line-height': 'lineHeight' }[t.id];
  if (key && getSettings()[key] !== v) setSettings({ [key]: v });
}

dialog.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn?.id === 'test-system') return preview(sampleFor(null), null);
  if (btn?.dataset.preview) return preview(sampleFor(btn.dataset.preview), btn.dataset.preview);
  if (btn?.dataset.download) return download(btn.dataset.download);
  if (btn?.dataset.remove) {
    const id = btn.dataset.remove;
    const name = NEURAL_VOICES.find((v) => v.id === id)?.name || id;
    if (!confirm(`¿Borrar la voz ${name} de este dispositivo? Podrás descargarla de nuevo.`)) return;
    return removeNeuralVoice(id).then(() => {
      downloaded.delete(id);
      renderNeural();
    });
  }
  const item = e.target.closest('.neural-item');
  if (item && !btn) {
    const id = item.dataset.voice;
    setSettings({ neuralVoice: id, engine: 'neural' });
    renderNeural();
    if (!downloaded.has(id)) download(id);
  }
});

dialog.addEventListener('close', stopPreview);
// Close when tapping the backdrop.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});
