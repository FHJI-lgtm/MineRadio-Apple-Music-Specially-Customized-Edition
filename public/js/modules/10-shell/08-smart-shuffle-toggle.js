// ============================================================
// 10-shell/08-smart-shuffle-toggle.js
// 搜索框旁边的 Smart Shuffle 开关（开发期用）。
//
//   点击 : off <-> shadow 来回切（'on' 尚未接线, 所以不给点）
//   标签 : 直接显示**已采集事件条数** —— 一眼看出到底有没有在收
//   标题 : 悬停显示详细状态
//
// 只写 mineradio-smart-shuffle-v1 这一个配置键, 不碰播放链路。
// ============================================================
var smartShuffleToggleTimer = 0;

function smartShuffleToggleEventCount() {
  try {
    if (typeof playEventsTotalRecorded === 'function') return Number(playEventsTotalRecorded()) || 0;
    if (typeof playEventCount === 'function') return Number(playEventCount()) || 0;
  } catch (e) { }
  return 0;
}

function smartShuffleToggleMode() {
  try { return typeof shuffleMode === 'function' ? shuffleMode() : 'off'; } catch (e) { return 'off'; }
}

function renderSmartShuffleToggle() {
  try {
    var btn = document.getElementById('smart-shuffle-btn');
    if (!btn) return;
    var label = document.getElementById('smart-shuffle-label');
    var mode = smartShuffleToggleMode();
    var count = smartShuffleToggleEventCount();
    var on = mode === 'shadow';
    if (btn.classList) {
      if (on) { btn.classList.add('ss-on'); btn.classList.add('active'); }
      else { btn.classList.remove('ss-on'); btn.classList.remove('active'); }
    }
    if (label) label.textContent = on ? ('SS ' + count) : 'SS';
    btn.title = on
      ? ('Smart Shuffle 影子模式 · 已采集 ' + count + ' 条事件（点击关闭）')
      : 'Smart Shuffle 关闭（点击开启影子模式：只记录，不干预播放）';
  } catch (e) { }
}

function refreshSmartShuffleToggleCount() {
  if (typeof playEventsRebuildAggregate !== 'function') return;
  Promise.resolve().then(function () { return playEventsRebuildAggregate(); })
    .then(function () { renderSmartShuffleToggle(); }, function () { });
}

function cycleSmartShuffleMode(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  var next = smartShuffleToggleMode() === 'shadow' ? 'off' : 'shadow';
  try {
    if (typeof writeShuffleConfig === 'function') writeShuffleConfig({ mode: next });
  } catch (e) { }

  if (next === 'shadow') {
    // 打开后立刻推演一次, 这样即使不开 DevTools 也能马上产生一条决策
    if (typeof smartShuffleShadowProbe === 'function') {
      try { smartShuffleShadowProbe('toggle-on'); } catch (e) { }
    }
    refreshSmartShuffleToggleCount();
  }
  renderSmartShuffleToggle();
  if (typeof showToast === 'function') {
    showToast(next === 'shadow'
      ? ('Smart Shuffle 影子模式已开启 · 已采集 ' + smartShuffleToggleEventCount() + ' 条')
      : 'Smart Shuffle 已关闭');
  }
}

function startSmartShuffleToggle() {
  renderSmartShuffleToggle();
  if (!smartShuffleToggleTimer) {
    smartShuffleToggleTimer = setInterval(renderSmartShuffleToggle, 3000);
  }
  // 启动时从 IndexedDB 重建一次总数(跨会话的真实条数)
  refreshSmartShuffleToggleCount();
}

startSmartShuffleToggle();
