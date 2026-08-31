/* 儿童成长助手 - Service Worker（离线可用 + PWA 可安装）
   v8：HTML 走 stale-while-revalidate，页面切换秒开；汉堡常驻、无隐身逻辑 */
const CACHE = 'child-growth-v8';
const CORE = ['./', './index.html', './study-record.html', './情商club.html', './account-manager.js', './manifest.json'];

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

/* HTML：缓存优先（秒开）→ 后台拉最新版更新缓存（stale-while-revalidate）
   其它资源：网络优先，失败回退缓存 */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  var isHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');

  if (isHtml) {
    e.respondWith(
      caches.match(e.request).then(function (cached) {
        // 先返回缓存（如果有），让页面立刻显示
        var networkFetch = fetch(e.request).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          }
          return res;
        }).catch(function () {
          return cached || caches.match('./index.html');
        });
        return cached || networkFetch;
      })
    );
    return;
  }

  // 其它资源：网络优先，失败回退缓存
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
