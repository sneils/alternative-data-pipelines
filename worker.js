// Offline receiver. Precaches the receiver page and its dependencies so a
// reload with no network still works - the airplane-mode proof depends on it.
//
// Relative precache URLs resolve against this script's location, so it works
// both at localhost:8123/ and under a GitHub Pages subpath. The ?v must track
// the <script> tag in receiver.html; bump CACHE when either changes.
const CACHE = 'receiver-offline-v7';
const CORE = ['tools/receiver.html', 'lib/protocol.js?v=2', 'vendor/jsQR.js', 'vendor/qrcode.js'];
const CORE_URLS = new Set(CORE.map(p => new URL(p, self.location).href));

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Versioned core assets: cache-first - a ?v bump is the update signal.
  if (req.mode !== 'navigate' && CORE_URLS.has(req.url)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => cachePut(req, res))));
    return;
  }

  // Pages and data files (measurements.json included): network-first so edits
  // show up immediately when online; the cached copy is the offline fallback,
  // and any page relaunched offline lands on the cached receiver.
  e.respondWith(
    fetch(req).then(res => cachePut(req, res)).catch(() =>
      caches.match(req).then(hit => hit ||
        (req.mode === 'navigate' ? caches.match('tools/receiver.html') : Response.error())))
  );
});

// Cache a copy of a successful response and return the original.
function cachePut(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
  }
  return res;
}
