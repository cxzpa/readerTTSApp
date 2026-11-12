// Small UI helpers: icons, toast, formatting.

const PATHS = {
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
  prev: '<path d="M18 6l-8 6 8 6V6z"/><path d="M6 6v12"/>',
  next: '<path d="M6 6l8 6-8 6V6z"/><path d="M18 6v12"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  type: '<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};

export function icon(name) {
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

/** Fill elements that declare data-icon / data-icon-left. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
  root.querySelectorAll('[data-icon-left]').forEach((el) => {
    if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.iconLeft));
  });
}

export function setIcon(el, name) {
  el.dataset.icon = name;
  el.innerHTML = icon(name);
}

let toastTimer;
export function toast(message, ms = 3200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Rough listening time: TTS voices speak about 15 characters per second at 1×. */
export function formatDuration(chars, rate = 1) {
  const minutes = Math.round(chars / (15 * rate) / 60);
  if (minutes < 1) return 'menos de 1 min';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function relativeDate(ts) {
  if (!ts) return '';
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Pleasant, stable cover color from the title. */
export function coverColor(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 38% 42%)`;
}
