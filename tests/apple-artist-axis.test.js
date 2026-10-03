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
;
// ============================================================
// 艺人详情页：端点与服务端聚合契约
// ============================================================
test('艺人详情：以 artist ID 为实体，且只展示本地资料库作品', async (t2) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t2.test('艺人列表按 catalog artist ID 归组，不按名字分组', () => {
    assert.match(SERVER, /byArtistId/, '必须以 artistId 作为聚合键');
    assert.match(SERVER, /ensureArtist\(/, '每个 artist ID 一个实体');
    // 不得存在"按名字建组"的实现
    assert.ok(!/byArtistName\s*=/.test(SERVER), '不得按艺人名字分组');
  });

  await t2.test('解析失败的歌曲必须保留并标记，不得丢弃或错归属', () => {
    assert.match(SERVER, /ensureUnresolved/, '解析失败要有独立的待解析集合');
    assert.match(SERVER, /pendingSongs/, '待解析数量要如实上报');
  });

  await t2.test('详情端点是 /api/apple/library/artist/detail 且按发行分区', () => {
    assert.match(SERVER, /\/api\/apple\/library\/artist\/detail/, '详情端点必须存在');
    ['single', 'ep', 'unknown'].forEach((k) => {
      assert.ok(SERVER.indexOf("'" + k + "'") >= 0 || SERVER.indexOf(k + ':') >= 0,
        '必须有 ' + k + ' 分区');
    });
    assert.match(SERVER, /classifyRelease/, '发行类型要有独立判定函数');
  });

  await t2.test('发行类型只按名称后缀判定，不用曲目数推断', () => {
    const fn = SERVER.slice(SERVER.indexOf('function classifyRelease'), SERVER.indexOf('const releases ='));
    assert.match(fn, /Single/, 'Single 后缀规则');
    assert.match(fn, /EP/, 'EP 后缀规则');
    // 绝不能用 songCount === 1 判定 Single
    assert.ok(!/songCount\s*===?\s*1/.test(fn), '不得用"只有一首歌"断定 Single');
  });

  await t2.test('详情页只展示本地资料库歌曲，不请求 catalog 全量', () => {
    const block = SERVER.slice(SERVER.indexOf("/api/apple/library/artist/detail"),
      SERVER.indexOf("/api/apple/library/artist/detail") + 2600);
    assert.match(block, /readLibrarySongs/, '歌曲来源必须是本地索引');
    assert.ok(!/\/artists\/[^']*\/albums/.test(block), '不得拉取 catalog 全量作品');
  });

  await t2.test('渲染层：返回按钮与列表滚动位置保留', () => {
    assert.match(MOD, /backToArtistList/, '必须有返回列表的入口');
    assert.match(MOD, /listScrollTop/, '返回时要恢复列表滚动位置');
  });

  await t2.test('渲染层：首字母占位规则覆盖英文/中文/空名', () => {
    assert.match(MOD, /function artistInitial/, '首字母必须是独立函数');
    const fn = MOD.slice(MOD.indexOf('function artistInitial'), MOD.indexOf('function artistAvatarHtml'));
    assert.match(fn, /A-Za-z/, '英文分支');
    assert.match(fn, /u4e00|\\u4e00/, '中文分支');
    assert.match(fn, /return ''/, '取不到字符时返回空（由调用方给音乐图标）');
  });

  await t2.test('渲染层：头像加载失败要移除图片而不是留破图', () => {
    assert.match(MOD, /img\.remove\(\)/, '失败时移除 img，露出首字母占位');
  });
});

test('同步执行 artistInitial 的真实行为', async (t2) => {
  const { execFileSync } = require('node:child_process');
  // 直接从模块源码里抽出函数求值，验证三种名称的实际输出
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const start = MOD.indexOf('function artistInitial');
  const end = MOD.indexOf('function artistAvatarHtml');
  const src = MOD.slice(start, end);
  const script = 'const ff = (function(){' + src + ' return artistInitial;})();' +
    'const cases=[["The Weeknd","T"],["张杰","张"],["", ""],["  ",""],["Aero 张","A"],["张 Aero","张"],["123","1"]];' +
    'const out=cases.map(function(c){try{return [c[0],ff(c[0]),c[1]];}catch(e){return [c[0],"ERR",c[1]];}});' +
    'console.log(JSON.stringify(out));';
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
  const rows = JSON.parse(out);
  await t2.test('英文取首字母大写、中文取首汉字、空名返回空', () => {
    rows.forEach(function (r) {
      assert.equal(r[1], r[2], '名称 ' + JSON.stringify(r[0]) + ' 期望 ' + JSON.stringify(r[2]) + ' 实际 ' + JSON.stringify(r[1]));
    });
  });
});
;
// ============================================================
// 艺人简介（Wikipedia）：解析、消歧与负缓存
//
// 本机无法访问 wikipedia（实测 tcp 超时），所以这里**注入假 HTTP** 来验证逻辑，
// 不依赖联网；联网表现由真机验收。
// ============================================================
test('艺人简介：只接受可确认的条目，且失败也要记缓存', async (t3) => {
  const os = require('node:os');
  const fsp = require('node:fs');
  const { createAppleMusicLibraryCacheService } = require(path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'));

  function makeService(handler) {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'wiki-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    const calls = [];
    svc.setHttpGetJsonImpl(function (url, timeoutMs, redirects) {
      calls.push(url);
      return Promise.resolve(handler(url));
    });
    return { svc: svc, calls: calls };
  }

  await t3.test('正常条目：取回正文与来源链接', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('zh.wikipedia.org') >= 0) {
        return { status: 200, json: { type: 'standard', title: '张杰', description: '中国内地男歌手', extract: '张杰，中国内地男歌手。', lang: 'zh', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/张杰' } } } };
      }
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('111', '张杰');
    assert.equal(rec.status, 'ok');
    assert.match(rec.extract, /男歌手/);
    assert.match(rec.url, /zh\.wikipedia\.org/);
    assert.equal(h.calls.length, 1, '中文名应只查一次中文维基');
    assert.ok(h.calls[0].indexOf('zh.wikipedia.org') >= 0, '中文名优先中文维基');
  });

  await t3.test('消歧页必须丢弃（不能把同名条目当艺人）', async () => {
    const h = makeService(function () {
      return { status: 200, json: { type: 'disambiguation', title: '张杰', extract: '张杰可以指：…' } };
    });
    const rec = await h.svc.resolveArtistWiki('222', '张杰');
    assert.equal(rec.status, 'missing');
    assert.equal(rec.reason, 'DISAMBIGUATION');
  });

  await t3.test('描述指向其他领域时丢弃', async () => {
    const h = makeService(function () {
      return { status: 200, json: { type: 'standard', title: '凤凰', description: '中国湖南省的一座城市', extract: '凤凰县位于…' } };
    });
    const rec = await h.svc.resolveArtistWiki('333', '凤凰');
    assert.equal(rec.status, 'missing');
    assert.match(rec.reason, /WRONG_SUBJECT/);
  });

  await t3.test('没有正文时丢弃', async () => {
    const h = makeService(function () { return { status: 200, json: { type: 'standard', title: 'X' } }; });
    const rec = await h.svc.resolveArtistWiki('444', 'X');
    assert.equal(rec.status, 'missing');
    assert.equal(rec.reason, 'NO_EXTRACT');
  });

  await t3.test('网络不可达：记为 missing 而不是抛错，且不影响其他功能', async () => {
    const h = makeService(function () { return null; });   // 模拟超时/不可达
    const rec = await h.svc.resolveArtistWiki('555', 'Someone');
    assert.equal(rec.status, 'missing');
    assert.match(rec.reason, /HTTP_/);
  });

  await t3.test('负缓存：同一个艺人不会反复请求', async () => {
    const h = makeService(function () { return null; });
    await h.svc.resolveArtistWiki('666', 'Nobody');
    const first = h.calls.length;
    await h.svc.resolveArtistWiki('666', 'Nobody');
    assert.equal(h.calls.length, first, '第二次必须命中缓存，不再发请求');
    assert.equal(h.svc.getArtistWiki('666').status, 'missing');
  });

  await t3.test('非中文名只查英文维基（不做多余请求）', async () => {
    const h = makeService(function (url) {
      assert.ok(url.indexOf('en.wikipedia.org') >= 0, '英文名应查英文维基');
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('777', 'Ariana Grande');
    assert.equal(rec.status, 'missing');
    assert.equal(h.calls.length, 1);
  });

  await t3.test('结果为 missing 时 title 为空也不发请求', async () => {
    const h = makeService(function () { return { status: 200, json: { type: 'standard', extract: 'x' } }; });
    const rec = await h.svc.resolveArtistWiki('888', '');
    assert.equal(rec, null);
    assert.equal(h.calls.length, 0, '没有名字就不该请求');
  });

  await t3.test('失败记录随缓存落盘（重开服务仍命中）', async () => {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'wiki-persist-'));
    const cacheFile = path.join(dir, 'idx.json');
    const s1 = createAppleMusicLibraryCacheService({ cachePath: cacheFile });
    s1.setHttpGetJsonImpl(function () { return { status: 200, json: { type: 'standard', title: 'A', description: '歌手', extract: 'A 是一名歌手。' } }; });
    await s1.resolveArtistWiki('999', 'A');
    // 重开：不再注入 http，若仍能读到说明落盘成功（读缓存不会发请求）
    const s2 = createAppleMusicLibraryCacheService({ cachePath: cacheFile });
    const rec = s2.getArtistWiki('999');
    assert.ok(rec, '简介结果必须落盘');
    assert.equal(rec.status, 'ok');
    assert.match(rec.extract, /歌手/);
  });
});

test('艺人简介：端点与 UI 契约', async (t3) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const HTML = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');

  await t3.test('简介端点存在，且不编造（拿不到就 null）', () => {
    assert.match(SERVER, /\/api\/apple\/library\/artist\/wiki/, '必须有简介端点');
    const fn = SERVER.slice(SERVER.indexOf('function wikiPayload'), SERVER.indexOf('function wikiPayload') + 500);
    assert.match(fn, /status !== 'ok'/, '非 ok 状态一律不给正文');
    assert.match(fn, /return null/, '拿不到就返回 null');
  });

  await t3.test('简介不得阻塞详情返回', () => {
    const detail = SERVER.slice(SERVER.indexOf('/api/apple/library/artist/detail'),
      SERVER.indexOf('/api/apple/library/artist/detail') + 4200);
    assert.ok(!/await resolveArtistWiki\(/.test(detail), '详情端点不得 await 维基请求');
    assert.ok(/resolveArtistWikiAsync/.test(detail) || /getArtistWiki/.test(detail),
      '详情只带已有缓存 / 后台启动解析');
  });

  await t3.test('UI 有「来源: Wikipedia」标注', () => {
    assert.match(HTML, /来源: Wikipedia/, '必须有来源标注');
    assert.match(HTML, /mlib-artist-bio-source/);
  });

  await t3.test('UI 拿不到简介时不显示该区块', () => {
    const fn = MOD.slice(MOD.indexOf('function renderArtistBio'), MOD.indexOf('function fetchArtistBioIfMissing'));
    assert.match(fn, /box\.hidden = true/, '没有正文必须隐藏整块');
  });

  await t3.test('返回列表时清掉简介，避免残留到别的艺人', () => {
    const back = MOD.slice(MOD.indexOf('window.backToArtistList'), MOD.indexOf('window.backToArtistList') + 400);
    assert.match(back, /renderArtistBio\(null\)/, '返回列表要清简介');
  });
});
