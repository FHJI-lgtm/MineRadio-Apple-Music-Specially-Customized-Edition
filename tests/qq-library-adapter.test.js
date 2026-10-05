'use strict';
// QQ 音乐 → 音乐资料库 适配层契约测试。
// 与网易云/酷狗同一套策略：字段不确定就留空，绝不编造。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'qq-library-adapter.js'));

// 实测样本（/api/qq/playlist/tracks 的真实返回）
const RAW = {
  provider: 'qq', source: 'qq', type: 'qq',
  id: '004NQiTg00To4D', qqId: 203784424,
  mid: '004NQiTg00To4D', songmid: '004NQiTg00To4D', mediaMid: '000zdjDt3RGnf7',
  name: 'Never Going Back',
  artist: 'The Score',
  artists: [{ id: 104574, mid: '0023TAHr2UmE2p', name: 'The Score' }],
  artistId: 104574, artistMid: '0023TAHr2UmE2p',
  album: 'Never Going Back', albumMid: '000aR2xc1Ur0lx',
  cover: 'https://y.qq.com/music/photo_new/T002R300x300M000000aR2xc1Ur0lx.jpg',
  duration: 197000, fee: 0, playable: false,
};

test('QQ 适配：曲目映射', async (t) => {
  await t.test('身份与取流标识用 mid（不是数字 id）', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.librarySongId, 'qq:004NQiTg00To4D');
    assert.equal(s.id, '004NQiTg00To4D', '播放器按 mid 取流 /api/qq/song/url?mid=');
    assert.equal(s.mid, RAW.mid);
    assert.equal(s.provider, 'qq');
    assert.equal(s.type, 'qq');
    assert.equal(s.name, 'Never Going Back');
    assert.equal(s.artist, 'The Score');
  });

  await t.test('专辑/艺人标识用 mid，时长毫秒换算成秒', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.albumId, '000aR2xc1Ur0lx', 'albumMid -> albumId');
    assert.equal(s.albumMid, '000aR2xc1Ur0lx');
    assert.equal(s.albumName, 'Never Going Back');
    assert.equal(s.artistMid, '0023TAHr2UmE2p');
    assert.equal(s.durationMs, 197000);
    assert.equal(s.duration, 197, '毫秒换算（若误留毫秒会显示成 3283 分钟）');
  });

  await t.test('以 0 开头的 mid 不能被当成无效值丢掉', () => {
    // QQ 的 mid 常以 0 开头（实测 000aR2xc1Ur0lx / 0023TAHr2UmE2p / 0007Okjj3kXfP7）
    ['000aR2xc1Ur0lx', '0023TAHr2UmE2p', '004NQiTg00To4D'].forEach(function (m) {
      assert.equal(A.validId(m), m, m + ' 必须保留');
    });
    assert.equal(A.validId('0'), '', '真正的 0 才该丢弃');
    assert.equal(A.validId(''), '');
    assert.equal(A.validId(null), '');
  });

  await t.test('数据不确定的字段留空；缺 mid 或缺标题的丢弃', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.releaseDate, '');
    assert.equal(s.trackNumber, 0);
    assert.equal(s.genre, '');
    assert.equal(A.toLibrarySong(null), null);
    assert.equal(A.toLibrarySong({ name: 'x' }), null, '没有 mid');
    assert.equal(A.toLibrarySong({ mid: 'abc' }), null, '没有标题');
    assert.equal(A.toLibrarySongs([RAW, null, { mid: 'x' }]).length, 1);
  });
});

test('QQ 适配：歌单与专辑', async (t) => {
  await t.test('歌单映射；「我的喜欢」按 virtual 标记识别', () => {
    const p = A.toLibraryPlaylist({ id: 'liked', name: 'QQ 音乐·我的喜欢', virtual: true, specialType: 5 });
    assert.equal(p.id, 'liked');
    assert.equal(p.virtual, true);
    assert.equal(p.isLiked, true);
    assert.equal(A.toLibraryPlaylist({ id: '9035601208', name: '链接导入' }).isLiked, false);
    assert.equal(A.toLibraryPlaylist({ name: '无 id' }), null);
  });

  await t.test('专辑卡与 Apple 索引同形，且必须能吃下 albumsFromSongs 的产物', () => {
    // 这一条守一个真实缺陷：albumsFromSongs 曾只给 albumId 不给 albumMid，
    // 而卡片按 albumMid 取 -> 专辑轴静默变成 0 张。
    const songs = A.toLibrarySongs([
      { mid: 'm1', name: 'a', album: 'A', albumMid: '000aR2xc1Ur0lx', artist: 'x', duration: 1000 },
    ]);
    const merged = A.albumsFromSongs(songs);
    assert.equal(merged.length, 1);
    const card = A.toAppleShapedAlbumCard(merged[0]);
    assert.ok(card, '归并产物必须能转成专辑卡（不能是 null）');
    assert.equal(card.provider, 'qq');
    assert.equal(card.id, 'qq:000aR2xc1Ur0lx');
    assert.equal(card.releaseDate, '', '从曲目归并没有发行日期，留空');
    assert.equal(card.dateAdded, '');
    assert.deepEqual(card.genreNames, []);
  });

  await t.test('专辑端点提供的 releaseDate 要带上', () => {
    const card = A.toAppleShapedAlbumCard({ albumMid: '000aR2xc1Ur0lx', name: 'A', releaseDate: '2017-09-08' });
    assert.equal(card.releaseDate, '2017-09-08');
  });

  await t.test('按 albumMid 归并，缺的不参与', () => {
    const songs = A.toLibrarySongs([
      { mid: 'm1', name: 'a', album: 'A', albumMid: '000a', artist: 'x', duration: 1000 },
      { mid: 'm2', name: 'b', album: 'A', albumMid: '000a', artist: 'x', duration: 1000, cover: 'c' },
      { mid: 'm3', name: 'c', album: 'A', duration: 1000 },
    ]);
    const albums = A.albumsFromSongs(songs);
    assert.equal(albums.length, 1);
    assert.equal(albums[0].trackCount, 2);
    assert.equal(albums[0].cover, 'c');
  });
});

test('QQ 适配：艺人聚合（身份键 artistMid）', async (t) => {
  await t.test('按 artistMid 归并；同名不同 mid 不合并', () => {
    const songs = A.toLibrarySongs([
      { mid: 'm1', name: 'a', artist: '同名', artists: [{ id: 1, mid: 'ma', name: '同名' }], album: 'A', albumMid: 'al', duration: 1000 },
      { mid: 'm2', name: 'b', artist: '同名', artists: [{ id: 2, mid: 'mb', name: '同名' }], album: 'A', albumMid: 'al', duration: 1000 },
      { mid: 'm3', name: 'c', artist: '同名 / Y', artists: [{ id: 1, mid: 'ma', name: '同名' }, { id: 3, mid: 'my', name: 'Y' }], album: 'A', albumMid: 'al', duration: 1000 },
    ]);
    const artists = A.artistsFromSongs(songs);
    assert.equal(artists.length, 3, 'mid 不同 -> 不同的人');
    assert.equal(artists.filter(a => a.artistId === 'ma')[0].songCount, 2);
    assert.equal(artists.filter(a => a.artistId === 'ma')[0].artistMid, 'ma', '要带上 artistMid 供取头像');
  });

  await t.test('头像留空：不得用曲目封面冒充', () => {
    const songs = A.toLibrarySongs([{ mid: 'm1', name: 'a', artist: 'X', artists: [{ mid: 'mx', name: 'X' }], album: 'A', albumMid: 'al', duration: 1000, cover: 'cover-x' }]);
    const a = A.artistsFromSongs(songs)[0];
    assert.equal(a.image, '');
    assert.equal(a.hasImage, false);
  });
});

test('QQ 接入的接线（端点与源登记）', async (t) => {
  const SERVER = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const DETAIL = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  await t.test('服务端四个端点齐备，且只显示已收藏', () => {
    ['/api/qq/library/index', '/api/qq/library/album/tracks', '/api/qq/library/artists', '/api/qq/library/artist/detail',
     '/api/qq/library/playlist/tracks'].forEach(function (p) {
      assert.ok(SERVER.indexOf(p) >= 0, '缺端点 ' + p);
    });
    const i = SERVER.indexOf("pn === '/api/qq/library/album/tracks'");
    const fn = SERVER.slice(i, i + 2200);
    assert.match(fn, /savedIds/, '专辑详情要按已收藏过滤');
    assert.match(fn, /collectQQLibrary/, '复用个人库聚合（带缓存）');
  });

  await t.test('客户端登记了 QQ 且标为已接入', () => {
    assert.match(MOD, /qq: \{ label: 'QQ 音乐', ready: true \}/, 'QQ 要标为已接入');
    assert.match(MOD, /index: '\/api\/qq\/library\/index'/, '索引端点');
    assert.match(MOD, /artists: '\/api\/qq\/library\/artists'/, '艺人端点');
    assert.match(MOD, /'\/api\/qq\/library\/artist\/detail\?id='/, '艺人详情端点');
    assert.match(MOD, /playlistsFromIndex: true/, 'QQ 歌单随索引返回');
  });

  await t.test('专辑/歌单详情按源分流到 QQ，不落到 Apple', () => {
    assert.ok(DETAIL.indexOf('(ne|kg|qq|qs|sp):') >= 0, '专辑/歌单的前缀判定要含 qq（以及后续源）');
    assert.ok(DETAIL.indexOf('/api/qq/library/album/tracks?id=') >= 0, '专辑曲目走 QQ 端点');
    assert.ok(DETAIL.indexOf('/api/qq/library/playlist/tracks?id=') >= 0, '歌单曲目走 QQ 端点');
    const i2 = DETAIL.indexOf('var isQQ = /^qq:/.test(id)');
    assert.ok(i2 > 0, '歌单要显式识别 qq');
    // 源变多后歌单分支嵌套更深，切片要够（700 会截断在 Spotify 分支之前）
    assert.ok(DETAIL.slice(i2, i2 + 1800).indexOf('/api/qq/library/playlist/tracks') > 0, 'QQ 歌单走自己的端点');
  });

  await t.test('专辑卡与歌单卡的播放按源分流到 QQ', () => {
    ['playLibraryAlbum', 'playLibraryPlaylist'].forEach(function (fnName) {
      const fn = MOD.slice(MOD.indexOf('function ' + fnName + '('), MOD.indexOf('function ' + fnName + '(') + 2600);
      assert.match(fn, /qq/, fnName + ' 要处理 QQ');
      assert.match(fn, /\/api\/qq\/library\//, fnName + ' 走 QQ 端点');
    });
  });
});

test('QQ 封面取色要走本地代理（y.qq.com 不返回 CORS 头）', async (t2) => {
  const DETAIL = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');
  const SERVER = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  await t2.test('存在按域名决定是否走代理的转换函数', () => {
    assert.ok(DETAIL.indexOf('function coverThemeSource(') > 0, '要有 coverThemeSource');
    // 名单常量声明在函数**之前**，切片必须从那里开始
    const i = DETAIL.indexOf('var COVER_THEME_PROXY_HOSTS');
    const fn = DETAIL.slice(i, i + 1200);
    assert.ok(fn.indexOf('/api/cover?url=') > 0, '走带 CORS 头的本地代理');
    assert.ok(fn.indexOf("'y.qq.com'") > 0, 'QQ 域名必须在需要代理的名单里');
    assert.ok(fn.indexOf("host === h || host.slice(-(h.length + 1)) === '.' + h") > 0,
      '要按域名后缀匹配，避免 evil-y.qq.com 之类被误判');
  });

  await t2.test('取色用的是代理地址，而页面显示的 img 仍是原地址', () => {
    // applyCoverTheme 里 img.src 必须经过 coverThemeSource
    const i = DETAIL.indexOf('function applyCoverTheme(');
    const fn = DETAIL.slice(i, i + 3200);
    assert.ok(fn.indexOf('img.src = coverThemeSource(coverUrl)') > 0, '取色要经转换');
    assert.ok(fn.indexOf("img.crossOrigin = 'anonymous'") > 0, 'canvas 取像素需要 crossOrigin');
    // crossOrigin 必须在 src 之前设置（顺序反了不生效）
    assert.ok(fn.indexOf("img.crossOrigin = 'anonymous'") < fn.indexOf('img.src = coverThemeSource(coverUrl)'),
      'crossOrigin 必须先于 src');
  });

  await t2.test('代理端点本身带 CORS 头（canvas 才读得到像素）', () => {
    const i = SERVER.indexOf("pn === '/api/cover'");
    assert.ok(i > 0, '要有 /api/cover 端点');
    const fn = SERVER.slice(i, i + 1200);
    assert.ok(fn.indexOf("'Access-Control-Allow-Origin': '*'") > 0, '必须带 ACAO');
    assert.ok(fn.indexOf('Cross-Origin-Resource-Policy') > 0, '要带 CORP');
  });

  await t2.test('未命中代理名单的地址原样返回，不增加无谓开销', () => {
    // Apple / 网易云 / 酷狗 实测都返回 ACAO: *，不该被代理
    const i = DETAIL.indexOf('var COVER_THEME_PROXY_HOSTS');
    const fn = DETAIL.slice(i, i + 700);
    assert.ok(!/mzstatic/.test(fn), 'Apple 域名不该进名单');
    assert.ok(!/126\.net/.test(fn), '网易云域名不该进名单');
    assert.ok(!/kugou/.test(fn), '酷狗域名不该进名单');
  });
});

test('QQ 艺人简介（在 singer_brief，不在 singer_info）', async (t3) => {
  const SERVER = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  await t3.test('handleQQArtistDetail 必须解析 singer_brief', () => {
    const i = SERVER.indexOf('async function handleQQArtistDetail');
    assert.ok(i > 0, '函数应存在');
    // 取到下一个函数声明为止，避免越界误判
    const end = SERVER.indexOf('async function handleQQAlbumDetail', i);
    const fn = SERVER.slice(i, end > i ? end : i + 3000);
    assert.ok(fn.indexOf('singer_brief') >= 0,
      '简介在 data.singer_brief（实测 The Score 648 字）；只看 singer_info 会永远拿不到');
    assert.ok(fn.indexOf('introduction') >= 0, '要把它暴露成 introduction');
  });

  await t3.test('资料库艺人详情把它接成 wiki 并标注来源', () => {
    // 该端点的 wiki 字段在片段较靠后处，切片要够长（否则误判为"没接线"）
    const i = SERVER.indexOf("pn === '/api/qq/library/artist/detail'");
    const fn = SERVER.slice(i, i + 4200);
    assert.ok(fn.indexOf('ar.introduction') >= 0, '要读 introduction');
    assert.ok(fn.indexOf("source: 'QQ 音乐'") >= 0, '来源如实标注');
    // 拿不到就不显示（wiki 为 null），不编造
    assert.ok(/wiki: qBio/.test(fn), 'wiki 由简介决定');
  });

  await t3.test('简介为空时不编造', () => {
    const i = SERVER.indexOf('async function handleQQArtistDetail');
    const end = SERVER.indexOf('async function handleQQAlbumDetail', i);
    const fn = SERVER.slice(i, end > i ? end : i + 3000);
    // 只有 string 类型才采纳，其余给空串
    assert.ok(/typeof data\.singer_brief === 'string' \? data\.singer_brief : ''/.test(fn),
      '非字符串一律空串，不猜');
  });
});

test('QQ 专辑简介：独立的"大字段"接口', async (t4) => {
  const SERVER = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  await t4.test('必须走 GetAlbumDetail 的独立接口，而不是主接口', () => {
    assert.ok(SERVER.indexOf('async function fetchQQAlbumDesc(') > 0, '要有专门的取简介函数');
    const i = SERVER.indexOf('async function fetchQQAlbumDesc(');
    const end = SERVER.indexOf('async function handleQQAlbumDetail', i);
    const fn = SERVER.slice(i, end > i ? end : i + 1600);
    assert.ok(fn.indexOf('music.musichallAlbum.AlbumInfoServer') > 0,
      '主接口（c.y.qq.com 的 album detail）为了响应速度不返回大文本，简介在 musicu 的这个模块');
    assert.ok(fn.indexOf('GetAlbumDetail') > 0, '方法名');
    assert.ok(fn.indexOf('basicInfo') > 0, '简介在 basicInfo.desc');
    assert.ok(fn.indexOf('bi.desc') > 0, '取 desc 字段');
  });

  await t4.test('非字符串一律空串，不编造', () => {
    const i = SERVER.indexOf('async function fetchQQAlbumDesc(');
    const end = SERVER.indexOf('async function handleQQAlbumDetail', i);
    const fn = SERVER.slice(i, end > i ? end : i + 1600);
    assert.ok(/typeof bi\.desc === 'string' \? bi\.desc : ''/.test(fn), '只采纳字符串');
    assert.ok(/catch \(_\) \{[\s\S]{0,120}return ''/.test(fn), '异常时返回空串，不抛错不猜');
  });

  await t4.test('资料库专辑端点带上简介，且在使用前定义', () => {
    assert.ok(SERVER.indexOf('description: qqAlbumDesc,') > 0, '要接到 album.description');
    const defAt = SERVER.indexOf("let qqAlbumDesc = '';");
    const useAt = SERVER.indexOf('description: qqAlbumDesc,');
    assert.ok(defAt > 0 && defAt < useAt, '变量必须先定义后使用');
    assert.ok(SERVER.indexOf('await fetchQQAlbumDesc(amid)') > 0, '用专辑 mid 取简介');
  });

  await t4.test('该模块只被真正调用一次（注释里说明用途不算重复实现）', () => {
    // 用带 module: 前缀的实际调用计数，避免把注释里的名字也算进去
    const calls = SERVER.split("module: 'music.musichallAlbum.AlbumInfoServer'").length - 1;
    assert.equal(calls, 1, '实际调用只应有一处（实际 ' + calls + ' 处）');
    const defs = SERVER.split('async function fetchQQAlbumDesc(').length - 1;
    assert.equal(defs, 1, '取简介的函数只应定义一次（实际 ' + defs + ' 处）');
  });
});
