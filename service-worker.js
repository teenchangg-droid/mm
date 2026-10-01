/* service-worker.js — 앱 자체를 오프라인에서 실행하기 위한 캐시
 * 음원은 여기서 다루지 않는다(IndexedDB에 Blob으로 저장, blob: URL로 재생하므로 네트워크가 필요 없음).
 * 앱 파일을 수정해서 다시 배포할 때는 VERSION 값을 올려야 기기의 캐시가 갱신된다.
 */
const VERSION = 'v4';
const SHELL_CACHE = `my-music-shell-${VERSION}`;
const RUNTIME_CACHE = 'my-music-runtime'; // lamejs / FFmpeg 등 CDN 파일 (한 번 받으면 오프라인 변환 가능)
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'db.js', 'player.js', 'media-session.js', 'converter.js',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
const CDN = ['cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('my-music-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(req, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(fallbackKey || req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { if (res && res.ok) cache.put(fallbackKey || req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('오프라인 상태예요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') { e.respondWith(staleWhileRevalidate(req, SHELL_CACHE, 'index.html')); return; }
  if (url.origin === self.location.origin) { e.respondWith(staleWhileRevalidate(req, SHELL_CACHE)); return; }
  if (CDN.includes(url.hostname)) e.respondWith(cacheFirst(req, RUNTIME_CACHE));
});
