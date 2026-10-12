/* 儿女学习时光 - Service Worker（离线可用 + PWA 可安装）
   v25：全站同步入口收敛完成。
        ① 同步引擎（cga-shard + sync-github + sync-gitee）只在 index.html 加载，
           index.html 就是导航中心；其余页面一律不加载引擎。
        ② 每个页面都引入 backup-hub.js —— 只为它的写入时间埋点（加载即装钩子，
           不 mount、页面不出现任何新 UI），让「本机每个键的最后写入时间」在
           每一页都真实可记（同源共用一份 localStorage，判新旧全靠它）。
        ③ 删除三处仍在页面内的自建 Gist 同步实现：情商club（EqSyncManager）、
           成长复盘（child-growth-assistant-sync.json）、
           朝暮计（efficiency-hub-sync.json —— 与效率中心共用同一个云端文件，
           最危险的一处）。子页侧栏「云端同步」统一跳到 index.html#sync。
        ④ 首页/成长复盘的 #sync 锚点改为「本页有引擎就点 #syncStatusBtn，
           没有就转导航中心」，并做了首页防死循环。
   v24：站点更名「儿女学习时光」；同步栈收敛到 efficiency-hub 同源引擎
        （cga-shard.js + sync-github.js + sync-gitee.js + backup-hub.js），
        退休 sync-core/sync-gist/sync-ui；补入 learning-goal / 时间统计 到预缓存。
   v22：首页成就墙布局调整——去掉「宝宝1/2」字眼，宝贝名字置首行，成就墙与段位并排第二行。
   v21：成就名字列补字号规则（10.5px），根治 4 字名折行。
   v20：成就格 gap/padding 收紧，修复 4 字成就名折行。
   v19：首页成就墙支持按宝宝切换（宝宝1/宝宝2），修复成就墙溢出卡片。
   v18：新增「游戏改变世界.html」「陪伴星球.html」，并入预缓存清单。
   v17：同步模块拆分为「内核 + 两个后端 + 界面 + 备份中心」5 个独立文件，
        全部纳入预缓存，避免离线打开时同步按钮点了没反应。
   v14：HTML 改为「网络优先 + 超时回退缓存」，修复「推送后仍显示旧版」；
        预缓存改用 cache:'reload' 绕过 GitHub Pages 的 HTTP 缓存（HTML 默认 max-age=600），
        避免后台更新反而把旧副本又写回缓存。 */
const CACHE = 'child-growth-v25';
const CORE = [
  './', './index.html', './study-record.html', './情商club.html', './成长复盘.html',
  './朝暮计-双端适配版.html', './learning-goal.html', './时间统计.html',
  './游戏改变世界.html', './陪伴星球.html',
  './account-manager.js', './site-nav.js', './manifest.json',
  './cga-shard.js', './sync-github.js', './sync-gitee.js', './backup-hub.js'
];

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
