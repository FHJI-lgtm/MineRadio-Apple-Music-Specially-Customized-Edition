'use strict';
// ============================================================
// Apple 动态专辑封面（Motion Artwork）· 契约测试
//
// 实测确定的四个关键事实（决定了实现方式）：
//   1) 主接口**默认不返回** editorialVideo，必须带 extend=editorialVideo
//      （实测：不加=false，加=true，include= 无效）。
//   2) 变体四个：motionDetailSquare / motionDetailTall / motionSquareVideo1x1 / motionTallVideo3x4。
//   3) video 是 HLS .m3u8，但抽样 9 张有动态封面的专辑**全部**是「单 mp4 + EXT-X-BYTERANGE」
//      形态 —— 所有分片是同一个 .mp4 的字节范围，所以可把该 mp4 直接当 <video> 源
//      （实测 Chromium 可播：768x768 / 约 29 秒），不需要 HLS 库。
//   4) 资源无防盗链（mvod.itunes.apple.com 直连 200/206，Accept-Ranges: bytes）。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SERVER = read('server.js');
const DETAIL = read('public/js/modules/10-shell/07-album-detail.js');
const CSS = read('public/css/index.css');

test('动态封面 · 服务端解析', async (t) => {
  await t.test('必须带 extend=editorialVideo（否则字段根本不存在）', () => {
    assert.ok(SERVER.indexOf("extend: 'editorialVideo'") > 0,
      'editorialVideo 只在带 extend 时才返回；不加的话 attributes 里没有这个字段');
  });

  await t.test('四个变体都认得，且优先正方形（详情页是正方形）', () => {
    const i = SERVER.indexOf('async function resolveAppleMotionArtwork(');
    assert.ok(i > 0, '解析函数应存在');
    const fn = SERVER.slice(i, i + 2600);
    ['motionDetailSquare', 'motionSquareVideo1x1', 'motionDetailTall', 'motionTallVideo3x4'].forEach(function (k) {
      assert.ok(fn.indexOf(k) > 0, '要认得变体 ' + k);
    });
    assert.ok(fn.indexOf('ev.motionDetailSquare || ev.motionSquareVideo1x1') > 0, '正方形优先');
  });

  await t.test('HLS 要解析成单个 mp4（所有分片同一文件时）', () => {
    const i = SERVER.indexOf('async function resolveAppleMotionArtwork(');
    const fn = SERVER.slice(i, i + 2600);
    assert.ok(fn.indexOf('EXT-X-STREAM-INF') > 0, '从主清单取媒体变体');
    assert.ok(fn.indexOf('segs.length === 1') > 0, '判断唯一分片');
    assert.ok(fn.indexOf('isDirectFile') > 0, '要标记是否可直接播');
    assert.ok(fn.indexOf('hlsUrl') > 0, '保留 m3u8 便于排查');
  });

  await t.test('资料库专辑没有 catalogId —— 要能按「专辑名+艺人」定位', () => {
    const i = SERVER.indexOf("pn === '/api/apple/library/album/motion'");
    assert.ok(i > 0, '端点应存在');
    const fn = SERVER.slice(i, i + 2600);
    assert.ok(fn.indexOf('/search') > 0, '要能走目录搜索');
    assert.ok(fn.indexOf("types: 'albums'") > 0, '只搜专辑');
    assert.ok(fn.indexOf('score') > 0, '要按名称+艺人打分匹配（同名专辑很多）');
  });

  await t.test('必须同时有正缓存与负缓存', () => {
    assert.ok(SERVER.indexOf('appleMotionCache') > 0, '要有缓存');
    const i = SERVER.indexOf('async function resolveAppleMotionArtwork(');
    const fn = SERVER.slice(i, i + 4200);   // 负缓存在函数尾部，切片要够
    // 「查到 / 确认没有」都要缓存（没动态封面的专辑只查一次）；
    // 但**鉴权失败不在此列** —— 那会把"没 token"永久记成"这张专辑没有动态封面"。
    assert.ok(/appleMotionCache\.set\(key/.test(fn), '查到或确认没有都要写缓存');
    assert.ok(/__authFailed/.test(fn), '鉴权失败必须走提前返回，不得写负缓存');
    assert.ok(fn.indexOf('APPLE_MOTION_TTL_MS') > 0, '要有 TTL（mvod 链接可能过期）');
  });

  await t.test('不得再引用不存在的模块名', () => {
    // 这个错误让首次实现静默返回 null（被 catch 吞掉，只看到"无动态封面"）
    // 真实踩过的坑：用了未声明的模块名 -> 异常被 catch 吞掉 -> 端点静默返回"无动态封面"，
    // 排查了很久才通过日志看到 "appleWebApi is not defined"。
    assert.ok(/const appleWebApi = require\('\.\/desktop\/apple-music-web-api'\)/.test(SERVER),
      'appleWebApi 必须有对应 require');
    // 用到它的地方必须都在 require 之后
    const reqAt = SERVER.indexOf("require('./desktop/apple-music-web-api')");
    const useAt = SERVER.indexOf('appleWebApi.getCatalog');
    assert.ok(reqAt > 0 && useAt > reqAt, 'require 必须在使用之前');
  });
});

test('动态封面 · 客户端渲染与降级', async (t) => {
  await t.test('只在 Apple 源启用（其它源没有这个接口）', () => {
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    assert.ok(i > 0, '渲染函数应存在');
    const fn = DETAIL.slice(i, i + 2600);
    assert.ok(fn.indexOf("provider !== 'apple'") > 0, '非 Apple 源直接返回');
  });

  await t.test('静态封面先渲染，作为 poster 与降级兜底', () => {
    const i = DETAIL.indexOf('function renderInfo(album, songs) {');
    const fn = DETAIL.slice(i, i + 900);
    assert.ok(fn.indexOf('<img src=') > 0, '静态封面先渲染');
    assert.ok(fn.indexOf('applyAlbumMotionArtwork(cover, album)') > 0, '再尝试动态封面');
  });

  await t.test('<video> 必须设 src —— 漏掉会让元素进 DOM 却没有源', () => {
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    const fn = DETAIL.slice(i, i + 2600);
    // 真实踩过的坑：写了 createElement/appendChild/play 却漏了 src，
    // 表现为 currentSrc 为空、networkState=0，看起来像"视频没生效"。
    assert.ok(fn.indexOf('v.src = videoUrl') > 0, '必须设置 src');
    const srcAt = fn.indexOf('v.src = videoUrl');
    const playAt = fn.indexOf('.play()');
    assert.ok(srcAt > 0 && playAt > srcAt, '设 src 要在 play 之前');
  });

  await t.test('poster 必须设置（防加载时黑屏）', () => {
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    const fn = DETAIL.slice(i, i + 2600);
    assert.ok(fn.indexOf('v.poster = poster') > 0, '要设 poster');
  });

  await t.test('视频失败要退回静态图，且就绪前不隐藏它', () => {
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    const fn = DETAIL.slice(i, i + 2600);
    assert.ok(fn.indexOf("addEventListener('error'") > 0, '监听 error');
    assert.ok(/v\.remove\(\)/.test(fn), 'error 时移除 video（露出静态图）');
    assert.ok(fn.indexOf("addEventListener('loadeddata'") > 0, '就绪后再隐藏静态图，避免闪烁');
  });

  await t.test('切专辑要作废旧响应', () => {
    assert.ok(DETAIL.indexOf('motionToken') > 0, '要有请求序号');
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    const fn = DETAIL.slice(i, i + 2600);
    assert.ok(/token !== state\.motionToken/.test(fn), '旧响应要丢弃');
  });

  await t.test('走既有音频代理（带 Range），不直连 mzstatic/mvod', () => {
    const i = DETAIL.indexOf('function applyAlbumMotionArtwork(');
    const fn = DETAIL.slice(i, i + 2600);
    assert.ok(fn.indexOf('/api/audio?url=') > 0, '复用既有代理');
  });

  await t.test('CSS 要能裁切非正方形视频（object-fit: cover）', () => {
    assert.ok(CSS.indexOf('.am-album-cover-video') > 0, '要有样式');
    const i = CSS.indexOf('.am-album-cover-video');
    const block = CSS.slice(i, i + 400);
    assert.ok(block.indexOf('object-fit: cover') > 0, '强制裁切，防止非正方形破坏布局');
    assert.ok(block.indexOf('position: absolute') > 0, '叠在静态封面之上');
    assert.ok(block.indexOf('border-radius') > 0, '与既有封面圆角一致');
  });
});
;

// ============================================================
// 动态封面：Apple Web token 必须显式校验
//
// 实测事实：/v1/catalog/* 目前**匿名**也返回 editorialVideo
//   （匿名 4 变体 == 带 token 4 变体），所以 token 不是"今天能不能拿到"的必要条件。
// 但 getBearer() 失败时返回空串、请求会静默发出 —— 将来 Apple 一收紧，
// 我们会把"没有 token"误判成"这张专辑没有动态封面"，
// 与 appleWebApi is not defined 被 catch 吞掉是同一类静默失败。
// 所以必须显式门禁 + 如实上报，且**不得把鉴权失败缓存成"无动态封面"**。
// ============================================================
test('动态封面：Apple Web token 显式门禁', async (t33) => {
  const SERVER = read('server.js');

  await t33.test('取 token 失败时不发请求、不再往下当"无动态封面"', () => {
    const i = SERVER.indexOf('async function appleWebTokenState(');
    assert.ok(i > 0, '要有独立的 token 状态检查');
    const fn = SERVER.slice(i, i + 1200);
    assert.ok(fn.indexOf('hasToken') > 0, '要给出是否持有 token');
    // 复用 apple-music-web-api 自己的 getBearer，而不是引用别的模块的变量
    assert.ok(fn.indexOf('appleWebApi.getBearer') > 0, '要用 appleWebApi.getBearer（它内部委托给 web-lyrics）');
  });

  await t33.test('解析函数里先过门禁再请求', () => {
    const i = SERVER.indexOf('async function resolveAppleMotionArtwork(');
    const fn = SERVER.slice(i, i + 2600);
    const gateAt = fn.indexOf('appleWebTokenState()');
    const reqAt = fn.indexOf('getCatalog(');
    assert.ok(gateAt > 0, '要先检查 token');
    assert.ok(gateAt < reqAt, '门禁必须在发请求之前');
    assert.ok(/__authFailed/.test(fn), '鉴权失败要有独立标记，不能混成 null');
  });

  await t33.test('鉴权失败要如实报错且返回非 2xx，不得写负缓存', () => {
    assert.ok(SERVER.indexOf("APPLE_WEB_NO_BEARER") > 0, '要有明确的错误码');
    const i = SERVER.indexOf("pn === '/api/apple/library/album/motion'");
    const fn = SERVER.slice(i, i + 2600);
    assert.ok(fn.indexOf('__authFailed') > 0, '端点要识别鉴权失败');
    assert.ok(/},\s*503\)/.test(fn), '鉴权失败应返回 503（服务不可用），不是 200 + motion:null');
  });

  await t33.test('不得再引用未定义的 webLyrics 变量', () => {
    // 这条是真实踩过的：我写过 webLyrics.getWebPlayerBearer 而 server.js 没导入它
    assert.equal(SERVER.indexOf('webLyrics'), -1, 'server.js 不得引用未导入的 webLyrics');
  });
});
