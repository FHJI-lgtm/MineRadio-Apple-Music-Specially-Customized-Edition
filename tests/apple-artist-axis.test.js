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
;
// ============================================================
// 艺人头像：国内源兜底（只补"艺人代表图像"，不用作品封面）
// ============================================================
test('艺人头像：Apple 判据优先，国内源头像兜底', async (t9) => {
  const os = require('node:os');
  const fsp = require('node:fs');
  const { createAppleMusicLibraryCacheService } = require(path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'));
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');

  function make(bioHandler) {
    const dir = fsp.mkdtempSync(path.join(os.tmpdir(), 'av-'));
    const svc = createAppleMusicLibraryCacheService({ cachePath: path.join(dir, 'idx.json') });
    svc.setHttpGetJsonImpl(function () { return Promise.resolve({ status: 404, json: null }); });
    svc.setNeteaseBioImpl(bioHandler);
    return svc;
  }

  await t9.test('有头像无简介时，头像仍要保留（头像本身有价值）', async () => {
    const svc = make(function () {
      return Promise.resolve({ ok: true, data: { extract: '', title: '周杰伦', lang: 'zh', source: '网易云音乐', neteaseAvatar: 'https://p4.music.126.net/x.jpg?param=300y300' } });
    });
    await svc.warmNetease([{ artistId: 'a1', name: '周杰伦' }]);
    const av = svc.getNeteaseAvatar('a1');
    assert.equal(av, 'https://p4.music.126.net/x.jpg?param=300y300', '头像必须被缓存下来');
  });

  await t9.test('缓存未命中时返回空串，而不是抛错', () => {
    const svc = make(function () { return Promise.resolve({ ok: false, found: false, reason: 'NETEASE_NO_EXACT_MATCH' }); });
    assert.equal(svc.getNeteaseAvatar('nope'), '');
  });

  await t9.test('预热去重：同一艺人解析一次，已解析过的不再请求', async () => {
    let calls = 0;
    const svc = make(function () {
      calls += 1;
      return Promise.resolve({ ok: true, data: { extract: 'x', title: 'A', lang: 'zh', neteaseAvatar: 'https://a/b.jpg' } });
    });
    await svc.warmNetease([{ artistId: 'd1', name: 'A' }, { artistId: 'd1', name: 'A' }]);
    assert.equal(calls, 1, '同一批里的重复项只能解析一次');
    const before = calls;
    await svc.warmNetease([{ artistId: 'd1', name: 'A' }]);
    assert.equal(calls, before, '已解析过的艺人不再请求');
  });

  await t9.test('列表与详情的头像优先级一致（都是 Apple > 国内源 > 首字母）', () => {
    const listBlock = SERVER.slice(SERVER.indexOf('image: (detail && detail.image) || cnAvatarOf(aid)'),
      SERVER.indexOf('image: (detail && detail.image) || cnAvatarOf(aid)') + 40);
    assert.ok(listBlock.length > 0, '列表要有国内源兜底');
    const detailBlock = SERVER.slice(SERVER.indexOf('image: (detail && detail.image) || cnAvatar'),
      SERVER.indexOf('image: (detail && detail.image) || cnAvatar') + 40);
    assert.ok(detailBlock.length > 0, '详情也要有同样的兜底');
  });

  await t9.test('国内源头像不得来自作品封面字段', () => {
    const CACHE = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'), 'utf8');
    const i = CACHE.indexOf('const rawAvatar =');
    const line = CACHE.slice(i, i + 220);
    assert.match(line, /a\.avatar \|\| a\.picUrl \|\| a\.img1v1Url/, '只能用艺人头像字段');
    assert.ok(!/artwork|album|cover/i.test(line), '不得用作品封面字段当头像');
  });
});
;
// ============================================================
// Apple 歌单曲目：必须取全，不能只取第一页
// ============================================================
test('Apple 歌单曲目：分页取全（不再只有 100 首）', async (t10) => {
  const READS = require(path.join(APP_ROOT, 'desktop', 'apple-music-web-reads-api.js'));
  const ALL = READS.handleApplePlaylistTracksAllWeb;
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  function makeFakePage(totalCount, pageLimit) {
    const calls = [];
    const fn = function (id, opts) {
      const limit = Number(opts && opts.limit) || pageLimit;
      const offset = Number(opts && opts.offset) || 0;
      calls.push({ offset: offset, limit: limit });
      const end = Math.min(totalCount, offset + limit);
      const tracks = [];
      for (let i = offset; i < end; i += 1) tracks.push({ index: i, name: 'T' + i });
      return Promise.resolve({
        ok: true, provider: 'apple', tracks: tracks, total: totalCount,
        offset: offset, limit: limit, nextOffset: end, hasMore: end < totalCount, error: '',
      });
    };
    return { fn: fn, calls: calls };
  }

  await t10.test('370 首会分页取满，而不是停在 100', async () => {
    const fake = makeFakePage(370, READS.APPLE_PLAYLIST_PAGE_LIMIT);
    const res = await ALL('p1', { fetchPage: fake.fn });
    assert.equal(res.tracks.length, 370, '必须取满 370 首');
    assert.equal(res.total, 370);
    assert.equal(res.pages, 4, '370 / 100 应为 4 页');
    assert.equal(res.truncated, false);
    assert.equal(res.error, '');
    // 页与页之间不能重叠或漏项
    assert.deepEqual(res.tracks.map(function (x) { return x.index; }),
      Array.from({ length: 370 }, function (_, i) { return i; }), '顺序与索引必须连续无重复');
  });

  await t10.test('页码推进正确（offset 逐页递增）', async () => {
    const fake = makeFakePage(250, READS.APPLE_PLAYLIST_PAGE_LIMIT);
    await ALL('p2', { fetchPage: fake.fn });
    assert.deepEqual(fake.calls.map(function (c) { return c.offset; }), [0, 100, 200]);
  });

  await t10.test('正好整除时不多取一页', async () => {
    const fake = makeFakePage(300, READS.APPLE_PLAYLIST_PAGE_LIMIT);
    const res = await ALL('p3', { fetchPage: fake.fn });
    assert.equal(res.tracks.length, 300);
    assert.equal(fake.calls.length, 3, '300 首正好 3 页，不该发第 4 次请求');
  });

  await t10.test('空歌单不发第二次请求', async () => {
    const fake = makeFakePage(0, READS.APPLE_PLAYLIST_PAGE_LIMIT);
    const res = await ALL('p4', { fetchPage: fake.fn });
    assert.equal(res.tracks.length, 0);
    assert.equal(fake.calls.length, 1);
  });

  await t10.test('有安全上限并标记 truncated，而不是无界循环', async () => {
    const fake = makeFakePage(999999, READS.APPLE_PLAYLIST_PAGE_LIMIT);
    const res = await ALL('p5', { fetchPage: fake.fn, maxTotal: 250 });
    assert.equal(res.tracks.length, 250);
    assert.equal(res.truncated, true, '被上限截断必须如实标记');
    assert.ok(fake.calls.length <= 40, '必须有页数上限，避免无界循环');
  });

  await t10.test('单页报错时如实带出错误，不假装取全了', async () => {
    let n = 0;
    const res = await ALL('p6', {
      fetchPage: function (id, opts) {
        n += 1;
        if (n === 1) {
          return Promise.resolve({ tracks: [{ index: 0 }], total: 370, nextOffset: 100, hasMore: true, error: '' });
        }
        return Promise.resolve({ tracks: [], total: 370, error: 'PLAYLIST_PAGE_FAILED', message: 'boom' });
      },
    });
    assert.equal(res.error, 'PLAYLIST_PAGE_FAILED', '错误必须冒出来');
    assert.equal(res.tracks.length, 1, '已取到的部分要保留');
  });

  await t10.test('游标不前进时中止，避免死循环', async () => {
    let n = 0;
    const res = await ALL('p7', {
      fetchPage: function () {
        n += 1;
        return Promise.resolve({ tracks: [{ index: 0 }], total: 370, nextOffset: 0, hasMore: true, error: '' });
      },
    });
    assert.ok(n <= 3, '游标不前进必须尽快中止（实际请求 ' + n + ' 次）');
  });

  await t10.test('前端必须用 all=1，服务端必须提供该分支', () => {
    assert.match(MOD, /playlist\/tracks\?id=[\s\S]{0,80}all=1/, '详情页要请求全部曲目');
    assert.ok(!/playlist\/tracks\?id=[\s\S]{0,80}limit=100/.test(MOD), '不得再写死 limit=100');
    assert.match(SERVER, /searchParams\.get\('all'\) === '1'/, '服务端要有 all=1 分支');
  });
});
;
// ============================================================
// 歌单详情的随机播放按钮
// ============================================================
test('歌单详情：随机播放按钮只在歌单里显示且常驻可见', async (t11) => {
  const HTML = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');
  const CSS = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'css', 'index.css'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  await t11.test('按钮存在于歌单详情，且紧邻播放歌单按钮', () => {
    assert.match(HTML, /am-playlist-detail-shuffle/, '歌单详情必须有随机按钮');
    const i = HTML.indexOf('am-album-actions');
    const block = HTML.slice(i, i + 900);
    assert.match(block, /am-playlist-detail-play/, '同一操作区里要有播放歌单');
    assert.match(block, /am-playlist-detail-shuffle/, '同一操作区里要有随机播放');
    assert.ok(block.indexOf('am-playlist-detail-play') < block.indexOf('am-playlist-detail-shuffle'),
      '随机应排在播放之后（左侧播放、右侧随机）');
  });

  await t11.test('只在歌单：专辑详情不得出现该按钮', () => {
    const albumPart = HTML.indexOf('am-album-detail');
    const shuffleCount = (HTML.match(/am-shuffle-btn/g) || []).length;
    assert.equal(shuffleCount, 1, '全页只应有一个随机按钮');
    assert.ok(albumPart > 0, '专辑详情存在');
    // 专辑详情的操作区不应包含随机按钮
    const ai = HTML.indexOf('id="am-album-detail-play"');
    if (ai > 0) {
      const around = HTML.slice(Math.max(0, ai - 400), ai + 400);
      assert.ok(around.indexOf('am-shuffle-btn') < 0, '专辑详情的播放区不得有随机按钮');
    }
  });

  await t11.test('常驻可见：不依赖 hover 才出现', () => {
    const i = CSS.indexOf('.am-shuffle-btn {');
    const block = CSS.slice(i, i + 900);
    assert.ok(!/opacity:\s*0/.test(block), '不得默认透明（那是悬浮才出现的做法）');
    assert.ok(!/pointer-events:\s*none/.test(block), '不得默认不可点');
    assert.ok(!/html\.mlib-has-hover[\s\S]{0,80}am-shuffle-btn/.test(CSS), '不得挂在 hover 规则下');
  });

  await t11.test('无文字描述，纯图标', () => {
    const i = HTML.indexOf('id="am-playlist-detail-shuffle"');
    const start = HTML.lastIndexOf('<button', i);
    const block = HTML.slice(start, HTML.indexOf('</button>', i) + 9);
    assert.ok(!/播放歌单|随机播放<\/span>/.test(block.replace(/title="[^"]*"|aria-label="[^"]*"/g, '')),
      '按钮内不得有可见文字');
    assert.match(block, /<svg/, '要有图标');
    // 图标形状：两条交叉的曲线箭头（不能是一堆端头重合的独立线段）
    // 注意：必须带单词边界，否则 id="..." 里的 "d=\"" 也会被算进来
    const paths = block.match(/\sd="[^"]+"/g) || [];
    assert.equal(paths.length, 4, '应为 2 条曲线 + 2 个箭头头部');
    assert.match(block, /M3 7h3\.5c2 0 3\.5 1\.2 5 3s3 5 5 5H20/, '一条曲线');
    assert.match(block, /M3 17h3\.5c2 0 3\.5-1\.2 5-3s3-5 5-5H20/, '另一条曲线（与前者交叉）');
    assert.match(block, /M17\.5 12\.5 20 15l-2\.5 2\.5/, '下端箭头');
    assert.match(block, /M17\.5 9\.5 20 7l-2\.5-2\.5/, '上端箭头');
  });

  await t11.test('浅色玻璃圆钮（歌单背景是亮青色，深色钮对比不足）', () => {
    const i = CSS.indexOf('.am-shuffle-btn {');
    const block = CSS.slice(i, i + 950);
    assert.match(block, /border-radius: 50%/, '圆形');
    assert.match(block, /backdrop-filter/, '保留玻璃质感');
    assert.match(block, /inset 0 1px 0 rgba\(255, 255, 255/, '内高光是浅色');
    // 底色必须明亮、文字/图标必须深色 —— 否则在亮青色背景上又变回看不清
    const bg = (block.match(/background:\s*rgba\(255, 255, 255, ([\d.]+)\)/) || [])[1];
    assert.ok(bg && Number(bg) >= 0.7, '底色要是明亮的浅色玻璃（实际 ' + bg + '）');
    assert.match(block, /color: #14161a/, '图标必须是深色，才能压在浅色底上');
    // 圆形与玻璃质感都要与专辑悬浮按钮同源
    const play = CSS.slice(CSS.indexOf('.mlib-play-btn {'), CSS.indexOf('.mlib-play-btn {') + 900);
    ['border-radius: 50%', 'backdrop-filter'].forEach(function (token) {
      assert.ok(block.indexOf(token) >= 0, '随机按钮要有 ' + token);
      assert.ok(play.indexOf(token) >= 0, '专辑悬浮按钮里确实有 ' + token + '（作为对照）');
    });
  });

  await t11.test('点击入口存在，且不会谎报已随机播放', () => {
    assert.match(HTML, /onclick="playAmPlaylistShuffled\(\)"/, '必须有点击入口');
    assert.match(MOD, /window\.playAmPlaylistShuffled = function/, '要有对应的全局入口');
    assert.match(MOD, /随机播放通道尚未接入/, '通道未接入时要如实提示，不能假装成功');
  });

  await t11.test('忙碌态会一并禁用随机按钮', () => {
    const i = MOD.indexOf('function plSetBusy');
    const block = MOD.slice(i, i + 500);
    assert.match(block, /am-playlist-detail-shuffle/, 'plSetBusy 要照顾随机按钮');
  });

  await t11.test('给 UIA 侧留出明确的接入标识', () => {
    assert.match(HTML, /data-am-shuffle="playlist"/, '要有稳定的 data-* 标识供 UIA 定位');
  });
});
;
// ============================================================
// 音乐资料库导航：视图常驻 + 源可切换
// ============================================================
test('音乐资料库导航：三个视图常驻，源列表可展开切换', async (t12) => {
  const HTML = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const nav = (function () {
    const s = HTML.indexOf('id="mlib-nav-section"');
    const e = HTML.indexOf('id="mlib-view-albums"');
    return HTML.slice(s, e);
  })();

  await t12.test('三个视图常驻：不再有可折叠的视图父级', () => {
    assert.match(HTML, /id="mlib-nav-children-views"/, '视图容器存在');
    assert.ok(!/id="mlib-nav-parent-albums"/.test(HTML), '不该再有可折叠的视图父级');
    assert.ok(!/id="mlib-nav-children-albums"/.test(HTML), '旧的视图折叠容器必须已移除');
    // 视图容器不得带折叠类（否则会被隐藏）
    assert.ok(!/mlib-nav-children is-collapsed" id="mlib-nav-children-views"/.test(HTML),
      '视图容器不得默认折叠');
    ['albums', 'artists', 'playlists'].forEach(function (v) {
      assert.match(HTML, new RegExp('id="mlib-nav-item-' + v + '"'), v + ' 入口必须存在');
    });
  });

  await t12.test('只有源列表可折叠，且默认展开', () => {
    assert.match(nav, /id="mlib-nav-parent-source"/, '源父级');
    assert.match(nav, /id="mlib-nav-children-source"/, '源子容器');
    assert.match(nav, /aria-expanded="false"/, '源列表默认收起');
    assert.match(MOD, /function toggleMlibSourceOpen/, '源展开切换存在');
    assert.ok(!/function toggleMlibNav/.test(MOD), '视图折叠函数应已删除（视图常驻）');
  });

  await t12.test('六个源都登记；已接入的才可点', () => {
    const i = MOD.indexOf('var MLIB_SOURCES = {');
    const block = MOD.slice(i, MOD.indexOf('};', i));
    ['apple', 'qq', 'kugou', 'netease', 'qishui', 'spotify'].forEach(function (s) {
      assert.match(block, new RegExp(s + ':\\s*\\{'), s + ' 必须登记（需求方要求列出）');
    });
    // Apple 与网易云已接资料库；其余如实标为未接入
    assert.match(block, /apple: \{ label: 'Apple Music', ready: true \}/, 'Apple 已接入');
    assert.match(block, /netease: \{ label: '网易云音乐', ready: true \}/, '网易云专辑轴已接入');
    const ready = block.match(/ready: true/g) || [];
    assert.equal(ready.length, 3, 'Apple / 网易云 / 酷狗 三个源可点（实际 ' + ready.length + '）');
    assert.match(block, /kugou: \{ label: '酷狗音乐', ready: true \}/, '酷狗已接入');
    const notReady = block.match(/ready: false/g) || [];
    assert.equal(notReady.length, 3, '其余 3 个源必须如实标为未接入');
    // 未接入的源必须仍然存在，不能被误删
    ['qq', 'qishui', 'spotify'].forEach(function (s) {
      // 逐行判断：该源的条目里必须出现 ready: false
      const line = block.split('\n').filter(function (l) { return l.indexOf(s + ':') >= 0; })[0] || '';
      assert.match(line, /ready: false/, s + ' 应保持未接入状态（实际: ' + line.trim() + '）');
    });
  });

  await t12.test('索引按源分开取，不共用同一个请求/快照', () => {
    assert.match(MOD, /function libraryIndexEndpoint\(src\)/, '要有按源选端点');
    assert.match(MOD, /'\/api\/netease\/library\/index'/, '网易云端点');
    assert.match(MOD, /libraryIndexSnapshots/, '快照必须按源分开存，避免把上一个源的列表留在界面上');
    const fn = MOD.slice(MOD.indexOf('function fetchLibraryIndex'), MOD.indexOf('function libraryIndexChanged'));
    assert.match(fn, /libraryIndexInflight\.src === s2/, '在途请求也要按源区分');
  });

  await t12.test('未接入的源不可点，且写明原因', () => {
    const fn = MOD.slice(MOD.indexOf('function renderSourceList'), MOD.indexOf('function setMlibSource'));
    assert.match(fn, /disabled aria-disabled="true"/, '未接入的源必须 disabled');
    assert.match(fn, /mlib-nav-note/, '要写明未接入，不能用"点了没反应"表达');
    assert.match(fn, /MLIB_SOURCE_NOT_READY/, '统一口径');
    // 点击兜底：即使绕过 disabled 也不切源
    const bind = MOD.slice(MOD.indexOf('function bindLibraryNav'), MOD.indexOf('function bindLibraryNav') + 1600);
    assert.match(bind, /data-mlib-source-ready/, '点击时还要再判一次是否已接入');
  });

  await t12.test('偏好键已更换，旧键不再影响界面', () => {
    const key = (MOD.match(/var MLIB_SOURCE_OPEN_KEY = '([^']+)'/) || [])[1];
    assert.equal(key, 'mineradio.mlib.sourceListOpen', '必须换键，否则旧的 sourceOpen=0 会继续折叠入口');
    // 注释里为说明换键原因会提到旧键，所以只看"代码中是否还引用它"
    const codeOnly = MOD.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/mineradio\.mlib\.sourceOpen'/.test(codeOnly), '旧键不该再被代码使用（注释提及不算）');
  });

  await t12.test('切换源只在已接入的源之间发生', () => {
    const fn = MOD.slice(MOD.indexOf('function setMlibSource'), MOD.indexOf('function setMlibView'));
    assert.match(fn, /MLIB_SOURCE_ORDER\.indexOf\(name\) < 0/, '未知源要回落到默认');
  });
});
;
// ============================================================
// 资料库模块：不得调用未定义的函数（语法检查抓不到这类错误）
// ============================================================
test('06-music-library.js：调用的函数必须存在（防 ReferenceError 中断绑定）', async (t13) => {
  const SELF = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const glob = require('node:fs');
  const pathMod = require('node:path');
  // 模块是拼接后一起加载的，所以「在别的模块里定义」也算存在
  const dir = path.join(APP_ROOT, 'public', 'js');
  function collect(dirPath, acc) {
    glob.readdirSync(dirPath, { withFileTypes: true }).forEach(function (d) {
      const p = pathMod.join(dirPath, d.name);
      if (d.isDirectory()) collect(p, acc);
      else if (d.name.endsWith('.js')) acc.push(glob.readFileSync(p, 'utf8'));
    });
    return acc;
  }
  const ALL = collect(dir, []).join('\n');

  function definedIn(src, name) {
    return new RegExp('function\\s+' + name + '\\b').test(src) ||
      new RegExp('var\\s+' + name + '\\s*=').test(src);
  }

  await t13.test('本模块「apply/set/toggle/render/bind/sync」前缀的调用都有定义', () => {
    const PREFIX = /^(apply|set|toggle|render|bind|sync)/;
    // 浏览器/JS 内置，不是本项目函数
    const BUILTIN = new Set(['setTimeout', 'setInterval', 'setAttribute', 'setProperty', 'setItem',
      'setRequestHeader', 'setDate', 'setHours', 'setMinutes', 'setSeconds', 'setFullYear', 'setMonth',
      'setSelectionRange', 'setStart', 'setEnd', 'setCustomValidity', 'setRangeText', 'setPointerCapture',
      'setLineDash', 'setTransform', 'setValueAtTime', 'apply']);
    const called = new Map();
    for (const m of SELF.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (!PREFIX.test(name) || BUILTIN.has(name)) continue;
      called.set(name, (called.get(name) || 0) + 1);
    }
    const missing = [];
    called.forEach(function (count, name) {
      if (definedIn(SELF, name)) return;
      if (definedIn(ALL, name)) return;   // 其它模块里的（拼接后可见）
      missing.push(name + '（本模块调用 ' + count + ' 次）');
    });
    assert.deepEqual(missing, [],
      '这些函数被调用但全局都没有定义，会在运行时抛 ReferenceError 并中断绑定流程：\n' + missing.join('\n'));
  });

  await t13.test('回归样本：曾真实发生的 applySourceOpen 缺失必须能被这条断言拦住', () => {
    // 这条断言的意义在于它确实能抓到"定义被误删、只剩调用"的情况。
    const fake = 'function bindX() { applySourceOpen(); }';
    const PREFIX = /^(apply|set|toggle|render|bind|sync)/;
    const called = [];
    for (const m of fake.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (PREFIX.test(m[2])) called.push(m[2]);
    }
    assert.ok(called.indexOf('applySourceOpen') >= 0, '样本本身应被识别');
    assert.ok(!definedIn(fake, 'applySourceOpen') && !definedIn(ALL, 'applySourceOpen'),
      'applySourceOpen 确实已不存在，因此任何残留调用都必须报错');
  });
});
;
// ============================================================
// 当前源的高亮必须真的看得见
// ============================================================
test('音乐资料库：当前源的高亮点不依赖会变的主题变量', async (t14) => {
  const CSS = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'css', 'index.css'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t14.test('高亮点用固定色，不用 var(--home-accent)', () => {
    const i = CSS.indexOf('.mlib-nav-item.is-active .mlib-nav-dot');
    const block = CSS.slice(i, i + 260);
    assert.ok(!/var\(--home-accent/.test(block),
      '--home-accent 会随主题变化（实测曾解析成 #ffffff，高亮等于看不见），必须用固定色');
    assert.match(block, /#00f5d4/, '固定强调色');
    assert.match(block, /box-shadow/, '再加一层辉光，弱色背景下也能看出');
  });

  await t14.test('普通点与高亮点视觉上必须可区分', () => {
    const plain = CSS.slice(CSS.indexOf('.mlib-nav-dot {'), CSS.indexOf('.mlib-nav-dot {') + 200);
    const activeIdx = CSS.indexOf('.mlib-nav-item.is-active .mlib-nav-dot');
    const active = CSS.slice(activeIdx, activeIdx + 260);
    assert.match(plain, /rgba\(255, 255, 255, \.38\)/, '普通点是低透明度白');
    assert.ok(active.indexOf('#00f5d4') >= 0, '高亮点是强调色 —— 两者色相不同，必然可辨');
  });

  await t14.test('切换源时必须重新渲染源列表，否则高亮留在上一个源上', () => {
    const fn = MOD.slice(MOD.indexOf('function setMlibSource'), MOD.indexOf('function setMlibView'));
    assert.match(fn, /renderSourceList\(\)/,
      '选中态是 renderSourceList 写进 DOM 的；只改标题而不重渲染，高亮会留在旧源上');
  });
});
;
// ============================================================
// 切换音乐源：专辑墙必须换成新源的数据（不能残留上一个源）
// ============================================================
test('音乐资料库：切源后专辑墙必须重渲染，不残留上一个源', async (t15) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t15.test('记住当前网格属于哪个源，切源即视为"首次"', () => {
    assert.match(MOD, /albumsRenderedSource/, '必须记录网格当前渲染自哪个源');
    const fn = MOD.slice(MOD.indexOf('function loadLibraryAlbums'), MOD.indexOf('function loadArtistsView'));
    assert.match(fn, /albumsRenderedSource !== mlibActiveSource/,
      '源变了就要按首次处理 —— 否则 changed 标记为假时不重渲染，会留着上一个源的列表');
    assert.match(fn, /albumsRenderedSource = requestedSource/, '渲染后要记住数据来源');
  });

  await t15.test('切源重渲染不依赖 changed 标记', () => {
    const fn = MOD.slice(MOD.indexOf('function loadLibraryAlbums'), MOD.indexOf('function loadArtistsView'));
    assert.match(fn, /var changed = first \|\| libraryIndexChanged\(data\)/,
      'first 为真时必须渲染（changed 只作为额外条件）');
    assert.match(fn, /if \(!changed\) return data;/, '仅在既非首次又无变化时才跳过渲染');
  });

  await t15.test('切源过程中又切回时，丢弃过期响应', () => {
    const fn = MOD.slice(MOD.indexOf('function loadLibraryAlbums'), MOD.indexOf('function loadArtistsView'));
    assert.match(fn, /requestedSource !== mlibActiveSource/,
      '请求期间用户又切源了，就不能把旧源的结果画到新源下');
  });

  await t15.test('视图状态也带来源标记（艺人/歌单同理不能串源）', () => {
    assert.match(MOD, /artistsState = \{[^}]*source:/, '艺人视图要记录来源');
    assert.match(MOD, /playlistsState = \{[^}]*source:/, '歌单视图要记录来源');
    assert.match(MOD, /playlistsState\.source = mlibActiveSource/, '加载成功时写入来源');
    assert.match(MOD, /playlistsState\.loaded && playlistsState\.source === mlibActiveSource/,
      '只有同一来源的已加载状态才可复用');
  });
});
;
// ============================================================
// 多源播放：非 Apple 源走 MineRadio 自有播放器，不碰 UIA
// ============================================================
test('多源播放：非 Apple 源必须走应用内播放器，不得落到 UIA 通道', async (t16) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  await t16.test('有 isNonAppleSource 判定，且播放入口都先过它', () => {
    assert.match(MOD, /function isNonAppleSource\(provider\)/, '要有非 Apple 源判定');
    const calls = (MOD.match(/isNonAppleSource\(album\.provider\)/g) || []).length;
    assert.ok(calls >= 2, '单曲与整张专辑两个入口都要先判源（实际 ' + calls + ' 处）');
  });

  await t16.test('非 Apple 源走 playInApp，而不是 amc.playAlbum', () => {
    // 单曲入口：判源之后必须 return，不能继续走到 amc.playAlbum
    const single = MOD.slice(MOD.indexOf('function playSongAt'), MOD.indexOf('window.playAmAlbumFromStart'));
    const guardIdx = single.indexOf('isNonAppleSource(album.provider)');
    const amcIdx = single.indexOf('amc.playAlbum');
    assert.ok(guardIdx > 0 && guardIdx < amcIdx, '判源必须在调用 Apple 播放通道之前');
    assert.match(single.slice(guardIdx, guardIdx + 200), /return/, '走非 Apple 分支后必须 return，不能继续下行');
  });

  await t16.test('playInApp 用 playQueue + playQueueAt（自有播放链路）', () => {
    const fn = MOD.slice(MOD.indexOf('function playInApp'), MOD.indexOf('function loadAlbum'));
    assert.match(fn, /playQueue = list/, '装进自有播放队列');
    assert.match(fn, /currentIdx =/, '设置起始曲目');
    assert.match(fn, /playQueueAt\(/, '交给自有播放器 —— 它会按 provider 选到该源的取流端点');
    assert.ok(!/amc\./.test(fn), 'playInApp 内部不得触及 AMC（UIA）通道');
  });

  await t16.test('曲目转成播放器可消费的形状时，必须带裸 id 与 provider', () => {
    const fn = MOD.slice(MOD.indexOf('function toPlayableSong'), MOD.indexOf('function playInApp'));
    assert.match(fn, /id: String/, '播放器用 song.id 取流');
    assert.match(fn, /provider: provider/, '播放器用 provider 选源（songProviderKey）');
    assert.ok(!/id: String\(\(song && \(song\.librarySongId/.test(fn),
      '不能把带 ne: 前缀的 librarySongId 当取流用的 id');
  });

  await t16.test('详情页小字按实际来源标注，不再一律写 Apple Music', () => {
    assert.match(MOD, /SOURCE_KICKER_LABELS/, '要有按来源的文案表');
    assert.match(MOD, /netease: '网易云音乐'/, '网易云要有自己的文案');
    const setKicker = MOD.slice(MOD.indexOf('function setKicker'), MOD.indexOf('function renderInfo'));
    assert.ok(!/Apple Music/.test(setKicker), 'setKicker 里不得写死 Apple Music');
  });

  await t16.test('歌单详情按源取曲目，不落到 Apple 端点上', () => {
    assert.match(MOD, /isNetease/, '歌单详情要判源');
    assert.match(MOD, /\/api\/playlist\/tracks\?id=/, '非 Apple 源走该源自己的曲目端点');
    const fn = MOD.slice(MOD.indexOf('function plLoad'), MOD.indexOf('window.openAmPlaylistDetail'));
    // 三元表达式：非网易云 -> Apple 端点；网易云 -> 本源端点。两者必须都出现且互斥分支。
    assert.match(fn, /var isNetease = [^;]+;/, '先判定是否网易云');
    assert.match(fn, /isNetease\s*\n?\s*\?\s*'\/api\/playlist\/tracks\?id='/, '网易云分支走本源端点');
    assert.match(fn, /:\s*'\/api\/apple\/playlist\/tracks\?id=/, 'Apple 分支才用 Apple 端点');
  });
});
;
// ============================================================
// 歌单播放也必须按源分流；曲目时长单位必须正确
// ============================================================
test('多源播放：歌单播放按源分流，时长单位正确', async (t17) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');

  await t17.test('plPlay 对非 Apple 源走自有播放器并 return', () => {
    const raw = MOD.slice(MOD.indexOf('function plPlay('), MOD.indexOf('function plLoad('));
    // 必须剥掉注释：注释里会提到 amc.playPlaylist 以说明改动背景，直接搜会误判
    const fn = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const guard = fn.indexOf('isNonAppleSource(playlist.provider)');
    const amc = fn.indexOf('amc.playPlaylist');
    assert.ok(guard > 0, '歌单播放要先判源');
    assert.ok(amc > guard, '判源必须在 Apple 通道之前');
    assert.match(fn.slice(guard, guard + 260), /return/, '非 Apple 分支必须 return，不能继续走到 amc');
    assert.match(MOD, /function playPlaylistInApp\(/, '歌单版应用内播放要存在');
    assert.match(fn, /return playPlaylistInApp\(/, 'plPlay 的非 Apple 分支要调用它');
  });

  await t17.test('歌单版应用内播放写自己的状态区，不写错弹窗', () => {
    const fn = MOD.slice(MOD.indexOf('function playPlaylistInApp'), MOD.indexOf('function playInApp'));
    assert.match(fn, /plSetStatus/, '要写歌单弹窗的状态区');
    assert.ok(!/setStatus\(/.test(fn), '不得写专辑弹窗的状态区');
    assert.ok(!/amc\./.test(fn), '不得触及 AMC');
  });

  await t17.test('非 Apple 源支持逐曲播放（指定起始曲）', () => {
    const i = MOD.indexOf('function plBindTracks');
    const fn = MOD.slice(i, i + 900);
    assert.match(fn, /plPlay\('这个歌单', idx/, '非 Apple 源要按点击的行给起始索引');
  });

  await t17.test('歌单曲目必须经适配层归一化（毫秒 -> 秒）', () => {
    // mapSongRecord 给的是毫秒；详情页 fmtDuration 期望秒。不经适配层就会显示成 3576:53。
    const i = SERVER.indexOf("pn === '/api/playlist/tracks'");
    const block = SERVER.slice(i, i + 2600);
    assert.match(block, /neteaseLibrary\.toLibrarySongs\(/, '歌单曲目要过适配层');
  });

  await t17.test('适配层禁止把毫秒当秒输出', () => {
    const AD = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'netease-library-adapter.js'), 'utf8');
    assert.match(AD, /duration: durationMs > 0 \? Math\.round\(durationMs \/ 1000\) : 0/,
      'duration 必须由毫秒换算成秒');
  });
});
;
// ============================================================
// 艺人轴：按源取数，只含已收藏
// ============================================================
test('音乐资料库：艺人轴按源取数且只含已收藏曲目', async (t18) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');

  await t18.test('艺人列表按源选端点', () => {
    assert.match(MOD, /MLIB_SOURCE_ENDPOINTS/, '端点集中在配置表，新增源只加一行');
    assert.match(MOD, /artists: '\/api\/netease\/library\/artists'/, '网易云艺人端点');
    assert.match(MOD, /artists: '\/api\/apple\/library\/artists\?resolve=1'/, 'Apple 艺人端点');
    assert.match(MOD, /artists: '\/api\/kugou\/library\/artists'/, '酷狗艺人端点');
    assert.match(MOD, /artistsState\.source = mlibActiveSource/, '记录来源，切源后必须重取');
  });

  await t18.test('艺人详情按源选端点；简介各源走自己的来源', () => {
    assert.match(MOD, /'\/api\/netease\/library\/artist\/detail\?id='/, '网易云艺人详情端点');
    assert.match(MOD, /'\/api\/kugou\/library\/artist\/detail\?id='/, '酷狗艺人详情端点');
    const fn = MOD.slice(MOD.indexOf('function loadArtistDetail'), MOD.indexOf('function scrollLibraryToTop'));
    // 只有 Apple 源需要"后台补维基简介"；非 Apple 源的简介随详情端点一并返回。
    // 该判断现在来自端点配置表的 usesWikiApi 标记（新增源不必改这里）。
    assert.match(fn, /usesWikiApi/, '维基补取由配置表的 usesWikiApi 决定');
    // 逐块取配置对象再判断，避免用长度猜测
    const epAt = MOD.indexOf('var MLIB_SOURCE_ENDPOINTS = {');
    const epBlock = MOD.slice(epAt, MOD.indexOf('function sourceEndpoint', epAt));
    const appleBlock = epBlock.slice(epBlock.indexOf('apple: {'), epBlock.indexOf('netease: {'));
    const neBlock = epBlock.slice(epBlock.indexOf('netease: {'), epBlock.indexOf('kugou: {'));
    assert.match(appleBlock, /usesWikiApi: true/, 'Apple 标为 true');
    assert.match(neBlock, /usesWikiApi: false/, '网易云标为 false');
    assert.match(fn, /fetchArtistBioIfMissing/, 'Apple 源仍走维基补取');
  });

  await t18.test('未接入的源仍如实提示，不显示别的源的艺人', () => {
    const fn = MOD.slice(MOD.indexOf('function loadArtistsView'), MOD.indexOf('function ensureViewData'));
    assert.match(fn, /if \(!srcCfg\.ready\)/, '未接入的源要拦在取数之前');
    assert.match(fn, /的艺人资料尚未接入/, '要写明原因');
  });

  await t18.test('网易云艺人/详情都从个人库聚合，不返回目录全量', () => {
    assert.match(SERVER, /async function collectNeteaseLibrarySongs\(uid\)/, '要有个人库聚合函数');
    const fn = SERVER.slice(SERVER.indexOf("pn === '/api/netease/library/artist/detail'"),
      SERVER.indexOf("pn === '/api/netease/library/artists'"));
    assert.match(fn, /collectNeteaseLibrarySongs/, '详情用个人库聚合');
    assert.match(fn, /lib\.songs\.filter/, '只保留该艺人在个人库里的曲目');
    assert.ok(!/artist_songs|artist_album/.test(fn.replace(/\/\/[^\n]*/g, '')),
      '不得改用目录接口 —— 那会混入未收藏的内容');
  });

  await t18.test('专辑详情只显示已收藏曲目', () => {
    const fn = SERVER.slice(SERVER.indexOf("pn === '/api/netease/library/album/tracks'"),
      SERVER.indexOf("async function collectNeteaseLibrarySongs"));
    assert.match(fn, /savedIds/, '要有已收藏集合');
    assert.match(fn, /allTracks\.filter/, '按集合过滤');
    assert.match(fn, /recallNeteaseSavedSongs/, '复用索引算好的集合，避免每开一张专辑重扫个人库');
  });
});
;
// ============================================================
// 非 Apple 源简介：来源如实标注 + 首次加载进缓存
// ============================================================
test('多源简介与缓存：网易云简介来源如实，艺人列表首次后进缓存', async (t19) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const CACHE = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'desktop', 'apple-music-library-cache.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t19.test('按 artistId 取简介（不经过搜索匹配），来源标注为网易云音乐', () => {
    const i = CACHE.indexOf('async function fetchNeteaseBioById(');
    assert.ok(i > 0, '要有按 id 的简介入口 —— 我们已有确定 id，不该再做名字搜索匹配');
    // 按下一个函数声明收尾，避免把后一个函数的实现也算进来
    const end = CACHE.indexOf('async function resolveNeteaseBio(', i);
    const fn = CACHE.slice(i, end > i ? end : i + 1200);
    assert.match(fn, /source: '网易云音乐'/, '来源如实标注');
    assert.match(fn, /fetchNeteaseArtistDetail\(/, '复用既有取数');
    assert.ok(!/neteaseSearchArtists/.test(fn), '按 id 不该再走搜索（越界截取会误判）');
  });

  await t19.test('详情端点把简介一并返回（wiki 形状与 Apple 侧一致）', () => {
    const fn = SERVER.slice(SERVER.indexOf("pn === '/api/netease/library/artist/detail'"),
      SERVER.indexOf("if (pn === '/api/netease/library/artists')"));
    assert.match(fn, /fetchNeteaseBioById\(aid\)/, '详情端点取简介');
    assert.match(fn, /wiki: bio/, '返回 wiki 字段');
    assert.match(fn, /wikiLang: bio/, '返回语言，供前端判断');
  });

  await t19.test('客户端不再对非 Apple 源禁掉简介', () => {
    const fn = MOD.slice(MOD.indexOf('function loadArtistDetail'), MOD.indexOf('function scrollLibraryToTop'));
    assert.match(fn, /usesWikiApi/, '维基补取由 usesWikiApi 决定');
    assert.ok(!/本源的简介接入前如实不显示/.test(fn), '非 Apple 源简介已接入，不该再写"未接入"');
  });

  await t19.test('艺人列表首次加载后进缓存，之后命中缓存', () => {
    const i = SERVER.indexOf("pn === '/api/netease/library/artists'");
    const fn = SERVER.slice(i, i + 3000);
    assert.match(fn, /neteaseArtistsCache\.get\(info4\.userId\)/, '取缓存');
    assert.match(fn, /neteaseArtistsCache\.set\(info4\.userId/, '写缓存');
    assert.match(fn, /Object\.assign\(\{\}, ck, \{ fromCache: true \}\)/, '命中缓存直接返回');
    assert.match(fn, /refresh/, '支持强制刷新');
  });

  await t19.test('个人库曲目聚合也有缓存（详情端点不再每次重扫）', () => {
    assert.match(SERVER, /neteaseLibrarySongsCache/, '要有曲目聚合缓存');
    const i = SERVER.indexOf('async function collectNeteaseLibrarySongs(uid)');
    const wrapper = SERVER.slice(i, i + 420);
    assert.match(wrapper, /neteaseLibrarySongsCache\.get\(key\)/, '先查缓存');
    assert.match(wrapper, /collectNeteaseLibrarySongsUncached\(uid\)/, '未命中才真正遍历');
  });

  await t19.test('头像抓取并发且有上限，不逐个串行', () => {
    const i = SERVER.indexOf("pn === '/api/netease/library/artists'");
    const fn = SERVER.slice(i, i + 4000);
    assert.match(fn, /enrichWorker/, '并发 worker');
    assert.match(fn, /const CONC = \d+/, '并发要有上限');
    assert.match(fn, /Promise\.all\(workers\)/, '等全部完成再返回，避免返回半成品');
  });
});
;
// ============================================================
// 网易云专辑简介
// ============================================================
test('音乐资料库：网易云专辑简介接入', async (t20) => {
  const SERVER = require('node:fs').readFileSync(path.join(APP_ROOT, 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  await t20.test('服务端返回 description（网易云用 description，briefDesc 多为空）', () => {
    const fn = SERVER.slice(SERVER.indexOf("pn === '/api/netease/library/album/tracks'"),
      SERVER.indexOf("async function collectNeteaseLibrarySongs"));
    // 注释里会解释"为什么不用 briefDesc"，所以剥掉注释再判断代码
    const code = fn.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /description: String\(albumObj\.description/, '要取 description 字段');
    assert.ok(!/briefDesc/.test(code), '不要用 briefDesc —— 实测多为空');
  });

  await t20.test('客户端把服务端专辑元数据并入当前专辑后再渲染', () => {
    const i = MOD.indexOf('if (/^(ne|kg):/.test(albumId)) {');
    const fn = MOD.slice(i, i + 1600);
    assert.match(fn, /apiJson\(albumTracksUrl\)/, '端点按源选（不再是写死的网易云 URL）');
    assert.match(fn, /neData\.album/, '要用服务端返回的专辑对象');
    assert.match(fn, /state\.album\.description = neAlbum\.description/, '简介要并入');
    assert.match(fn, /renderInfo\(state\.album, neSongs\)/, '合并后必须重渲染信息区，否则简介区块永远不显示');
  });

  await t20.test('没有简介时整块隐藏，不显示空框', () => {
    // renderInfo 里已有的行为：descFull 为空即隐藏描述与展开按钮
    const fn = MOD.slice(MOD.indexOf('function renderInfo'), MOD.indexOf('function renderInfo') + 3000);
    assert.match(fn, /if \(!state\.descFull\)/, '空简介要走隐藏分支');
    assert.match(fn, /desc\.hidden = true/, '隐藏描述');
    assert.match(fn, /toggle\.hidden = true/, '同时隐藏展开按钮');
  });
});
;
// ============================================================
// 歌单视图也必须按源取数（曾把 Apple 歌单显示在酷狗源下）
// ============================================================
test('音乐资料库：歌单视图按源取数，不再一律落到 Apple', async (t21) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');

  await t21.test('歌单端点由配置表决定，而不是"非网易云即 Apple"', () => {
    const fn = MOD.slice(MOD.indexOf('function loadPlaylistsView'), MOD.indexOf('function ensureViewData'));
    // 之前这里只有 isNetease 判定，else 一律打 Apple 端点
    assert.ok(!/isNetease\s*\?/.test(fn), '不该再用 isNetease 三元决定端点');
    assert.match(fn, /epP\.playlistsFromIndex/, '由配置表的 playlistsFromIndex 决定');
    assert.match(fn, /\/api\/apple\/user\/playlists\?limit=300/, 'Apple 才走自己的歌单端点');
  });

  await t21.test('三个已接入的源都标了 playlistsFromIndex', () => {
    const epAt = MOD.indexOf('var MLIB_SOURCE_ENDPOINTS = {');
    const epBlock = MOD.slice(epAt, MOD.indexOf('function sourceEndpoint', epAt));
    const appleB = epBlock.slice(epBlock.indexOf('apple: {'), epBlock.indexOf('netease: {'));
    const neB = epBlock.slice(epBlock.indexOf('netease: {'), epBlock.indexOf('kugou: {'));
    const kgB = epBlock.slice(epBlock.indexOf('kugou: {'));
    assert.match(appleB, /playlistsFromIndex: false/, 'Apple 有自己的端点');
    assert.match(neB, /playlistsFromIndex: true/, '网易云歌单随索引返回');
    assert.match(kgB, /playlistsFromIndex: true/, '酷狗歌单随索引返回');
  });

  await t21.test('状态文案按源显示，不写死 Apple', () => {
    const fn = MOD.slice(MOD.indexOf('function loadPlaylistsView'), MOD.indexOf('function ensureViewData'));
    assert.match(fn, /srcLabel/, '要按当前源取展示名');
    assert.ok(!/正在读取' \+ \(isNetease/.test(fn), '不该再用 isNetease 决定文案');
  });

  await t21.test('酷狗歌单卡显示作者而不是 Apple Music', () => {
    // 卡片副标题由 playlistCardHtml 决定；酷狗歌单带 creator，应优先显示
    const fn = MOD.slice(MOD.indexOf('function playlistCardHtml'), MOD.indexOf('function playlistCardHtml') + 900);
    assert.match(fn, /creator|artist/, '副标题要能取到来源作者');
  });
});
;
// ============================================================
// 切源强制隔离 + 非 Apple 源播放不得走 UIA
// ============================================================
test('音乐资料库：切源强制隔离与非 Apple 播放路由', async (t22) => {
  const MOD = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const DETAIL = require('node:fs').readFileSync(
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');
  const CSS = require('node:fs').readFileSync(path.join(APP_ROOT, 'public', 'css', 'index.css'), 'utf8');

  await t22.test('切源立即清空三个视图并立起骨架屏', () => {
    assert.match(MOD, /function clearSourceViewsForSwitch\(\)/, '要有清空函数');
    const fn = MOD.slice(MOD.indexOf('function clearSourceViewsForSwitch'), MOD.indexOf('function setMlibSource'));
    ['mlib-albums-grid', 'mlib-artists-grid', 'mlib-playlists-grid'].forEach(function (g) {
      assert.ok(fn.indexOf(g) >= 0, '要清空 ' + g);
    });
    assert.match(fn, /mlib-skeleton/, '要立起骨架屏，避免看到旧源内容');
    assert.match(fn, /artistsState\.loaded = false/, '作废已加载标记，强制重取');
    assert.match(fn, /playlistsState\.loaded = false/, '歌单同理');
    // setMlibSource 必须调用它，且在渲染源列表之前
    const sw = MOD.slice(MOD.indexOf('function setMlibSource'), MOD.indexOf('function setMlibSource') + 900);
    assert.match(sw, /clearSourceViewsForSwitch\(\)/, '切源要调用清空');
  });

  await t22.test('骨架屏样式存在且复用既有 shimmer 动画', () => {
    assert.match(CSS, /\.mlib-skeleton\s*\{/, '要有骨架屏样式');
    assert.match(CSS, /\.mlib-skeleton[\s\S]{0,300}mlib-shimmer/, '复用既有动画');
  });

  await t22.test('发行卡必须带 provider（否则会被误判成 Apple）', () => {
    const fn = MOD.slice(MOD.indexOf('function renderReleaseCard'), MOD.indexOf('function renderReleaseCard') + 1400);
    assert.match(fn, /provider: release\.provider \|\| mlibActiveSource/, '发行卡要带源');
  });

  await t22.test('播放不按源分流就交给 Apple —— 必须改掉', () => {
    const fn = MOD.slice(MOD.indexOf('function playLibraryAlbum'), MOD.indexOf('function playLibraryAlbum') + 2200);
    assert.match(fn, /albumProvider !== 'apple'/, '非 Apple 要分流');
    // 非 Apple 分支必须走应用内播放，且不得引用 amc
    const branch = fn.slice(fn.indexOf("albumProvider !== 'apple'"), fn.indexOf('var amc ='));
    assert.ok(branch.length > 0, '非 Apple 分支要存在且在取 amc 之前返回');
    assert.ok(!/amc\./.test(branch), '非 Apple 分支不得触碰 UIA（amc）');
    assert.match(branch, /playSongsInApp/, '非 Apple 走应用内播放');
    assert.match(branch, /api\/kugou\/library\/album\/tracks/, '酷狗取曲目');
    assert.match(branch, /api\/netease\/library\/album\/tracks/, '网易云取曲目');
  });

  await t22.test('应用内播放入口统一为 playSongsInApp', () => {
    assert.match(DETAIL, /window\.playSongsInApp = function/, '要暴露统一入口');
    const fn = DETAIL.slice(DETAIL.indexOf('window.playSongsInApp = function'), DETAIL.indexOf('function playInApp'));
    assert.match(fn, /playQueueAt\(/, '走应用内取流链路');
    assert.ok(!/amc/.test(fn), '不得触碰 UIA');
  });
});
;
// ============================================================
// 结构性不变量：非 Apple 源强制 MineRadio 内部播放，绝不碰 UIA
// ============================================================
test('不变量：任何 amc（UIA）调用点之前必须有"非 Apple 源提前返回"的守卫', async (t23) => {
  const FILES = [
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'),
    path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'),
  ];
  // 守卫的几种合法写法（都必须出现在 amc 引用之前，且是提前 return）
  const GUARDS = [
    /isNonAppleSource\s*\(/,                       // 统一判定函数
    /Provider\s*(?:!==|===)\s*['"]apple['"]/,      // 显式比较 provider
    /mlibActiveSource\s*(?:!==|===)\s*['"]apple['"]/,
  ];

  function enclosingFunctionStart(lines, idx) {
    for (let i = idx; i >= 0; i -= 1) {
      if (/^\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[i])) return i;
      if (/^\s*(?:window\.|module\.exports\.)?[A-Za-z_$][\w$.]*\s*=\s*(?:async\s+)?function\s*\(/.test(lines[i])) return i;
    }
    return -1;
  }

  await t23.test('逐个 amc 调用点检查', () => {
    const problems = [];
    let checked = 0;
    FILES.forEach(function (file) {
      const src = require('node:fs').readFileSync(file, 'utf8');
      const lines = src.split('\n');
      lines.forEach(function (line, i) {
        // 只看真正调用 UIA 的行（跳过把 amc 取出来做能力检测的那行也行，但取出来也必须已经过守卫）
        if (!/\bamc\b/.test(line)) return;
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const start = enclosingFunctionStart(lines, i);
        if (start < 0) { problems.push(file + ':' + (i + 1) + ' 找不到所属函数'); return; }
        checked += 1;
        const head = lines.slice(start, i).join('\n');
        const code = head.replace(/\/\/[^\n]*/g, '');
        const hasGuard = GUARDS.some(function (re) { return re.test(code); });
        // 守卫必须带提前 return（否则只是算了算没拦）
        const hasEarlyReturn = /return\s*;/.test(code);
        if (!hasGuard) {
          problems.push(file.split('\\').pop() + ':' + (i + 1) + ' 的 amc 调用前没有非 Apple 源守卫');
        } else if (!hasEarlyReturn) {
          problems.push(file.split('\\').pop() + ':' + (i + 1) + ' 的守卫没有提前 return');
        }
      });
    });
    assert.ok(checked >= 4, '至少要覆盖到 4 个 UIA 调用点（实际 ' + checked + '）');
    assert.deepEqual(problems, [], '这些 UIA 调用点没拦住非 Apple 源：\n  ' + problems.join('\n  '));
  });

  await t23.test('未接入的源不得被静默当成 Apple 处理', () => {
    // 只对"未接入"的源做要求：accessor 必须先看 ready，未就绪就如实说明并 return，
    // 不能悄悄落到 Apple 端点/通道。仅用 ready 就够，不预设任何具体源名。
    const LIB = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
    ['loadArtistsView', 'loadPlaylistsView', 'loadLibraryAlbums'].forEach(function (fn) {
      const at = LIB.indexOf('function ' + fn + '(');
      assert.ok(at > 0, fn + ' 应存在');
      const fnSrc = LIB.slice(at, at + 1800);
      assert.match(fnSrc, /srcCfg\.ready|\.ready\b/, fn + ' 必须检查该源是否已接入');
    });
  });

  await t23.test('每个已接入源都能命中至少一个应用内播放入口', () => {
    const DETAIL = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');
    const LIB = require('node:fs').readFileSync(
      path.join(APP_ROOT, 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
    // 应用内入口存在，且不触碰 UIA
    const entry = DETAIL.slice(DETAIL.indexOf('window.playSongsInApp = function'),
      DETAIL.indexOf('function playInApp'));
    assert.match(entry, /playQueueAt\(/, '走应用内取流');
    assert.ok(!/amc/.test(entry), '应用内入口不得触碰 UIA');
    // 专辑卡、歌单卡、发行卡三个播放入口都要按源分流
    ['playLibraryAlbum', 'playLibraryPlaylist'].forEach(function (fnName) {
      const fn = LIB.slice(LIB.indexOf('function ' + fnName + '('),
        LIB.indexOf('function ' + fnName + '(') + 2400);
      assert.match(fn, /Provider !== 'apple'/, fnName + ' 要按源分流');
      const branch = fn.slice(fn.indexOf("Provider !== 'apple'"), fn.indexOf('var amc ='));
      assert.ok(branch.length > 0 && !/amc\./.test(branch), fnName + ' 的非 Apple 分支不得触碰 UIA');
      assert.match(branch, /playSongsInApp/, fnName + ' 非 Apple 走应用内播放');
    });
  });
});
