// Service Worker：快取 App 外殼，斷線時仍可開啟（題庫備援由 app.js 的 offline_cache 負責）
const CACHE = 'surprise-machine-v3'; // 更新檔案後請改版本號
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'districts.geojson',
  'chime.mp3', 'countdown.mp3', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))) // 缺檔不讓安裝失敗
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && !k.startsWith('surprise-audio')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同源資源：網路優先，失敗退回快取；GAS API（跨網域）不攔截
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
