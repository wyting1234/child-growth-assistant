// 光阴の 共享「学员管理」：三个页面（index.html / study-record.html / 情商club.html）
// 都可以从侧栏 footer 👤 学员管理 按钮直接打开，不需要回主页。
// 数据键与主系统保持一致：child_account_list / child_account_current / child_account_meta::<name>
// 暴露 window.AccountManager = { open, close, add, switchTo, deleteAccount, editGrade, getList, getCurrent, getGrade }
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function getList() {
    try { return JSON.parse(localStorage.getItem('child_account_list') || '[]'); } catch (e) { return []; }
  }
  function saveList(arr) { try { localStorage.setItem('child_account_list', JSON.stringify(arr)); } catch (e) {} }
  function getCurrent() { try { return localStorage.getItem('child_account_current') || ''; } catch (e) { return ''; } }
  function setCurrent(name) { try { localStorage.setItem('child_account_current', name); } catch (e) {} }
  function getGrade(name) { try { return localStorage.getItem('child_account_meta::' + name) || ''; } catch (e) { return ''; } }
  function setGrade(name, grade) {
    try {
      if (grade) localStorage.setItem('child_account_meta::' + name, grade);
      else localStorage.removeItem('child_account_meta::' + name);
    } catch (e) {}
  }
  // 数字年级 ↔ 中文
  var CN_GRADES = ['一', '二', '三', '四', '五', '六'];
  function cnToGrade(text) {
    var t = (text || '').trim();
    if (!t) return null;
    var idx = CN_GRADES.indexOf(t.charAt(0));
    if (idx < 0) {
      var m = t.match(/^(\d+)/);
      if (m) return { num: parseInt(m[1], 10), sem: t.indexOf('下') >= 0 ? '下' : '上' };
      return null;
    }
    return { num: idx + 1, sem: t.indexOf('下') >= 0 ? '下' : '上' };
  }
  function gradeToCn(num, sem) {
    var n = parseInt(num, 10);
    if (!n || n < 1 || n > 6) return '';
    return CN_GRADES[n - 1] + '年级' + (sem === '下' ? '下' : '上');
  }

  // 注入 modal HTML + 基础样式
  function ensureModal() {
    if ($('am-modal')) return;
    var modalCss = '<style id="am-style">' +
      '#am-modal{display:none;position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:99999;align-items:center;justify-content:center;}' +
      '#am-modal.show{display:flex;}' +
      '#am-modal .am-box{background:#fff;border-radius:16px;padding:24px;max-width:520px;width:92vw;max-height:88vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3);}' +
      '#am-modal .am-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}' +
      '#am-modal .am-title{font-size:18px;font-weight:700;color:#1e293b;}' +
      '#am-modal .am-x{background:none;border:none;font-size:22px;color:#94a3b8;cursor:pointer;line-height:1;padding:0 4px;}' +
      '#am-modal .am-x:hover{color:#475569;}' +
      '#am-modal .am-row{display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:8px;}' +
      '#am-modal .am-row .am-name{flex:1;font-weight:600;color:#1e293b;}' +
      '#am-modal .am-row .am-tag{font-size:11px;background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:10px;margin-left:6px;}' +
      '#am-modal .am-row .am-cur{font-size:11px;background:#16a34a;color:#fff;padding:2px 8px;border-radius:10px;}' +
      '#am-modal .am-row .am-act{display:flex;gap:6px;flex-wrap:wrap;}' +
      '#am-modal .am-row .am-act button{background:none;border:1px solid #e2e8f0;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;color:#64748b;transition:all .15s;}' +
      '#am-modal .am-row .am-act button:hover{background:#f1f5f9;border-color:#cbd5e1;color:#1e293b;}' +
      '#am-modal .am-row .am-act .am-del{color:#ef4444;border-color:#fecaca;}' +
      '#am-modal .am-row .am-act .am-del:hover{background:#fef2f2;}' +
      '#am-modal .am-empty{text-align:center;padding:24px;color:#94a3b8;font-size:13px;background:#f8fafc;border-radius:10px;margin-bottom:12px;}' +
      '#am-modal .am-add{border-top:1px solid #e2e8f0;padding-top:14px;}' +
      '#am-modal .am-add p{font-size:13px;color:#64748b;margin-bottom:8px;}' +
      '#am-modal .am-addrow{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}' +
      '#am-modal .am-addrow input,#am-modal .am-addrow select{padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;background:#fff;color:#1e293b;}' +
      '#am-modal .am-addrow input:focus,#am-modal .am-addrow select:focus{border-color:#2563eb;}' +
      '#am-modal .am-addrow .am-name-i{flex:1;min-width:120px;}' +
      '#am-modal .am-addrow .am-addbtn{padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;}' +
      '#am-modal .am-addrow .am-addbtn:hover{background:#1d4ed8;}' +
      '#am-modal.dark .am-box{background:#1e293b;color:#e2e8f0;}' +
      '</style>';
    document.head.insertAdjacentHTML('beforeend', modalCss);

    var modalHtml =
      '<div class="modal-mask" id="am-modal" onclick="if(event.target===this)window.AccountManager.close()">' +
        '<div class="am-box">' +
          '<div class="am-head">' +
            '<span class="am-title">👦 儿童账户管理</span>' +
            '<button class="am-x" type="button" onclick="window.AccountManager.close()" aria-label="关闭">×</button>' +
          '</div>' +
          '<div id="am-rows"></div>' +
          '<div class="am-add">' +
            '<p>＋ 添加儿童账户</p>' +
            '<div class="am-addrow">' +
              '<input class="am-name-i" type="text" id="am-newname" placeholder="姓名">' +
              '<select id="am-newgrade"></select>' +
              '<select id="am-newsem"><option value="上">上</option><option value="下">下</option></select>' +
              '<button class="am-addbtn" type="button" id="am-addbtn">添加</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    $('am-addbtn').onclick = function () { addNew(); };
    // 填年级选项
    var gradeSel = $('am-newgrade');
    for (var n = 1; n <= 6; n++) {
      gradeSel.options.add(new Option(CN_GRADES[n-1] + '年级', String(n)));
    }
    gradeSel.value = '1';
  }

  function renderRows() {
    var list = getList();
    var cur = getCurrent();
    var rows = $('am-rows');
    if (!rows) return;
    if (list.length === 0) {
      rows.innerHTML = '<div class="am-empty">还没有儿童账户，点下方「＋ 添加」创建第一个吧 👶</div>';
      return;
    }
    rows.innerHTML = list.map(function (n) {
      var g = getGrade(n);
      var gradeTag = g ? '<span class="am-tag">📘 ' + esc(g) + '</span>' : '';
      var isCur = n === cur;
      return '<div class="am-row">' +
        '<span class="am-name">' + esc(n) + '</span>' + gradeTag +
        (isCur ? '<span class="am-cur">当前</span>' : '') +
        '<span class="am-act">' +
          '<button data-grade="' + esc(n) + '" title="修改年级" style="cursor:pointer;">📘</button>' +
          (isCur ? '' : '<button data-switch="' + esc(n) + '" title="切换为当前" style="cursor:pointer;">切换</button>') +
          '<button data-del="' + esc(n) + '" class="am-del" title="删除学员" style="cursor:pointer;">🗑</button>' +
        '</span></div>';
    }).join('');
    rows.querySelectorAll('[data-grade]').forEach(function (b) {
      b.onclick = function () { editGrade(b.getAttribute('data-grade')); };
    });
    rows.querySelectorAll('[data-switch]').forEach(function (b) {
      b.onclick = function () { switchTo(b.getAttribute('data-switch')); };
    });
    rows.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () { delAccount(b.getAttribute('data-del')); };
    });
  }

  function addNew() {
    var name = (($('am-newname') || {}).value || '').trim();
    var num = ($('am-newgrade') || {}).value;
    var sem = ($('am-newsem') || {}).value;
    if (!name) { alert('请输入姓名'); return; }
    var list = getList();
    if (list.indexOf(name) >= 0) { alert('已有同名账户'); return; }
    list.push(name);
    saveList(list);
    if (num) setGrade(name, gradeToCn(num, sem || '上'));
    if (!getCurrent()) setCurrent(name);
    if ($('am-newname')) $('am-newname').value = '';
    renderRows();
    fireSidebarUpdate();
  }

  function delAccount(name) {
    if (!confirm('确定删除学员「' + name + '」？此操作不可恢复。')) return;
    var list = getList().filter(function (x) { return x !== name; });
    saveList(list);
    setGrade(name, '');
    if (getCurrent() === name) setCurrent(list[0] || '');
    renderRows();
    fireSidebarUpdate();
  }

  function switchTo(name) {
    setCurrent(name);
    renderRows();
    fireSidebarUpdate();
  }

  function editGrade(name) {
    var cur = getGrade(name);
    var g = prompt('学员「' + name + '」当前年级：' + (cur || '（未设置）') +
      '\n输入新年级（格式：一年级上 / 二年级下 / 三年级上 ...）：', cur || '三年级上');
    if (g === null) return;
    g = String(g).trim();
    var m = cnToGrade(g);
    if (!m) { alert('格式不正确，请按「三年级上」格式输入'); return; }
    setGrade(name, gradeToCn(m.num, m.sem));
    renderRows();
    fireSidebarUpdate();
  }

  function open() {
    ensureModal();
    renderRows();
    var m = $('am-modal');
    if (m) m.classList.add('show');
  }
  function close() {
    var m = $('am-modal');
    if (m) m.classList.remove('show');
  }

  // 同步顶栏账号名 + 跨标签页 storage 自动通知其它 tab
  function fireSidebarUpdate() {
    var acc = getCurrent();
    var accEl = document.getElementById('sidebarAccount');
    if (accEl) accEl.textContent = acc || '未选择';
    // 其它标签页通过 storage 事件自动同步（同源 localStorage）
  }

  window.AccountManager = {
    open: open,
    close: close,
    add: addNew,
    switchTo: switchTo,
    deleteAccount: delAccount,
    editGrade: editGrade,
    getList: getList,
    getCurrent: getCurrent,
    getGrade: getGrade
  };
})();
