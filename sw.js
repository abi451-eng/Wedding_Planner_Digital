/* Wedding Fund — Service Worker
   Naikkan nomor versi (v1 -> v2 -> ...) tiap kali kamu update index.html,
   supaya cache lama otomatis dibersihkan di HP. */
const CACHE = 'wedding-fund-v7';

// File inti yang di-cache saat install (app tetap jalan tanpa internet)
const SHELL = [
  './',
  './index.html',
  './db.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// Install: simpan app shell
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {})) // jangan gagal total kalau 1 file meleset
      .then(() => self.skipWaiting())
  );
});

// Activate: hapus cache versi lama
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: stale-while-revalidate
// -> tampilkan versi cache dulu (cepat & offline), lalu perbarui di background
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Halaman HTML -> NETWORK-FIRST: selalu ambil versi terbaru saat online,
  // jadi tiap deploy baru langsung kelihatan (nggak nyangkut cache lama).
  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  // Aset lain (Chart.js, font, ikon) -> stale-while-revalidate: cepat + offline.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
