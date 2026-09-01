/* 儿童成长助手 - Service Worker（离线可用 + PWA 可安装）
   v18：HTML 网络优先（失败才回退缓存）。导航中心升级为默认首页 index.html，原主页更名 主页.html */
const CACHE = 'child-growth-v18';
const CORE = ['./', './index.html', './主页.html', './study-record.html', './情商club.html', './时间统计.html', './account-manager.js', './manifest.json'];

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

/* HTML：严格网络优先。在线时先请求网络，拿到最新版就展示并更新缓存；
   只有网络真正失败（断网/超时等）才回退缓存。去掉 1.5s 提前回退，避免在
   GitHub Pages 部署延迟或网络抖动时把旧版秒开展示给用户。
   其它资源：网络优先，失败回退缓存 */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  var isHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');

  if (isHtml) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        // 网络正常：展示新版并写入缓存
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        // 网络真正失败：回退缓存，保证离线可用
        return caches.match(e.request).then(function (c) {
          return c || caches.match('./index.html');
        });
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
