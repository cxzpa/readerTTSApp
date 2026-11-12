// Tracks work that must not be interrupted by an automatic reload
// (importing books, downloading a voice, dragging a book). When the last
// piece finishes, 'lector:idle' is dispatched so a pending update can apply.
const active = new Set();

export function busyStart(key) {
  active.add(key);
}

export function busyEnd(key) {
  active.delete(key);
  if (!active.size) window.dispatchEvent(new Event('lector:idle'));
}

export function isBusy() {
  return active.size > 0;
}
