/* 儿童成长助手 - Service Worker（离线可用 + PWA 可安装）
   v15：HTML 改网络优先（1.5s 超时回退缓存），改完推送后打开即最新版，不必二次刷新 */
const CACHE = 'child-growth-v15';
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

/* HTML：网络优先（保证拿到最新版）→ 1.5s 内没回来就先用缓存秒开，
   网络结果仍会写入缓存供下次/离线使用。
   之前是「缓存优先」，导致改完推送后用户打开看到的还是旧页面，必须二次刷新才生效。
   其它资源：网络优先，失败回退缓存 */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  var isHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');

  if (isHtml) {
    e.respondWith(
      new Promise(function (resolve) {
        var settled = false;
        // 网络偏慢时先用缓存秒开，不阻塞用户
        var timer = setTimeout(function () {
          if (settled) { return; }
          caches.match(e.request).then(function (c) {
            if (c && !settled) { settled = true; resolve(c); }
          });
        }, 1500);

        fetch(e.request).then(function (res) {
          clearTimeout(timer);
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          }
          if (!settled) { settled = true; resolve(res); }
        }).catch(function () {
          clearTimeout(timer);
          if (settled) { return; }
          settled = true;
          resolve(caches.match(e.request).then(function (c) {
            return c || caches.match('./index.html');
          }));
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
