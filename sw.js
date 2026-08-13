// Mavis Service Worker
const CACHE = 'mavis-v1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

// install：不阻塞，让 SW 尽快进入 waiting 状态
// 缓存预加载放在后台进行，不阻塞 install 完成
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  // 不调用 skipWaiting：让新 SW 进入 waiting 状态，
  // 由用户在页面点击「更新」后通过 postMessage 触发 SKIP_WAITING 完成接管
});

// activate：清理旧缓存并立即接管
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// fetch：stale-while-revalidate 策略
// 优先用缓存（瞬间响应），同时后台更新缓存；缓存缺失时才等网络
// 这样用户感知"秒开"，更新在后台静默进行
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 不缓存 API 请求
  if (url.pathname.includes('/chat/completions') || url.pathname.includes('/models')) return;
  // 只处理同源请求
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then(cached => {
      // 后台异步更新缓存（不阻塞响应）
      const fetchPromise = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);

      // 有缓存 → 立即返回缓存，后台同时更新
      // 无缓存 → 等网络请求
      return cached || fetchPromise;
    })
  );
});

// 接收页面消息：手动触发跳过等待，立即接管
self.addEventListener('message', e => {
  if (e.data && e.data.action === 'SKIP_WAITING') self.skipWaiting();
});
