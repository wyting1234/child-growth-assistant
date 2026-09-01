/* =============================================================
 *  儿童成长助手 · 全站统一导航（site-nav.js）
 *  ------------------------------------------------------------
 *  规则（全站唯一约定）：
 *   1. 跨页导航的唯一入口 = index.html（导航中心）。
 *      任何子页面都不再平铺其它页面链接，抽屉里只有「返回导航中心」。
 *   2. 汉堡按钮固定贴在左侧垂直居中位置，任何页面都在同一位置。
 *   3. 抽屉内除「返回导航中心」外，只允许出现「本页内快捷跳转」
 *      与三个常用功能（云备份 / 学员管理 / 页面变色）。
 *
 *  用法：
 *    <script src="./site-nav.js"
 *            data-title="学习记录"
 *            data-sections='[{"ico":"📊","name":"仪表盘","sel":"#sec-dashboard"}]'></script>
 *
 *  data-sections 每项字段：
 *    ico  图标（可选）
 *    name 显示名
 *    sel  目标选择器（默认滚动到该元素）
 *    click 为 true 时，找到元素后触发 click（用于切换页面内的 tab）
 *    fn   可直接在 window 上调用的函数名（优先级高于 sel/click）
 * ============================================================= */
(function () {
    'use strict';

    var HOME = './index.html';

    /* 站点清单：只用于识别「当前在哪一页」 */
    var SITES = [
        { file: 'index.html',        ico: '🧭', name: '导航中心' },
        { file: '成长复盘.html',      ico: '🌱', name: '成长复盘' },
        { file: 'study-record.html', ico: '📚', name: '学习记录' },
        { file: '情商club.html',      ico: '💬', name: '情商club' },
        { file: '时间统计.html',       ico: '⏱️', name: '时间统计' }
    ];

    var me = document.currentScript || (function () {
        var list = document.getElementsByTagName('script');
        for (var i = list.length - 1; i >= 0; i--) {
            if (list[i].src && list[i].src.indexOf('site-nav.js') > -1) return list[i];
        }
        return null;
    })();

    function attr(name, dflt) {
        var v = me && me.getAttribute(name);
        return (v === null || v === undefined || v === '') ? dflt : v;
    }

    /* ---------- 当前页 ---------- */
    function currentFile() {
        var p = '';
        try { p = decodeURIComponent(window.location.pathname.split('/').pop() || ''); } catch (e) { p = ''; }
        if (!p || p.indexOf('.html') === -1) p = 'index.html';
        return p;
    }
    var CUR = currentFile();
    var isHome = (CUR === 'index.html');

    var meta = { ico: '🌱', name: attr('data-title', '') };
    if (!meta.name) {
        for (var i = 0; i < SITES.length; i++) if (SITES[i].file === CUR) { meta = SITES[i]; break; }
        if (!meta.name) meta = { ico: '🌱', name: '儿童成长助手' };
    }

    /* ---------- 页内快捷 ---------- */
    var SECTIONS = [];
    try {
        var raw = attr('data-sections', '');
        if (raw) SECTIONS = JSON.parse(raw);
    } catch (e) { SECTIONS = []; }
    if (!Array.isArray(SECTIONS)) SECTIONS = [];

    /* ---------- 样式 ---------- */
    var CSS = [
        '.snav-btn{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:9001;width:38px;height:64px;',
        'background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;font-size:18px;line-height:1;',
        'border:none;border-radius:0 12px 12px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;',
        'box-shadow:2px 0 14px rgba(99,102,241,.42);padding:0;transition:width .22s,box-shadow .22s;}',
        '.snav-btn:hover{width:44px;box-shadow:2px 0 18px rgba(99,102,241,.6);}',
        '.snav-btn:active{transform:translateY(-50%) scale(.96);}',
        /* 抽屉打开时，按钮跟着移到抽屉右缘外侧并浮到最上层，避免被抽屉盖住 */
        '.snav-btn.open{z-index:9100;transform:translateY(-50%) translateX(min(290px,86vw));}',
        '.snav-btn.open:hover{width:38px;}',
        '.snav-mask{display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9002;opacity:0;transition:opacity .26s;}',
        '.snav-mask.show{display:block;opacity:1;}',
        '.snav-panel{position:fixed;top:0;left:0;bottom:0;width:min(290px,86vw);background:#0f172a;color:#cbd5e1;',
        'z-index:9003;box-shadow:6px 0 28px rgba(0,0,0,.32);display:flex;flex-direction:column;',
        'transform:translateX(-102%);transition:transform .28s cubic-bezier(.4,0,.2,1);visibility:hidden;}',
        '.snav-panel.open{transform:translateX(0);visibility:visible;}',
        '.snav-head{padding:18px 16px 12px;border-bottom:1px solid #1e293b;display:flex;align-items:flex-start;gap:10px;flex:none;}',
        '.snav-head .t{font-size:15px;font-weight:700;color:#fff;display:flex;align-items:center;gap:6px;}',
        '.snav-head .s{font-size:11px;color:#94a3b8;margin-top:5px;line-height:1.5;}',
        '.snav-head .s b{color:#e2e8f0;font-weight:600;}',
        '.snav-close{margin-left:auto;background:none;border:none;color:#64748b;font-size:20px;line-height:1;cursor:pointer;padding:2px 4px;}',
        '.snav-close:hover{color:#f1f5f9;}',
        '.snav-body{flex:1;overflow-y:auto;padding:14px 12px 18px;}',
        '.snav-label{font-size:10px;letter-spacing:.08em;color:#64748b;padding:6px 8px 8px;font-weight:600;}',
        '.snav-home{display:flex;align-items:center;gap:10px;padding:12px;border-radius:11px;text-decoration:none;',
        'background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;font-size:14px;font-weight:600;',
        'box-shadow:0 4px 14px rgba(99,102,241,.32);margin-bottom:6px;}',
        '.snav-home:hover{filter:brightness(1.08);}',
        '.snav-home .go{margin-left:auto;font-size:12px;opacity:.85;}',
        '.snav-here{display:flex;align-items:center;gap:10px;padding:12px;border-radius:11px;font-size:14px;font-weight:600;',
        'background:rgba(148,163,184,.12);color:#94a3b8;margin-bottom:6px;}',
        '.snav-item{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:10px;border:none;',
        'background:transparent;color:#cbd5e1;font-size:13.5px;cursor:pointer;text-align:left;font-family:inherit;}',
        '.snav-item:hover{background:rgba(148,163,184,.14);color:#f1f5f9;}',
        '.snav-item .k{margin-left:auto;font-size:10px;color:#64748b;}',
        '.snav-foot{flex:none;border-top:1px solid #1e293b;padding:12px;display:flex;flex-direction:column;gap:6px;}',
        '.snav-foot button{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border-radius:10px;border:none;',
        'background:rgba(255,255,255,.06);color:#e2e8f0;font-size:13.5px;cursor:pointer;text-align:left;font-family:inherit;}',
        '.snav-foot button:hover{background:rgba(255,255,255,.14);color:#fff;}',
        '.snav-ver{text-align:center;font-size:10px;color:#475569;padding-top:4px;}',
        '@media (max-width:640px){.snav-btn{width:34px;height:58px;font-size:16px;}.snav-btn:hover{width:38px;}}',
        '@media print{.snav-btn,.snav-mask,.snav-panel{display:none !important;}}'
    ].join('');

    if (!document.getElementById('snav-style')) {
        var st = document.createElement('style');
        st.id = 'snav-style';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    /* ---------- DOM ---------- */
    var sectionsHTML = '';
    if (SECTIONS.length) {
        sectionsHTML += '<div class="snav-label">本页快捷</div>';
        sectionsHTML += SECTIONS.map(function (s, i) {
            return '<button class="snav-item" data-idx="' + i + '">' +
                '<span>' + (s.ico || '•') + '</span><span>' + (s.name || '') + '</span>' +
                (s.click ? '<span class="k">切换</span>' : '') +
                '</button>';
        }).join('');
    }

    var wrap = document.createElement('div');
    wrap.innerHTML =
        '<button class="snav-btn" id="siteDrawerToggle" title="导航中心与常用功能" aria-label="打开导航菜单">☰</button>' +
        '<div class="snav-mask" id="siteDrawerMask"></div>' +
        '<aside class="snav-panel" id="siteDrawer" role="dialog" aria-label="全站导航">' +
            '<div class="snav-head">' +
                '<div>' +
                    '<div class="t">🌱 儿童成长助手</div>' +
                    '<div class="s">当前：<b id="snavCurPage">' + meta.name + '</b> · 学员 <b id="snavAccount">未选择</b></div>' +
                '</div>' +
                '<button class="snav-close" id="siteDrawerClose" aria-label="关闭">✕</button>' +
            '</div>' +
            '<div class="snav-body">' +
                '<div class="snav-label">全站导航</div>' +
                (isHome
                    ? '<div class="snav-here">🧭 导航中心<span class="k">当前位置</span></div>'
                    : '<a class="snav-home" href="' + HOME + '">🧭 返回导航中心<span class="go">›</span></a>') +
                sectionsHTML +
            '</div>' +
            '<div class="snav-foot">' +
                '<button id="sidebarCloudSyncBtn" title="数据云端备份/恢复">☁️ 云备份</button>' +
                '<button id="sidebarUserManagerBtn" title="切换/添加孩子学员">👤 学员管理</button>' +
                '<button id="sidebarThemeBtn" title="切换页面深色/浅色模式">🌗 页面变色</button>' +
                '<div class="snav-ver">全站导航 · v1.0</div>' +
            '</div>' +
        '</aside>';

    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    var btn = document.getElementById('siteDrawerToggle');
    var mask = document.getElementById('siteDrawerMask');
    var panel = document.getElementById('siteDrawer');
    var closeBtn = document.getElementById('siteDrawerClose');

    /* ---------- 开合 ---------- */
    var scrollLock = 0;
    function open() {
        panel.classList.add('open');
        mask.classList.add('show');
        btn.classList.add('open');
        btn.textContent = '✕';
        btn.setAttribute('aria-label', '关闭导航菜单');
        refreshAccount();
        scrollLock = window.pageYOffset || document.documentElement.scrollTop || 0;
        document.body.style.overflow = 'hidden';
    }
    function close() {
        panel.classList.remove('open');
        mask.classList.remove('show');
        btn.classList.remove('open');
        btn.textContent = '☰';
        btn.setAttribute('aria-label', '打开导航菜单');
        document.body.style.overflow = '';
    }
    function toggle() { panel.classList.contains('open') ? close() : open(); }

    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(); });
    mask.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });

    /* ---------- 页内快捷 ---------- */
    panel.addEventListener('click', function (e) {
        var item = e.target.closest ? e.target.closest('.snav-item') : null;
        if (!item) return;
        var cfg = SECTIONS[parseInt(item.getAttribute('data-idx'), 10)] || {};
        close();
        setTimeout(function () { gotoSection(cfg); }, 180);
    });

    function gotoSection(cfg) {
        if (cfg.fn && typeof window[cfg.fn] === 'function') { window[cfg.fn](); return; }
        if (!cfg.sel) return;
        var el = document.querySelector(cfg.sel);
        if (!el) return;
        if (cfg.click) { el.click(); return; }
        var top = el.getBoundingClientRect().top + (window.pageYOffset || 0) - 76;
        try { window.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' }); }
        catch (err) { window.scrollTo(0, top < 0 ? 0 : top); }
    }

    /* ---------- 学员名 ---------- */
    function readAccount() {
        try { return localStorage.getItem('child_account_current') || ''; } catch (e) { return ''; }
    }
    function refreshAccount() {
        var el = document.getElementById('snavAccount');
        if (el) el.textContent = readAccount() || '未选择';
    }
    refreshAccount();
    window.addEventListener('storage', function (e) {
        if (!e.key || e.key === 'child_account_current' || e.key === 'child_account_list') refreshAccount();
        if (!e.key || e.key === 'page_theme_v1' || e.key === 'theme') syncThemeText();
    });

    /* ---------- 三个功能按钮 ---------- */
    function toast(msg) {
        if (typeof window.showToast === 'function') { try { window.showToast(msg); return; } catch (e) {} }
        var t = document.getElementById('toast');
        if (t) {
            t.textContent = msg;
            t.classList.add('show');
            setTimeout(function () { t.classList.remove('show'); }, 1800);
        }
    }

    /* data-actions="custom"：云备份 / 学员管理由页面自己实现（页面有本地降级弹窗时用它），
       此时组件只负责注入按钮 DOM 与主题切换，避免双重绑定。 */
    if (attr('data-actions', 'auto') !== 'custom') {
        document.getElementById('sidebarUserManagerBtn').addEventListener('click', function () {
            close();
            if (window.AccountManager && typeof window.AccountManager.open === 'function') { window.AccountManager.open(); return; }
            var acc = document.getElementById('accountBtn');
            if (acc) { acc.click(); return; }
            if (typeof window.openAccountModal === 'function') { window.openAccountModal(); return; }
            toast('学员管理加载中…');
        });

        document.getElementById('sidebarCloudSyncBtn').addEventListener('click', function () {
            close();
            if (typeof window.openSyncPanel === 'function') { window.openSyncPanel(); return; }
            if (window.EqSyncManager && typeof window.EqSyncManager.open === 'function') { window.EqSyncManager.open(); return; }
            toast('云备份模块加载中…');
        });
    } else {
        /* 页面自己实现了云备份 / 学员管理：这里只负责点完收起抽屉 */
        ['sidebarUserManagerBtn', 'sidebarCloudSyncBtn'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('click', function () { close(); });
        });
    }

    var themeBtn = document.getElementById('sidebarThemeBtn');
    function syncThemeText() {
        themeBtn.textContent = document.documentElement.classList.contains('dark') ? '🌙 页面变色' : '☀️ 页面变色';
    }
    function setTheme(dark, persist) {
        document.documentElement.classList.toggle('dark', dark);
        try {
            localStorage.setItem('page_theme_v1', dark ? 'dark' : 'light');
            localStorage.setItem('theme', dark ? 'dark' : 'light');
        } catch (e) {}
        syncThemeText();
        if (persist !== false) {
            try { window.dispatchEvent(new CustomEvent('snav:themechange', { detail: { dark: dark } })); } catch (e) {}
        }
    }
    /* 初始化：没有历史选择时，使用 data-theme-default（默认 dark，与原各页一致） */
    (function initTheme() {
        var saved = null;
        try { saved = localStorage.getItem('page_theme_v1') || localStorage.getItem('theme'); } catch (e) {}
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.classList.toggle('dark', saved === 'dark');
        } else {
            var dflt = attr('data-theme-default', 'dark');   // dark / light / system
            var dark = true;
            if (dflt === 'light') dark = false;
            else if (dflt === 'system') {
                try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { dark = true; }
            }
            document.documentElement.classList.toggle('dark', dark);
        }
        syncThemeText();
    })();
    themeBtn.addEventListener('click', function () {
        setTheme(!document.documentElement.classList.contains('dark'), true);
    });

    /* 供其它脚本使用 */
    window.SiteNav = {
        open: open,
        close: close,
        setTheme: setTheme,
        refreshAccount: refreshAccount,
        page: CUR
    };
})();
