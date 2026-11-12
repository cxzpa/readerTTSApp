// Home screen: the saved books, "continue reading" and adding new .txt files.
import { listBooks, addBook, deleteBook, hashText, getText, requestPersistence } from './db.js';
import { decodeText, detectLang, parseBook, titleFromFileName } from './text.js';
import { getSettings } from './settings.js';
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

  $('book-list').addEventListener('click', async (e) => {
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

function renderList() {
  const q = $('lib-search').value.trim().toLowerCase();
  const visible = q ? books.filter((b) => b.title.toLowerCase().includes(q)) : books;
  $('lib-tools').hidden = books.length === 0;
  $('lib-search').hidden = books.length < 6;
  $('empty-state').hidden = books.length > 0;
  $('book-list').innerHTML = visible
    .map(
      (b) => `
    <li class="book" data-book="${b.id}" tabindex="0" role="button" aria-label="Abrir ${escapeHtml(b.title)}">
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

/** "Open with" from the operating system when the app is installed (desktop). */
function setupLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    importFiles(files);
  });
}
