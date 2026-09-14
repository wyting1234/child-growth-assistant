/* ================================================================
 *  儿童成长助手 · Gist 后端  sync-gist.js
 *  ----------------------------------------------------------------
 *  实现 sync-core.js 约定的 io 接口（GitHub Gist 版）。
 *
 *  Gist 的特别之处：一次 PATCH 可以把多个文件一起提交（天然批量），
 *  且未列出的文件保持不变 —— 这也是最早用 Gist 的原因。
 *
 *  ⚠️ 单文件超 1MB 时 Gist 的 content 是截断的，必须改走 raw_url。
 * ================================================================ */
(function () {
  'use strict';

  var Core = window.CGASyncCore;
  if (!Core) {
    console.warn('[Gist] 同步内核未加载（sync-core.js 应先加载），Gist 后端已跳过');
    return;
  }

  var API = 'https://api.github.com';
  var TOKEN_KEY = 'github_token';
  var GIST_ID_KEY = 'github_gist_id';
  var GIST_DESC = '儿童成长助手-云端同步';

  var TOKEN = localStorage.getItem(TOKEN_KEY) || '';
  var GIST_ID = localStorage.getItem(GIST_ID_KEY) || '';

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function setGistId(id) {
    GIST_ID = id || '';
    try {
      if (id) localStorage.setItem(GIST_ID_KEY, id);
      else localStorage.removeItem(GIST_ID_KEY);
    } catch (e) {}
  }

  function isNotFound(e) {
    return /不存在|Not Found|404/i.test((e && e.message) || '');
  }

  /* ---------- HTTP ---------- */
  function humanError(status, payload, what) {
    var msg = (payload && (payload.message || payload.error)) || '';
    var raw = msg ? '（GitHub 原文：' + msg + '）' : '';
    if (status === 401) return '令牌无效或已过期（' + what + '）：请重新生成 GitHub Token。' + raw;
    if (status === 403) return '令牌权限不足或被限流（' + what + '）：请确认勾选了「gist」。' + raw;
    if (status === 404) return '云端同步文件不存在（' + what + '）。' + raw;
    if (status === 422) return '提交被拒绝（' + what + '）：内容可能为空或格式有误。' + raw;
    if (status === 429) return '请求过于频繁（' + what + '），请稍后重试。' + raw;
    return 'GitHub 接口报错 ' + status + (msg ? '：' + msg : '') + '（' + what + '）';
  }

  function isRetryable(e) {
    var st = e && e.status;
    if (!st) return true;                          // 网络层错误值得重试
    return st === 408 || st === 429 || st >= 500;
  }

  async function req(method, path, opts) {
    var o = opts || {};
    if (!TOKEN) throw new Error('还没有配置 GitHub Token');
    var lastErr = null;
    for (var i = 0; i < 3; i++) {
      try {
        var headers = {
          'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        };
        var r = await fetch(API + path, {
          method: method,
          headers: headers,
          body: o.json !== undefined ? JSON.stringify(o.json) : undefined,
          cache: 'no-store'
        });
        if (r.ok) {
          if (r.status === 204) return null;
          return await r.json();
        }
        var payload = null;
        try { payload = await r.json(); } catch (e2) { payload = null; }
        var err = new Error(humanError(r.status, payload, o.what || (method + ' ' + path)));
        err.status = r.status;
        if (!isRetryable(err)) throw err;
        lastErr = err;
      } catch (e) {
        if (e && e.status && !isRetryable(e)) throw e;
        lastErr = e;
      }
      if (i < 2) await sleep(600 * (i + 1));
    }
    throw lastErr || new Error('请求失败（' + (o.what || path) + '）');
  }

  /* ---------- 载体：找到或创建 Gist ---------- */
  // 两端复用同一个 Gist：按同名文件查找，优先含有数据的那个
  async function findOrCreateGist() {
    var list = await req('GET', '/gists?per_page=100', { what: '列出 Gist' });
    var best = null, bestWith = null;
    (list || []).forEach(function (g) {
      if (!g.files || !g.files[Core.META_FILENAME]) return;
      if (!best || new Date(g.updated_at) > new Date(best.updated_at)) best = g;
      // 含 meta 的视为「有数据」
      if (!bestWith || new Date(g.updated_at) > new Date(bestWith.updated_at)) bestWith = g;
    });
    var chosen = bestWith || best;
    if (chosen) {
      setGistId(chosen.id);
      return GIST_ID;
    }
    // 一个都没有 → 建一个新的空 Gist
    var d = await req('POST', '/gists', {
      what: '创建 Gist',
      json: {
        description: GIST_DESC,
        public: false,
        files: (function () {
          var f = {};
          f[Core.META_FILENAME] = { content: JSON.stringify(Core.newMeta('gist')) };
          return f;
        })()
      }
    });
    setGistId(d.id);
    return GIST_ID;
  }

  async function ensureGist() {
    if (GIST_ID) {
      // 验证一下这个 id 还在（可能被用户删了）
      try {
        await req('GET', '/gists/' + GIST_ID, { what: '检查 Gist' });
        return GIST_ID;
      } catch (e) {
        if (!isNotFound(e)) throw e;
        setGistId('');
      }
    }
    return findOrCreateGist();
  }

  /* ---------- io 实现 ---------- */
  var gistIO = {
    origin: 'gist',
    label: 'GitHub',
    ensureTarget: async function () {
      return await ensureGist();
    },
    getMeta: async function () {
      var g = await req('GET', '/gists/' + GIST_ID, { what: '读取 meta' });
      var mf = g && g.files && g.files[Core.META_FILENAME];
      if (!mf || !mf.content) return null;
      try { return JSON.parse(mf.content); } catch (e) { return null; }
    },
    // Gist 单文件超 1MB 时 content 是截断的，必须改走 raw_url
    getFile: async function (name) {
      var g = await req('GET', '/gists/' + GIST_ID, { what: '读取 ' + name });
      var f = g && g.files && g.files[name];
      if (!f) return null;
      if (f.truncated || !f.content) {
        if (!f.raw_url) return null;
        try {
          var r = await fetch(f.raw_url, { cache: 'no-store' });
          if (!r.ok) { console.warn('[Gist] 拉取大文件失败 ' + r.status); return null; }
          return await r.text();
        } catch (e) {
          console.warn('[Gist] 拉取大文件异常:', e && e.message);
          return null;
        }
      }
      return f.content;
    },
    putFiles: async function (map) {
      var files = {};
      for (var name in map) {
        if (Object.prototype.hasOwnProperty.call(map, name)) files[name] = { content: map[name] };
      }
      await req('PATCH', '/gists/' + GIST_ID, { json: { files: files }, what: '写入数据' });
    },
    deleteFiles: async function (names) {
      var files = {};
      names.forEach(function (n) { files[n] = null; });   // Gist 里置 null 即删除
      await req('PATCH', '/gists/' + GIST_ID, { json: { files: files }, what: '清理旧分片' });
    }
  };

  /* ---------- 导出 ---------- */
  window.CGAGistIO = gistIO;
  window.CGAGistApi = {
    configure: function (token) {
      TOKEN = token || '';
      try {
        if (TOKEN) localStorage.setItem(TOKEN_KEY, TOKEN);
        else localStorage.removeItem(TOKEN_KEY);
      } catch (e) {}
    },
    getToken: function () { return TOKEN; },
    hasToken: function () { return !!TOKEN; },
    ensureTarget: function () { return ensureGist(); },
    resetCache: function () { setGistId(''); },
    getGistId: function () { return GIST_ID; }
  };
})();
