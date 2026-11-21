'use strict';
// ============================================================
// 音乐资料库设置 · 专辑卡片圆角
//
// 需求：在视觉控制台里加一个「音乐资料库」设置分组（点击展开式），
// 第一个功能是调整专辑卡片圆角。
// 本测试钉住整条接线：默认值 → 持久化读取/保存 → 滑条绑定 → CSS 变量消费。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('专辑卡片圆角：CSS 由变量消费', async (t) => {
  await t.test('.mlib-art 使用 --mlib-card-radius，且保留 18px 回落', () => {
    const CSS = read('public/css/index.css');
    assert.ok(CSS.indexOf('var(--mlib-card-radius, 18px)') > 0, '封面圆角必须读 CSS 变量并保留原默认值');
    assert.equal(/border-radius:\s*18px/.test(CSS.slice(CSS.indexOf('.mlib-art {'), CSS.indexOf('.mlib-art {') + 600)), false, '不应再写死 18px');
  });

  await t.test('专辑/歌单详情页封面也跟随同一变量', () => {
    const CSS = read('public/css/index.css');
    const i = CSS.indexOf('.am-album-cover {');
    assert.ok(i > 0, '.am-album-cover 应存在（专辑与歌单详情共用）');
    const block = CSS.slice(i, i + 600);
    assert.ok(block.indexOf('var(--mlib-card-radius, 18px)') > 0, '详情页封面要读同一个圆角变量');
    const j = CSS.indexOf('.am-album-cover-video {');
    assert.ok(j > 0, '动态封面覆盖层应存在');
    assert.ok(CSS.slice(j, j + 500).indexOf('var(--mlib-card-radius, 18px)') > 0, '动态封面覆盖层必须同圆角，否则切换时露边');
  });
});

test('专辑卡片圆角：默认值与持久化', async (t) => {
  await t.test('默认值 18px（不设置时外观不变）', () => {
    const D = read('public/js/modules/00-state/04-fx-defaults.js');
    assert.match(D, /albumCardRadius:\s*18\b/, 'fxDefaults.albumCardRadius 默认 18');
  });

  await t.test('读取与保存都包含该键', () => {
    const P = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
    assert.ok(P.indexOf('savedAlbumCardRadius') > 0, '读取时要有 savedAlbumCardRadius');
    assert.ok(P.indexOf('albumCardRadius: savedAlbumCardRadius') > 0, '读取结果要带上它');
    assert.match(P, /albumCardRadius:\s*layoutInteger\(fx\.albumCardRadius/, '保存 payload 要带上它（整数 0–32）');
  });

  await t.test('应用函数写 CSS 变量并夹到 0–32', () => {
    const R2 = read('public/js/modules/00-state/06-fx-runtime-layout.js');
    assert.ok(R2.indexOf('function applyMlibCardRadius') > 0, '要有 applyMlibCardRadius');
    assert.ok(R2.indexOf("'--mlib-card-radius'") > 0, '要写 --mlib-card-radius');
    assert.match(R2, /MLIB_CARD_RADIUS_MAX\s*=\s*32/, '上限 32');
    assert.ok(R2.indexOf('applyMlibCardRadius(fx.albumCardRadius)') > 0, '启动时立即应用');
  });
});

test('专辑卡片圆角：控制台 UI 接线', async (t) => {
  await t.test('滑条存在于 index.html，范围 0–32', () => {
    const H = read('public/index.html');
    assert.match(H, /id="fx-mlibradius"[^>]*type="range"[^>]*min="0"[^>]*max="32"/, '滑条要有 0–32');
  });

  await t.test('视觉控制台登记了「音乐资料库」分组（点击展开式）', () => {
    const W = read('public/js/modules/07-fx/09-console-workspace.js');
    assert.match(W, /key:\s*'library',\s*title:\s*'音乐资料库'/, '要有音乐资料库分组');
    assert.match(W, /fxConsoleItem\('fx-mlibradius',\s*'专辑卡片圆角'/, '分组里要引用滑条');
    assert.ok(W.indexOf("title: '音乐资料库'") > 0, '标题文案');
  });

  await t.test('滑条绑定并实时应用', () => {
    const B = read('public/js/modules/07-fx/07-bindings-shelf-immersive.js');
    assert.ok(B.indexOf("['fx-mlibradius', 'albumCardRadius']") > 0, '要绑定到 fx.albumCardRadius');
    assert.ok(B.indexOf('applyMlibCardRadius(fx.albumCardRadius)') > 0, '输入时要立即应用');
  });

  await t.test('恢复默认也会应用', () => {
    const P = read('public/js/modules/07-fx/05-fx-panel-performance.js');
    assert.ok(P.indexOf("if (key === 'albumCardRadius') applyMlibCardRadius(fx[key]);") > 0, '恢复默认要重新应用');
    assert.ok(P.indexOf("setRange('fx-mlibradius'") > 0, '面板同步时要回填滑条值');
  });
});