/* ================================================================
 *  儿女学习时光 · CGA 分片表  cga-shard.js
 *  ----------------------------------------------------------------
 *  作用：告诉同步引擎「哪个键该进哪一片」。
 *
 *  为什么需要它：
 *    本页数据是多儿童模型，键的真实名字是「小明::growth_diary」这种形式，
 *    而孩子数量与名字运行期才知道 —— 所以归属只能靠「解析键名」算出来，
 *    不可能写死清单。
 *
 *    同步引擎自带的分片兜底是 `key.split('_')[0]`，于是：
 *      小明::growth_diary    → 'growth'
 *      小明::growth_homework → 'growth'
 *      小明::growth_targets  → 'growth'
 *      …growth_* 一整族全落同一片 ⇒ 改一张卡片也要重传整族。
 *    本表把它们拆开，并且把「同一业务的键」聚在一起，
 *    这样一次改动只弄脏它真正落到的那一片。
 *
 *  与引擎的契约：
 *    window.CGAShardMap(key) -> 片 id（ASCII，只含 [a-zA-Z0-9_-]）
 *    返回空值/抛错时引擎自动退回自己的兜底逻辑，本文件缺失也不影响同步可用性。
 *
 *  ⚠️ 片 id 会成为云端文件名（引擎侧前缀 'cga-'），必须是 ASCII：
 *     引擎的 shardFile() 会把非 [a-zA-Z0-9_-] 字符直接删掉，
 *     若片 id 用中文，多个片会被清洗成同一个空名 ⇒ 互相覆盖。
 * ================================================================ */
(function () {
  'use strict';

  /* ---------- 键名解析 ----------
   *   "小明::growth_diary"            → { account:'小明', base:'growth_diary', date:null }
   *   "小明::daily_temp_2026-09-14"   → { account:'小明', base:'daily_temp',   date:'2026-09-14' }
   *   "growth_targets"                → { account:null,   base:'growth_targets', date:null }
   */
  var DATE_SUFFIX_RE = /^(.*)_(\d{4}-\d{2}-\d{2})$/;

  function parseKey(fullKey) {
    var account = null, rest = String(fullKey);
    var sep = rest.indexOf('::');
    if (sep > -1) {
      account = rest.slice(0, sep);
      rest = rest.slice(sep + 2);
    }
    var date = null, base = rest;
    var m = DATE_SUFFIX_RE.exec(rest);
    if (m) { base = m[1]; date = m[2]; }
    return { account: account, base: base, date: date };
  }

  /* ---------- 业务域划分 ----------
   * 按「同一业务尽量同片」分组：一次编辑通常只涉及一个业务域，
   * 域内聚得越好，脏片判定命中的片数越少，上传越省。
   * 顺序有意义：先匹配到的先赢，所以更具体的（growth_diary）要排在更宽泛的前面。
   */
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

  function domainOf(fullKey) {
    var base = parseKey(fullKey).base;
    for (var i = 0; i < DOMAINS.length; i++) {
      var d = DOMAINS[i];
      for (var j = 0; j < d.bases.length; j++) {
        var cand = d.bases[j];
        if (base === cand || base.indexOf(cand + '_') === 0) return d.id;
      }
    }
    // 兜底：取第一个下划线前的段，保证同类数据尽量同片（与引擎原兜底同义）
    var seg = base.split('_')[0];
    return seg || 'misc';
  }

  // 片 id 只回业务域名（ASCII），云端文件名前缀 'cga-' 由引擎侧 shardFile() 统一加，
  // 避免两边各加一次变成 'cga-cga-*'。这里再加一道 ASCII 清洗兜底。
  function CGAShardMap(key) {
    if (!key) return '';
    var id = String(domainOf(key)).replace(/[^a-zA-Z0-9_-]/g, '');
    return id || 'misc';
  }

  try { window.CGAShardMap = CGAShardMap; } catch (e) {}
  // 供回归测试与排查用
  try {
    window.CGAShard = {
      map: CGAShardMap,
      domainOf: domainOf,
      parse: parseKey,
      domains: DOMAINS.map(function (d) { return d.id; })
    };
  } catch (e) {}
})();
