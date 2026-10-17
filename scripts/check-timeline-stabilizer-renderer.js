#!/usr/bin/env node
'use strict';
// ============================================================
// Timeline Stabilizer Plus —— 真实渲染进程 / 真实 QPC 时钟验证
//
// 在隐藏的 Electron 窗口里加载真正的 public/index.html（index-loader 会把
// 12-smtc/08-timeline-stabilizer-plus.js 与其它 117 个模块拼成一个脚本执行），
// 然后直接驱动真实的 smtcApplyBridgeState()，用真实 performance.now()
// （Windows 上由 QueryPerformanceCounter 支撑）检查：
//
//   1. 模块在真实渲染进程里加载成功，且默认走 TSP 路径（非 legacy）
//   2. 正常播放：Stable Position 单调、按 1x 推进、无跳变
//   3. 单次 +800ms 异常：不污染时间轴（真实时钟 + 真实定时器）
//   4. 50ms 粒度连续性 / 暂停不得增长 / 恢复重新锚定
//   5. 歌词·进度条共用的 smtcPositionSecondsNow() 与 stablePosition 一致
//   6. A/B：smtcTspSetMode('legacy') 能切回 v4，('tsp') 能切回 Plus
//
// 运行（两种都行）：
//   node scripts/check-timeline-stabilizer-renderer.js
//   node_modules\electron\dist\electron.exe scripts/check-timeline-stabilizer-renderer.js
// ============================================================
const path = require('node:path');

const isElectronRuntime = !!(process.versions && process.versions.electron);
if (!isElectronRuntime) {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) {
    console.error('[FAIL] Electron executable not found: ' + exe);
    process.exit(1);
  }
  // DSH/CI 环境可能带 ELECTRON_RUN_AS_NODE，会让 electron 退化成纯 node（拿不到 app）。
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(exe, [__filename], { stdio: 'inherit', env: env });
  process.exit(child.status === null ? 1 : child.status);
}

const { app, BrowserWindow } = require('electron');
if (!app || !BrowserWindow) {
  console.error('[FAIL] Electron app API unavailable (ELECTRON_RUN_AS_NODE set?). Unset it and retry.');
  process.exit(1);
}

// 这段函数源码会被序列化后注入渲染进程执行（因此只用页面里的全局函数）。
async function pageCheck() {
  const failures = [];
  const notes = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = () => smtcTspSnapshot();
  const stable = () => smtcStablePositionMsNow();

  // ---- 1. 模块在真实渲染进程里加载 ----
  if (typeof smtcTspSnapshot !== 'function') failures.push('TSP module not loaded in renderer');
  if (typeof tspQpcNow !== 'function') failures.push('tspQpcNow missing');
  if (typeof smtcStablePositionMsNow !== 'function') failures.push('smtcStablePositionMsNow missing');
  if (typeof updatePlaybackProgressUi !== 'function') failures.push('progress UI function missing');
  const mode0 = snap().mode;
  if (mode0 !== 'tsp') failures.push('default timeline mode is not tsp: ' + mode0);
  const q1 = tspQpcNow();
  await sleep(30);
  const q2 = tspQpcNow();
  if (!(q2 > q1)) failures.push('performance.now()/QPC is not advancing: ' + q1 + ' -> ' + q2);
  notes.push('clock=' + snap().clockSource + ' qpcDelta=' + (q2 - q1).toFixed(2) + 'ms');

  // ---- 2. 正常播放 + 单次 +800ms 异常（真实 1s 定时器）----
  const DUR = 240000;
  const push = (pos, extra) => smtcApplyBridgeState(Object.assign({
    active: true, bridgeReady: true, isPlaying: true, durationMs: DUR,
    positionMs: pos, title: 'QA Song', artist: 'QA Artist', album: 'QA Album',
    aumid: 'AppleInc.AppleMusicWin!App', lastUpdatedMs: Date.now(),
  }, extra || {}));
  push(38000);
  const samples = [stable()];
  const actions = [];
  for (let i = 1; i <= 6; i += 1) {
    await sleep(1000);
    const glitch = i === 3 ? 800 : 0;                 // 第 3 拍注入单次 +800ms
    push(38000 + i * 1000 + glitch);
    samples.push(stable());
    actions.push(snap().lastAction);
  }
  for (let i = 1; i < samples.length; i += 1) {
    const d = samples[i] - samples[i - 1];
    if (samples[i] < samples[i - 1] - 0.001) failures.push('stable went backwards at ' + i + ': ' + d.toFixed(1));
    if (d > 1500) failures.push('visible jump at ' + i + ': ' + d.toFixed(1) + 'ms');
  }
  const totalAdvance = samples[samples.length - 1] - samples[0];
  if (totalAdvance < 5000 || totalAdvance > 7000) {
    failures.push('real-time advance out of range: ' + totalAdvance.toFixed(1) + 'ms');
  }
  if (actions.some((a) => a === 'confirmed-seek' || a === 'repeat-restart')) {
    failures.push('single glitch was treated as a seek: ' + actions.join(','));
  }
  notes.push('actions=' + actions.join(','));
  notes.push('rate=' + snap().correctionRate.toFixed(4));
  if (snap().anchorResets !== 1) failures.push('unexpected anchor resets: ' + snap().anchorResets);

  // ---- 3. 50ms 粒度连续性（真实 QPC + 真实定时器）----
  const fine = [];
  for (let i = 0; i < 20; i += 1) { fine.push(stable()); await sleep(50); }
  let maxStep = 0;
  for (let i = 1; i < fine.length; i += 1) {
    const d = fine[i] - fine[i - 1];
    if (d < -0.001) failures.push('fine-grained backwards step at ' + i + ': ' + d.toFixed(2));
    if (d > maxStep) maxStep = d;
  }
  if (maxStep > 70) failures.push('fine-grained jump: ' + maxStep.toFixed(1) + 'ms');
  notes.push('maxStep50ms=' + maxStep.toFixed(1) + 'ms');

  // ---- 4. 下游统一时间源一致 ----
  const secs = smtcPositionSecondsNow();
  const stableMs = stable();
  if (Math.abs(secs * 1000 - stableMs) > 2) {
    failures.push('smtcPositionSecondsNow() diverged from stable: ' + (secs * 1000) + ' vs ' + stableMs);
  }
  const safeT = (typeof safeAudioTime === 'function') ? safeAudioTime() : null;
  if (safeT == null || Math.abs(safeT * 1000 - stableMs) > 2) {
    failures.push('safeAudioTime() not following stable timeline: ' + safeT);
  }

  // ---- 5. 暂停 / 恢复（真实时间）----
  push(Math.round(stable()), { isPlaying: false, status: 'Paused' });
  const pausedA = stable();
  await sleep(1200);
  const pausedB = stable();
  if (Math.abs(pausedB - pausedA) > 0.001) failures.push('timeline advanced while paused: ' + (pausedB - pausedA).toFixed(1));
  push(158000, { isPlaying: true, status: 'Playing' });
  const resumed = stable();
  if (Math.abs(resumed - 158000) > 1500) failures.push('resume did not re-anchor to SMTC position: ' + resumed);

  // ---- 6. A/B 回退 ----
  smtcTspSetMode('legacy');
  if (tspIsTimelineActive()) failures.push('legacy mode still active');
  const legacyPos = smtcStablePositionMsNow();
  if (!(legacyPos > 0)) failures.push('legacy path produced no position: ' + legacyPos);
  if (typeof smtcStore !== 'object' || !(smtcStore.positionMs > 0)) failures.push('legacy smtcStore.positionMs missing');
  smtcTspSetMode('tsp');
  if (!tspIsTimelineActive()) failures.push('tsp mode did not reactivate');

  let tspLogs = [];
  try { tspLogs = smtcTspDump().split('\n').slice(-6); } catch (e) { }
  return {
    ok: failures.length === 0,
    failures: failures,
    notes: notes,
    samples: samples.map((v) => Math.round(v)),
    snapshot: snap(),
    tspLogs: tspLogs,
  };
}

const logs = [];

function finish(code, payload) {
  console.log('MINERADIO_TSP_RESULT:' + JSON.stringify(payload));
  setTimeout(() => app.exit(code), 80);
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 600, show: false, frame: false, transparent: true,
    skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: false, nodeIntegration: false,
      backgroundThrottling: false, offscreen: true,
    },
  });
  win.webContents.on('console-message', (_event, details) => {
    logs.push(String((details && details.message) || '').slice(0, 260));
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    finish(1, { ok: false, reason: 'render-process-gone', details: details, rendererLogs: logs.slice(-12) });
  });
  await win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500));
  let result = null;
  try {
    result = await win.webContents.executeJavaScript('(' + pageCheck.toString() + ')()');
  } catch (error) {
    finish(1, { ok: false, reason: 'executeJavaScript failed', message: String(error && error.message || error), rendererLogs: logs.slice(-12) });
    return;
  }
  const payload = Object.assign({}, result, { rendererLogs: logs.slice(-12) });
  console.log('=== Timeline Stabilizer Plus · real renderer check ===');
  console.log('ok        : ' + payload.ok);
  console.log('samples   : ' + JSON.stringify(payload.samples));
  console.log('notes     : ' + JSON.stringify(payload.notes));
  console.log('snapshot  : ' + JSON.stringify(payload.snapshot));
  if (payload.failures && payload.failures.length) console.log('failures  : ' + JSON.stringify(payload.failures, null, 1));
  if (payload.tspLogs && payload.tspLogs.length) console.log('tsp logs  :' + String.fromCharCode(10) + payload.tspLogs.join(String.fromCharCode(10)));
  finish(payload.ok === true ? 0 : 1, payload);
}).catch((err) => {
  finish(1, { ok: false, reason: 'exception', message: String(err && err.message || err), rendererLogs: logs.slice(-12) });
});
