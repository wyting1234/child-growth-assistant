/* =============================================================
 *  儿女学习时光 · 全站统一导航抽屉（site-nav.js）
 *  ------------------------------------------------------------
 *  规则（全站唯一约定）：
 *   1. 跨页导航的唯一入口 = index.html（导航中心 · 儿女学习时光）。
 *      子页面抽屉里只有「返回导航中心」+「本页快捷」，不再平铺其它页面链接。
 *   2. 汉堡按钮固定贴在左侧垂直居中位置，任何页面都在同一位置。
 *   3. 云端同步只有一套实现 —— 跑在 index.html 上的 sync-github.js。
 *      子页不加载同步引擎（对齐 efficiency-hub：工具页不加载，
 *      同步由导航页独占），子页按钮只负责跳到导航中心的同步面板。
 *      理由：全站同源共用一份 localStorage，导航页同步一次即覆盖全站；
 *      子页各自再跑一套引擎只会产生两个云端副本与两套合并策略。
 *   4. 视觉语言对齐 efficiency-hub 的侧边栏（深色导航轨 / nav-label 分组 /
 *      side-foot 底部功能区 + 版本徽标）。
 *
 *  用法：
 *    <script src="./site-nav.js"
 *            data-title="学习记录"
 *            data-theme-default="system"
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

    /* ---------- 版本号（推送批次）---------------------------------
     * 导航版本用小写后缀，子工具版本用大写后缀；
     * 规则：推送日期 + 字母递增（aa → ab → …），导航版本不低于任何子工具版本。
     * 单个页面单独迭代时，把它的版本写进 PAGE_VERS 即可，导航版本同步抬高。
     * ----------------------------------------------------------- */
    var NAV_VER = 'V20261012 aa';
    var PAGE_VER_DEFAULT = 'V20261012 AA';
    var PAGE_VERS = {
        // 'study-record.html': 'V20261012 AB',
    };

    /* 站点清单：只用于识别「当前在哪一页」 */
    var SITES = [
        { file: 'index.html',            ico: '🧭', name: '儿女学习时光' },
        { file: '成长复盘.html',          ico: '🌱', name: '成长复盘' },
        { file: 'study-record.html',     ico: '📚', name: '学习记录' },
        { file: '情商club.html',          ico: '💬', name: '情商club' },
        { file: '时间统计.html',           ico: '⏱️', name: '时间统计' },
        { file: '朝暮计-双端适配版.html',  ico: '🌅', name: '朝暮计' },
        { file: 'learning-goal.html',    ico: '🎯', name: '学习目标' },
        { file: '游戏改变世界.html',      ico: '🎮', name: '游戏改变世界' },
        { file: '陪伴星球.html',          ico: '🪐', name: '陪伴星球' }
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
    var PAGE_VER = PAGE_VERS[CUR] || PAGE_VER_DEFAULT;

    var meta = { ico: '🌱', name: attr('data-title', '') };
    if (!meta.name) {
        for (var i = 0; i < SITES.length; i++) if (SITES[i].file === CUR) { meta = SITES[i]; break; }
        if (!meta.name) meta = { ico: '🌱', name: '儿女学习时光' };
    }

    /* ---------- 页内快捷 ---------- */
    var SECTIONS = [];
    try {
        var raw = attr('data-sections', '');
        if (raw) SECTIONS = JSON.parse(raw);
    } catch (e) { SECTIONS = []; }
    if (!Array.isArray(SECTIONS)) SECTIONS = [];

    /* ---------- 样式（对齐 efficiency-hub 侧边栏）---------- */
    var CSS = [
        /* 左侧悬浮标签：始终可见，点击开合抽屉（对应 hub 的 .float-tab） */
        '.snav-btn{position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:9001;width:28px;height:56px;',
        'background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;font-size:15px;line-height:1;',
        'border:none;border-radius:0 10px 10px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;',
        'box-shadow:2px 0 12px rgba(99,102,241,.4);padding:0;transition:width .22s,box-shadow .22s;}',
        '.snav-btn:hover{width:32px;box-shadow:2px 0 18px rgba(99,102,241,.6);}',
        '.snav-btn.open{z-index:9100;transform:translateY(-50%) translateX(min(290px,86vw));}',
        '.snav-btn.open:hover{width:28px;}',
        '.snav-mask{display:none;position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:9002;opacity:0;transition:opacity .26s;}',
        '.snav-mask.show{display:block;opacity:1;}',

        /* 抽屉 = hub 的 .sidebar */
        '.snav-panel{position:fixed;top:0;left:0;bottom:0;width:280px;max-width:86vw;background:#0f172a;color:#cbd5e1;',
        'z-index:9003;box-shadow:6px 0 28px rgba(0,0,0,.32);display:flex;flex-direction:column;padding:18px 14px 12px;gap:6px;',
        'transform:translateX(-102%);transition:transform .28s cubic-bezier(.4,0,.2,1);visibility:hidden;}',
        '.snav-panel.open{transform:translateX(0);visibility:visible;}',

        /* 品牌区 = hub 的 .brand */
        '.snav-head{display:flex;align-items:center;gap:10px;padding:6px 8px 14px;flex:none;}',
        '.snav-head .logo{width:38px;height:38px;border-radius:10px;flex:0 0 38px;font-size:20px;',
        'background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);display:flex;align-items:center;justify-content:center;',
        'box-shadow:0 4px 12px rgba(99,102,241,.4);}',
        '.snav-head .meta{flex:1;min-width:0;}',
        '.snav-head .t{font-size:16px;font-weight:700;color:#fff;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.snav-head .s{font-size:11px;color:#7c8aa5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.snav-head .s b{color:#cbd5e1;font-weight:600;}',
        '.snav-close{flex:none;width:28px;height:28px;border-radius:10px;background:transparent;border:none;color:#cbd5e1;',
        'font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s;}',
        '.snav-close:hover{background:rgba(255,255,255,.1);color:#fff;}',

        /* 分组标签 = hub 的 .nav-label */
        '.snav-label{flex:none;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5b6b86;padding:12px 10px 6px;}',

        '.snav-body{flex:1;overflow-y:auto;overflow-x:hidden;}',
        '.snav-body::-webkit-scrollbar{width:6px;}',
        '.snav-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.18);border-radius:4px;}',

        /* 导航中心 / 当前位置 = hub 的 .nav-item */
        '.snav-home{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;text-decoration:none;',
        'background:#6366f1;color:#fff;font-size:14px;font-weight:600;box-shadow:0 4px 12px rgba(99,102,241,.35);}',
        '.snav-home:hover{filter:brightness(1.08);}',
        '.snav-home .go{margin-left:auto;font-size:12px;opacity:.85;}',
        '.snav-here{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:10px;font-size:14px;font-weight:600;',
        'background:rgba(148,163,184,.12);color:#94a3b8;}',

        /* 页内快捷 = hub 的 .nav-item */
        '.snav-item{display:flex;align-items:center;gap:11px;width:100%;padding:10px 12px;border-radius:10px;border:none;',
        'background:transparent;color:#cbd5e1;font-size:14px;cursor:pointer;text-align:left;font-family:inherit;',
        'transition:background .15s,color .15s;}',
        '.snav-item:hover{background:rgba(255,255,255,.06);color:#fff;}',
        '.snav-item .k{margin-left:auto;font-size:10px;color:#64748b;}',

        /* 底部功能区 = hub 的 .side-foot / .side-btn / #buildTag */
        '.snav-foot{margin-top:auto;flex:none;border-top:1px solid rgba(255,255,255,.07);padding:12px 0 4px;',
        'display:flex;flex-direction:column;gap:8px;}',
        '.snav-foot button{display:flex;align-items:center;gap:11px;width:100%;padding:10px 12px;border-radius:10px;border:none;',
        'background:transparent;color:#cbd5e1;font-size:14px;cursor:pointer;text-align:left;font-family:inherit;',
        'transition:background .15s,color .15s;}',
        '.snav-foot button:hover{background:rgba(255,255,255,.1);color:#fff;}',
        '.snav-ver{font:600 10px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3px;',
        'padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);color:#8ea2c0;text-align:center;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:text;}',
        '.snav-ver span{display:block;}',
        '.snav-ver .vt-nav{color:#94a3b8;}',

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
                '<div class="logo">🌱</div>' +
                '<div class="meta">' +
                    '<div class="t">儿女学习时光</div>' +
                    '<div class="s">当前：<b id="snavCurPage">' + meta.name + '</b> · 学员 <b id="snavAccount">未选择</b></div>' +
                '</div>' +
                '<button class="snav-close" id="siteDrawerClose" aria-label="关闭">✕</button>' +
            '</div>' +
            '<div class="snav-body">' +
                '<div class="snav-label">全站导航</div>' +
                (isHome
                    ? '<div class="snav-here">🧭 儿女学习时光<span class="k" style="margin-left:auto;font-size:10px;color:#64748b">当前位置</span></div>'
                    : '<a class="snav-home" href="' + HOME + '">🧭 返回导航中心<span class="go">›</span></a>') +
                sectionsHTML +
            '</div>' +
            '<div class="snav-foot">' +
                '<button id="sidebarCloudSyncBtn" title="跳到导航中心的云端同步面板">☁️ 云端同步</button>' +
                '<button id="sidebarUserManagerBtn" title="切换/添加孩子学员">👤 学员管理</button>' +
                '<button id="sidebarThemeBtn" title="切换页面深色/浅色模式">🌗 页面变色</button>' +
                '<div class="snav-ver">' +
                    '<span class="vt-nav">导航：' + NAV_VER + '</span>' +
                    '<span class="vt-tool">' + meta.name + '：' + PAGE_VER + '</span>' +
                '</div>' +
            '</div>' +
        '</aside>';

    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    var btn = document.getElementById('siteDrawerToggle');
    var mask = document.getElementById('siteDrawerMask');
    var panel = document.getElementById('siteDrawer');
    var closeBtn = document.getElementById('siteDrawerClose');

    /* ---------- 开合 ---------- */
    function open() {
        panel.classList.add('open');
        mask.classList.add('show');
        btn.classList.add('open');
        btn.textContent = '✕';
        btn.setAttribute('aria-label', '关闭导航菜单');
        refreshAccount();
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

    /* 云端同步：全站只有 index.html 跑同步引擎（见文件头 §3），
       子页一律跳到导航中心的同步面板 —— 不再调用各页自己的旧同步实现。 */
    document.getElementById('sidebarCloudSyncBtn').addEventListener('click', function () {
        close();
        window.location.href = HOME + '#sync';
    });

    document.getElementById('sidebarUserManagerBtn').addEventListener('click', function () {
        var handled = false;
        if (window.AccountManager && typeof window.AccountManager.open === 'function') {
            try { window.AccountManager.open(); handled = true; } catch (e) {}
        }
        if (!handled) {
            var acc = document.getElementById('accountBtn');
            if (acc) { acc.click(); handled = true; }
        }
        if (!handled && typeof window.openAccountModal === 'function') {
            try { window.openAccountModal(); handled = true; } catch (e) {}
        }
        if (handled) { close(); return; }
        // 本页没有学员管理能力 → 回导航中心
        window.location.href = HOME;
    });

    var themeBtn = document.getElementById('sidebarThemeBtn');
    function syncThemeText() {
        if (themeBtn) themeBtn.textContent = document.documentElement.classList.contains('dark') ? '🌗 页面变浅' : '🌗 页面变深';
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
        version: { nav: NAV_VER, page: PAGE_VER },
        page: CUR
    };
})();
