// ============================================================
// lyrics-source-window.js — 歌词源搜索顺序窗口 renderer (独立窗口专用)
//
// 排序部分: 显示搜索顺序 / 拖拽排序 / 上报新顺序 / 触发重新搜索。
//   真实状态在主窗口 renderer; 拖拽完成后立即保存 (无保存按钮)。
// 凭证部分: Apple Music 歌词的可选 Web 凭证 (media-user-token) 的
//   状态显示 / 导入 / 删除。只显示"是否已配置", 永不显示 token 明文,
//   不发起任何网络请求。
//   Apple Music 本地缓存歌词路径 (官方歌词缓存) 不需要任何凭证, 保持原样。
// ============================================================
(function () {
  // 四个歌词源同级 (顺序完全由用户拖拽决定; 数组顺序仅用于"缺失源"的插入位置)
  var OPTIONS = [
    { id: 'apple', name: 'Apple Music' },
    { id: 'qq', name: 'QQ音乐' },
    { id: 'kugou', name: '酷狗音乐' },
    { id: 'netease', name: '网易云音乐' },
  ];
  var OPTIONS_BY_ID = {};
  OPTIONS.forEach(function (o) { OPTIONS_BY_ID[o.id] = o; });
  var currentOrder = [];
  var dragId = '';

  function render() {
    var list = document.getElementById('list');
    if (!list) return;
    list.innerHTML = '';
    currentOrder.forEach(function (id) {
      var opt = OPTIONS_BY_ID[id];
      if (!opt) return;
      var row = document.createElement('div');
      row.className = 'row';
      row.draggable = true;
      row.setAttribute('data-id', id);
      var handle = document.createElement('span');
      handle.className = 'handle';
      handle.textContent = '☰';
      var label = document.createElement('span');
      label.textContent = opt.name;
      row.appendChild(handle);
      row.appendChild(label);
      row.addEventListener('dragstart', function (e) {
        dragId = id;
        row.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch (err) {}
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('dragging');
        dragId = '';
        reportOrder();   // 兜底: 松开后保存
      });
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', function () {
        row.classList.remove('drag-over');
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        row.classList.remove('drag-over');
        var fromId = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        var toId = id;
        if (!fromId || fromId === toId) return;
        var from = currentOrder.indexOf(fromId);
        var to = currentOrder.indexOf(toId);
        if (from < 0 || to < 0) return;
        currentOrder.splice(from, 1);
        currentOrder.splice(to, 0, fromId);
        render();
        reportOrder();   // 立即保存
      });
      list.appendChild(row);
    });
  }

  function reportOrder() {
    if (window.lyricsSource && typeof window.lyricsSource.reportOrder === 'function') {
      window.lyricsSource.reportOrder(currentOrder.slice());
    }
  }

  function closeWin() {
    if (window.lyricsSource && typeof window.lyricsSource.closeWindow === 'function') {
      window.lyricsSource.closeWindow();
    }
  }

  if (window.lyricsSource && typeof window.lyricsSource.onState === 'function') {
    window.lyricsSource.onState(function (state) {
      var order = state && Array.isArray(state.order) ? state.order : [];
      var known = order.filter(function (id) { return OPTIONS_BY_ID[id]; });
      // 缺失的源按 OPTIONS 中的相对位置插入 (而不是一律追加末尾), 保证四源同级
      OPTIONS.forEach(function (o, idx) {
        if (known.indexOf(o.id) >= 0) return;
        var insertAt = known.length;
        for (var n = idx + 1; n < OPTIONS.length; n++) {
          var pos = known.indexOf(OPTIONS[n].id);
          if (pos >= 0 && pos < insertAt) insertAt = pos;
        }
        known.splice(insertAt, 0, o.id);
      });
      currentOrder = known;
      render();
    });
  }
  var closeBtn = document.getElementById('close');
  if (closeBtn) closeBtn.addEventListener('click', closeWin);
  var doneBtn = document.getElementById('done');
  if (doneBtn) doneBtn.addEventListener('click', closeWin);

  // ---- [重新搜索] 按钮: 按当前排序强制重搜当前歌曲 (绕过缓存) ----
  var researchBtn = document.getElementById('research');
  if (researchBtn) {
    var researchTimer = 0;
    function researchReset() {
      researchBtn.disabled = false;
      researchBtn.textContent = '重新搜索歌词';
    }
    researchBtn.addEventListener('click', function () {
      if (researchBtn.disabled) return;
      researchBtn.disabled = true;
      researchBtn.textContent = '搜索中…';
      if (window.lyricsSource && typeof window.lyricsSource.reSearch === 'function') {
        window.lyricsSource.reSearch();
      }
      // 超时兜底: 主窗口完成会通过 onReSearchDone 提前恢复
      if (researchTimer) clearTimeout(researchTimer);
      researchTimer = setTimeout(researchReset, 10000);
    });
    if (window.lyricsSource && typeof window.lyricsSource.onReSearchDone === 'function') {
      window.lyricsSource.onReSearchDone(function () {
        if (researchTimer) clearTimeout(researchTimer);
        researchTimer = 0;
        researchReset();
      });
    }
  }

  render();
})();

// ============================================================
// Apple Music 歌词凭证 (media-user-token) UI
//   只做: 状态显示 / 导入弹窗 / 保存 / 删除。
//   渲染进程永远拿不到 token 明文: 已配置时只显示掩码。
//   "验证并保存" 只做非空 + 基本格式检查, 不发起任何 Apple Music 请求。
// ============================================================
(function () {
  var api = window.appleMusicLyricsCredential;

  var stateEl = document.getElementById('cred-state');
  var importBtn = document.getElementById('cred-import');
  var loginBtn = document.getElementById('cred-login');
  var loginRow = document.getElementById('cred-login-row');
  var loginModalBtn = document.getElementById('cred-login-modal');
  var modalTitleEl = document.getElementById('cred-modal-title');
  var modalBodyEl = document.getElementById('cred-modal-body');
  var clearBtn = document.getElementById('cred-clear');
  var modal = document.getElementById('cred-modal');
  var input = document.getElementById('cred-input');
  var tipEl = document.getElementById('cred-tip');
  var saveBtn = document.getElementById('cred-save');
  var cancelBtn = document.getElementById('cred-cancel');
  if (!stateEl || !importBtn || !modal || !input) return;

  var DEFAULT_TIP = 'Token 仅保存在本机，不会显示完整内容，也不会写入日志。';
  var credentialConfigured = false;
  var ERROR_TEXT = {
    EMPTY_TOKEN: '请先粘贴 media-user-token。',
    TOKEN_TOO_SHORT: '这个值太短，看起来不是完整的 media-user-token。',
    TOKEN_TOO_LONG: '这个值过长，请确认只粘贴了 media-user-token 本身。',
    TOKEN_SHAPE: '格式不正确：media-user-token 不含空格或换行，请重新复制。',
    WRITE_FAILED: '保存失败，请重试。',
    CLEAR_FAILED: '删除失败，请重试。',
    UNTRUSTED_SENDER: '调用被拒绝。'
  };

  function setTip(text, isError) {
    if (!tipEl) return;
    tipEl.textContent = text || '';
    tipEl.className = 'modal-tip' + (isError ? ' error' : '');
  }

  function setBusy(busy) {
    if (saveBtn) saveBtn.disabled = !!busy;
    if (cancelBtn) cancelBtn.disabled = !!busy;
    importBtn.disabled = !!busy;
    if (loginBtn) loginBtn.disabled = !!busy;
    if (loginModalBtn) loginModalBtn.disabled = !!busy;
    if (clearBtn) clearBtn.disabled = !!busy;
  }

  // 只显示"是否已配置"; 不写入、不显示 token 本身。
  function renderStatus(status) {
    var configured = !!(status && status.configured);
    stateEl.textContent = configured
      ? '已配置 · Token：●●●●●●●●'
      : '未配置 Apple Music 歌词凭证';
    stateEl.className = 'cred-state' + (configured ? ' configured' : '');
    credentialConfigured = configured;
    importBtn.textContent = configured ? '重新获取 Token' : '手动导入 Token';
    // 已获取 token 时内联不再显示"登录获取"入口: 需要重新登录获取时走"重新获取"弹窗。
    if (loginRow) loginRow.hidden = configured;
    else if (loginBtn) loginBtn.hidden = configured;
    if (clearBtn) clearBtn.hidden = !configured;
  }

  function refreshStatus() {
    if (!api || typeof api.getStatus !== 'function') {
      renderStatus({ configured: false });
      return Promise.resolve();
    }
    return Promise.resolve(api.getStatus()).then(function (res) {
      renderStatus(res || {});
    }).catch(function () {
      renderStatus({ configured: false });
    });
  }

  function openModal() {
    if (modalTitleEl) modalTitleEl.textContent = credentialConfigured ? '重新获取 Apple Music 歌词凭证' : '导入 Apple Music 歌词凭证';
    input.value = '';
    setTip(DEFAULT_TIP, false);
    setBusy(false);
    modal.hidden = false;
    // 弹窗内容可能比窗口高: 每次打开回到顶部, 保证"登录获取/重新获取"入口可见
    if (modalBodyEl) modalBodyEl.scrollTop = 0;
    // 未配置(手动导入入口)时才聚焦粘贴框; 已配置(重新获取)时聚焦会把顶部入口滚出可视区
    if (!credentialConfigured) { try { input.focus(); } catch (err) {} }
  }

  function closeModal() {
    modal.hidden = true;
    // 关闭即清空输入框, 避免令牌明文残留在 DOM 里
    input.value = '';
    setTip(DEFAULT_TIP, false);
    setBusy(false);
  }

  function save() {
    if (!api || typeof api.set !== 'function') return;
    var token = String(input.value || '').trim();
    if (!token) {
      setTip(ERROR_TEXT.EMPTY_TOKEN, true);
      return;
    }
    setBusy(true);
    setTip('保存中…', false);
    Promise.resolve(api.set(token)).then(function (res) {
      // 无论成功与否, 立刻清掉输入框里的明文
      input.value = '';
      if (res && res.ok) {
        closeModal();
        return refreshStatus();
      }
      setBusy(false);
      var code = res && res.error;
      setTip(ERROR_TEXT[code] || '保存失败，请检查后重试。', true);
      return null;
    }).catch(function () {
      input.value = '';
      setBusy(false);
      setTip('保存失败，请重试。', true);
    });
  }

  function clearCredential() {
    if (!api || typeof api.clear !== 'function') return;
    if (!window.confirm('确定要删除已保存的 Apple Music 歌词凭证吗？')) return;
    setBusy(true);
    Promise.resolve(api.clear()).then(function () {
      setBusy(false);
      return refreshStatus();
    }).catch(function () {
      setBusy(false);
    });
  }

  // ---- [登录 Apple Music 获取 Token]: 复用主进程 Apple Music Web 登录窗口 ----
  // 主进程只回状态字段 (ok / configured / reused / error / message), 永不回传 token;
  // 这里也绝不打印 token, 只展示固定文案。
  var LOGIN_ERROR_TEXT = {
    EMPTY_TOKEN: '未能获取 Token，请重试或使用手动导入。',
    TOKEN_TOO_SHORT: '未检测到有效登录令牌，请重试或使用手动导入。',
    TOKEN_TOO_LONG: '未检测到有效登录令牌，请重试或使用手动导入。',
    TOKEN_SHAPE: '未检测到有效登录令牌，请重试或使用手动导入。',
    WRITE_FAILED: 'Token 保存失败，请重试。',
    LOGIN_TIMEOUT: '登录超时，请重试。',
    LOGIN_WINDOW_CLOSED: '登录窗口已关闭，未检测到登录态。',
    LOGIN_PAGE_FAILED: 'Apple Music 登录页打开失败，请检查网络后重试。',
    TOKEN_REJECTED: '未能识别登录令牌，请重试或使用手动导入 Token。',
    UNTRUSTED_SENDER: '调用被拒绝。',
  };
  function loginWithAppleMusic(fromModal) {
    if (!api || typeof api.loginWithAppleMusic !== 'function') {
      setTip('当前版本不支持自动获取，请使用手动导入 Token。', true);
      return;
    }
    setBusy(true);
    setTip('请在打开的 Apple Music 登录窗口完成登录…', false);
    Promise.resolve(api.loginWithAppleMusic()).then(function (res) {
      setBusy(false);
      if (res && res.ok) {
        if (fromModal) closeModal();
        setTip('已获取并保存 Token。', false);
        return refreshStatus();
      }
      var code = res && res.error;
      setTip(LOGIN_ERROR_TEXT[code] || '未能获取 Token，请重试或使用手动导入 Token。', true);
      return null;
    }).catch(function () {
      setBusy(false);
      setTip('未能获取 Token，请重试或使用手动导入 Token。', true);
    });
  }
  if (loginBtn) loginBtn.addEventListener('click', function () { loginWithAppleMusic(false); });
  if (loginModalBtn) loginModalBtn.addEventListener('click', function () { loginWithAppleMusic(true); });

  importBtn.addEventListener('click', openModal);
  if (clearBtn) clearBtn.addEventListener('click', clearCredential);
  if (saveBtn) saveBtn.addEventListener('click', save);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  // 点击遮罩空白处关闭
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (modal.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    else if (e.key === 'Enter') { e.preventDefault(); save(); }
  });

  refreshStatus();
})();
