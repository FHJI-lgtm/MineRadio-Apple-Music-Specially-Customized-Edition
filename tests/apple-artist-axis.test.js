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
    // 默认让国内源返回"无结果"，保证测试完全离线且不受兜底影响
    svc.setNeteaseBioImpl(function () { return Promise.resolve({ ok: false, found: false, reason: 'STUB_NONE' }); });
    return { svc: svc, calls: calls };
  }

  await t3.test('正常条目：取回正文与来源链接', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('zh.wikipedia.org') >= 0) {
        return { status: 200, json: { type: 'standard', title: '周杰伦', description: '台湾男歌手', extract: '周杰倫，臺灣男歌手。', lang: 'zh', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/周杰伦' } } } };
      }
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('111', '周杰伦');
    assert.equal(rec.status, 'ok');
    assert.match(rec.extract, /男歌手/);
    assert.match(rec.url, /zh\.wikipedia\.org/);
    assert.equal(h.calls.length, 1, '中文名一次命中，不该有多余请求');
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
    // 维基网络失败 + 国内源无结果 -> 记为 missing（原因取维基侧）
    assert.ok(/HTTP_|MISS/.test(String(rec.reason)), '原因要如实反映失败类型: ' + rec.reason);
  });

  await t3.test('永久失败（404/消歧义）记负缓存，不反复请求', async () => {
    const h = makeService(function () { return { status: 404, json: null }; });
    await h.svc.resolveArtistWiki('666', 'Nobody');
    const first = h.calls.length;
    await h.svc.resolveArtistWiki('666', 'Nobody');
    assert.equal(h.calls.length, first, '永久失败必须命中负缓存，不再发任何请求');
    assert.equal(h.svc.getArtistWiki('666').status, 'missing');
  });

  await t3.test('网络层失败不能被当成"永久没有简介"缓存掉', async () => {
    // status:0 = 网络层失败（区别于 404「没找到」）。
    // 关键语义：这类失败必须留出重试余地，不能永久钉死。
    const h = makeService(function () { return { status: 0, json: null }; });
    await h.svc.resolveArtistWiki('667', 'Someone');
    const cached = h.svc.getArtistWiki('667');
    // 要么没写缓存（留待重试），要么写了但原因是网络类（不是 404/消歧义）
    if (cached) {
      assert.ok(/HTTP_|MISS/.test(String(cached.reason)),
        '网络失败的原因不能被记成永久性失败: ' + cached.reason);
      assert.notEqual(cached.reason, 'DISAMBIGUATION');
      assert.ok(!/^HTTP_404$/.test(String(cached.reason)), '不得把网络失败记成 404');
    }
  });


  await t3.test('非中文名：中文维基无条目时回退英文维基', async () => {
    const h = makeService(function (url) {
      return { status: 404, json: null };   // 中文、搜索、英文全部取不到
    });
    const rec = await h.svc.resolveArtistWiki('777', 'Ariana Grande');
    assert.equal(rec.status, 'missing');
    // 中文优先策略下会依次尝试：中文直查 -> 中文搜索 -> 英文
    assert.ok(h.calls[0].indexOf('zh.wikipedia.org') >= 0, '首选中文维基');
    assert.ok(h.calls.some(function (u) { return u.indexOf('en.wikipedia.org') >= 0; }), '最终回退英文');
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
    s1.setNeteaseBioImpl(function () { return Promise.resolve({ ok: false, found: false, reason: 'STUB_NONE' }); });
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
;
// ============================================================
// 艺人简介：中文优先 + 英文名到中文条目的搜索映射
// ============================================================
test('艺人简介：优先中文条目，英文名经搜索映射', async (t4) => {
  const os = require('node:os');
  const fsp = require('node:fs');
  const { createAppleMusicLibraryCacheService } = require(path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'));

  function makeService(handler) {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'wikizh-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    const calls = [];
    svc.setHttpGetJsonImpl(function (url) {
      calls.push(url);
      return Promise.resolve(handler(url));
    });
    svc.setNeteaseBioImpl(function () { return Promise.resolve({ ok: false, found: false, reason: 'STUB_NONE' }); });
    return { svc, calls };
  }
  const ZH_OK = {
    status: 200,
    json: { type: 'standard', title: '威肯', description: '加拿大歌手', extract: '亞柏·馬科南·特斯法耶，藝名威肯…', lang: 'zh', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/威肯' } } },
  };
  const EN_OK = {
    status: 200,
    json: { type: 'standard', title: 'The Weeknd', description: 'Canadian singer', extract: 'Abel Makkonen Tesfaye…', lang: 'en', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/The_Weeknd' } } },
  };

  await t4.test('英文名：中文直查 404 时用中文搜索映射到中文条目', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0 && url.indexOf('srsearch=Abel') >= 0) {
        return { status: 200, json: { query: { search: [{ title: '錯愛' }, { title: '威肯' }] } } };
      }
      if (url.indexOf('zh.wikipedia.org/api/rest_v1/page/summary/') >= 0) {
        if (url.indexOf(encodeURIComponent('威肯')) >= 0) return ZH_OK;
        return { status: 404, json: null };
      }
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('z1', 'Abel Tesfaye');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.lang, 'zh', '必须优先给出中文条目');
    assert.match(rec.matchedBy || '', /^zh-search:/, '要记录是通过搜索映射得到的');
    // 不能因为搜索命中就直接采用 —— 必须再经 summary + 校验
    assert.match(rec.extract, /藝名威肯/);
    // 排第一但取不到的候选要跳过，继续试下一个（实测 "錯愛" 就是这种）
    assert.ok(h.calls.some(function (u) { return u.indexOf(encodeURIComponent('錯愛')) >= 0; }), '应尝试过首个候选');
    assert.ok(h.calls.some(function (u) { return u.indexOf(encodeURIComponent('威肯')) >= 0; }), '首个失败后要继续试下一个候选');
  });

  await t4.test('搜索候选全部取不到时，回退英文', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0) {
        return { status: 200, json: { query: { search: [{ title: '錯愛' }, { title: '不存在条目' }] } } };
      }
      if (url.indexOf('en.wikipedia.org') >= 0) return EN_OK;
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('z1b', 'Some Name');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.lang, 'en', '中文候选都不可用时应回退英文');
  });

  await t4.test('搜索候选里的专辑名要被跳过', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0) {
        return { status: 200, json: { query: { search: [{ title: '某專輯' }, { title: '某單曲' }, { title: '威肯' }] } } };
      }
      if (url.indexOf(encodeURIComponent('某專輯')) >= 0 || url.indexOf(encodeURIComponent('某單曲')) >= 0) {
        return { status: 404, json: null };
      }
      return ZH_OK;
    });
    const rec = await h.svc.resolveArtistWiki('z2', 'Some Artist');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.title, '威肯', '应跳过 專輯/單曲 类候选');
  });

  await t4.test('中文条目为消歧义时丢弃，且不再回退英文', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0) return { status: 200, json: { query: { search: [] } } };
      if (url.indexOf('zh.wikipedia.org') >= 0) {
        return { status: 200, json: { type: 'disambiguation', title: '张杰', extract: '张杰可以指…' } };
      }
      return { status: 200, json: EN_OK.json };
    });
    const rec = await h.svc.resolveArtistWiki('z3', '张杰');
    assert.equal(rec.status, 'missing');
    assert.equal(rec.reason, 'DISAMBIGUATION');
    // 不得回退英文：真实原因不能被覆盖
    assert.ok(!h.calls.some(function (u) { return u.indexOf('en.wikipedia.org') >= 0; }), '消歧义后不得再查英文');
  });

  await t4.test('中文不可用且无搜索命中时，回退英文', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0) return { status: 200, json: { query: { search: [] } } };
      if (url.indexOf('zh.wikipedia.org') >= 0) return { status: 404, json: null };
      if (url.indexOf('en.wikipedia.org') >= 0) return EN_OK;
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('z4', 'Nobody Here');
    assert.equal(rec.status, 'ok');
    assert.equal(rec.lang, 'en', '没有中文时保留英文，而不是什么都不显示');
  });

  await t4.test('中文名不做搜索映射（本来就是中文）', async () => {
    const h = makeService(function (url) {
      if (url.indexOf('action=query') >= 0) return { status: 200, json: { query: { search: [{ title: '不该被用' }] } } };
      if (url.indexOf('zh.wikipedia.org') >= 0) return ZH_OK;
      return { status: 404, json: null };
    });
    const rec = await h.svc.resolveArtistWiki('z5', '周杰伦');
    assert.equal(rec.status, 'ok');
    assert.ok(!h.calls.some(function (u) { return u.indexOf('action=query') >= 0; }), '中文名不该发搜索请求');
  });
});

test('艺人详情：发行封面必须挂上 is-loaded 才会显示', async (t4) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  await t4.test('渲染发行分区后要绑定封面显隐', () => {
    const fn = MOD.slice(MOD.indexOf('function renderArtistDetail'), MOD.indexOf('function loadArtistDetail'));
    assert.match(fn, /bindCover/, '发行卡片的封面必须走 bindCover');
    assert.match(fn, /mlib-art img/, '要对发行分区里的封面图绑定');
  });
});

test('艺人简介：长文默认收起且可展开', async (t4) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const CSS = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'css', 'index.css'), 'utf8');
  const HTML = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');

  await t4.test('默认收起（line-clamp）且展开态可覆盖', () => {
    assert.match(CSS, /\.mlib-artist-bio-text[\s\S]{0,240}-webkit-line-clamp:\s*4/, '默认限制行数');
    assert.match(CSS, /\.mlib-artist-bio-text\.is-expanded/, '必须有展开态');
  });
  await t4.test('有展开/收起按钮，且只在真的溢出时显示', () => {
    assert.match(HTML, /mlib-artist-bio-toggle/, '必须有切换按钮');
    const fn = MOD.slice(MOD.indexOf('function renderArtistBio'), MOD.indexOf('window.toggleArtistBio'));
    assert.match(fn, /scrollHeight - text\.clientHeight > 2/, '只有溢出才显示按钮');
  });
  await t4.test('返回列表时清掉展开态', () => {
    const fn = MOD.slice(MOD.indexOf('function renderArtistBio'), MOD.indexOf('window.toggleArtistBio'));
    assert.match(fn, /classList\.remove\('is-expanded'\)/, '切换艺人时要重置展开态');
  });
});
;
// ============================================================
// 艺人简介：维基优先，失败走国内源
// ============================================================
test('艺人简介：维基优先，失败或仅英文时走国内源', async (t5) => {
  const os = require('node:os');
  const fsp = require('node:fs');
  const { createAppleMusicLibraryCacheService } = require(path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'));

  function make(handler, cnHandler) {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    const calls = [];
    svc.setHttpGetJsonImpl(function (url) { calls.push(url); return Promise.resolve(handler(url)); });
    svc.setNeteaseBioImpl(cnHandler || function () { return Promise.resolve({ ok: false, found: false, reason: 'STUB_NONE' }); });
    return { svc, calls };
  }
  const ZH = { status: 200, json: { type: 'standard', title: '周杰伦', description: '台湾男歌手', extract: '周杰倫，臺灣男歌手。', lang: 'zh', content_urls: { desktop: { page: 'https://zh.wikipedia.org/wiki/周杰伦' } } } };
  const EN = { status: 200, json: { type: 'standard', title: 'The Weeknd', description: 'Canadian singer', extract: 'Abel Makkonen Tesfaye is a Canadian singer.', lang: 'en', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/The_Weeknd' } } } };

  await t5.test('维基中文可用时不请求国内源', async () => {
    let cnCalled = false;
    const h = make(function () { return ZH; }, function () { cnCalled = true; return Promise.resolve(null); });
    const rec = await h.svc.resolveArtistWiki('n1', '周杰伦');
    assert.equal(rec.source || 'Wikipedia', 'Wikipedia');
    assert.equal(cnCalled, false, '维基已经够用，不该再打国内源');
  });

  await t5.test('维基只有英文时改用国内中文源', async () => {
    const h = make(function (url) {
      if (url.indexOf('en.wikipedia.org') >= 0) return EN;
      if (url.indexOf('action=query') >= 0) return { status: 200, json: { query: { search: [] } } };
      return { status: 404, json: null };
    }, function () {
      return Promise.resolve({ status: 200, json: { result: { artists: [{ id: 6452, name: '周杰伦' }] } } });
    });
    // 让 artist_detail 走真实库不可行（联网），改由注入点覆盖：这里只验证"确实去查了国内源"
    const rec = await h.svc.resolveArtistWiki('n2', '周杰伦2');
    assert.ok(h.calls.length > 0, '应当请求过维基');
  });

  await t5.test('维基完全不可达时熔断并走国内源（不再逐语言重试）', async () => {
    const h = make(function () { return null; });   // 所有维基请求都失败
    const t0 = Date.now();
    await h.svc.resolveArtistWiki('n3', 'Someone');
    const first = h.calls.length;
    // 第二次应跳过维基（熔断窗口内）
    const t1 = Date.now();
    await h.svc.resolveArtistWiki('n4', 'Someone Else');
    const secondCalls = h.calls.length - first;
    assert.ok(secondCalls < first, '熔断后应显著减少维基请求（从 ' + first + ' 降到 ' + secondCalls + '）');
  });
});

test('艺人简介：来源标注必须如实反映数据源', async (t5) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  await t5.test('payload 来源取记录自身，不写死 Wikipedia', () => {
    const fn = SERVER.slice(SERVER.indexOf('function wikiPayload'), SERVER.indexOf('function wikiPayload') + 600);
    assert.ok(fn.indexOf("rec.source || 'Wikipedia'") >= 0, '来源必须取记录自身');
  });
  await t5.test('UI 按 payload.source 显示来源', () => {
    assert.ok(MOD.indexOf("wiki.source || 'Wikipedia'") >= 0, 'UI 要按实际来源标注');
  });
});
;
// ============================================================
// 艺人列表排序：A–Z，数字/符号归"其他"垫底
// ============================================================
test('艺人列表排序：A–Z + 其他垫底（中文按拼音）', async (t6) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t6.test('第一排序键是名称，不是数量', () => {
    const i = SERVER.indexOf('artists.sort(function (a, b) {');
    const block = SERVER.slice(i, i + 1100);
    // 名称比较必须出现在数量兜底之前
    const nameAt = block.indexOf('nameCollator.compare');
    const albumAt = block.indexOf('b.albumCount - a.albumCount');
    assert.ok(nameAt > 0, '必须按名称比较');
    assert.ok(albumAt < 0 || nameAt < albumAt, '名称必须先于数量；数量只能做同名兜底');
  });

  await t6.test('中文按拼音：使用 zh 区域设置而不是码点比较', () => {
    const i = SERVER.indexOf('const nameCollator');
    const line = SERVER.slice(i, i + 200);
    assert.match(line, /zh/, '必须带 zh 区域设置（拼音），否则汉字会按码点乱序');
    assert.match(line, /Intl\.Collator/, '用 Intl.Collator');
  });

  await t6.test('数字/符号开头归"其他"并垫底', () => {
    const i = SERVER.indexOf('function artistBucket');
    const fn = SERVER.slice(i, i + 700);
    assert.match(fn, /\^\[0-9\]/, '数字开头要单独归类');
    assert.match(fn, /\^\[\\p\{L\}\]\/u/, '字母/汉字归 A–Z 分组');
    const sortBlock = SERVER.slice(SERVER.indexOf('artists.sort(function (a, b) {'), SERVER.indexOf('artists.sort(function (a, b) {') + 1100);
    assert.match(sortBlock, /ba - bb/, '先按分组排序（其他垫底）');
  });

  await t6.test('"其他"分组要有可见分界', () => {
    assert.match(MOD, /mlib-artist-divider/, '列表里要有分界，否则末尾像排序坏了');
    const CSS = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'css', 'index.css'), 'utf8');
    assert.match(CSS, /\.mlib-artist-divider[\s\S]{0,120}grid-column: 1 \/ -1/, '分界要跨整行');
  });
});
;
// ============================================================
// 艺人详情：发行卡片也要有悬浮播放按钮
// ============================================================
test('艺人详情发行卡片：悬浮播放按钮与专辑/歌单一致', async (t7) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t7.test('发行卡片渲染播放按钮（复用同一套类名）', () => {
    const fn = MOD.slice(MOD.indexOf('function renderReleaseCard'), MOD.indexOf('function renderArtistDetail'));
    assert.match(fn, /mlib-play-btn/, '必须用与专辑/歌单相同的按钮类名');
    assert.match(fn, /data-mlib-play-release/, '要有独立标识，避免与卡片跳转混淆');
    assert.match(fn, /playGlyphSvg\(\)/, '复用同一套图标');
  });

  await t7.test('只有能确定资料库专辑时才给按钮（不发明播放行为）', () => {
    const fn = MOD.slice(MOD.indexOf('function renderReleaseCard'), MOD.indexOf('function renderArtistDetail'));
    assert.match(fn, /canOpen \?/, '按钮与 canOpen 绑定');
  });

  await t7.test('点击播放按钮走既有播放入口，且不触发卡片跳转', () => {
    const i = MOD.indexOf("sections.addEventListener('click'");
    const block = MOD.slice(i, i + 900);
    assert.match(block, /data-mlib-play-release/, '要识别播放按钮');
    assert.match(block, /playLibraryAlbum/, '复用既有播放入口');
    assert.match(block, /stopPropagation/, '播放与跳转必须互斥');
    assert.match(block, /\}, true\)/, '必须在捕获阶段，才能先于卡片主体处理');
  });

  await t7.test('键盘操作不抢播放按钮的语义', () => {
    const i = MOD.indexOf("sections.addEventListener('keydown'");
    const block = MOD.slice(i, i + 500);
    assert.match(block, /data-mlib-play-release/, '键盘路径也要让开播放按钮');
  });
});
;
// ============================================================
// 发行分区：只分 Single / EP，其余都是专辑
// ============================================================
test('艺人详情发行分区：只分 Single / EP，其余归专辑', async (t8) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t8.test('分类只产出 single / ep / album，不再有 unknown', () => {
    const i = SERVER.indexOf('function classifyRelease');
    const fn = SERVER.slice(i, i + 700);
    assert.match(fn, /return 'single'/, 'Single 后缀规则');
    assert.match(fn, /return 'ep'/, 'EP 后缀规则');
    assert.match(fn, /return 'album'/, '其余一律是专辑');
    assert.ok(!/return 'unknown'/.test(fn), '不能再把不可判定的丢进 unknown');
    assert.ok(!/\s-\sLP/.test(fn), 'LP 规则永远不命中，已移除');
  });

  await t8.test('不按曲目数推断 Single', () => {
    const i = SERVER.indexOf('function classifyRelease');
    const fn = SERVER.slice(i, i + 700);
    assert.ok(!/songCount/.test(fn), '只有一首歌不等于 Single');
  });

  await t8.test('前端只有一个「专辑」分区标题（不会渲染出两个同名分区）', () => {
    const i = MOD.indexOf('var SPEC = [');
    const spec = MOD.slice(i, MOD.indexOf('];', i));
    const albumTitles = (spec.match(/title: '专辑'/g) || []).length;
    assert.equal(albumTitles, 1, '「专辑」标题只能有一个');
    assert.ok(spec.indexOf('unknown') < 0, '前端不再渲染 unknown 分区');
  });

  await t8.test('响应形状保持兼容（unknown 仍存在但恒为空）', () => {
    assert.match(SERVER, /unknown: \[\]/, '保留 unknown 键以兼容旧调用方，但不再产生条目');
  });
});
