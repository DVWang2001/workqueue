const CACHE = 'workqueue-v5';
const SHELL = ['./', './index.html', './style.css', './app.js',
               './firebase-config.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;

  // HTML / JS / CSS：網路優先，離線才用快取
  const url = new URL(e.request.url);
  const isShell = ['.html', '.js', '.css', '.json'].some(ext => url.pathname.endsWith(ext))
                  || url.pathname === '/' || url.pathname.endsWith('/');

  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // 圖示等靜態資源：快取優先
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request))
    );
  }
});
