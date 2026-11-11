// Service worker: η εφαρμογή ανοίγει αμέσως από τη μνήμη του κινητού, και χωρίς σύνδεση
// (η αναζήτηση/δρομολόγηση θέλουν internet).
//  • CACHE  : τα αρχεία της εφαρμογής — αλλάζει όνομα σε κάθε έκδοση
//  • VENDOR : μεγάλα αρχεία που δεν αλλάζουν (ανάγνωση screenshots ~12 MB, χάρτης) — ΔΕΝ σβήνεται στις ενημερώσεις
const CACHE = 'rooting-v50';
const VENDOR = 'rooting-vendor-1';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'solver.js', 'ocr.js', 'geo.js', 'mapview.js', 'navigate.js', 'icons.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== VENDOR).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('version.json')) return; // πάντα από το δίκτυο
  const vendor = url.pathname.includes('/vendor/');
  const name = vendor ? VENDOR : CACHE;
  // Πρώτα από τη μνήμη (άμεσο άνοιγμα). Οι ενημερώσεις έρχονται όταν αλλάξει το version.json:
  // τότε η εφαρμογή αδειάζει το CACHE και ξαναφορτώνει, οπότε όλα τα αρχεία έρχονται μαζί από το δίκτυο.
  e.respondWith(
    caches.open(name).then((c) => c.match(e.request, { ignoreSearch: !vendor }).then((hit) => hit ||
      fetch(e.request, { cache: 'no-cache' }).then((r) => {
        if (r.ok) c.put(e.request, r.clone());
        return r;
      }).catch(() => (e.request.mode === 'navigate' ? c.match('index.html') : Response.error()))))
  );
});
