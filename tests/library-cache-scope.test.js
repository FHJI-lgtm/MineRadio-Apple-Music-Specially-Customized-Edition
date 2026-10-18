'use strict';
// ============================================================
// 资料库缓存作用域 · 契约测试
//
// 真实缺陷（存在了很久）：四个资料库聚合缓存声明在 http.createServer 的
// 请求处理函数**内部** —— 该函数每个请求都会重新执行，于是缓存每次重建，
// 「5 分钟 TTL」从未生效：
//   - 网易云每次打开都重扫 3 个歌单全部曲目，实测 5.4s
//   - 酷狗 / QQ / 汽水同理
// 修复：把 4 个缓存移到模块级；本测试确保它们不会再被写回处理器内部。
//
// 另一个缺陷：Apple 索引的探测冷却只看 ageMs()（= 距上次全量），
// 而探测发现「内容没变」时不会更新它 —— 于是只要 Apple 侧不变，
// 冷却永远不成立，每次打开都探测 2.5–3s。修复：冷却同时参考 lastProbeAt。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const HANDLER_AT = SERVER.indexOf('const server = http.createServer');

test('资料库缓存必须声明在模块作用域', async (t) => {
  const CACHES = ['neteaseLibrarySongsCache', 'kugouLibraryCache', 'qishuiLibraryCache', 'qqLibraryCache'];

  await t.test('请求处理器存在（定位基准）', () => {
    assert.ok(HANDLER_AT > 0, '没能定位到 http.createServer');
  });

  for (const name of CACHES) {
    await t.test(name + ' 必须是模块级且在处理器之前', () => {
      const moduleDecl = new RegExp('^const ' + name + ' = new Map\\(\\);', 'm');
      assert.ok(moduleDecl.test(SERVER), name + ' 必须在模块级声明（0 缩进的 const）');
      const at = SERVER.search(moduleDecl);
      assert.ok(at > 0 && at < HANDLER_AT, name + ' 必须声明在请求处理器之前');
      const innerDecl = new RegExp('^  const ' + name + ' = new Map\\(\\);', 'm');
      assert.equal(innerDecl.test(SERVER), false, name + ' 不得再声明于请求处理器内部');
    });
  }

  await t.test('对应的 TTL 常量也在模块级', () => {
    for (const k of ['NETEASE_LIB_TTL_MS', 'KUGOU_LIB_TTL_MS', 'QISHUI_LIB_TTL_MS', 'QQ_LIB_TTL_MS']) {
      const re = new RegExp('^const ' + k + ' = ', 'm');
      assert.ok(re.test(SERVER), k + ' 必须模块级');
      assert.ok(SERVER.search(re) < HANDLER_AT, k + ' 必须在处理器之前');
    }
  });
});

test('Apple 索引探测冷却必须参考上次探测时间', async (t) => {
  const CACHE = fs.readFileSync(path.join(ROOT, 'desktop', 'apple-music-library-cache.js'), 'utf8');
  const start = CACHE.indexOf('async function sync(');
  assert.ok(start > 0, 'sync 函数应存在');
  const fn = CACHE.slice(start, start + 4000);

  await t.test('冷却判据包含 lastProbeAt', () => {
    assert.ok(fn.indexOf('lastProbeAt') > 0, 'sync 里必须读取 lastProbeAt');
    assert.ok(/freshByProbe/.test(fn), '必须有基于探测时间的冷却分支');
    assert.ok(/freshByFullSync \|\| freshByProbe/.test(fn), '冷却应为「全量新鲜 或 探测新鲜」');
  });

  await t.test('探测失败也要落盘探测时间，避免离线时每请求重试', () => {
    const i = fn.indexOf('if (p.reason)');
    assert.ok(i > 0, '探测失败分支应存在');
    const failBranch = fn.slice(i, i + 600);
    assert.ok(/persist\(\)/.test(failBranch), '探测失败分支应 persist()');
  });
});