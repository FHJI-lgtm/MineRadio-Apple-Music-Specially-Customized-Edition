'use strict';
// ============================================================
// 搜索框旁的 Smart Shuffle 开关 —— 测试
// 运行: node tests/smart-shuffle-toggle.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const playbackDir = path.join(appRoot, 'public', 'js', 'modules', '05-playback');
const shellDir = path.join(appRoot, 'public', 'js', 'modules', '10-shell');

function makeEl(id) {
  const cls = {};
  return {
    id,
    textContent: '',
    title: '',
    classList: {
      add: (c) => { cls[c] = true; },
      remove: (c) => { delete cls[c]; },
      contains: (c) => !!cls[c],
      _all: cls,
    },
  };
}

function makeSandbox() {
  const store = {};
  const elements = {};
  const toasts = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Array, Object, String, Number, Boolean, Date, RegExp, Error, Promise,
    isFinite, isNaN, parseInt, parseFloat, Infinity,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.queueItemKey = (song) => String((song && (song.key || song.id)) || '');
  sandbox.document = { getElementById: (id) => elements[id] || (elements[id] = makeEl(id)) };
  sandbox.showToast = (msg) => { toasts.push(String(msg)); };
  sandbox.__elements = elements;
  sandbox.__toasts = toasts;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(playbackDir, '02b-play-events.js'), 'utf8'), ctx, { filename: '02b' });
  vm.runInContext(fs.readFileSync(path.join(playbackDir, '02c-shuffle-score.js'), 'utf8'), ctx, { filename: '02c' });
  vm.runInContext(fs.readFileSync(path.join(shellDir, '08-smart-shuffle-toggle.js'), 'utf8'), ctx, { filename: '08-smart-shuffle-toggle.js' });
  return sandbox;
}

test('TEST 1 — 默认关闭: 标签为 SS, 无开启态', () => {
  const sb = makeSandbox();
  sb.renderSmartShuffleToggle();
  const btn = sb.__elements['smart-shuffle-btn'];
  const label = sb.__elements['smart-shuffle-label'];
  assert.strictEqual(sb.shuffleMode(), 'off');
  assert.strictEqual(label.textContent, 'SS');
  assert.strictEqual(btn.classList.contains('ss-on'), false);
  assert.ok(/关闭/.test(btn.title), 'title=' + btn.title);
});

test('TEST 2 — 点击开启影子模式, 并写进配置', () => {
  const sb = makeSandbox();
  sb.cycleSmartShuffleMode();
  assert.strictEqual(sb.shuffleMode(), 'shadow', '必须真的写入配置');
  const btn = sb.__elements['smart-shuffle-btn'];
  assert.strictEqual(btn.classList.contains('ss-on'), true);
  assert.ok(/影子模式/.test(btn.title), 'title=' + btn.title);
});

test('TEST 3 — 标签直接显示已采集条数(一眼看出有没有在收)', () => {
  const sb = makeSandbox();
  sb.cycleSmartShuffleMode();          // 开
  sb.playEventRecord({ type: 'play', key: 'k1' });
  sb.playEventRecord({ type: 'play', key: 'k2' });
  sb.playEventRecord({ type: 'seek', key: 'k1' });
  sb.renderSmartShuffleToggle();
  const label = sb.__elements['smart-shuffle-label'];
  assert.strictEqual(label.textContent, 'SS 3', 'label=' + label.textContent);
  assert.ok(/已采集 3 条/.test(sb.__elements['smart-shuffle-btn'].title));
});

test('TEST 4 — 再点一次关回去, 且标签退回 SS', () => {
  const sb = makeSandbox();
  sb.cycleSmartShuffleMode();
  assert.strictEqual(sb.shuffleMode(), 'shadow');
  sb.cycleSmartShuffleMode();
  assert.strictEqual(sb.shuffleMode(), 'off');
  assert.strictEqual(sb.__elements['smart-shuffle-label'].textContent, 'SS');
});

test('TEST 5 — 点开时有 toast 反馈, 且不抛异常', () => {
  const sb = makeSandbox();
  assert.doesNotThrow(() => sb.cycleSmartShuffleMode());
  assert.strictEqual(sb.__toasts.length, 1);
  assert.ok(/影子模式已开启/.test(sb.__toasts[0]), 'toast=' + sb.__toasts[0]);
});
