/* 儿童成长助手 - Service Worker（离线可用 + PWA 可安装）
   v5：错题本下拉彻底跟学员同步 + 汉堡侧栏左缘定位 */
const CACHE = 'child-growth-v5';
const CORE = ['./', './index.html', './study-record.html', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(CORE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* 网络优先，失败回退缓存（离线时仍可使用核心功能） */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  // HTML 页面导航请求：始终网络优先，不写入缓存，确保更新即时生效
  var isHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (isHtml) {
    e.respondWith(
      fetch(e.request).catch(function () {
        return caches.match(e.request).then(function (m) {
          return m || caches.match('./index.html');
        });
      })
    );
    return;
  }

  // 其他资源（manifest、图标等）：网络优先，缓存副本供离线回退
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
