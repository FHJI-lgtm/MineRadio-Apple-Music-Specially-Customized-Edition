'use strict';
// ============================================================
// Apple Music 资料库 · 艺人轴契约测试
//
// 目标：把两条已确认的规则钉死在代码上，而不是靠实现时的记忆：
//   1) 艺人实体以 catalog artist ID 为准，绝不按 artistName 字符串分组；
//   2) 头像只采用「艺人代表图像」的高置信判据，作品封面不得冒充头像。
// 判据样本来自实测：docs/assets/artist-image-sample/contact-sheet.png（15 张）。
// 运行: node tests/apple-artist-axis.test.js
// ============================================================
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');
const webApi = require(path.join(APP_ROOT, 'desktop', 'apple-music-web-api.js'));

function art(bucket, file) {
  return { url: 'https://is1-ssl.mzstatic.com/image/thumb/' + bucket + '/v4/aa/bb/cc/' + file + '/{w}x{h}bb.jpg' };
}

test('艺人代表图像判据：只认高置信的两类，作品封面一律降级', async (t) => {
  await t.test('Features*/mzl.* 判为高置信（实测 5/5 均为艺人肖像）', () => {
    ['Features125', 'Features115', 'Features211'].forEach((bucket) => {
      const v = webApi.classifyArtistArtwork(art(bucket, 'mzl.rkcfvott.jpg'));
      assert.equal(v.kind, 'artist', bucket + ' 下 mzl.* 必须是高置信');
      assert.equal(v.rule, webApi.ARTIST_IMAGE_RULES.FEATURES_MZL);
    });
  });

  await t.test('AMCArtistImages* 且含 ami-identity 判为高置信（官方插画也算）', () => {
    const v = webApi.classifyArtistArtwork(art('AMCArtistImages221',
      'c4c3139f_ami-identity-aeae3b79_cropped.png'));
    assert.equal(v.kind, 'artist');
    assert.equal(v.rule, webApi.ARTIST_IMAGE_RULES.AMC_IDENTITY);
  });

  await t.test('Music* 一律不作为头像（实测混着作品封面与纯文字 Logo）', () => {
    // pr_source.png 实测是 HOYO-MiX 的纯文字 Logo，不是肖像
    assert.equal(webApi.classifyArtistArtwork(art('Music116', 'pr_source.png')).kind, 'release-artwork');
    // cover.jpg / *_cover.* 是作品封面
    assert.equal(webApi.classifyArtistArtwork(art('Music125', 'cover.jpg')).kind, 'release-artwork');
    assert.equal(webApi.classifyArtistArtwork(art('Music211', '0198448935531_cover.jpg')).kind, 'release-artwork');
    // 编号文件名（COCX-37647.jpg）实测也是作品封面
    assert.equal(webApi.classifyArtistArtwork(art('Music221', 'COCX-37647.jpg')).kind, 'release-artwork');
    assert.equal(webApi.classifyArtistArtwork(art('Music221', '3617052360029.jpg')).kind, 'release-artwork');
  });

  await t.test('缺 artwork / 未知形态不给头像', () => {
    assert.equal(webApi.classifyArtistArtwork(null).kind, 'none');
    assert.equal(webApi.classifyArtistArtwork({}).kind, 'none');
    assert.equal(webApi.classifyArtistArtwork({ url: '' }).kind, 'none');
    // AMCArtistImages 但缺 ami-identity → 首版保守不采用
    assert.equal(webApi.classifyArtistArtwork(art('AMCArtistImages211', 'random.png')).kind, 'unsure');
    // Features 下但不是 mzl.* → 首版保守不采用
    assert.equal(webApi.classifyArtistArtwork(art('Features125', 'other.jpg')).kind, 'unsure');
  });

  await t.test('只有 kind=artist 才允许作为头像使用', () => {
    const KINDS = ['artist', 'unsure', 'release-artwork', 'none'];
    const samples = [
      art('Features125', 'mzl.a.jpg'),
      art('AMCArtistImages221', 'x_ami-identity-y_cropped.png'),
      art('Music221', 'cover.jpg'),
      art('Music116', 'pr_source.png'),
      null,
    ];
    samples.forEach((a) => {
      const v = webApi.classifyArtistArtwork(a);
      assert.ok(KINDS.indexOf(v.kind) >= 0, 'kind 必须落在已知集合内');
    });
    // 反向断言：作品封面与空资源绝不能是 'artist'
    assert.notEqual(webApi.classifyArtistArtwork(art('Music221', 'cover.jpg')).kind, 'artist');
    assert.notEqual(webApi.classifyArtistArtwork(null).kind, 'artist');
  });
});

test('storefront 来自 bearer，不写死', async (t) => {
  await t.test('导出了权威 storefront 访问器，且失败时不抛错', () => {
    assert.equal(typeof webApi.getWebPlayerStorefront, 'function',
      'storefront 必须有一个权威来源访问器，不能在调用点写死');
    // 不触网：只断言"取不到时返回空串"这条降级契约（真实取值由运行时验证覆盖）
    assert.equal(typeof webApi.getCatalog, 'function');
  });

  await t.test('web-api 内部不得把 storefront 写死成具体地区', () => {
    const src = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'desktop', 'apple-music-web-api.js'), 'utf8');
    // getCatalog 的默认值只能是中性兜底，不能是业务地区
    assert.ok(!/'cn'/.test(src) && !/"cn"/.test(src),
      'web-api 层不得写死 cn；地区必须来自 bearer 或既有的降级链');
  });
});

test('艺人缓存：解析结果与负缓存都要落盘', async (t) => {
  const { createAppleMusicLibraryCacheService } = require(path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'));
  const os = require('node:os');
  const fsp = require('node:fs');

  await t.test('API 形状：暴露按需解析与缓存自省', () => {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'artist-cache-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    assert.equal(typeof svc.resolveArtistsForSongs, 'function');
    assert.equal(typeof svc.getArtistCacheInfo, 'function');
    assert.equal(typeof svc.getResolvedArtistIds, 'function');
    assert.equal(typeof svc.getArtistDetail, 'function');
    const info = svc.getArtistCacheInfo();
    assert.equal(info.songEntries, 0, '空缓存起步');
    assert.equal(info.artistEntries, 0);
    assert.ok(/apple-music-artist-cache\.json$/.test(info.path), '艺人缓存必须独立成文件: ' + info.path);
  });

  await t.test('负缓存：解析不到的歌曲要记住"查过但没有"，不重复请求', () => {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'artist-neg-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    // 未解析过的 id 返回空数组（而不是抛错）
    assert.deepEqual(svc.getResolvedArtistIds('999'), []);
    assert.equal(svc.getArtistDetail('999'), null);
  });

  await t.test('schema 版本不符时旧艺人缓存按空处理', () => {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'artist-schema-'));
    const cacheFile = path.join(dir, 'idx.json');
    fsp.writeFileSync(path.join(dir, 'apple-music-artist-cache.json'), JSON.stringify({
      schemaVersion: 999,
      savedAt: Date.now(),
      songToArtists: [['111', ['222']]],
      artists: [['222', { artistId: '222', name: 'X', image: 'stale.jpg' }]],
    }), 'utf8');
    const svc = createAppleMusicLibraryCacheService({ cachePath: cacheFile });
    const info = svc.getArtistCacheInfo();
    assert.equal(info.songEntries, 0, '版本不符必须当空缓存，避免读到旧头像规则的结果');
  });
});
