'use strict';
// ============================================================
// 封面消费链 · 契约测试
//
// 起因：Apple Music 外部播放时，封面进了粒子/纹理/歌词配色，**唯独没进
// #album-bg（背景环境光）** —— 因为 setAlbumBackground 只在内部播放的两条
// 封面路径里各自调用，而 SMTC（Apple）那条没调。
// 实测证据：smtcActive=true / uHasCover=1 / thumbSrc=data:... 但
//          albumBgHasImage=false，albumBackgroundSrc 还残留上一首网易云的 URL。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const COVER_DEPTH = read('public/js/modules/02-visual/15-ripples-cover-depth.js');
const COVER_LOAD = read('public/js/modules/03-beat/05-cover-loading-crop.js');
const SMTC_UI = read('public/js/modules/12-smtc/03-smtc-ui.js');

test('封面消费链：背景环境光必须在共用落点里设置', async (t) => {
  await t.test('applyCoverCanvas 里要设 #album-bg（所有封面来源的共用落点）', () => {
    const i = COVER_DEPTH.indexOf('function applyCoverCanvas(');
    assert.ok(i > 0, 'applyCoverCanvas 应存在');
    const fn = COVER_DEPTH.slice(i, i + 4000);
    assert.ok(fn.indexOf('setAlbumBackground(') > 0,
      'applyCoverCanvas 必须设背景：它是 loadCoverFromUrl / applyCoverDataUrl / smtcApplyVisualizerCover 的共同落点，放在这里新增封面来源才不必记得单独设一次');
    // 必须在 uHasCover 置位之后（此时封面已被接受）
    assert.ok(fn.indexOf('uniforms.uHasCover.value = 1') < fn.indexOf('setAlbumBackground('),
      '应在封面被接受（uHasCover=1）之后再设背景');
  });

  await t.test('三条封面路径都汇聚到 applyCoverCanvas', () => {
    // 内部播放
    assert.ok(COVER_LOAD.indexOf('applyCoverCanvas(cv, proxiedUrl') > 0, 'loadCoverFromUrl 走共用落点');
    // 自定义封面
    assert.ok(COVER_LOAD.indexOf('applyCoverCanvas(cv, dataUrl') > 0, 'applyCoverDataUrl 走共用落点');
    // Apple（SMTC）
    assert.ok(SMTC_UI.indexOf('applyCoverCanvas(cv, thumb') > 0, 'SMTC 走共用落点');
  });

  await t.test('SMTC 路径不得再"只进粒子不进背景"', () => {
    // 回归守卫：SMTC 覆盖过去只调 applyCoverCanvas，没有 setAlbumBackground
    const i = SMTC_UI.indexOf('function smtcApplyVisualizerCover(');
    assert.ok(i > 0, 'smtcApplyVisualizerCover 应存在');
    const fn = SMTC_UI.slice(i, i + 2500);
    assert.ok(fn.indexOf('applyCoverCanvas(') > 0, 'SMTC 要应用封面');
    // 只要 applyCoverCanvas 里有 setAlbumBackground，这里就不需要单独调；
    // 但仍要保证拇指图确实被传进去（thumbSrc 是背景的来源）
    assert.ok(/applyCoverCanvas\(cv,\s*thumb/.test(fn), '要把 thumb 作为 thumbSrc 传入（背景取它）');
  });
});

test('封面消费链：Apple 播放时的清理语义保持', async (t) => {
  const SEARCH = read('public/js/modules/05-playback/07-search.js');

  await t.test('发布 Apple 播放上下文时要清掉上一首的内部背景', () => {
    const i = SEARCH.indexOf('function publishAmcPlaybackContext(');
    assert.ok(i > 0, 'publishAmcPlaybackContext 应存在');
    const fn = SEARCH.slice(i, i + 4000);   // 清除点在函数较靠后处，切片要够
    assert.ok(fn.indexOf("setAlbumBackground('')") > 0,
      'E-A F4：要清掉上一首内部曲目的残留背景（实测它会残留上一首网易云的 URL）');
  });

  await t.test('清空路径不得经由 applyCoverCanvas（否则会被重新设回）', () => {
    // setAlbumBackground('') 只在"没有封面"的分支里；有价值封面才走 applyCoverCanvas
    const clears = COVER_LOAD.split("setAlbumBackground('')").length - 1;
    assert.ok(clears >= 3, '空封面分支应直接清背景（实际 ' + clears + ' 处）');
  });
});
