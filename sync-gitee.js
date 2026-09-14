/* ================================================================
 *  儿童成长助手 · Gitee 后端  sync-gitee.js
 *  ----------------------------------------------------------------
 *  实现 sync-core.js 约定的 io 接口（Gitee 版）。
 *
 *  ⚠️ Gitee contents 接口有三个极易踩的坑，本文件全部做了防御：
 *    ① ref 指向不存在的分支时返回 HTTP 200 + 空数组 []（不是 404）——
 *       「静默失败」的万恶之源。必须当「分支不对」处理并就地自愈。
 *    ② 文件超过约 1MB 时响应**不含 content 字段**，只给 sha + download_url。
 *       若把它当成「文件不存在」→ 走 POST 新建 → 对已存在文件必然 400。
 *    ③ 不支持批量写（一个文件一次请求）→ 并发 PUT；新建 POST、更新 PUT（必须带 sha）。
 * ================================================================ */
(function () {
  'use strict';

  var Core = window.CGASyncCore;
  if (!Core) {
    console.warn('[Gitee] 同步内核未加载（sync-core.js 应先加载），Gitee 后端已跳过');
    return;
  }

  var API = 'https://gitee.com/api/v5';
  var DEFAULT_REPO = 'child-growth-sync';

  var TOKEN = localStorage.getItem('gitee_token') || '';
  var OWNER = localStorage.getItem('gitee_owner') || '';
  var REPO = localStorage.getItem('gitee_repo') || DEFAULT_REPO;
  // ⚠️ 默认分支绝不能写死：Gitee 新库既有 master 也有 main。
  //    写错的后果极隐蔽 —— contents 对不存在分支返回 200 + []，看起来像「目录为空」。
  var BRANCH = localStorage.getItem('gitee_branch') || '';

  function setBranch(b) {
    if (!b || b === BRANCH) return;
    BRANCH = b;
    try { localStorage.setItem('gitee_branch', b); } catch (e) {}
  }

  /* ---------- 响应归一化（三个坑的第一道防线） ---------- */
  function normContents(j) {
    if (!j) return { kind: 'missing' };
    if (Array.isArray(j)) {
      if (j.length === 0) return { kind: 'bad-branch' };   // 关键：分支/路径不存在
      return { kind: 'dir', list: j };
    }
    if (typeof j === 'string') return { kind: 'text', text: j };
    if (typeof j.content === 'string') {
      return { kind: 'file', text: b64ToText(j.content), sha: j.sha, raw: j };
    }
    // ⚠️ 大文件（>1MB）时响应不含 content，只给 sha + download_url。
    //    若落到 missing，会连锁成：missing → sha=null → 判定「不存在」→ POST 新建 → 400。
    //    只要响应里有 sha，就说明文件确实存在 —— 按存在处理，内容另拉。
    if (j.sha) {
      return { kind: 'file', text: null, sha: j.sha, raw: j, needsDownload: !j.content };
    }
    return { kind: 'missing', raw: j };
  }

  function b64ToText(b64) {
    try {
      var bin = atob((b64 || '').replace(/\s/g, ''));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) { return ''; }
  }
  function textToB64(text) {
    var bytes = new TextEncoder().encode(text);
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  }

  /* ---------- HTTP ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function humanError(status, payload, what) {
    var msg = (payload && (payload.message || payload.error)) || '';
    var raw = msg ? '（Gitee 原文：' + msg + '）' : '';
    if (status === 401) return '令牌无效或已过期（' + what + '）：请重新生成 Gitee 私人令牌并粘贴。' + raw;
    if (status === 403) return '令牌权限不足（' + what + '）：请确认勾选了「projects」。' + raw;
    if (status === 404) {
      // Gitee 对「私有库无权限」也回 404，故意不区分存在性。
      // ⚠️ 文案里必须保留「不存在」二字：上层靠 /不存在/ 判断是否该走新建流程。
      return '仓库或文件不存在（' + what + '）。' +
        '若仓库已建好，多半是令牌没有该仓库权限（私有库无权限时 Gitee 也回 404），' +
        '请确认勾选了「projects」。' + raw;
    }
    if (status === 400 && /sha/i.test(msg)) {
      return '文件已被其它设备改动（' + what + '），本次写入跳过，请重试一次同步。' + raw;
    }
    if (status === 422) return '提交被拒绝（' + what + '）：可能是分支不存在或内容为空。' + raw;
    if (status === 429) return '请求过于频繁（' + what + '），请稍后重试。' + raw;
    return 'Gitee 接口报错 ' + status + (msg ? '：' + msg : '') + '（' + what + '）';
  }

  // ⚠️ 400/401/403/404/409/422 这类「语义错误」不重试：重试不会变好，
  //    却会把「文件不存在」拖成 1.2 秒等待，还会丢掉原始语义。
  function isRetryable(e) {
    var st = e && e.status;
    if (!st) return true;
    return st === 408 || st === 429 || st >= 500;
  }

  async function req(method, path, opts) {
    var o = opts || {};
    if (!TOKEN) throw new Error('还没有配置 Gitee 令牌');
    var lastErr = null;
    for (var i = 0; i < 3; i++) {
      try {
        var headers = { 'Authorization': 'Bearer ' + TOKEN };
        var url = path;
        if (o.query) {
          var qs = Object.keys(o.query).map(function (k) {
            return encodeURIComponent(k) + '=' + encodeURIComponent(o.query[k]);
          }).join('&');
          url = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs;
        }
        var body;
        if (o.json !== undefined) {
          headers['Content-Type'] = 'application/json;charset=UTF-8';
          body = JSON.stringify(o.json);
        }
        var r = await fetch(API + url, { method: method, headers: headers, body: body, cache: 'no-store' });
        if (r.ok) {
          var txt = await r.text();
          if (!txt) return null;
          try { return JSON.parse(txt); } catch (e2) { return txt; }
        }
        var payload = null;
        try { payload = JSON.parse(await r.text()); } catch (e3) { payload = null; }
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

  /* ---------- 仓库探测（会话级缓存） ---------- */
  // 一次上传会发多个请求，若每次都探一遍仓库，白花好几个往返 —— 实测「卡顿」主因。
  var repoProbed = null;
  function resetRepoProbe() { repoProbed = null; }

  async function getLogin() {
    if (OWNER) return OWNER;
    var u = await req('GET', '/user', { what: '读取账号' });
    OWNER = (u && u.login) || '';
    if (OWNER) { try { localStorage.setItem('gitee_owner', OWNER); } catch (e) {} }
    return OWNER;
  }

  async function ensureRepo() {
    if (!TOKEN) throw new Error('还没有配置 Gitee 令牌');
    if (repoProbed && repoProbed.repo === REPO && repoProbed.branch) {
      setBranch(repoProbed.branch);
      return repoProbed;
    }
    var login = await getLogin();
    if (!login) throw new Error('无法读取 Gitee 账号信息，请检查令牌');

    var exists = false, realBranch = '';
    try {
      var info = await req('GET', '/repos/' + login + '/' + REPO, { what: '检查仓库' });
      exists = true;
      realBranch = (info && info.default_branch) || '';
    } catch (e) {
      // 404 可能是「不存在」也可能是「无权限」，不能武断；其余错误直接抛
      if (!/不存在/.test(e.message || '')) throw new Error(e.message || String(e));
    }

    if (!exists) {
      try {
        await req('POST', '/user/repos', {
          what: '创建仓库',
          json: {
            name: REPO,
            description: '儿童成长助手 - 云端同步数据（请勿公开）',
            private: true,
            auto_init: true,
            has_issues: false,
            has_wiki: false
          }
        });
      } catch (e) {
        throw new Error('创建私有仓库失败：' + (e.message || e) + '\n请确认令牌勾选了「projects」权限。');
      }
      // 新建仓库后要等它初始化出第一个提交（auto_init 是异步的），否则写 contents 会 404
      realBranch = await waitRepoReady(login, REPO);
    }

    if (realBranch) {
      if (realBranch !== BRANCH) {
        if (BRANCH) console.warn('[Gitee] 缓存分支 "' + BRANCH + '" 与远端 "' + realBranch + '" 不一致，已纠正');
        setBranch(realBranch);
      }
    } else if (!BRANCH) {
      // 兜底：绝不能让 BRANCH 为空 —— ref='' 会被当作「分支不存在」静默返回 []
      try {
        var info2 = await req('GET', '/repos/' + login + '/' + REPO, { what: '读取仓库信息' });
        setBranch((info2 && info2.default_branch) || 'master');
      } catch (e) { setBranch('master'); }
    }
    repoProbed = { owner: login, repo: REPO, branch: BRANCH };
    return repoProbed;
  }

  // 等仓库初始化完成。
  // ⚠️ 两处易踩坑：
  //   ① 【空目录 ≠ 未就绪】contents 对「分支存在但目录为空」返回合法 []，
  //      与「分支不存在」返回的 [] 在响应上完全一样。所以不能靠探目录判断就绪；
  //      能读到 default_branch 就说明仓库和分支都建好了。
  //   ② 【必须有兜底分支】探测全失败也不能留空 BRANCH。
  async function waitRepoReady(owner, repo) {
    var lastBranch = '', lastErr = '';
    for (var i = 0; i < 12; i++) {
      await sleep(400);
      try {
        var info = await req('GET', '/repos/' + owner + '/' + repo, { what: '等待仓库就绪' });
        var br = (info && info.default_branch) || '';
        if (!br) continue;                  // 仓库信息还没出来，继续等
        lastBranch = br;
        setBranch(br);
        return br;
      } catch (e) { lastErr = e.message || String(e); }
    }
    var fallback = lastBranch || 'master';
    console.warn('[Gitee] 未能确认仓库默认分支，暂用 "' + fallback + '" 继续。最后一次探测：' + lastErr);
    setBranch(fallback);
    return BRANCH;
  }

  /* ---------- 文件读写（带缓存） ---------- */
  var fileCache = new Map();
  var shaCache = new Map();
  var inflight = new Map();
  function clearFileCache() { fileCache.clear(); shaCache.clear(); inflight.clear(); }

  function contentsPath(name) {
    // OWNER 由 ensureRepo()->getLogin() 填入；内核保证任何文件操作前先 ensureTarget()，
    // 正常不会走到空。留着兜底是为了万一漏掉，能第一时间暴露成明确错误，
    // 而不是拼出 /repos//repo/... 这种注定 404 的路径（那种失败非常难排查）。
    if (!OWNER) console.warn('[Gitee] contentsPath 在 OWNER 未知时被调用，请确认已先调用 ensureTarget()');
    return '/repos/' + (OWNER || '') + '/' + REPO + '/contents/' + encodeURIComponent(name);
  }

  async function readContents(name, quiet, retried) {
    if (!retried && fileCache.has(name)) return fileCache.get(name);
    if (!retried && inflight.has(name)) return inflight.get(name);
    var p = readContentsRaw(name, quiet, retried);
    if (!retried) {
      inflight.set(name, p);
      p.finally(function () { if (inflight.get(name) === p) inflight.delete(name); });
    }
    return p;
  }

  async function readContentsRaw(name, quiet, retried) {
    try {
      var raw = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      var n = normContents(raw);
      if (n.kind === 'text') { fileCache.set(name, n.text); return n.text; }
      if (n.kind === 'file') {
        // 同一次响应把 sha 也带回来了，顺手存下，省掉后面写文件时再发一次 GET
        if (n.sha) shaCache.set(name, n.sha);
        if (n.text !== null && n.text !== undefined) { fileCache.set(name, n.text); return n.text; }
        // 大文件：响应里没有 content，另拉一次原文。
        // 缓存里先放 null 占位是不行的（会被误判成「不存在」），所以只在拿到内容后才写缓存。
        // ⚠️ 传 n（归一化对象），不是 n.raw —— fetchRaw 内部再取 n.raw。
        var txt = await fetchRaw(n);
        if (txt !== null) fileCache.set(name, txt);
        return txt;
      }
      // bad-branch：分支名不对时 Gitee 回 200 + []（不是 404）。就地重探后重读一次。
      if (n.kind === 'bad-branch') {
        if (!retried) {
          try { await healBranch(); } catch (e) {}
          if (BRANCH) return await readContents(name, quiet, true);
        }
        if (!quiet) throw new Error('分支名不正确，且自动修正失败（请检查令牌是否有该仓库权限）。');
        return null;
      }
      fileCache.set(name, null);   // 「不存在」也缓存，省掉同轮重复的 404
      return null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) { fileCache.set(name, null); return null; }
      if (quiet) { console.warn('[Gitee] 读 ' + name + ' 失败:', e.message); return null; }
      throw e;
    }
  }

  // 拉大文件原文。download_url 走 gitee.com 原始文件通道，同样受 CORS 限制，
  // 失败要优雅降级（宁可这片读不到，也不能把「存在」误判成「不存在」）。
  //
  // ⚠️ 入参是 normContents 归一化后的对象 n（n.raw 才是原始响应），
  //    不是原始响应本身 —— 早先误传 n.raw 导致 info.raw 为 undefined，
  //    大文件永远拉不回来（且失败得很安静）。
  async function fetchRaw(n) {
    var raw = n && n.raw;
    var url = raw && (raw.download_url || raw.raw_url);
    if (!url) return null;
    try {
      var r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) { console.warn('[Gitee] 拉取大文件失败 ' + r.status); return null; }
      return await r.text();
    } catch (e) {
      console.warn('[Gitee] 拉取大文件异常:', e && e.message);
      return null;
    }
  }

  // 读 sha（写之前必须拿；文件不存在返回 null）
  async function getSha(name, retried) {
    // ⚠️ 只能复用「非 null」的缓存值。缓存的 null 含义是「曾经认为它不存在」，
    //    但那个判断可能是错的（大文件缺 content、网络抖动、分支当时不对…）。
    //    把 null 当命中直接返回，等于把错误判断永久固化 → putFiles 一律走 POST
    //    新建 → 对已存在文件必然 400「文件新建失败」。
    if (!retried && shaCache.get(name)) return shaCache.get(name);
    try {
      var raw = await req('GET', contentsPath(name), { query: { ref: BRANCH }, what: '读取 ' + name });
      var n = normContents(raw);
      if (n.kind === 'file') { shaCache.set(name, n.sha || null); return n.sha || null; }
      if (n.kind === 'text') return null;
      if (n.kind === 'bad-branch') {
        if (!retried) {
          await healBranch();
          if (BRANCH) return await getSha(name, true);
        }
        throw new Error('分支名不正确，且自动修正失败（请检查令牌是否有该仓库权限）。');
      }
      // 既无 content 也无 sha —— 确实不存在。
      // 不写缓存：这类判断可能由响应异常造成，缓存会误导后续调用。
      return null;
    } catch (e) {
      if (/不存在/.test(e.message || '')) return null;
      throw e;
    }
  }

  // 取 sha 的另一种入口：先保证「内容已读过」，让 sha 与内容共用同一次 GET。
  async function getShaViaRead(name) {
    // ⚠️ 不能用 shaCache.has() 判断「有结果」：文件不存在时我们故意缓存 null，
    //    用它当命中条件会把 null 当有效 sha 返回 → 误判文件不存在 → POST 新建 → 400。
    if (shaCache.get(name)) return shaCache.get(name);
    await readContents(name, true);
    if (shaCache.get(name)) return shaCache.get(name);
    return getSha(name);
  }

  async function writeContents(name, text, sha, message) {
    var payload = {
      content: textToB64(text),
      message: message || ('sync ' + new Date().toISOString().slice(0, 19)),
      branch: BRANCH
    };
    if (sha) payload.sha = sha;
    if (sha) await req('PUT', contentsPath(name), { json: payload, what: '更新 ' + name });
    else await req('POST', contentsPath(name), { json: payload, what: '新建 ' + name });
    // 写成功后本机缓存就过期了
    fileCache.delete(name);
    shaCache.delete(name);
  }

  async function deleteContents(name, sha, message) {
    await req('DELETE', contentsPath(name), {
      json: { sha: sha, message: message || ('cleanup ' + name), branch: BRANCH },
      what: '删除 ' + name
    });
    fileCache.set(name, null);
    shaCache.set(name, null);
  }

  // 分支名失效时就地重探，而不是把错误抛给上层。
  // 为什么必须自愈：BRANCH 一旦是错的，读会得到 []、写会走 POST 撞「已存在」，
  // 上层只看到「传不上去」这种毫无线索的现象。
  async function healBranch() {
    var before = BRANCH;
    resetRepoProbe();
    try { localStorage.removeItem('gitee_branch'); } catch (e) {}
    BRANCH = '';
    if (!OWNER) { try { await getLogin(); } catch (e) {} }
    var r = await ensureRepo();
    if (r && r.branch && r.branch !== before) {
      console.warn('[Gitee] 分支名从 "' + (before || '空') + '" 修正为 "' + r.branch + '"');
    }
    return BRANCH;
  }

  /* ---------- io 实现 ---------- */
  var giteeIO = {
    origin: 'gitee',
    label: 'Gitee',
    ensureTarget: async function () {
      var r = await ensureRepo();
      return r.owner + '/' + r.repo;
    },
    getMeta: async function () {
      var txt = await readContents(Core.META_FILENAME, true);
      if (!txt) return null;
      try { return JSON.parse(txt); } catch (e) { return null; }
    },
    getFile: function (name) { return readContents(name); },
    // ⚠️ 与 Gist 最大的差异：没有批量写。并发 PUT，逐个取 sha。
    //    分片数通常只有 1~6 片，并发不会有压力。
    putFiles: async function (map) {
      var names = Object.keys(map);
      // meta 必写，先把它的 sha 取到手，从下面的 getShaViaRead 里摘出去，
      // 避免为它多发一次 GET（它刚在 writeShardedWith 里被读过）。
      var metaSha = null;
      if (map[Core.META_FILENAME] !== undefined) {
        try { metaSha = await getShaViaRead(Core.META_FILENAME); } catch (e) { metaSha = null; }
      }
      var tasks = names.map(async function (name) {
        for (var attempt = 0; attempt < 3; attempt++) {
          var sha = null;
          try {
            sha = (name === Core.META_FILENAME && attempt === 0) ? metaSha : await getShaViaRead(name);
          } catch (e) {
            if (attempt < 2) { await sleep(600); continue; }
            throw e;
          }
          try {
            await writeContents(name, map[name], sha);
            return name;
          } catch (e) {
            var m = e.message || '';
            // 「已被改动 / 已存在 / 分支名不正确」——说明手里的 sha 是旧的或漏了。
            // 必须先清缓存再重试，否则 getShaViaRead 会把旧 sha 再交回来，
            // 3 次重试全是同一个错误答案（实测会把一次写入放大成 3 个注定失败的请求）。
            if (attempt < 2 && (/已被其它设备改动/.test(m) || /已存在/.test(m) || /分支名不正确/.test(m))) {
              fileCache.delete(name);
              shaCache.delete(name);
              resetRepoProbe();
              await sleep(700 * (attempt + 1));
              continue;
            }
            throw e;
          }
        }
        return null;
      });
      var done = await Promise.all(tasks);
      return done.filter(Boolean);
    },
    deleteFiles: async function (names) {
      await Promise.all(names.map(async function (name) {
        try {
          var sha = await getSha(name);
          if (sha) await deleteContents(name, sha);
        } catch (e) {
          // 单个文件删不掉不该让整次同步失败（旧片残留只影响体积，不影响正确性）
          console.warn('[Gitee] 删除 ' + name + ' 失败:', e.message);
        }
      }));
    }
  };

  /* ---------- 导出 ---------- */
  window.CGAGiteeIO = giteeIO;
  window.CGAGiteeApi = {
    configure: function (token, repo, owner) {
      TOKEN = token || TOKEN;
      REPO = repo || REPO;
      if (owner) OWNER = owner;
      try {
        if (TOKEN) localStorage.setItem('gitee_token', TOKEN);
        if (REPO) localStorage.setItem('gitee_repo', REPO);
        if (OWNER) localStorage.setItem('gitee_owner', OWNER);
      } catch (e) {}
      resetRepoProbe();
      clearFileCache();
    },
    getToken: function () { return TOKEN; },
    hasToken: function () { return !!TOKEN; },
    getRepo: function () { return REPO; },
    getOwner: function () { return OWNER; },
    getBranch: function () { return BRANCH; },
    ensureTarget: function () { return ensureRepo(); },
    resetCache: function () { resetRepoProbe(); clearFileCache(); }
  };
})();
