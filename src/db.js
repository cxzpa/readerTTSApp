// Local library stored in IndexedDB. Book metadata and full text live in
// separate stores so the library list stays fast even with many books.

const DB_NAME = 'lector-tts';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción cancelada'));
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listBooks() {
  const db = await open();
  const books = await request(db.transaction('books').objectStore('books').getAll());
  return books.sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
}

export async function getBook(id) {
  const db = await open();
  return request(db.transaction('books').objectStore('books').get(id));
}

export async function getText(id) {
  const db = await open();
  const row = await request(db.transaction('texts').objectStore('texts').get(id));
  return row?.text ?? null;
}

/** Add a book, or return the existing one if the same text was already loaded. */
export async function addBook(meta, text) {
  const db = await open();
  const existing = await getBook(meta.id);
  if (existing) return { book: existing, isNew: false };
  const tx = db.transaction(['books', 'texts'], 'readwrite');
  tx.objectStore('books').put(meta);
  tx.objectStore('texts').put({ id: meta.id, text });
  await done(tx);
  return { book: meta, isNew: true };
}

export async function updateBook(id, patch) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  const store = tx.objectStore('books');
  const book = await request(store.get(id));
  if (!book) return null;
  Object.assign(book, patch);
  store.put(book);
  await done(tx);
  return book;
}

/** Save a manual order for the library in one transaction (other fields untouched). */
export async function setBookOrder(ids) {
  const db = await open();
  const tx = db.transaction('books', 'readwrite');
  const store = tx.objectStore('books');
  ids.forEach((id, order) => {
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, order });
    };
  });
  await done(tx);
}

export async function deleteBook(id) {
  const db = await open();
  const tx = db.transaction(['books', 'texts'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('texts').delete(id);
  await done(tx);
}

/** Stable id from the file contents, so loading the same book twice doesn't duplicate it. */
export async function hashText(text) {
  if (crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (insecure contexts): FNV-1a.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `f${(h >>> 0).toString(16)}${text.length.toString(16)}`;
}

/** Ask the browser not to evict the library when storage runs low. */
export function requestPersistence() {
  try {
    navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}
