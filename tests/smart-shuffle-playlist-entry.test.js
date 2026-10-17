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
const CTRL = fs.readFileSync(
  path.join(appRoot, 'public', 'js', 'modules', '05-playback', '14-player-controls.js'), 'utf8');

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

test('入口 3 — 语义是「歌单先随机 + 再插歌」, 不是纯重排', () => {
  assert.match(MOD, /window\.playAmPlaylistSmartShuffled = function/, '必须有全局入口');
  assert.match(MOD, /smartShuffleApplyGuard/, '必须过唯一接管判定点');
  assert.match(MOD, /smartShuffleFetchPool/, '必须拉候选池');
  assert.match(MOD, /planSmartShuffleInsertions/, '必须用「追加」而不是纯重排');

  const handlerStart = MOD.indexOf('window.playAmPlaylistSmartShuffled = function');
  const handlerEnd = MOD.indexOf('window.playAmPlaylistFromStart = function');
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, '要能切出 handler 本体');
  const body = MOD.slice(handlerStart, handlerEnd);

  // 纯重排是另一件事, 歌单入口不应再用它
  assert.ok(body.indexOf('planSmartShuffleOrder') < 0, '歌单入口不应再用纯重排');
  // 插歌失败也必须照常播放「打乱后的歌单」, 不能什么都不做
  assert.match(body, /playInApp\(base/, '插歌失败要照常随机播放');
  // 先随机再插: Fisher-Yates 必须出现在拉池之前
  const shuffleAt = body.indexOf('Math.random() * (i + 1)');
  const poolAt = body.indexOf('smartShuffleFetchPool');
  assert.ok(shuffleAt > 0 && poolAt > shuffleAt, '必须先打乱歌单, 再拉池插歌');
});

test('入口 4 — Apple 歌单里直接隐藏该按钮', () => {
  assert.match(MOD, /am-playlist-detail-smart-shuffle/, '要在 plRenderInfo 里控制显隐');
  assert.match(MOD, /smartBtn\.hidden = !isNonAppleSource/, '非四源必须隐藏');
});

test('入口 6 — 控制条也有智能随机, 且只动 currentIdx 之后的部分', () => {
  assert.match(HTML, /id="smart-shuffle-queue-btn"/, '控制条必须有按钮');
  assert.ok(HTML.indexOf('onclick="smartShuffleQueue()"') >= 0, '必须指向 handler');
  assert.match(CTRL, /function smartShuffleQueue\(\)/, '必须有实现');
  assert.match(CTRL, /smartShuffleApplyGuard/, '必须过唯一接管判定点');
  assert.match(CTRL, /planSmartShuffleInsertions/, '必须插歌（不是纯重排）');

  const i = CTRL.indexOf('function smartShuffleQueue()');
  const body = CTRL.slice(i, i + 5200);
  // 只截断 currentIdx 之后: 正在播的和已播前缀都不许动
  assert.ok(body.indexOf('playQueue.length = startIdx + 1') >= 0, '只能替换未播部分');
  // 顺序: 先随机尾部, 再拉池插歌
  assert.ok(body.indexOf('shuffleArrayInPlace') > 0, '尾部必须先随机');
  assert.ok(body.indexOf('shuffleArrayInPlace') < body.indexOf('smartShuffleFetchPool'),
    '必须先随机再拉池');
});

test('入口 7 — 两个入口用同一个图标（四角星 + 交叉箭头 + 圆点）', () => {
  const stars = HTML.match(/M7 3\.4C7\.35 4\.9/g) || [];
  assert.strictEqual(stars.length, 2, '歌单详情与控制条应各有一处同一图标, 实际=' + stars.length);
});

test('入口 5 — 只对非 Apple 源生效, 且带 provenance', () => {
  assert.match(MOD, /智能随机只用于 MineRadio 自己的源/, 'Apple 歌单要有明确提示');
  assert.match(MOD, /smartShuffle: true/, '播放上下文要标记来源');
});
