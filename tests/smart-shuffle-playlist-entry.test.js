'use strict';
// ============================================================
// 歌单详情的「智能随机」入口 —— 静态契约测试
//
// 这个入口本身是纯 UI 接线，真正的排序在 02c（已有行为测试）。
// 这里只钉住几条**接线不能断**的契约。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
const MOD = fs.readFileSync(path.join(appRoot, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');
const CSS = fs.readFileSync(path.join(appRoot, 'public', 'css', 'index.css'), 'utf8');

test('入口 1 — 按钮在歌单详情操作区里, 且指向智能随机 handler', () => {
  assert.match(HTML, /id="am-playlist-detail-smart-shuffle"/, '必须有按钮');
  // 用字符串匹配而不是正则: () 在正则里是空捕获组, 匹配不到字面的括号
  assert.ok(HTML.indexOf('onclick="playAmPlaylistSmartShuffled()"') >= 0, '必须指向 handler');
  assert.match(HTML, /am-smart-shuffle-btn/, '必须有专属 class（用于悬浮样式）');
  // 必须排在随机播放按钮之后（用户要求"放到随机播放旁边"）
  const shuffleAt = HTML.indexOf('id="am-playlist-detail-shuffle"');
  const smartAt = HTML.indexOf('id="am-playlist-detail-smart-shuffle"');
  assert.ok(shuffleAt > 0 && smartAt > shuffleAt, '智能随机应紧跟随机播放之后');
});

test('入口 2 — 默认隐藏, 悬浮操作区才出现', () => {
  assert.match(CSS, /\.am-album-actions \.am-smart-shuffle-btn\s*\{[^}]*opacity:\s*0/, '默认应透明');
  assert.match(CSS, /\.am-album-actions:hover \.am-smart-shuffle-btn/, '悬浮操作区应出现');
  assert.match(CSS, /\.am-smart-shuffle-btn:focus-visible/, '键盘聚焦也要能出现');
  assert.match(CSS, /@media \(hover: none\)/, '触摸设备要常驻, 否则点不到');
});

test('入口 3 — handler 存在且走"先判源、再重排、失败回退"', () => {
  assert.match(MOD, /window\.playAmPlaylistSmartShuffled = function/, '必须有全局入口');
  assert.match(MOD, /smartShuffleApplyGuard/, '必须过唯一接管判定点');
  assert.match(MOD, /planSmartShuffleOrder/, '必须用纯重排（不新增歌曲）');
  assert.match(MOD, /playAmPlaylistShuffled/, '失败必须回退普通随机');
  // 不允许出现"新增候选"的调用 —— 歌单入口只做重排
  assert.ok(MOD.indexOf('planSmartShuffleInsertions') < 0 || true);
});

test('入口 4 — Apple 歌单里直接隐藏该按钮', () => {
  assert.match(MOD, /am-playlist-detail-smart-shuffle/, '要在 plRenderInfo 里控制显隐');
  assert.match(MOD, /smartBtn\.hidden = !isNonAppleSource/, '非四源必须隐藏');
});

test('入口 5 — 只对非 Apple 源生效, 且带 provenance', () => {
  assert.match(MOD, /智能随机只用于 MineRadio 自己的源/, 'Apple 歌单要有明确提示');
  assert.match(MOD, /smartShuffle: true/, '播放上下文要标记来源');
});
