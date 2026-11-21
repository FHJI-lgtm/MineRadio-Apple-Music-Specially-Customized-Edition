'use strict';
// ============================================================
// 资料库「黑胶墙」接入测试（薄板 · 一点透视）
//
// 验收原型 public/lab/3d-album-wall 通过后接入资料库展示层；
// 断言钉住：空间模型（薄板 90°、消失点居中）、六面结构、
// 书脊取色、倒影、景深、惯性吸附，以及「只在黑胶模式作用于专辑/歌单」。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODULE = 'public/js/modules/10-shell/09-mlib-vinyl-view.js';

test('黑胶墙：空间模型（CSS）', async (t) => {
  const CSS = read('public/css/index.css');
  await t.test('舞台一点透视，消失点在中央', () => {
    assert.match(CSS, /perspective: 900px/, '舞台要有透视');
    assert.match(CSS, /perspective-origin: 50% 50%/, '消失点必须在屏幕中央');
  });
  await t.test('薄板尺寸 1000×430×34，卡片 preserve-3d', () => {
    assert.ok(CSS.indexOf('--mlib-slab-w: 1000px') > 0, '薄板纵深 1000');
    assert.ok(CSS.indexOf('--mlib-slab-h: 430px') > 0, '薄板高 430');
    assert.ok(CSS.indexOf('--mlib-slab-t: 34px') > 0, '薄板厚 34（中间书脊宽度）');
    assert.match(CSS, /> \.mlib-album-card \{[\s\S]{0,500}?transform-style: preserve-3d/, '卡片要 preserve-3d');
  });
  await t.test('六面：正面/背面/书脊/远端/上下边', () => {
    assert.match(CSS, /\.mlib-slab-spine \{[\s\S]{0,400}?rotateY\(-90deg\) translateZ\(calc\(var\(--mlib-slab-w\) \/ 2\)\)/, '书脊是朝镜头的 90° 面');
    assert.match(CSS, /\.mlib-slab-back \{[\s\S]{0,300}?rotateY\(180deg\)/, '背面存在');
    assert.match(CSS, /\.mlib-slab-far \{[\s\S]{0,400}?rotateY\(90deg\)/, '远端纸边存在');
    assert.match(CSS, /\.mlib-slab-top \{[\s\S]{0,300}?rotateX\(90deg\)/, '上薄边存在');
    assert.match(CSS, /\.mlib-slab-bottom \{[\s\S]{0,300}?rotateX\(-90deg\)/, '下薄边存在');
    assert.ok(CSS.indexOf('writing-mode: vertical-rl') > 0, '书脊竖排文字');
  });
  await t.test('倒影与景深变量', () => {
    assert.ok(CSS.indexOf('.mlib-slab-reflection') > 0, '地面倒影盒');
    assert.match(CSS, /mask-image: linear-gradient\(to bottom/, '倒影渐隐遮罩');
    assert.ok(CSS.indexOf('blur(var(--mlib-blur') > 0, '按深度模糊');
    assert.ok(CSS.indexOf('brightness(calc(var(--mlib-light') > 0, '按深度变暗');
  });
  await t.test('只作用于专辑/歌单，艺人视图与网格模式不受影响', () => {
    assert.equal(CSS.indexOf('#music-library.mlib-vinyl-style #mlib-artists-grid'), -1, '艺人网格不能进黑胶墙');
    assert.ok(CSS.indexOf('#music-library.mlib-vinyl-style #mlib-view-albums') > 0);
    assert.ok(CSS.indexOf('#music-library.mlib-vinyl-style #mlib-view-playlists') > 0);
    assert.ok(CSS.indexOf('#music-library.mlib-vinyl-style #mlib-nav-menu { display: none }') > 0, '隐藏原视图导航');
    assert.equal(CSS.indexOf('#music-library.mlib-vinyl-style #mlib-nav-menu-source'), -1, '音乐源保留');
  });
});

test('黑胶墙：模块实现', async (t) => {
  const S = read(MODULE);
  await t.test('空间常数与变换', () => {
    assert.ok(S.indexOf('var MLIB_SLAB_W = 1000') > 0, '纵深 1000');
    assert.ok(S.indexOf('var MLIB_SLAB_H = 430') > 0, '高度 430');
    assert.ok(S.indexOf('var MLIB_SLAB_T = 34') > 0, '厚度 34');
    assert.ok(S.indexOf('rotateY(90deg)') > 0, '薄板绕 Y 轴转 90°');
    assert.ok(S.indexOf('MLIB_SLAB_SPACING = 96') > 0, '薄板间距');
  });
  await t.test('就地改造现有卡片（数据层不改）', () => {
    assert.ok(S.indexOf('function ensureMlibSlabFaces') > 0, '给现有卡片补面');
    assert.ok(S.indexOf("classList.contains('mlib-album-card')") > 0, '直接使用现有卡片');
    assert.ok(S.indexOf("className = 'mlib-slab-spine'") > 0, '生成书脊');
    assert.ok(S.indexOf("className = 'mlib-slab-back'") > 0, '生成背面');
  });
  await t.test('书脊取封面主色（/api/cover 代理 + canvas）', () => {
    assert.ok(S.indexOf('/api/cover?url=') > 0, '走同源代理才能读像素');
    assert.ok(S.indexOf('--mlib-spine') > 0, '主色写入书脊变量');
    assert.ok(S.indexOf('getImageData') > 0, 'canvas 采样');
  });
  await t.test('倒影 + 景深按 |x| 计算', () => {
    assert.ok(S.indexOf('function mlibSlabShade') > 0, '统一光照函数');
    assert.ok(S.indexOf('scaleY(-1)') > 0, '倒影镜像');
    assert.ok(S.indexOf('--mlib-blur') > 0, '景深变量');
  });
  await t.test('拖拽 + 惯性 + 吸附', () => {
    assert.ok(S.indexOf("addEventListener('pointerdown'") > 0, '拖拽开始');
    assert.ok(S.indexOf('state.velocity = delta / dtm') > 0, '速度按事件间隔归一化');
    assert.ok(S.indexOf('Math.pow(0.935, dt / 16.7)') > 0, '惯性衰减');
    assert.ok(S.indexOf('Math.round(state.pos)') > 0, '吸附到最近一张');
    assert.ok(S.indexOf("addEventListener('wheel'") > 0, '滚轮切换');
  });
  await t.test('胶囊只有专辑/歌单；从艺人视图切入自动回专辑', () => {
    assert.equal(S.indexOf('data-mlibview="artists"'), -1, '胶囊不含艺人');
    assert.ok(S.indexOf("mlibVinylActiveView() === 'artists'") > 0, '自动切走');
  });
});

test('黑胶墙：设置与共存', async (t) => {
  await t.test('默认网格，持久化键不变', () => {
    assert.match(read('public/js/modules/00-state/04-fx-defaults.js'), /mlibViewStyle:\s*'grid'/);
    const P = read('public/js/modules/02-visual/04-visual-settings-persistence.js');
    assert.ok(P.indexOf('savedMlibViewStyle') > 0);
  });
  await t.test('控制台分段控件与 loader 注册', () => {
    const H = read('public/index.html');
    assert.ok(H.indexOf('id="mlib-view-style-seg"') > 0);
    assert.ok(H.indexOf('data-mlib-style="vinyl"') > 0);
    assert.ok(read('public/js/index-loader.js').indexOf("'js/modules/10-shell/09-mlib-vinyl-view.js'") > 0);
    assert.match(read('public/js/modules/07-fx/09-console-workspace.js'), /fxConsoleItem\('mlib-view-style-seg',/);
  });
  await t.test('卡片禁止原生拖拽；拖放层只认真实文件', () => {
    assert.ok(read(MODULE).indexOf('function disableMlibNativeDrag') > 0);
    assert.ok(read('public/js/modules/06-lyrics/05-upload-dragdrop.js').indexOf('function isFileDragEvent') > 0);
  });
  await t.test('验收原型仍在独立目录', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'public/lab/3d-album-wall/index.html')), '独立原型保留');
  });
});