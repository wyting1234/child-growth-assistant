/* ================================================================
 *  儿童成长助手 · 云同步界面  sync-ui.js
 *  ----------------------------------------------------------------
 *  把「内核（sync-core.js）」与「两个后端（sync-gist.js / sync-gitee.js）」
 *  接起来，并负责全部界面交互：
 *    · 侧边栏「☁️ 云端同步」按钮 → 打开面板
 *    · 上传 / 下载（支持 合并 / 覆盖 三选一）
 *    · 后端切换（GitHub Gist / Gitee）
 *    · 配置令牌、进度反馈、结果提示
 *
 *  ⚠️ 必须排在 sync-core.js / sync-gist.js / sync-gitee.js 之后加载。
 * ================================================================ */
(function () {
  'use strict';

  var Core = window.CGASyncCore;
  if (!Core) {
    console.warn('[SyncUI] 同步内核未加载，云端同步界面已跳过');
    return;
  }

  /* ============ 配置 ============ */
  var BACKEND_KEY = 'sync_backend';        // 'gist' | 'gitee'
  var LAST_SYNC_KEY = 'sync_last_sync';
  var DIRTY_KEY = 'sync_dirty';

  function getBackend() {
    try {
      var b = localStorage.getItem(BACKEND_KEY);
      return b === 'gitee' ? 'gitee' : 'gist';
    } catch (e) { return 'gist'; }
  }
  function setBackend(b) {
    try { localStorage.setItem(BACKEND_KEY, b === 'gitee' ? 'gitee' : 'gist'); } catch (e) {}
  }

  function activeIO() {
    return getBackend() === 'gitee' ? window.CGAGiteeIO : window.CGAGistIO;
  }
  function activeApi() {
    return getBackend() === 'gitee' ? window.CGAGiteeApi : window.CGAGistApi;
  }
  function backendLabel() {
    return getBackend() === 'gitee' ? 'Gitee 码云' : 'GitHub Gist';
  }

  function hasToken() {
    var api = activeApi();
    return !!(api && api.hasToken && api.hasToken());
  }

  function toastMsg(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    console.log('[SyncUI] ' + msg);
  }

  /* ============ 状态 ============ */
  var connected = false;
  var dirty = false;
  // 同步过程中自己回写数据时置 true，避免把「同步写入」误判成「用户改动」→ 永远显示脏
  var suppressDirty = false;

  function readDirty() {
    try { dirty = localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { dirty = false; }
    markDirtyUI();
  }
  function markDirty() {
    dirty = true;
    try { localStorage.setItem(DIRTY_KEY, '1'); } catch (e) {}
    markDirtyUI();
  }
  function markClean() {
    dirty = false;
    try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
    markDirtyUI();
  }
  function markDirtyUI() {
    var dot = document.getElementById('syncDot');
    if (dot) dot.classList.toggle('on', dirty);
  }
  function lastSyncText() {
    var ts = localStorage.getItem(LAST_SYNC_KEY);
    if (!ts) return '还没有同步过';
    try {
      var d = new Date(Number(ts));
      return '上次：' + d.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return '上次同步过'; }
  }
  function setLastSync() {
    try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch (e) {}
  }

  /* ============ 数据变更检测 ============ */
  // 双保险：CGA 的绝大多数业务写入走 Storage.set()，但也存在直接
  // localStorage.setItem 的地方，两层都包才能保证「有未同步更改」不误报为干净。
  // 标志位放闭包（不能挂 localStorage，那会污染出一个新键）。
  var setItemWrapped = false;
  function wrapStorage() {
    function apply() {
      // ① 包 Storage.set（注意：CGA 顶层 var Storage 已覆盖原生 window.Storage）
      try {
        var S = (typeof window.Storage === 'object' && window.Storage) ? window.Storage : null;
        if (S && typeof S.set === 'function' && !S.set.__wrapped) {
          var origSet = S.set;
          var wrappedSet = function (k, v) {
            origSet(k, v);
            try { if (!suppressDirty && !Core.isExcludedKey(k, null)) markDirty(); } catch (e) {}
          };
          wrappedSet.__wrapped = true;
          S.set = wrappedSet;
        }
      } catch (e) { console.warn('[SyncUI] 包装 Storage.set 失败', e); }

      // ② 包 localStorage.setItem（兜底，覆盖未走 Storage 的直写）
      // ⚠️ 两个坑（与 backup-hub.js 同源，改一处必须同步改另一处）：
      //    坑① setItem 在 Storage 原型上，写 localStorage.setItem = fn 只会在实例上
      //         新增一个名为 "setItem" 的键（会被枚举、会被备份出去），包装却不生效。
      //    坑② 本页 window.Storage 已被 CGA 的业务对象影子化
      //         （index.html 顶层 `var Storage = { rk/set/get }`），
      //         所以 Storage.prototype 是业务对象的原型，挂上去没用。
      //    正解：从 localStorage 自己反查原型链。
      //    标志位放闭包，不能挂 localStorage（那会污染出 __hub_setItem_wrapped 键）。
      try {
        if (!setItemWrapped) {
          var _lp = Object.getPrototypeOf(localStorage);
          if (_lp && typeof _lp.setItem === 'function') {
            setItemWrapped = true;
            var origSetItem = _lp.setItem;
            _lp.setItem = function (k, v) {
              var r = origSetItem.apply(this, arguments);
              try { if (!suppressDirty && !Core.isExcludedKey(k, null)) markDirty(); } catch (e) {}
              return r;
            };
          }
        }
      } catch (e) { console.warn('[SyncUI] 包装 localStorage.setItem 失败', e); }
    }
    if (document.readyState === 'complete') apply();
    else window.addEventListener('load', apply);
  }

  /* ============ 通用弹窗（flex-start 防溢出 + sticky 关闭） ============ */
  function makeMask(innerHTML) {
    var mask = document.createElement('div');
    mask.className = 'modal-overlay show sync-mask';
    mask.style.zIndex = '2000';
    // ⚠️ CGA 的 .modal-box 已带 max-height:90vh + overflow-y:auto，
    //    遮罩层的 .modal-overlay 也已用 align-items:center —— 这里额外把
    //    mask 自身改成 flex-start + 可滚动，双重保险：即使将来 .modal-box
    //    的高度限制被改掉，关闭按钮也不会被挤出视口。
    mask.style.alignItems = 'flex-start';
    mask.style.overflowY = 'auto';
    mask.style.padding = '16px';
    mask.style.boxSizing = 'border-box';
    mask.innerHTML = '<div class="modal-box sync-box" style="margin:auto;max-width:460px;">' + innerHTML + '</div>';
    document.body.appendChild(mask);
    return mask;
  }

  function showConfirm(title, message, okText) {
    return new Promise(function (resolve) {
      var mask = makeMask(
        '<div class="modal-title"><span>' + esc(title) + '</span>' +
        '<button class="modal-close sync-cancel" type="button" aria-label="关闭">&times;</button></div>' +
        '<p style="font-size:14px;color:#475569;line-height:1.7;white-space:pre-wrap;margin:6px 0 20px;">' + esc(message) + '</p>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button class="btn sync-no" style="background:#fff;color:#475569;border:1px solid var(--border);">取消</button>' +
        '<button class="btn btn-primary sync-yes">' + esc(okText || '确定') + '</button></div>'
      );
      var done = function (v) { mask.remove(); resolve(v); };
      mask.querySelector('.sync-cancel').onclick = function () { done(false); };
      mask.querySelector('.sync-no').onclick = function () { done(false); };
      mask.querySelector('.sync-yes').onclick = function () { done(true); };
      mask.addEventListener('click', function (e) { if (e.target === mask) done(false); });
      escClose(mask);
    });
  }

  // 三选一：合并 / 覆盖 / 取消 → 'merge' | 'overwrite' | 'cancel'
  function showChoice(title, message, mergeText, overwriteText) {
    return new Promise(function (resolve) {
      var mask = makeMask(
        '<div class="modal-title"><span>' + esc(title) + '</span>' +
        '<button class="modal-close sync-cancel" type="button" aria-label="关闭">&times;</button></div>' +
        '<p style="font-size:14px;color:#475569;line-height:1.7;white-space:pre-wrap;margin:6px 0 20px;">' + esc(message) + '</p>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">' +
        '<button class="btn sync-cancel2" style="background:#fff;color:#475569;border:1px solid var(--border);">取消</button>' +
        '<button class="btn sync-ow" style="background:#fff;color:#475569;border:1px solid var(--border);">' + esc(overwriteText || '覆盖') + '</button>' +
        '<button class="btn btn-primary sync-mg">' + esc(mergeText || '合并') + '</button></div>'
      );
      var done = function (v) { mask.remove(); resolve(v); };
      mask.querySelector('.sync-cancel').onclick = function () { done('cancel'); };
      mask.querySelector('.sync-cancel2').onclick = function () { done('cancel'); };
      mask.querySelector('.sync-ow').onclick = function () { done('overwrite'); };
      mask.querySelector('.sync-mg').onclick = function () { done('merge'); };
      mask.addEventListener('click', function (e) { if (e.target === mask) done('cancel'); });
      escClose(mask);
    });
  }

  function showAlertMsg(title, message) {
    return new Promise(function (resolve) {
      var mask = makeMask(
        '<div class="modal-title"><span>' + esc(title) + '</span>' +
        '<button class="modal-close sync-ok" type="button" aria-label="关闭">&times;</button></div>' +
        '<p style="font-size:14px;color:#475569;line-height:1.7;white-space:pre-wrap;margin:6px 0 20px;">' + esc(message) + '</p>' +
        '<div style="display:flex;justify-content:flex-end;"><button class="btn btn-primary sync-ok2">知道了</button></div>'
      );
      var done = function () { mask.remove(); resolve(); };
      mask.querySelector('.sync-ok').onclick = done;
      mask.querySelector('.sync-ok2').onclick = done;
      mask.addEventListener('click', function (e) { if (e.target === mask) done(); });
      escClose(mask);
    });
  }

  // Esc 关闭 + 清理监听（避免监听器泄漏）
  function escClose(mask) {
    var onEsc = function (e) {
      if (e.key === 'Escape') { mask.remove(); document.removeEventListener('keydown', onEsc); }
    };
    document.addEventListener('keydown', onEsc);
    var origRemove = mask.remove.bind(mask);
    mask.remove = function () { document.removeEventListener('keydown', onEsc); origRemove(); };
  }

  function closeTopModal() {
    var m = document.querySelectorAll('.sync-mask');
    for (var i = 0; i < m.length; i++) m[i].remove();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ============ 进度反馈 ============ */
  // 同步要跑几秒到几十秒。没有进度，用户会以为「点了没反应」——
  // 这正是之前 Gitee「卡顿、不知道进程和结果」的根因。
  var progTimer = null, progStart = 0;
  function fmtSec(ms) { return (ms / 1000).toFixed(1) + 's'; }

  function progShow(state, title, detail) {
    var box = document.getElementById('syncProgress');
    if (!box) return;
    var color = state === 'ok' ? '#0a6b45' : (state === 'fail' ? '#a3341f' : '#1f4fa8');
    var bg = state === 'ok' ? '#eafaf3' : (state === 'fail' ? '#fdf0ee' : '#eef4ff');
    var bd = state === 'ok' ? '#b7ebd4' : (state === 'fail' ? '#f7ccc4' : '#cfe0ff');
    box.style.display = 'block';
    box.style.background = bg;
    box.style.border = '1px solid ' + bd;
    box.style.color = color;
    box.innerHTML = '<div style="font-weight:600;font-size:13px">' + esc(title) +
      '<span id="syncProgTime" style="float:right;font-weight:400;opacity:.8"></span></div>' +
      (detail ? '<div style="font-size:12px;margin-top:4px;line-height:1.6;opacity:.9">' + esc(detail) + '</div>' : '');
    var t = document.getElementById('syncProgTime');
    if (t) t.textContent = fmtSec(Date.now() - progStart);
  }
  function progTick() {
    var t = document.getElementById('syncProgTime');
    if (t) t.textContent = fmtSec(Date.now() - progStart);
  }
  function progStartRun() {
    progStart = Date.now();
    if (progTimer) clearInterval(progTimer);
    progTimer = setInterval(progTick, 200);
  }
  function progStop() {
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
  }
  function progHide() {
    progStop();
    var box = document.getElementById('syncProgress');
    if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  }
  function progBusy(on) {
    var btns = document.querySelectorAll('#syncPanelBody .sync-up, #syncPanelBody .sync-down, #syncPanelBody .sync-reconfig');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !!on;
  }

  function notifyOK(title, detail) {
    if (document.getElementById('syncProgress')) { progShow('ok', title, detail); progBusy(false); return; }
    toastMsg('✅ ' + title);
  }
  function notifyFail(title, detail) {
    progStop();
    if (document.getElementById('syncProgress')) { progShow('fail', title, detail); progBusy(false); return; }
    showAlertMsg(title, detail || '');
  }

  /* ============ 读云端 ============ */
  // 语义约定：返回 {data:{}} = 云端确实为空；throw = 真失败（带原因）。
  // 旧版把网络故障静默吞成 null，界面就弹「云端还没有数据」——
  // 把故障说成没数据，非常误导。
  async function readCloud(io) {
    var cloudMeta = null;
    try {
      cloudMeta = await Core.readShardedMetaWith(io);
    } catch (e) {
      throw new Error('读取云端失败：' + (e && e.message ? e.message : e) + '，请检查网络后重试');
    }
    if (cloudMeta && cloudMeta.shards) {
      var merged = await Core.readShardedWith(io, cloudMeta);
      // 附带每个键在云端的写入时间，供合并裁决
      var tsMap = {};
      try {
        for (var k in (cloudMeta.keys || {})) {
          if (Object.prototype.hasOwnProperty.call(cloudMeta.keys, k)) {
            tsMap[k] = cloudMeta.keys[k].ts || 0;
          }
        }
      } catch (e2) {}
      merged.tsMap = tsMap;
      return merged;
    }
    // 旧格式（内联版留存的单文件）不做兼容读取：CGA 旧同步写的是
    // child-growth-assistant-sync.json，格式与分片完全不同，强行兼容风险大于收益。
    return { data: {}, updatedAt: 0, tsMap: {} };
  }

  /* ============ 动作：上传 ============ */
  // 同步前先让备份中心把它节流中的「写入时间埋点」落盘。
  // 不这么做的话：用户改完数据立刻点上传，__hub_meta_v1__ 里还是旧时间戳，
  // 分片的脏判定会以为「本片没变」→ 跳过 → 改动留在本地没传上去（静默丢）。
  function flushWriteMeta() {
    try {
      if (window.BackupHub && typeof window.BackupHub.flushMeta === 'function') window.BackupHub.flushMeta();
    } catch (e) {}
  }

  async function doUpload() {
    if (!hasToken()) { openConfig(); return; }
    closeTopModal();
    flushWriteMeta();
    var io = activeIO();
    var api = activeApi();
    progStartRun();
    progShow('running', '正在上传到 ' + backendLabel() + '…', '正在检查远端分片、只重传改动过的片，稍等片刻。');
    progBusy(true);
    try {
      api.resetCache && api.resetCache();
      await api.ensureTarget();

      var cloudMeta = null;
      try { cloudMeta = await Core.readShardedMetaWith(io); } catch (e) { cloudMeta = null; }
      var cloudHas = !!(cloudMeta && cloudMeta.shards && Object.keys(cloudMeta.shards).length);

      var mode = 'overwrite';
      if (cloudHas) {
        var choice = await showChoice('上传到云端',
          '云端已经存有数据。\n「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖云端」用【本机数据】整体替换云端。',
          '合并到云端', '覆盖云端');
        if (choice === 'cancel') { progHide(); progBusy(false); return; }
        mode = choice;
      }

      var payloadData;
      if (mode === 'merge') {
        var remote = await readCloud(io);
        payloadData = Core.buildMergedUpload({ data: remote.data }, remote.tsMap);
      } else {
        payloadData = Core.collectLocalData();
      }

      var res = await Core.writeShardedWith(io, payloadData, mode === 'overwrite', function (n, total, sid) {
        progShow('running', '正在上传到 ' + backendLabel() + '…', '已写 ' + n + '/' + total + ' 片（' + sid + '）');
      });

      setLastSync();
      markClean();
      try {
        if (window.BackupHub && window.BackupHub.markSync) {
          window.BackupHub.markSync('up', Object.keys(payloadData));
        }
      } catch (e) {}

      var detail = '写了 ' + res.wroteShards + ' 片 / 共 ' + res.totalShards + ' 片';
      if (res.skippedShards) detail += '（跳过 ' + res.skippedShards + ' 片未改动）';
      if (res.deletedShards) detail += '，清理旧片 ' + res.deletedShards + ' 个';
      detail += '，' + (res.wroteBytes / 1024).toFixed(1) + ' KB';
      progStop();
      notifyOK('已上传到 ' + backendLabel(), detail);
      renderAccountLine();
    } catch (e) {
      console.warn('[SyncUI] 上传失败:', e);
      notifyFail('上传失败', (e && e.message) || String(e));
    } finally {
      progStop();
    }
  }

  /* ============ 动作：下载 ============ */
  async function doDownload() {
    if (!hasToken()) { openConfig(); return; }
    closeTopModal();
    var io = activeIO();
    var api = activeApi();
    progStartRun();
    progShow('running', '正在读取 ' + backendLabel() + '…', '正在拉取云端分片。');
    progBusy(true);
    try {
      api.resetCache && api.resetCache();
      await api.ensureTarget();

      var remote = await readCloud(io);
      if (!remote || !remote.data || Object.keys(remote.data).length === 0) {
        // 新版读不到分片时，顺手看一眼有没有旧版单文件——老用户升级后
        // 数据还在云端，只是换了文件名，必须给一条迁移路，否则会以为丢数据。
        var legacy = null;
        try {
          // 旧格式只存在于 Gist（Gitee 是本次新增的后端，从没写过旧格式）
          if (getBackend() === 'gist') {
            var raw = await io.getFile(Core.LEGACY_FILENAME);
            if (raw) legacy = Core.parseLegacyPayload(raw);
          }
        } catch (e) { legacy = null; }

        if (legacy && legacy.count > 0) {
          progHide(); progBusy(false);
          var go = await showConfirm('发现旧版云端数据',
            '云端存在旧版同步文件，共 ' + legacy.count + ' 项（更新于 ' +
            (legacy.updatedAt ? new Date(legacy.updatedAt).toLocaleString() : '未知时间') + '）。\n\n' +
            '可以直接把它迁移到本机（合并，不动本机已有内容），迁移后新格式也能正常同步。',
            '迁移到本机');
          if (!go) { await showAlertMsg('已取消', '旧数据仍保留在云端，随时可以再来迁移。'); return; }
          var st2 = Core.mergeCloudToLocal({ data: legacy.data }, {});
          // 故意不调 markClean：本机刚导入了一批云端还没有（新格式）的数据，
          // 面板上显示「有未同步更改」正是对的，提示用户接着点一次上传。
          markDirty();
          await showAlertMsg('迁移完成',
            '已迁移 ' + ((st2 && st2.added) || 0) + ' 项 / 新增，' +
            ((st2 && st2.merged) || 0) + ' 项 / 更新。\n建议现在点一次「上传到云端」，把数据写成新格式分片。');
          return;
        }

        progHide(); progBusy(false);
        await showAlertMsg('云端还没有数据', '请先在一部设备上点「上传到云端」，再来这里下载。');
        return;
      }

      var choice = await showChoice('从云端下载',
        '「合并」保留两边较新的数据，不会丢任何一边；\n「覆盖本机」用【云端数据】整体替换本机。',
        '合并到本机', '覆盖本机');
      if (choice === 'cancel') { progHide(); progBusy(false); return; }

      var stats;
      suppressDirty = true;   // 同步回写期间不标脏（否则刚同步完就显示「有未同步更改」）
      try {
        if (choice === 'merge') {
          progShow('running', '正在合并…', '正在逐条比对两边数据。');
          stats = Core.mergeCloudToLocal({ data: remote.data }, remote.tsMap);
        } else {
          // 覆盖：先清掉本机所有可同步键，再写入云端
          var keys = Core.localKeys();
          for (var i = 0; i < keys.length; i++) {
            try { localStorage.removeItem(keys[i]); } catch (e) {}
          }
          var written = 0;
          for (var k in remote.data) {
            if (!Object.prototype.hasOwnProperty.call(remote.data, k)) continue;
            var entry = remote.data[k];
            if (!entry || typeof entry.value !== 'string') continue;
            if (Core.isExcludedKey(k, entry.value)) continue;
            try { localStorage.setItem(k, entry.value); written++; } catch (e2) {}
          }
          stats = { added: written, merged: 0, kept: 0 };
        }
      } finally {
        suppressDirty = false;
      }

      setLastSync();
      markClean();
      try {
        if (window.BackupHub && window.BackupHub.markSync) {
          window.BackupHub.markSync('down', Object.keys(remote.data));
        }
      } catch (e) {}

      progStop();
      notifyOK('已从 ' + backendLabel() + ' 恢复',
        '新增 ' + (stats.added || 0) + ' 项，合并更新 ' + (stats.merged || 0) + ' 项，保持本机 ' + (stats.kept || 0) + ' 项。即将刷新…');
      setTimeout(function () { location.reload(); }, 1400);
    } catch (e) {
      console.warn('[SyncUI] 下载失败:', e);
      notifyFail('下载失败', (e && e.message) || String(e));
    } finally {
      progStop();
    }
  }

  /* ============ 配置令牌 ============ */
  function openConfig() {
    closeTopModal();
    var isGitee = getBackend() === 'gitee';
    var api = activeApi();
    var cur = (api && api.getToken && api.getToken()) || '';
    var repo = (isGitee && api.getRepo && api.getRepo()) || '';

    var help = isGitee
      ? '<div class="form-item"><label>第 1 步：获取 Gitee 私人令牌</label>' +
        '<a href="https://gitee.com/profile/personal_access_tokens" target="_blank" rel="noopener" ' +
        'style="display:inline-block;padding:8px 14px;background:#c71d23;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;">打开 Gitee 令牌页</a>' +
        '<div style="font-size:12px;color:var(--gray);margin-top:6px;">勾选「projects」权限（仓库读写需要它）</div></div>'
      : '<div class="form-item"><label>第 1 步：获取 GitHub Token</label>' +
        '<a href="https://github.com/settings/tokens/new?description=child-growth-sync&scopes=gist" target="_blank" rel="noopener" ' +
        'style="display:inline-block;padding:8px 14px;background:#24292e;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;">点击生成 GitHub Token</a>' +
        '<div style="font-size:12px;color:var(--gray);margin-top:6px;">勾选「gist」权限，点最底部「Generate token」</div></div>';

    var mask = makeMask(
      '<div class="modal-title"><span>⚙️ 配置云端同步</span>' +
      '<button class="modal-close sync-cancel" type="button" aria-label="关闭">&times;</button></div>' +
      '<div class="form-item"><label>存储位置</label>' +
      '<div style="display:flex;gap:8px;margin-bottom:6px;">' +
      '<button class="btn sync-bk-gist" style="flex:1;' + (isGitee ? 'background:#fff;color:#475569;border:1px solid var(--border);' : '') + '">GitHub Gist</button>' +
      '<button class="btn sync-bk-gitee" style="flex:1;' + (isGitee ? '' : 'background:#fff;color:#475569;border:1px solid var(--border);') + '">Gitee 码云</button>' +
      '</div><div style="font-size:12px;color:var(--gray);">Gitee 国内访问更稳定；GitHub 需要能连上 api.github.com。</div></div>' +
      help +
      '<div class="form-item"><label>第 2 步：粘贴令牌</label>' +
      '<input type="text" id="syncToken" placeholder="' + (isGitee ? 'Gitee 私人令牌' : 'ghp_xxxxxxxxxxxx') + '" value="' + esc(cur) + '" /></div>' +
      (isGitee
        ? '<div class="form-item"><label>第 3 步：仓库名（可留默认）</label>' +
          '<input type="text" id="syncRepo" placeholder="child-growth-sync" value="' + esc(repo) + '" /></div>'
        : '') +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">' +
      '<button class="btn sync-cancel2" style="background:#fff;color:#475569;border:1px solid var(--border);">取消</button>' +
      '<button class="btn btn-primary sync-save">保存并连接</button></div>'
    );

    mask.querySelector('.sync-cancel').onclick = function () { mask.remove(); };
    mask.querySelector('.sync-cancel2').onclick = function () { mask.remove(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    escClose(mask);

    // 切换后端后重开面板（令牌输入会随之变化）
    mask.querySelector('.sync-bk-gist').onclick = function () { setBackend('gist'); mask.remove(); openConfig(); };
    mask.querySelector('.sync-bk-gitee').onclick = function () { setBackend('gitee'); mask.remove(); openConfig(); };

    mask.querySelector('.sync-save').onclick = function () {
      var val = mask.querySelector('#syncToken').value.trim();
      if (!val) { showAlertMsg('请先粘贴令牌', '令牌不能为空。'); return; }
      var api2 = activeApi();
      if (getBackend() === 'gitee') {
        var repoVal = (mask.querySelector('#syncRepo') && mask.querySelector('#syncRepo').value.trim()) || 'child-growth-sync';
        api2.configure(val, repoVal);
      } else {
        api2.configure(val);
      }
      var btn = mask.querySelector('.sync-save');
      btn.textContent = '连接中…';
      btn.disabled = true;
      api2.ensureTarget().then(function () {
        connected = true;
        mask.remove();
        toastMsg('✅ 已连接云端，可以开始同步了');
        openPanel();
      }).catch(function (e) {
        btn.textContent = '保存并连接';
        btn.disabled = false;
        showAlertMsg('连接失败', (e && e.message) || '网络错误');
      });
    };
  }

  /* ============ 同步面板 ============ */
  function renderAccountLine() {
    var el = document.getElementById('syncAccountLine');
    if (!el) return;
    var api = activeApi();
    var extra = '';
    try {
      if (getBackend() === 'gitee' && api && api.getOwner) {
        var ow = api.getOwner(), rp = api.getRepo && api.getRepo();
        if (ow && rp) extra = '（' + ow + '/' + rp + '）';
      }
    } catch (e) {}
    el.textContent = backendLabel() + extra;
  }

  function openPanel() {
    closeTopModal();
    readDirty();

    var stateTxt = hasToken() ? '✅ 已配置令牌' : '⚙️ 未配置（点击下方配置）';
    var lastTxt = lastSyncText();
    var dirtyTxt = dirty ? '<b style="color:var(--danger);">有未同步更改</b>' : '所有改动已同步';

    var mask = makeMask(
      '<div class="modal-title"><span>☁️ 云端数据同步</span>' +
      '<button class="modal-close sync-cancel" type="button" aria-label="关闭">&times;</button></div>' +
      '<div class="sync-status-row"><span class="sync-state">' + stateTxt + '</span>' +
      '<span class="sync-last" style="margin-left:auto;">' + lastTxt + '</span></div>' +
      '<div style="font-size:12px;color:var(--gray);margin:-6px 0 12px;">' + dirtyTxt +
      ' ｜ 存储位置：<span id="syncAccountLine"></span></div>' +
      '<div class="sync-hint"><b>怎么用：</b><br>' +
      '· <b>上传</b>：把这部设备的数据存到云端（可选合并 / 覆盖）<br>' +
      '· <b>下载</b>：把云端的数据恢复到本机（可选合并 / 覆盖，会刷新页面）<br>' +
      '多设备保持一致：在 A 设备<b>上传</b>，到 B 设备<b>下载</b>。数据按业务域分片，只传改动过的部分。</div>' +
      '<div id="syncProgress" style="display:none;border-radius:9px;padding:10px 12px;margin-bottom:12px;"></div>' +
      '<div id="syncPanelBody" class="sync-actions">' +
      '<button class="btn btn-primary sync-up">⬆️ 上传到云端</button>' +
      '<button class="btn btn-success sync-down">⬇️ 从云端下载</button>' +
      '</div>' +
      // 本机备份中心入口：与云端同步并列，互为补充（云端跨设备，本机防误删/回滚）
      '<div class="sync-backup-card" style="border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:12px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
      '<b style="font-size:14px;">📦 本机数据备份</b>' +
      '<span id="syncBkLine" style="font-size:12px;color:var(--gray);margin-left:auto;"></span></div>' +
      '<div style="font-size:12px;color:var(--gray);line-height:1.6;margin-bottom:10px;">' +
      '快照存在本机浏览器（IndexedDB），不占云端；适合防止误删、改错后回滚。' +
      '换设备/清缓存会丢失，跨设备请用上面的云端同步。</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      '<button class="btn sync-bk-open" data-bh-absorbed="1" style="background:#fff;color:#334155;border:1px solid var(--border);font-size:13px;">打开备份中心</button>' +
      '<button class="btn sync-bk-snap" data-bh-absorbed="1" style="background:#fff;color:#334155;border:1px solid var(--border);font-size:13px;">立即快照</button>' +
      '</div></div>' +
      '<div class="sync-foot"><span class="sync-last">数据存在你的私有仓库 / Gist，仅自己可见</span>' +
      '<button class="sync-link-btn sync-reconfig">重新配置</button></div>'
    );

    mask.querySelector('.sync-cancel').onclick = function () { mask.remove(); };
    mask.querySelector('.sync-up').onclick = doUpload;
    mask.querySelector('.sync-down').onclick = doDownload;
    mask.querySelector('.sync-reconfig').onclick = function () { openConfig(); };
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove(); });
    escClose(mask);

    renderAccountLine();
    renderBackupLine(mask);
  }

  /* ============ 本机备份集成 ============ */
  function renderBackupLine(mask) {
    var line = mask.querySelector('#syncBkLine');
    var s = null;
    try { s = window.BackupHub && window.BackupHub.scan ? window.BackupHub.scan() : null; } catch (e) {}
    if (line && s) {
      line.textContent = '已备份 ' + (typeof s.total === 'number' ? (s.total / 1024).toFixed(1) + ' KB' : '—');
    } else if (line) {
      line.textContent = '备份中心未就绪';
    }
    var openBtn = mask.querySelector('.sync-bk-open');
    if (openBtn) openBtn.onclick = function () {
      if (window.BackupHub && window.BackupHub.open) { window.BackupHub.open(null); }
      else { toastMsg('备份中心未加载'); }
    };
    var snapBtn = mask.querySelector('.sync-bk-snap');
    if (snapBtn) snapBtn.onclick = async function () {
      if (!window.BackupHub || !window.BackupHub.createSnapshot) { toastMsg('备份中心未加载'); return; }
      snapBtn.disabled = true;
      var old = snapBtn.textContent;
      snapBtn.textContent = '快照中…';
      try {
        await window.BackupHub.createSnapshot('手动快照（同步面板）');
        toastMsg('已创建本机快照');
        renderBackupLine(mask);
      } catch (e) {
        toastMsg('快照失败：' + (e && e.message ? e.message : e));
      } finally {
        snapBtn.disabled = false;
        snapBtn.textContent = old;
      }
    };
  }

  /* ============ 初始化 ============ */
  function init() {
    readDirty();
    wrapStorage();
    try { window.openSyncPanel = openPanel; } catch (e) {}

    // 侧边栏「☁️ 云端同步」按钮
    // 注意：index.html 里另有 2 处也绑了这个按钮（都调 window.openSyncPanel），
    // openPanel 自身有 closeTopModal 幂等保护，这里再加一道去重防连开。
    var btn = document.getElementById('sidebarCloudSyncBtn');
    if (btn && !btn.__hub_sync_bound) {
      btn.__hub_sync_bound = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        openPanel();
      });
    }
    // 自动探测：有令牌就静默确认一次可连接（失败不打扰用户）
    if (hasToken()) {
      var api = activeApi();
      Promise.resolve()
        .then(function () { return api.ensureTarget(); })
        .then(function () { connected = true; })
        .catch(function () { connected = false; });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ============ 导出 ============ */
  window.CGASyncUI = {
    open: openPanel,
    openConfig: openConfig,
    upload: doUpload,
    download: doDownload,
    getBackend: getBackend,
    setBackend: setBackend,
    markDirty: markDirty,
    markClean: markClean,
    isDirty: function () { return dirty; }
  };

  /* ============ BackupHub 兼容层 ============
   * backup-hub.js 里 cloudApi() 找的是 window.CloudSync（沿用 efficiency-hub 的
   * 命名），签名是 peek() / upload() / download()。不接上，备份中心里的
   * 「云端同步」区块会永远显示「跨设备同步由导航页提供」——在 CGA 上就是死路。 */
  window.CloudSync = {
    upload: doUpload,
    download: doDownload,
    openPanel: openPanel,
    isConnected: function () { return connected; },
    getStatus: function () {
      var last = 0;
      try { last = Number(localStorage.getItem(LAST_SYNC_KEY) || 0); } catch (e) {}
      return { connected: connected, lastSync: last };
    },
    // 只读探测：给备份中心显示「云端已有 N 项数据」，不触发任何写入
    peek: async function () {
      if (!hasToken()) return { connected: false, reason: '未配置 Token', cloudCount: 0, updatedAt: 0 };
      try {
        var io = activeIO();
        var api = activeApi();
        api.resetCache && api.resetCache();
        await api.ensureTarget();
        var meta = await Core.readShardedMetaWith(io);
        connected = true;
        if (!meta || !meta.shards) return { connected: true, cloudCount: 0, updatedAt: 0 };
        var cnt = 0;
        try { cnt = Object.keys(meta.keys || {}).length; } catch (e) { cnt = 0; }
        return { connected: true, cloudCount: cnt, updatedAt: meta.updatedAt || 0 };
      } catch (e) {
        connected = false;
        return { connected: false, reason: (e && e.message ? e.message : String(e)), cloudCount: 0, updatedAt: 0 };
      }
    }
  };
})();
