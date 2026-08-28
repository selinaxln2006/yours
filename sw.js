/* 枢 · 生活工作台 Service Worker —— 离线缓存应用外壳 */
const CACHE = 'shu-workbench-v21';
const ASSETS = [
  './',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith('http')) return;

  // API 请求（/api/*）：一律直连网络、永不缓存 —— 登录态/同步数据不能吃陈旧缓存
  const u = new URL(req.url);
  if (u.pathname === '/api' || u.pathname.startsWith('/api/')) return;

  // 导航请求（页面加载）：网络优先 —— 代码更新后刷新即可看到新版本
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }      ).catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./console.html'))
      )
    );
    return;
  }

  // 静态资源：缓存优先，保证离线可用
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => Response.error());
    })
  );
});
