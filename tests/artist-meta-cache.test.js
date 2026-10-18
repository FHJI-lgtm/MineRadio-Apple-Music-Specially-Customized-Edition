'use strict';
// ============================================================
// 艺人元数据缓存 · 契约测试
//
// 起因：QQ / 酷狗的艺人列表要为**每一个**艺人单独发一次详情请求补头像
// （QQ 269 个、酷狗 474 个），且没有任何缓存 —— 实测 QQ 7.9s、酷狗 2.2s，
// 每次打开都重来。网易云/汽水则是整份艺人结果只缓存在内存，重启即失效。
// 本模块把「头像/名称/简介」和「整份艺人结果」都落盘，重启后直接命中。
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'desktop', 'artist-meta-cache.js'));
const { createArtistMetaCache, ARTIST_META_SCHEMA_VERSION } = mod;

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'artist-meta-')), name);
}

test('进程内读写', async (t) => {
  await t.test('set 后能 get 回来', () => {
    const c = createArtistMetaCache({ cachePath: tmpFile('a.json') });
    c.set('qq', 'mid1', { image: 'http://x/1.jpg', name: 'A' });
    assert.deepEqual(c.get('qq', 'mid1'), { image: 'http://x/1.jpg', name: 'A' });
    assert.equal(c.get('qq', 'mid2'), null);
  });

  await t.test('来源命名空间隔离（同 id 不同源互不干扰）', () => {
    const c = createArtistMetaCache({ cachePath: tmpFile('b.json') });
    c.set('qq-avatar', 'x', { image: 'qq.jpg' });
    c.set('kugou-avatar', 'x', { image: 'kg.jpg' });
    assert.equal(c.get('qq-avatar', 'x').image, 'qq.jpg');
    assert.equal(c.get('kugou-avatar', 'x').image, 'kg.jpg');
  });

  await t.test('缺 source / id 时拒绝写入', () => {
    const c = createArtistMetaCache({ cachePath: tmpFile('c.json') });
    assert.equal(c.set('', 'x', {}), false);
    assert.equal(c.set('qq', '', {}), false);
    assert.equal(c.get('qq', ''), null);
  });

  await t.test('负缓存：确认「没有头像」也应被记住', () => {
    const c = createArtistMetaCache({ cachePath: tmpFile('d.json') });
    c.set('kugou-avatar', 'noimg', { image: '' });
    const got = c.get('kugou-avatar', 'noimg');
    assert.ok(got, '空头像也要返回记录，避免反复重试');
    assert.equal(got.image, '');
  });
});

test('TTL', async (t) => {
  await t.test('超过 ttl 后视为未命中', async () => {
    const c = createArtistMetaCache({ cachePath: tmpFile('ttl.json'), ttlMs: 10 * 60 * 1000 });
    c.set('qq-avatar', 'k', { image: 'x' });
    assert.ok(c.get('qq-avatar', 'k', 10 * 60 * 1000));
    await new Promise(function (r) { setTimeout(r, 15); });
    assert.equal(c.get('qq-avatar', 'k', 5), null, '超过传入的短 TTL 应未命中');
  });
});

test('落盘与读回', async (t) => {
  await t.test('flush 写盘、无 .tmpdir 残留、新实例可读回', () => {
    const file = tmpFile('disk.json');
    const c1 = createArtistMetaCache({ cachePath: file });
    c1.set('netease-avatar', 'a1', { image: 'n1.jpg' });
    c1.set('netease-artists', 'u1', { artists: [{ artistId: 'a1' }], total: 1 });
    assert.equal(c1.flush(), true, 'flush 应写盘');
    assert.ok(fs.existsSync(file), '文件应存在');
    assert.equal(fs.existsSync(file + '.tmpdir'), false, '原子写不应残留 .tmpdir');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schemaVersion, ARTIST_META_SCHEMA_VERSION);
    const c2 = createArtistMetaCache({ cachePath: file });
    assert.equal(c2.get('netease-avatar', 'a1').image, 'n1.jpg', '重启后应读回');
    assert.equal(c2.get('netease-artists', 'u1').total, 1, '整份结果也应读回');
  });

  await t.test('schemaVersion 不符时当空缓存', () => {
    const file = tmpFile('ver.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 999, entries: [['qq:x', { at: Date.now(), value: { image: 'z' } }]] }), 'utf8');
    const c = createArtistMetaCache({ cachePath: file });
    assert.equal(c.get('qq', 'x'), null, '版本不符必须丢弃，不能误用旧结构');
  });

  await t.test('没有脏数据时不重复写盘', () => {
    const file = tmpFile('nodirty.json');
    const c = createArtistMetaCache({ cachePath: file });
    c.set('qq', 'a', { image: 'x' });
    c.flush();
    const first = fs.statSync(file).mtimeMs;
    c.flush();
    assert.equal(fs.statSync(file).mtimeMs, first, '无改动不应重写');
  });
});

test('server.js 接线：艺人列表/详情必须走缓存', () => {
  const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const keys = ['qq-avatar', 'kugou-avatar', 'qq-meta', 'netease-meta', 'netease-avatar', 'netease-artists', 'qishui-avatar', 'qishui-artists'];
  for (const k of keys) {
    assert.ok(SERVER.indexOf("'" + k + "'") > 0, '缺少缓存键 ' + k + ' —— 该路径又会每次打开都走网络');
  }
  assert.ok(SERVER.indexOf('artistMetaCache.flush()') > 0, '写入后必须 flush 落盘');
});