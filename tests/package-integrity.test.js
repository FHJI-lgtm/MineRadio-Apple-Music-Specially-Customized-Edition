'use strict';
// ============================================================
// 打包完整性 · 契约测试
//
// 起因：electron-builder 的 build.files 是**白名单**。新增的适配层
// （*-library-adapter.js）不在其中，而 server.js 会 require 它们 ——
// 打包后应用**启动即崩**。这类问题在开发环境永远看不见，必须靠断言钉住。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = pkg.build && Array.isArray(pkg.build.files) ? pkg.build.files : [];

// 只做包含性判断，不求完整 glob 语义
function included(name) {
  let hit = false;
  FILES.forEach(function (pattern) {
    const negate = pattern.charAt(0) === '!';
    const p = negate ? pattern.slice(1) : pattern;
    let m = false;
    if (p.indexOf('**') >= 0) {
      // 形如 desktop/**/*：按第一个 * 之前的目录前缀匹配
      const prefix = p.slice(0, p.indexOf('*')).replace(/\/$/, '');
      m = prefix === '' || name === prefix || name.indexOf(prefix + '/') === 0;
    } else if (p.indexOf('*') >= 0) {
      m = new RegExp('^' + p.replace(/[.+?^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$').test(name);
    } else m = p === name;
    if (m) hit = !negate;
  });
  return hit;
}

test('打包完整性：根目录被 require 的 JS 必须在 build.files 白名单里', async (t) => {
  await t.test('每个根目录 JS 都被白名单覆盖', () => {
    const roots = fs.readdirSync(ROOT).filter(function (f) {
      return /\.js$/.test(f) && fs.statSync(path.join(ROOT, f)).isFile();
    });
    const missing = roots.filter(function (f) { return !included(f); });
    assert.deepEqual(missing, [], '这些文件不会被包进应用，但可能被 require：' + missing.join(', '));
  });

  await t.test('server.js 实际 require 的本地模块都能被解析到', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const reqs = [];
    const re = /require\('\.\/([^']+)'\)/g;
    let m = null;
    while ((m = re.exec(server))) reqs.push(m[1]);
    assert.ok(reqs.length > 0, 'server.js 应当有本地 require');
    const missing = [];
    reqs.forEach(function (rel) {
      const target = path.join(ROOT, rel);
      if (!fs.existsSync(target) && !fs.existsSync(target + '.js') && !fs.existsSync(path.join(target, 'index.js'))) {
        missing.push(rel + '(文件不存在)');
        return;
      }
      // 出现在 server.js 里的每个本地模块都要能进包
      const top = rel.split('/')[0];
      const candidate = /\.js$/.test(top) ? top : top + '.js';
      if (fs.existsSync(path.join(ROOT, candidate)) && !included(candidate)) missing.push(candidate + '(存在但不在白名单)');
    });
    assert.deepEqual(missing, [], '这些问题会让打包后的应用启动失败：' + missing.join(', '));
  });

  await t.test('新增的适配层必须在白名单里（曾全部遗漏）', () => {
    ['kugou-library-adapter.js', 'netease-library-adapter.js', 'qq-library-adapter.js', 'qishui-library-adapter.js'].forEach(function (f) {
      assert.ok(included(f), f + ' 必须进包（server.js 会 require 它）');
    });
  });

  await t.test('desktop 下的出网代理模块要被 desktop/**/* 覆盖', () => {
    assert.ok(included('desktop/outbound-proxy.js'), 'main.js 会 require 它');
  });

  await t.test('测试与脚本目录不得进包', () => {
    assert.equal(included('tests/anything.test.js'), false, '测试不该进包');
    assert.equal(included('scripts/foo.js'), false, '脚本不该进包');
  });
});
