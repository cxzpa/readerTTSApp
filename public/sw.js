// Offline support. The build fills in PRECACHE (every app file) and VERSION
// (a hash of their contents), so the first visit caches the whole app and
// each update replaces the old cache. Neural voice runtime files are cached
// the first time they are used; voice models are stored by the app itself.
const VERSION = '__VERSION__';
const PRECACHE = /*__PRECACHE__*/ [];
const CACHE = `lector-${VERSION}`;
// Neural voice runtime (~50 MB) lives in its own cache so app updates don't
// throw it away; it is replaced only when those files change.
const VENDOR_VERSION = '__VENDOR_VERSION__';
const VENDOR_CACHE = `lector-vendor-${VENDOR_VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Only old app/vendor caches; 'lector-models' (downloaded voices) is kept.
      .then((keys) => Promise.all(keys.filter((k) => /^lector-(vendor-)?[0-9a-f]{12}$/.test(k) && k !== CACHE && k !== VENDOR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Fresh page when online; cached app when offline or if the server errors.
    event.respondWith(
      fetch(req)
        .then((res) => (res.ok ? res : caches.match('./index.html', { ignoreVary: true }).then((hit) => hit || res)))
        .catch(() => caches.match('./index.html', { ignoreVary: true }).then((hit) => hit || caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            const name = url.pathname.includes('/vendor/') ? VENDOR_CACHE : CACHE;
            caches.open(name).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
