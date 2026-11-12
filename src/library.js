// Home screen: the saved books, "continue reading" and adding new .txt files.
import { listBooks, addBook, deleteBook, hashText, getText, requestPersistence, setBookOrder } from './db.js';
import { decodeText, detectLang, parseBook, titleFromFileName } from './text.js';
import { getSettings, setSettings } from './settings.js';
import { unlockAudio } from './voice.js';
import { escapeHtml, formatDuration, relativeDate, coverColor, icon, toast } from './ui.js';

const $ = (id) => document.getElementById(id);
let books = [];
let onOpen = () => {};

export function initLibrary({ open }) {
  onOpen = open;
  $('add-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await importFiles(files);
  });
  $('lib-search').addEventListener('input', renderList);
  $('lib-sort').addEventListener('change', (e) => changeSort(e.target.value));
  $('lib-dir').addEventListener('click', () => {
    setSettings({ librarySortDesc: !getSettings().librarySortDesc });
    renderList();
  });

  $('book-list').addEventListener('click', async (e) => {
    if (e.target.closest('[data-drag]') || Date.now() < suppressClickUntil) return;
    const del = e.target.closest('[data-delete]');
    if (del) {
      e.stopPropagation();
      const book = books.find((b) => b.id === del.dataset.delete);
      if (book && confirm(`¿Quitar "${book.title}" de la biblioteca?`)) {
        await deleteBook(book.id);
        toast('Libro eliminado');
        refreshLibrary();
      }
      return;
    }
    const item = e.target.closest('[data-book]');
    if (item) onOpen(item.dataset.book);
  });
  $('book-list').addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-book]');
    if (item && (e.key === 'Enter' || e.key === ' ') && e.target === item) {
      e.preventDefault();
      onOpen(item.dataset.book);
    }
  });
  $('continue-card').addEventListener('click', () => {
    const id = $('continue-card').dataset.book;
    if (!id) return;
    unlockAudio(); // the book starts playing after it opens, outside this tap
    onOpen(id, { autoplay: true });
  });

  setupDragAndDrop();
  setupLaunchQueue();
  setupReorder();
}

export async function refreshLibrary() {
  books = await listBooks();
  renderContinue();
  renderList();
}

/** Import several .txt files; then open the first one in the reader. */
export async function importFiles(files) {
  const txt = files.filter((f) => /\.txt$/i.test(f.name) || f.type === 'text/plain');
  const skipped = files.length - txt.length;
  if (!txt.length) {
    toast(skipped ? 'Solo se pueden abrir archivos .txt' : 'No se eligió ningún archivo');
    return;
  }
  requestPersistence();
  let firstId = null;
  let added = 0;
  for (const file of txt) {
    try {
      const text = decodeText(await file.arrayBuffer());
      if (!text.trim()) {
        toast(`"${file.name}" está vacío`);
        continue;
      }
      const lang = detectLang(text);
      const { chunks } = parseBook(text, lang);
      if (!chunks.length) {
        toast(`"${file.name}" no tiene texto para leer`);
        continue;
      }
      const id = await hashText(text);
      const now = Date.now();
      const { book, isNew } = await addBook(
        {
          id,
          title: titleFromFileName(file.name),
          fileName: file.name,
          lang,
          chars: text.length,
          totalChunks: chunks.length,
          position: 0,
          progress: 0,
          addedAt: now,
          lastOpenedAt: 0,
        },
        text,
      );
      if (isNew) added++;
      firstId ??= book.id;
    } catch (err) {
      console.error(err);
      toast(`No se pudo abrir "${file.name}"`);
    }
  }
  await refreshLibrary();
  const parts = [];
  if (txt.length > 1) parts.push(added === 1 ? '1 libro agregado' : `${added} libros agregados`);
  const repeated = txt.length - added;
  if (repeated && txt.length > 1) parts.push(repeated === 1 ? '1 ya estaba' : `${repeated} ya estaban`);
  if (skipped) parts.push(skipped === 1 ? '1 archivo no era .txt' : `${skipped} archivos no eran .txt`);
  if (parts.length) toast(parts.join(' · '));
  if (firstId) onOpen(firstId);
}

function bookStatus(b) {
  const rate = getSettings().rate;
  if (!b.position) return `Sin empezar · ${formatDuration(b.chars, rate)}`;
  if (b.progress >= 0.999) return 'Terminado';
  const left = b.chars * (1 - b.progress);
  return `${Math.round(b.progress * 100)}% · quedan ${formatDuration(left, rate)}`;
}

async function renderContinue() {
  const card = $('continue-card');
  const last = books.find((b) => b.lastOpenedAt && b.progress < 0.999);
  if (!last) {
    card.hidden = true;
    return;
  }
  card.dataset.book = last.id;
  card.innerHTML = `
    <span class="label">Continuar escuchando</span>
    <h2>${escapeHtml(last.title)}</h2>
    <p class="snippet"></p>
    <button class="play-btn small" aria-label="Continuar ${escapeHtml(last.title)}">${icon('play')}</button>
    <div class="progress"><span style="width:${(last.progress * 100).toFixed(1)}%"></span></div>`;
  card.hidden = false;
  // Show where the reader left off.
  const text = await getText(last.id);
  if (text && card.dataset.book === last.id) {
    const { chunks } = parseBook(text, last.lang);
    const snippet = chunks[Math.min(last.position, chunks.length - 1)]?.text.trim() || '';
    card.querySelector('.snippet').textContent = snippet ? `“${snippet}”` : bookStatus(last);
  }
}

// ---- Sorting ----

// Comparators sort ascending; `desc` reverses. Each sort starts in its natural direction.
const DEFAULT_DESC = { recent: true, added: true, name: false, length: false, manual: false };
const DIR_LABELS = {
  recent: ['Abiertos hace más tiempo primero', 'Abiertos recientemente primero'],
  added: ['Cargados hace más tiempo primero', 'Cargados recientemente primero'],
  name: ['A → Z', 'Z → A'],
  length: ['Más cortos primero', 'Más largos primero'],
};
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

function compareBooks(sort) {
  switch (sort) {
    case 'added':
      return (a, b) => a.addedAt - b.addedAt;
    case 'name':
      return (a, b) => collator.compare(a.title, b.title);
    case 'length':
      return (a, b) => a.chars - b.chars;
    case 'manual':
      // Books without a saved place (just added) go first, newest on top.
      return (a, b) => {
        const ha = Number.isFinite(a.order);
        const hb = Number.isFinite(b.order);
        if (ha && hb) return a.order - b.order;
        if (ha !== hb) return ha ? 1 : -1;
        return b.addedAt - a.addedAt;
      };
    default:
      return (a, b) => (a.lastOpenedAt || a.addedAt) - (b.lastOpenedAt || b.addedAt);
  }
}

/** A sorted copy: `books` itself stays most-recent-first for the "continue" card. */
function sortedBooks(list) {
  const { librarySort: sort, librarySortDesc: desc } = getSettings();
  const cmp = compareBooks(sort);
  const sorted = [...list].sort(cmp);
  return sort !== 'manual' && desc ? sorted.reverse() : sorted;
}

async function changeSort(sort) {
  const s = getSettings();
  if (sort === 'manual' && !books.some((b) => Number.isFinite(b.order))) {
    // First time: start "Mi orden" from what is on screen, so nothing jumps.
    const ids = sortedBooks(books).map((b) => b.id);
    ids.forEach((id, i) => (books.find((b) => b.id === id).order = i));
    await setBookOrder(ids);
  }
  setSettings({ librarySort: sort, librarySortDesc: DEFAULT_DESC[sort] ?? s.librarySortDesc });
  renderList();
}

function renderSortControls(q) {
  const { librarySort: sort, librarySortDesc: desc } = getSettings();
  $('lib-sort').value = sort;
  const dir = $('lib-dir');
  dir.hidden = sort === 'manual';
  if (sort !== 'manual') {
    const label = DIR_LABELS[sort][desc ? 1 : 0];
    dir.innerHTML = icon(desc ? 'arrowDown' : 'arrowUp');
    dir.setAttribute('aria-label', `Invertir orden (ahora: ${label})`);
    dir.title = label;
  }
  $('manual-hint').hidden = !(sort === 'manual' && !q && books.length > 1);
}

function renderList() {
  const q = $('lib-search').value.trim().toLowerCase();
  const filtered = q ? books.filter((b) => b.title.toLowerCase().includes(q)) : books;
  const visible = sortedBooks(filtered);
  const canDrag = getSettings().librarySort === 'manual' && !q && books.length > 1;
  $('lib-tools').hidden = books.length === 0;
  $('lib-search').hidden = books.length < 6;
  $('empty-state').hidden = books.length > 0;
  renderSortControls(q);
  $('book-list').innerHTML = visible
    .map(
      (b) => `
    <li class="book" data-book="${b.id}" tabindex="0" role="button" aria-label="Abrir ${escapeHtml(b.title)}">
      ${canDrag ? `<button type="button" class="drag-handle" data-drag aria-label="Mover ${escapeHtml(b.title)}. Usa las flechas arriba y abajo.">${icon('grip')}</button>` : ''}
      <div class="book-cover" style="background:${coverColor(b.title)}">${escapeHtml(b.title.trim()[0]?.toUpperCase() || '?')}</div>
      <div class="book-info">
        <h3>${escapeHtml(b.title)}</h3>
        <p>${bookStatus(b)}${b.lastOpenedAt ? ` · ${relativeDate(b.lastOpenedAt)}` : ''}</p>
        <div class="progress"><span style="width:${(b.progress * 100).toFixed(1)}%"></span></div>
      </div>
      <button class="icon-btn danger" data-delete="${b.id}" aria-label="Quitar ${escapeHtml(b.title)}">${icon('trash')}</button>
    </li>`,
    )
    .join('');
}

function setupDragAndDrop() {
  const overlay = $('drop-overlay');
  let depth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFiles(e) || $('library').hidden) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (isFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    importFiles([...e.dataTransfer.files]);
  });
}

// ---- Drag to reorder ("Mi orden") ----
// Pointer events on a handle, so it works with touch and mouse and the rest
// of the list still scrolls normally.

let suppressClickUntil = 0;

function setupReorder() {
  const list = $('book-list');
  let drag = null;

  const finish = async (commit) => {
    if (!drag) return;
    const { li, raf } = drag;
    cancelAnimationFrame(raf);
    li.classList.remove('dragging');
    li.style.transform = '';
    list.classList.remove('is-dragging');
    const moved = drag.moved;
    drag = null;
    if (moved) suppressClickUntil = Date.now() + 400;
    if (commit && moved) await saveDomOrder();
  };

  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-drag]');
    if (!handle || e.button > 0) return;
    e.preventDefault();
    const li = handle.closest('.book');
    const rect = li.getBoundingClientRect();
    drag = { li, pointerId: e.pointerId, grabY: e.clientY - rect.top, y: e.clientY, moved: false, raf: 0 };
    handle.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    list.classList.add('is-dragging');
    const tick = () => {
      if (!drag) return;
      // Scroll the page when dragging near the top or bottom edge.
      const edge = 70;
      if (drag.y < edge) window.scrollBy(0, -Math.ceil((edge - drag.y) / 6));
      else if (drag.y > innerHeight - edge) window.scrollBy(0, Math.ceil((drag.y - innerHeight + edge) / 6));
      place();
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  });

  const place = () => {
    const { li, y, grabY } = drag;
    // Move the row past neighbours whose middle the pointer has crossed.
    let next = li.nextElementSibling;
    while (next && y > mid(next)) {
      list.insertBefore(next, li);
      drag.moved = true;
      next = li.nextElementSibling;
    }
    let prev = li.previousElementSibling;
    while (prev && y < mid(prev)) {
      list.insertBefore(li, prev);
      drag.moved = true;
      prev = li.previousElementSibling;
    }
    // Then let the row follow the finger.
    li.style.transform = '';
    const natural = li.getBoundingClientRect().top;
    li.style.transform = `translateY(${y - grabY - natural}px)`;
  };

  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
  });
  list.addEventListener('pointerup', (e) => drag && e.pointerId === drag.pointerId && finish(true));
  list.addEventListener('pointercancel', (e) => drag && e.pointerId === drag.pointerId && finish(true));

  // Keyboard: arrows move the focused handle's book.
  list.addEventListener('keydown', async (e) => {
    const handle = e.target.closest('[data-drag]');
    if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const li = handle.closest('.book');
    if (e.key === 'ArrowUp' && li.previousElementSibling) list.insertBefore(li, li.previousElementSibling);
    else if (e.key === 'ArrowDown' && li.nextElementSibling) list.insertBefore(li.nextElementSibling, li);
    else return;
    handle.focus();
    await saveDomOrder();
  });
}

function mid(el) {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
}

async function saveDomOrder() {
  const ids = [...$('book-list').querySelectorAll('[data-book]')].map((el) => el.dataset.book);
  ids.forEach((id, order) => {
    const b = books.find((x) => x.id === id);
    if (b) b.order = order;
  });
  await setBookOrder(ids);
}

/** "Open with" from the operating system when the app is installed (desktop). */
function setupLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    importFiles(files);
  });
}
