/* ================================================================
 *  儿童成长助手 · 云同步内核  sync-core.js
 *  ----------------------------------------------------------------
 *  与后端无关的「内核」：分片、压缩、增量判定、合并、进度反馈。
 *  两个后端（Gist / Gitee）各自实现 io 接口，本文件只认 io。
 *
 *  为什么要分三层（内核 / io / UI）：
 *    Gitee 没有 Gist 的批量 PATCH；若各写一套分片逻辑，早晚会漂移
 *    （改了 GitHub 忘了 Gitee）。所以「脏片判定、meta 结构、并发拉片、
 *     大文件兜底、缓存失效」这些容易出错的部分只在这里写一次。
 *
 *  ⚠️ CGA 与 efficiency-hub 最大的不同：多儿童键名前缀隔离。
 *     记录类键的真实名字是 "<儿童名>::growth_diary" 这种形式，
 *     且孩子数量与名字运行期才知道 —— 所以分片/备份只能靠 prefixes
 *     动态匹配，绝不能写死 keys。
 * ================================================================ */
(function () {
  'use strict';

  var Core = {};

  /* ============ 常量 ============ */
  var SHARD_RE = /^cga-sync-(\d{3})\.json$/;
  var META_FILENAME = 'cga-sync-meta.json';
  var LEGACY_FILENAME = 'child-growth-assistant-sync.json';
  var MAX_SHARD_BYTES = 500 * 1024;   // 单片原始数据上限（压缩前）；CGA 单儿童 0.5–1.5MB，需多片
  var PACK_ENC = 'gzip';

  /* ============ 必须排除的键 ============ */
  // 同步凭据 / 运行时状态 / 外部系统 / 备份中心内部键
  var EXCLUDE_KEYS = [
    'github_token',            // Gist 凭据
    'github_gist_id',          // Gist 载体 id
    'gitee_token',             // Gitee 凭据
    'gitee_owner',             // Gitee 用户名
    'gitee_repo',              // Gitee 仓库名
    'gitee_branch',            // Gitee 分支
    'sync_last_sync',          // 同步状态
    'sync_dirty',              // 同步脏标记
    'sync_backend',            // 同步后端选择（每台设备各自决定）
    'timer_state_sm',          // 计时器运行时状态（跨设备同步会互相打架）
    'studyUsers_v21',          // 外部学习系统（CGA 只读不写）
    '__hub_meta_v1__',         // 备份中心元数据
    '__hub_last_snap_v1__',
    '__hub_activity_v1__',
    '__hub_bkfp_v1__',
    '__hub_snapshots_v1__'
  ];
  var EXCLUDE_PREFIXES = [
    '__hub_',      // 备份中心全部内部键
    '__BEACON_',   // 腾讯埋点 SDK 残留
    '_hmt',        // 百度统计残留
    '__tea_sdk_'   // 埋点 SDK 残留
  ];
  var BIG_IMAGE_MIN = 30 * 1024;   // 超过 30KB 的内嵌图片视为背景资源，不同步

  function isExcludedKey(key, value) {
    if (!key) return true;
    if (EXCLUDE_KEYS.indexOf(key) > -1) return true;
    for (var i = 0; i < EXCLUDE_PREFIXES.length; i++) {
      if (key.indexOf(EXCLUDE_PREFIXES[i]) === 0) return true;
    }
    if (value && value.length > BIG_IMAGE_MIN && value.slice(0, 11) === 'data:image/') return true;
    return false;
  }

  /* ============ 键名解析（CGA 特有） ============ */
  // CGA 的 Storage.rk() 会给「记录类」键加 "<儿童名>::" 前缀。
  // 同步时我们必须能反向拆出 { account, base, date }，否则：
  //   ① 分片会把不同儿童的数据混在一起；
  //   ② 合并会把两个儿童的记录当成同一个键。
  //
  // 形如：  "小明::growth_diary"          → { account:'小明', base:'growth_diary', date:null }
  //         "小明::daily_temp_2026-09-14" → { account:'小明', base:'daily_temp', date:'2026-09-14' }
  //         "growth_targets"              → { account:null, base:'growth_targets', date:null }
  var DATE_SUFFIX_RE = /^(.*)_(\d{4}-\d{2}-\d{2})$/;

  function parseKey(fullKey) {
    var account = null, rest = fullKey;
    var sep = fullKey.indexOf('::');
    if (sep > -1) {
      account = fullKey.slice(0, sep);
      rest = fullKey.slice(sep + 2);
    }
    var date = null, base = rest;
    var m = DATE_SUFFIX_RE.exec(rest);
    if (m) { base = m[1]; date = m[2]; }
    return { account: account, base: base, date: date, rest: rest };
  }

  // 业务域划分：决定「哪个键进哪一片」。
  // 按 CGA 的数据域分组（不是按前缀切），同名业务的数据尽量落在同一片。
  var DOMAINS = [
    // 列表型（可逐条合并）
    { id: 'diary',    bases: ['growth_diary', 'growth_diary_cats'] },
    { id: 'homework', bases: ['growth_homework', 'homework_subjects'] },
    { id: 'todo',     bases: ['todos'] },
    { id: 'time',     bases: ['time_records'] },
    { id: 'daily',    bases: ['daily_temp', 'daily_fixed', 'daily_sign', 'daily_behavior'] },
    { id: 'behavior', bases: ['growth_behavior', 'growth_behavior_cfg'] },
    { id: 'target',   bases: ['growth_targets', 'growth_subjects', 'growth_actions',
                              'growth_indicators', 'growth_keypoints'] },
    // 配置型 / 集合型
    { id: 'plan',     bases: ['growth_goal', 'growth_week_review', 'growth_month_review',
                              'growth_milestone', 'growth_month_days'] },
    { id: 'pomo',     bases: ['pomo_count'] },
    { id: 'timer',    bases: ['timer_categories'] },
    { id: 'account',  bases: ['child_account_list', 'child_account_current', 'child_account_meta'] },
    { id: 'ui',       bases: ['page_theme_v1', 'theme', 'sidebar_order_v3',
                              'sidebar_collapsed_v3', 'growth_indicator_tab'] }
  ];

  function domainOfKey(fullKey) {
    var p = parseKey(fullKey);
    var b = p.base;
    for (var i = 0; i < DOMAINS.length; i++) {
      var d = DOMAINS[i];
      for (var j = 0; j < d.bases.length; j++) {
        var cand = d.bases[j];
        if (b === cand || b.indexOf(cand + '_') === 0) return d.id;
      }
    }
    // 兜底：取第一个下划线前的段，保证同类数据尽量同片
    var seg = b.split('_')[0];
    return seg || 'misc';
  }

  /* ============ 合并策略（键级 + 领域级） ============ */
  // 已确认的决策：不做 tombstones（CGA 全部是硬删除，删除不可观测）。
  // 因此跨设备「删除后再同步」可能复活记录 —— 这是已知取舍。
  //
  // 合并分四层（第 ③ 层借鉴 toll2 的 mergeUserConfig/mergeStudyLog 语义）：
  //   ① 列表型（有 id）：按 id 取并集，同 id 比时间戳
  //   ② 集合型（字符串数组）：取并集
  //   ③ 累计型（纯数值）：取最大值 —— 见下方 ACCEPT 说明
  //   ④ 其它：整键取较新
  //
  // 为什么不把累计型并进第 ④ 层：番茄钟/统计类键存的是**单值累计**，
  // 用「整键取较新」会让一台设备的成果被整条丢掉。实测复现：
  // A 设备完成 5 个番茄、B 设备完成 3 个，同步后只剩 3 —— A 的 5 没了。
  // 语义上「同一天同一人完成几次」取两边较大值才是对的：
  // 两次记录描述的是同一事实的不同快照，取 max 等价于「取信息更全的那份」。
  var LIST_BASES = ['growth_diary', 'growth_homework', 'todos', 'time_records',
                    'daily_temp', 'growth_behavior'];
  var SET_BASES = ['growth_month_days', 'child_account_list', 'growth_diary_cats',
                   'homework_subjects', 'timer_categories'];
  // 累计型：值为纯数字（或数字字符串）的键，合并时取 max
  var ACC_BASES = ['pomo_count'];
  // 统计表型：值形如 { "日期": { 数字字段... } }，合并时逐字段取 max
  var STAT_TABLE_BASES = ['study_log', 'daily_stat', 'time_stat'];

  function baseOf(fullKey) { return parseKey(fullKey).base; }

  function inList(bases, base) {
    for (var i = 0; i < bases.length; i++) if (bases[i] === base) return true;
    return false;
  }

  // 累计型键的前缀匹配：pomo_count_2026-09-15 的 base 是 pomo_count（日期被 parseKey 拆走）
  function isAccKey(base) {
    for (var i = 0; i < ACC_BASES.length; i++) {
      if (base === ACC_BASES[i] || base.indexOf(ACC_BASES[i] + '_') === 0) return true;
    }
    return false;
  }

  // 把值解析成有限数；不是数字返回 null
  function asNumber(text) {
    if (text == null) return null;
    var t = String(text).trim();
    if (t === '') return null;
    var n = Number(t);
    return (typeof n === 'number' && isFinite(n)) ? n : null;
  }

  /* ---- 对象内逐字段取 max（借自 toll2 第 3 层）----
     有些统计不是「一个键一个数字」，而是「一个键装了一张表」：
         study_log = { "2026-09-14": { seconds: 1200, questions: 30 }, ... }
     两台设备各记各的，若整键取较新，后同步的那台会把前面的分钟数冲小。
     正确做法是逐字段取 max —— 时长、题量这类计数只会增不会减。
     只在「两边同键的值都是对象，且对象里的值都是数字」时才启用；否则退回上层逻辑。 */
  function maxFields(a, b) {
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (k in b) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
      var av = out[k], bv = b[k];
      var an = (typeof av === 'number') ? av : asNumber(av);
      var bn = (typeof bv === 'number') ? bv : asNumber(bv);
      if (an != null && bn != null) out[k] = (bn > an) ? bn : an;
      else if (av === undefined || av === null || av === '') out[k] = bv;
    }
    return out;
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // 整表逐字段取 max：a/b 都是「日期 → 统计对象」的表时返回合并结果，否则 null
  function mergeStatTable(a, b) {
    if (!isPlainObject(a) || !isPlainObject(b)) return null;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (!ka.length || !kb.length) return null;
    // 抽查样本：值必须是对象，对象里至少有一个数字字段，才认这是统计表
    function looksLikeTable(obj, keys) {
      var checked = 0;
      for (var i = 0; i < keys.length && checked < 3; i++) {
        var v = obj[keys[i]];
        if (!isPlainObject(v)) return false;
        var inner = Object.keys(v);
        if (!inner.length) return false;
        var hasNum = false;
        for (var j = 0; j < inner.length; j++) {
          if (typeof v[inner[j]] === 'number' || asNumber(v[inner[j]]) != null) { hasNum = true; break; }
        }
        if (!hasNum) return false;
        checked++;
      }
      return checked > 0;
    }
    if (!looksLikeTable(a, ka) || !looksLikeTable(b, kb)) return null;
    // 外层键（日期）取并集，内层逐字段 max
    var out = {}, seen = {};
    for (var i = 0; i < ka.length; i++) { seen[ka[i]] = 1; out[ka[i]] = a[ka[i]]; }
    for (var j = 0; j < kb.length; j++) {
      var d = kb[j];
      if (!seen[d]) { out[d] = b[d]; continue; }
      out[d] = isPlainObject(out[d]) && isPlainObject(b[d]) ? maxFields(out[d], b[d]) : out[d];
    }
    return out;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  // 取一条记录的时间戳（各业务字段不同，逐个兜底）
  function itemTs(item) {
    if (!item || typeof item !== 'object') return 0;
    var cands = [item.updatedAt, item.createdAt, item._editedAt, item._ts,
                 item.completedAt, item.start, item.sentTime];
    for (var i = 0; i < cands.length; i++) {
      var v = cands[i];
      if (v == null) continue;
      if (typeof v === 'number') return v;
      var t = Date.parse(v);
      if (!isNaN(t)) return t;
    }
    return 0;
  }

  // 列表型合并：按 id 取并集，同 id 取时间戳较新者
  // growth_milestone 无 id，用「date|content」派生稳定 id
  function mergeList(localArr, cloudArr) {
    var byId = {}, order = [], i, it, id;
    function keyOf(x) {
      if (x && x.id != null) return 'i:' + x.id;
      if (x && x.date != null && x.content != null) return 'd:' + x.date + '|' + x.content;
      return 'j:' + JSON.stringify(x);   // 兜底：内容全等视为同一条
    }
    for (i = 0; i < localArr.length; i++) {
      it = localArr[i]; id = keyOf(it);
      if (!Object.prototype.hasOwnProperty.call(byId, id)) order.push(id);
      byId[id] = it;
    }
    for (i = 0; i < cloudArr.length; i++) {
      it = cloudArr[i]; id = keyOf(it);
      if (!Object.prototype.hasOwnProperty.call(byId, id)) {
        order.push(id); byId[id] = it;         // 云端独有 → 补进来
      } else {
        // 两边都有 → 取时间戳较新；都无时间戳则保留本机
        var lts = itemTs(byId[id]), cts = itemTs(it);
        if (cts > lts) byId[id] = it;
      }
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      if (Object.prototype.hasOwnProperty.call(byId, order[i])) out.push(byId[order[i]]);
    }
    return out;
  }

  // 集合型合并：字符串数组取并集（保序，本机优先）
  function mergeSet(localArr, cloudArr) {
    var seen = {}, out = [], i, v;
    for (i = 0; i < localArr.length; i++) {
      v = localArr[i];
      if (typeof v !== 'string' || seen[v]) continue;
      seen[v] = 1; out.push(v);
    }
    for (i = 0; i < cloudArr.length; i++) {
      v = cloudArr[i];
      if (typeof v !== 'string' || seen[v]) continue;
      seen[v] = 1; out.push(v);
    }
    return out;
  }

  // 单键合并：返回合并后的字符串值。
  // localText / cloudText 为 localStorage 原始字符串；cloudTs / localTs 为写入时间。
  function mergeValue(fullKey, localText, cloudText, localTs, cloudTs) {
    if (localText == null) return { value: cloudText, how: 'fill' };   // 本机没有 → 补
    if (cloudText == null) return { value: localText, how: 'keep' };   // 云端没有 → 保留

    var base = baseOf(fullKey);

    // ① 列表型：逐条合并
    if (inList(LIST_BASES, base)) {
      var la = safeParse(localText), ca = safeParse(cloudText);
      if (Array.isArray(la) && Array.isArray(ca)) {
        return { value: JSON.stringify(mergeList(la, ca)), how: 'merge-list' };
      }
    }

    // ② 集合型：取并集
    if (inList(SET_BASES, base)) {
      var ls = safeParse(localText), cs = safeParse(cloudText);
      if (Array.isArray(ls) && Array.isArray(cs)) {
        var merged = mergeSet(ls, cs);
        // 并集没变化时保持原样，避免无谓写入
        if (JSON.stringify(merged) === JSON.stringify(ls)) return { value: localText, how: 'keep' };
        return { value: JSON.stringify(merged), how: 'merge-set' };
      }
    }

    // ③ 累计型：纯数字计数，取较大值
    //    同一台设备离线记了 5，另一台记了 3 —— 取 5 而不是「谁的时间新算谁」，
    //    否则晚同步的那台会把已有的计数冲小。计数只会增不会减，取 max 是安全的。
    if (isAccKey(base)) {
      var ln = asNumber(localText), cn = asNumber(cloudText);
      if (ln != null && cn != null) {
        if (cn > ln) return { value: String(cn), how: 'acc-cloud' };
        if (ln > cn) return { value: String(ln), how: 'acc-local' };
        return { value: String(ln), how: 'same' };
      }
    }

    // ④ 统计表：「一个键装一张日期→统计表」，逐字段取 max
    //    放在累计型之后、整键取新之前：能合并就合并，合并不了才比时间。
    if (inList(STAT_TABLE_BASES, base) || inList(ACC_BASES, base)) {
      var ta = safeParse(localText), tb = safeParse(cloudText);
      var table = mergeStatTable(ta, tb);
      if (table) {
        var tv = JSON.stringify(table);
        if (tv === localText) return { value: localText, how: 'same' };
        return { value: tv, how: 'merge-stat' };
      }
    }

    // ⑤ 其它：整键取较新（时间未知时保留本机，避免误覆盖）
    if (cloudTs && cloudTs > (localTs || 0)) return { value: cloudText, how: 'cloud-newer' };
    if (localText === cloudText) return { value: localText, how: 'same' };
    return { value: localText, how: 'keep' };
  }

  /* ============ 压缩 ============ */
  function canCompress() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  }
  function bufToB64(buf) {
    var u8 = new Uint8Array(buf), s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBuf(b64) {
    var bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  async function packCloud(obj) {
    var json = JSON.stringify(obj);
    if (!canCompress()) return { version: 2, enc: 'none', data: json, updatedAt: Date.now() };
    try {
      var cs = new CompressionStream(PACK_ENC);
      var buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
      return { version: 2, enc: PACK_ENC, data: bufToB64(buf), updatedAt: Date.now() };
    } catch (e) {
      return { version: 2, enc: 'none', data: json, updatedAt: Date.now() };
    }
  }
  async function unpackCloud(parsed) {
    if (!parsed) return null;
    if (parsed.enc === PACK_ENC) {
      if (!canCompress()) throw new Error('本浏览器不支持解压，请改用较新的 Chrome / Edge 打开');
      var ds = new DecompressionStream(PACK_ENC);
      var txt = await new Response(new Blob([b64ToBuf(parsed.data)]).stream().pipeThrough(ds)).text();
      return JSON.parse(txt);
    }
    if (parsed.enc === 'none' && typeof parsed.data === 'string') return JSON.parse(parsed.data);
    return parsed;   // 兼容 v1 明文
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ============ 旧版单文件格式迁移 ============ */
  // 旧版 CGA 的 index.html 内联同步把全部数据塞进一个 Gist 文件
  // （child-growth-assistant-sync.json），格式是：
  //   { version: 1, data: { "<键>": "<字符串值>", ... }, updatedAt: <ms> }
  // 新版改成分片（cga-sync-meta.json + cga-sync-*.json），文件名和结构都变了。
  // 如果不认旧文件，老用户升级后会看到「云端还没有数据」——数据其实还在，
  // 只是没人去读那个旧文件。这里把它转成新版结构，供「迁移旧数据」用。
  function parseLegacyPayload(text) {
    var parsed;
    try { parsed = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    var data = parsed.data;
    if (!data || typeof data !== 'object') return null;
    var at = Number(parsed.updatedAt) || 0;
    var out = {};
    for (var k in data) {
      if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
      var v = data[k];
      // 旧版存的是 JSON 字符串；若已是对象则原样保留（防手写文件）
      var text2 = typeof v === 'string' ? v : JSON.stringify(v);
      out[k] = { value: text2, timestamp: at };
    }
    return { data: out, updatedAt: at, count: Object.keys(out).length };
  }

  /* ============ 分片 ============ */
  // 把本机数据打包成 { shardId: {key: {value, timestamp}} }
  function buildShards(dataObj) {
    var shards = {}, key;
    for (key in dataObj) {
      if (!Object.prototype.hasOwnProperty.call(dataObj, key)) continue;
      var sid = domainOfKey(key);
      if (!shards[sid]) shards[sid] = {};
      shards[sid][key] = dataObj[key];
    }
    // 单片过大时按体积再切（xxx__2 这种后缀）
    var out = {};
    for (var sid2 in shards) {
      if (!Object.prototype.hasOwnProperty.call(shards, sid2)) continue;
      var raw = shards[sid2], idx = 0, cur = {}, curBytes = 0;
      var flush = function () {
        var n = 0;
        for (var k in cur) { if (Object.prototype.hasOwnProperty.call(cur, k)) n++; }
        if (n) { out[sid2 + (idx === 0 ? '' : '__' + idx)] = cur; idx++; cur = {}; curBytes = 0; }
      };
      for (var k2 in raw) {
        if (!Object.prototype.hasOwnProperty.call(raw, k2)) continue;
        var v = raw[k2];
        var sz = (v && typeof v.value === 'string') ? v.value.length + k2.length : 0;
        var cnt = 0;
        for (var kk in cur) { if (Object.prototype.hasOwnProperty.call(cur, kk)) cnt++; }
        if (curBytes + sz > MAX_SHARD_BYTES && cnt) flush();
        cur[k2] = v; curBytes += sz;
      }
      flush();
    }
    return out;
  }

  function shardFile(sid) { return 'cga-sync-' + sid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json'; }

  // 本机每个键的最后写入时间（备份中心维护），用于判定脏片
  function localMeta() {
    try { return JSON.parse(localStorage.getItem('__hub_meta_v1__') || '{}') || {}; } catch (e) { return {}; }
  }

  /* ---------- 内容指纹（时间戳不可靠时的兜底判据） ----------
   * 为什么需要：脏片判定依赖 __hub_meta_v1__ 的写入时间，但那份埋点由备份中心
   * 节流写、且可能没初始化。时间戳拿不到（=0）时不能直接当「没变」——那会静默
   * 丢改动。这里退化成比内容：长度 + 头尾片段，足够区分「改过」与「没改」，
   * 又不必把整片内容都比一遍。
   */
  function valueFingerprint(s) {
    s = String(s == null ? '' : s);
    var n = s.length;
    if (n <= 96) return n + '|' + s;
    return n + '|' + s.slice(0, 48) + '~' + s.slice(n - 48);
  }
  function shardFingerprint(rawObj) {
    var ks = Object.keys(rawObj).sort();
    var parts = [];
    for (var i = 0; i < ks.length; i++) parts.push(ks[i] + '=' + valueFingerprint(rawObj[ks[i]].value));
    return valueFingerprint(parts.join('\u0001'));
  }

  function newMeta(origin) {
    return { version: 5, origin: origin || '', updatedAt: Date.now(), shards: {}, keys: {} };
  }

  /* ============ 分片读写（与后端无关） ============ */
  // io 接口（各后端实现，全部返回 Promise）：
  //   io.ensureTarget()     确保远端载体存在，返回载体标识
  //   io.getMeta()          读远端 meta 对象；不存在返回 null
  //   io.getFile(name)      读单个文件文本；不存在返回 null
  //   io.putFiles(map)      map = { 文件名: 文本 }，批量写
  //   io.deleteFiles(names) 删除文件（可选）
  //   io.origin / io.label  后端标识与名字
  async function writeShardedWith(io, allData, forceShards, onProgress) {
    var origin = io.origin || '';
    await io.ensureTarget();

    var cloudMeta = null;
    try { cloudMeta = await io.getMeta(); } catch (e) { cloudMeta = null; }

    // 换后端写时不能拿旧后端的 meta 做脏片判定 —— 两边时间戳没有可比性，
    // 沿用会导致「以为没变，其实远端一片都没有」→ 数据静默丢失。强制全量。
    if (cloudMeta && cloudMeta.origin && origin && cloudMeta.origin !== origin) {
      console.warn('[' + (io.label || 'sync') + '] 远端 meta 属于其它后端（' + cloudMeta.origin + '），本次强制全量写片');
      cloudMeta = null;
      forceShards = true;
    }

    var shards = buildShards(allData);
    var meta = localMeta();
    var prevTs = (cloudMeta && cloudMeta.keys) || {};
    var files = {};
    var wroteBytes = 0, wroteShards = 0, skippedShards = 0, totalShards = 0;
    var next = newMeta(origin);

    for (var sid in shards) {
      if (!Object.prototype.hasOwnProperty.call(shards, sid)) continue;
      totalShards++;
      var raw = shards[sid];
      var keys = Object.keys(raw);
      var maxTs = 0;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var t = meta[k] || 0;
        if (t > maxTs) maxTs = t;
        next.keys[k] = { shard: sid, ts: t || (prevTs[k] && prevTs[k].ts) || 0 };
      }
      var fp = shardFingerprint(raw);
      next.shards[sid] = { keys: keys, ts: maxTs, fp: fp };

      var cloudShard = cloudMeta && cloudMeta.shards && cloudMeta.shards[sid];
      var cloudTs = cloudShard ? (cloudShard.ts || 0) : 0;

      // 脏片判定，三条独立判据任一成立即视为脏：
      //   ① 强制全量 / 远端还没这个片
      //   ② 时间戳可比较且本机更新（maxTs > cloudTs）
      //   ③ 时间戳不可靠（两边都是 0）时退回比内容指纹
      // ③ 是兜底：没有它，__hub_meta_v1__ 缺失或还没 flush 时，
      //    改动会被判成「没变」而不上传 —— 静默丢数据。
      var dirty = forceShards || !cloudMeta || !cloudShard || maxTs > cloudTs;
      if (!dirty && !cloudShard.fp) dirty = true;                  // 远端无指纹 → 保守重传
      if (!dirty && maxTs === 0 && cloudShard.fp !== fp) dirty = true;  // 时间戳不可用 → 比内容

      if (!dirty) { skippedShards++; continue; }

      var body = JSON.stringify(await packCloud({ version: 2, data: raw, updatedAt: Date.now() }));
      files[shardFile(sid)] = body;
      wroteBytes += body.length;
      wroteShards++;
      if (onProgress) { try { onProgress(wroteShards, totalShards, sid); } catch (e) {} }
    }

    // meta 很小，几乎零成本，每次都写
    files[META_FILENAME] = JSON.stringify(next);

    await io.putFiles(files);

    // 清理残留片：本机重新切片后片名可能变少，远端旧片不清会污染下次下载
    var deletedShards = 0;
    if (cloudMeta && cloudMeta.shards && io.deleteFiles) {
      var stale = [];
      for (var oldSid in cloudMeta.shards) {
        if (!Object.prototype.hasOwnProperty.call(cloudMeta.shards, oldSid)) continue;
        if (!next.shards[oldSid]) stale.push(shardFile(oldSid));
      }
      if (stale.length) {
        try { await io.deleteFiles(stale); deletedShards = stale.length; }
        catch (e) { console.warn('[' + (io.label || 'sync') + '] 清理旧分片失败（不影响本次同步）:', e.message); }
      }
    }

    return {
      wroteBytes: wroteBytes, wroteShards: wroteShards, skippedShards: skippedShards,
      totalShards: totalShards, deletedShards: deletedShards, meta: next
    };
  }

  async function readShardedMetaWith(io) {
    await io.ensureTarget();
    return io.getMeta();
  }

  async function readShardedWith(io, cloudMeta, onProgress) {
    var shardIds = Object.keys((cloudMeta && cloudMeta.shards) || {});
    var merged = { data: {}, updatedAt: (cloudMeta && cloudMeta.updatedAt) || 0 };
    var doneN = 0;

    var tasks = shardIds.map(async function (sid) {
      var fname = shardFile(sid);
      var content = null;
      try { content = await io.getFile(fname); } catch (e) { content = null; }
      if (!content) return null;
      try {
        var payload = await unpackCloud(JSON.parse(content));
        return (payload && payload.data) || {};
      } catch (e) {
        console.warn('[' + (io.label || 'sync') + '] 分片解析失败 ' + sid + ':', e.message);
        return null;   // 单片失败不影响其它片
      } finally {
        doneN++;
        if (onProgress) { try { onProgress(doneN, shardIds.length, sid); } catch (e2) {} }
      }
    });
    var results = await Promise.all(tasks);
    var okCount = 0;
    for (var i = 0; i < results.length; i++) {
      if (results[i]) { okCount++; Object.assign(merged.data, results[i]); }
    }
    merged.shardCount = shardIds.length;
    merged.shardOk = okCount;
    return merged;
  }

  /* ============ 本机数据收集 / 应用 ============ */
  function collectLocalData() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      var value = localStorage.getItem(key);
      if (value === null || value === '') continue;
      if (isExcludedKey(key, value)) continue;
      data[key] = { value: value, timestamp: Date.now() };
    }
    return data;
  }

  function localKeys() {
    var out = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      var value = localStorage.getItem(key);
      if (value === null || value === '') continue;
      if (isExcludedKey(key, value)) continue;
      out.push(key);
    }
    return out;
  }

  // 应用合并结果到本机：逐个键用领域级合并，返回统计
  function mergeCloudToLocal(serverData, cloudTsMap) {
    var sdata = (serverData && serverData.data) || serverData || {};
    var meta = localMeta();
    var added = 0, merged = 0, kept = 0, skipped = 0;
    for (var key in sdata) {
      if (!Object.prototype.hasOwnProperty.call(sdata, key)) continue;
      var entry = sdata[key];
      if (!entry || typeof entry.value !== 'string') continue;
      if (isExcludedKey(key, entry.value)) continue;

      var localText = localStorage.getItem(key);
      var localTs = meta[key] || 0;
      var cloudTs = entry.timestamp || (cloudTsMap && cloudTsMap[key]) || 0;

      var res = mergeValue(key, localText, entry.value, localTs, cloudTs);
      if (localText === null) {
        localStorage.setItem(key, res.value);
        added++;
      } else if (res.value !== localText) {
        localStorage.setItem(key, res.value);
        merged++;
      } else {
        kept++;
      }
    }
    return { added: added, merged: merged, kept: kept, skipped: skipped };
  }

  // 合并上传：以云端为底，逐键与本机合并，返回合并后的数据集
  function buildMergedUpload(serverData, cloudTsMap) {
    var sdata = (serverData && serverData.data) || serverData || {};
    var meta = localMeta();
    var out = {}, key;

    for (key in sdata) {
      if (!Object.prototype.hasOwnProperty.call(sdata, key)) continue;
      var e = sdata[key];
      if (!e || typeof e.value !== 'string') continue;
      if (isExcludedKey(key, e.value)) continue;
      out[key] = { value: e.value, timestamp: e.timestamp || (cloudTsMap && cloudTsMap[key]) || 0 };
    }

    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      var v = localStorage.getItem(k);
      if (v === null || v === '') continue;
      if (isExcludedKey(k, v)) continue;
      var lts = meta[k] || Date.now();
      if (!out[k]) { out[k] = { value: v, timestamp: lts }; continue; }
      var res = mergeValue(k, v, out[k].value, lts, out[k].timestamp || 0);
      out[k] = { value: res.value, timestamp: Math.max(lts, out[k].timestamp || 0) };
    }
    return out;
  }

  /* ============ 导出 ============ */
  Core.META_FILENAME = META_FILENAME;
  Core.LEGACY_FILENAME = LEGACY_FILENAME;
  Core.parseLegacyPayload = parseLegacyPayload;
  Core.valueFingerprint = valueFingerprint;
  Core.shardFingerprint = shardFingerprint;
  Core.MAX_SHARD_BYTES = MAX_SHARD_BYTES;
  Core.isExcludedKey = isExcludedKey;
  Core.parseKey = parseKey;
  Core.domainOfKey = domainOfKey;
  Core.mergeValue = mergeValue;
  Core.mergeList = mergeList;
  Core.mergeSet = mergeSet;
  Core.mergeCloudToLocal = mergeCloudToLocal;
  Core.buildMergedUpload = buildMergedUpload;
  Core.collectLocalData = collectLocalData;
  Core.localKeys = localKeys;
  Core.buildShards = buildShards;
  Core.shardFile = shardFile;
  Core.newMeta = newMeta;
  Core.localMeta = localMeta;
  Core.writeShardedWith = writeShardedWith;
  Core.readShardedWith = readShardedWith;
  Core.readShardedMetaWith = readShardedMetaWith;
  Core.packCloud = packCloud;
  Core.unpackCloud = unpackCloud;
  Core.canCompress = canCompress;
  Core.sleep = sleep;

  window.CGASyncCore = Core;
})();
