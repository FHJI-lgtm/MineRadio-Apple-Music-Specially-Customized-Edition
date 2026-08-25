// ============================================================
// lyrics-source-window.js — 歌词源搜索顺序窗口 renderer (独立窗口专用)
// 只负责: 显示搜索顺序 / 拖拽排序 / 上报新顺序。真实状态在主窗口 renderer。
// 拖拽完成后立即保存 (无保存按钮)。
// ============================================================
(function () {
  var OPTIONS = [
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
      OPTIONS.forEach(function (o) { if (known.indexOf(o.id) < 0) known.push(o.id); });
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
      researchBtn.textContent = '重新搜索';
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
