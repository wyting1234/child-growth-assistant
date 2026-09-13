/* 儿童成长助手 - Service Worker（离线可用 + PWA 可安装）
   v14：HTML 改为「网络优先 + 超时回退缓存」，修复「推送后仍显示旧版」；
        预缓存改用 cache:'reload' 绕过 GitHub Pages 的 HTTP 缓存（HTML 默认 max-age=600），
        避免后台更新反而把旧副本又写回缓存。 */
const CACHE = 'child-growth-v16';
const CORE = ['./', './index.html', './study-record.html', './情商club.html', './成长复盘.html', './朝暮计-双端适配版.html', './account-manager.js', './manifest.json'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 逐个 reload 拉取：绕过 HTTP 缓存，且单个失败不影响整体安装
      return Promise.all(CORE.map(function (u) {
        return fetch(new Request(u, { cache: 'reload' })).then(function (res) {
          if (res && res.status === 200) return c.put(u, res);
        }).catch(function () { /* 离线或单个失败：忽略，仍可完成安装 */ });
      }));
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

/* HTML：网络优先（带超时回退缓存）→ 联网时一刷新就是最新版，弱网/离线回退缓存秒开
   其它资源：网络优先，失败回退缓存 */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  var isHtml = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');

  if (isHtml) {
    e.respondWith(networkFirst(e.request, 3000));
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

/* 网络优先 + 超时回退：保证「刷新即最新」，同时不牺牲离线可用
   - 网络先返回（含 304/200）→ 用它，并静默更新缓存
   - 超过 timeoutMs 或断网失败 → 立刻回退缓存，页面不干等
   - 回退之后网络若仍成功返回，照样写回缓存（后台静默升级） */
function networkFirst(req, timeoutMs) {
  return new Promise(function (resolve) {
    var settled = false;

    function fromCache() {
      if (settled) return;
      settled = true;
      caches.match(req).then(function (c) {
        resolve(c || caches.match('./index.html'));
      });
    }

    var timer = setTimeout(fromCache, timeoutMs);

    fetch(req, { cache: 'no-cache' }).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      if (!settled) { settled = true; clearTimeout(timer); resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      fromCache();
    });
  });
}
