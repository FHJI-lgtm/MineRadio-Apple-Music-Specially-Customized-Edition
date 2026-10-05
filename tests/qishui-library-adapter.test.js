'use strict';
// 汽水音乐 → 音乐资料库 适配层契约测试。
// 与其它三个源同一套策略；这里重点钉住汽水**特有的差异**（都是实测得出的）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'qishui-library-adapter.js'));

// 实测样本（/api/qishui/playlist/tracks 的真实返回）
const RAW = {
  provider: 'qishui', source: 'qishui', type: 'qishui',
  id: '6772142136369350658', providerSongId: '6772142136369350658',
  name: 'Where Is Your Love',
  artist: 'J. Lisk',
  artists: [{ id: '6702338894014191618', name: 'J. Lisk', mid: '6702338894014191618' }],
  album: 'Where Is Your Love',
  cover: 'https://p3-luna.douyinpic.com/img/x.jpg',
  duration: 157, popularity: 0, fee: 1, playable: true,
};

test('汽水适配：duration 已经是秒，绝不能再除 1000', async (t) => {
  await t.test('157 秒必须原样保留', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.duration, 157, '若误当毫秒处理会变成 0 秒');
    assert.equal(s.durationMs, 157000, '内部毫秒字段才乘 1000');
  });

  await t.test('多条真实时长都落在合理区间', () => {
    // 实测样本：157 / 235 / 257 / 198 / 179 / 194
    [157, 235, 257, 198, 179, 194].forEach(function (sec) {
      const s = A.toLibrarySong(Object.assign({}, RAW, { duration: sec }));
      assert.equal(s.duration, sec);
      assert.ok(s.duration < 3600, '不该出现 3000+ 分钟的荒谬值');
    });
  });
});

test('汽水适配：曲目映射与 albumId 的诚实做法', async (t) => {
  await t.test('关键字段就位，取流标识用 id', () => {
    const s = A.toLibrarySong(RAW);
    assert.equal(s.librarySongId, 'qs:6772142136369350658');
    assert.equal(s.id, '6772142136369350658');
    assert.equal(s.provider, 'qishui');
    assert.equal(s.type, 'qishui');
    assert.equal(s.artistId, '6702338894014191618');
    assert.equal(s.albumName, 'Where Is Your Love');
  });

  await t.test('汽水不给 albumId —— 用名称+艺人派生 slug，且同一专辑稳定', () => {
    const a = A.toLibrarySong(RAW);
    const b = A.toLibrarySong(Object.assign({}, RAW, { id: 'other', name: 'Different Song' }));
    assert.ok(a.albumId, '要有可归并的专辑标识');
    assert.equal(a.albumId, b.albumId, '同专辑不同曲目必须归到同一个 slug');
    const c = A.toLibrarySong(Object.assign({}, RAW, { album: '另一张专辑' }));
    assert.notEqual(a.albumId, c.albumId, '不同专辑必须不同');
    assert.ok(/^a[0-9a-z]+$/.test(a.albumId), 'slug 形状稳定');
  });

  await t.test('缺 id 或缺标题的丢弃；不确定的字段留空', () => {
    assert.equal(A.toLibrarySong(null), null);
    assert.equal(A.toLibrarySong({ name: 'x' }), null, '没有 id');
    assert.equal(A.toLibrarySong({ id: 'abc' }), null, '没有标题');
    const s = A.toLibrarySong(RAW);
    assert.equal(s.releaseDate, '');
    assert.equal(s.trackNumber, 0);
    assert.equal(s.genre, '');
  });
});

test('汽水适配：歌单与专辑', async (t) => {
  await t.test('个人库歌单用 owned 判定，系统 virtual 条目不算', () => {
    const mine = A.toLibraryPlaylist({ id: '7328494693733203978', name: '李601喜欢的音乐', owned: true, trackCount: 131 });
    assert.equal(mine.owned, true);
    const virtualPl = A.toLibraryPlaylist({ id: 'qishui-recent', name: '汽水最近播放', virtual: true, owned: false, creator: '汽水音乐' });
    assert.equal(virtualPl.virtual, true);
    assert.equal(virtualPl.owned, false, '推荐/最近播放不属于个人库');
    const liked = A.toLibraryPlaylist({ id: 'qishui-liked', name: '汽水我的喜欢', virtual: true, owned: true, shelfPane: 'mine' });
    assert.equal(liked.isLiked, true, '「我的喜欢」要能识别');
    assert.equal(A.toLibraryPlaylist({ name: '无 id' }), null);
  });

  await t.test('专辑卡与 Apple 索引同形；缺 slug/名称不产出', () => {
    const songs = A.toLibrarySongs([RAW]);
    const merged = A.albumsFromSongs(songs);
    assert.equal(merged.length, 1);
    const card = A.toAppleShapedAlbumCard(merged[0]);
    assert.ok(card, '归并产物必须能转成专辑卡');
    assert.equal(card.provider, 'qishui');
    assert.ok(card.id.indexOf('qs:') === 0);
    assert.equal(card.releaseDate, '', '汽水不给发行日期');
    assert.equal(card.dateAdded, '');
    assert.deepEqual(card.genreNames, []);
    assert.equal(A.toAppleShapedAlbumCard({ name: 'x' }), null);
  });

  await t.test('艺人聚合按 artists[].id，且不得用封面冒充头像', () => {
    const songs = A.toLibrarySongs([RAW, Object.assign({}, RAW, { id: 'b', name: 'y' })]);
    const artists = A.artistsFromSongs(songs);
    assert.equal(artists.length, 1);
    assert.equal(artists[0].artistId, '6702338894014191618');
    assert.equal(artists[0].songCount, 2);
    assert.equal(artists[0].image, '', '曲目封面不是艺人头像');
    assert.equal(artists[0].hasImage, false);
  });
});

test('汽水接入的接线', async (t) => {
  const SERVER = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const MOD = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  const DETAIL = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'modules', '10-shell', '07-album-detail.js'), 'utf8');

  await t.test('五个端点齐备', () => {
    ['/api/qishui/library/index', '/api/qishui/library/album/tracks', '/api/qishui/library/artists',
     '/api/qishui/library/artist/detail', '/api/qishui/library/playlist/tracks'].forEach(function (p) {
      assert.ok(SERVER.indexOf(p) >= 0, '缺端点 ' + p);
    });
  });

  await t.test('歌单曲目必须翻页取全（每页硬上限 50）', () => {
    assert.ok(SERVER.indexOf('async function fetchAllQishuiPlaylistTracks(') > 0, '要有翻页函数');
    const i = SERVER.indexOf('async function fetchAllQishuiPlaylistTracks(');
    const fn = SERVER.slice(i, i + 1500);
    assert.ok(fn.indexOf('offset') > 0, '要翻页');
    assert.ok(fn.indexOf('hasMore') > 0, '按 hasMore 继续');
    assert.ok(fn.indexOf('nextOffset') > 0, '按 nextOffset 前进');
    assert.ok(/advance <= offset/.test(fn), '不前进就停，避免死循环');
    // 实测：limit 被 clamp 到 50，声明 131 首要翻 3 页
    assert.ok(/limit: 50/.test(fn), '每页按 50 取（上限）');
  });

  await t.test('客户端登记汽水且标为已接入', () => {
    assert.match(MOD, /qishui: \{ label: '汽水音乐', ready: true \}/, '要标为已接入');
    assert.match(MOD, /index: '\/api\/qishui\/library\/index'/, '索引端点');
    assert.match(MOD, /playlistsFromIndex: true/, '歌单随索引返回');
  });

  await t.test('专辑/歌单详情与播放都按源分流到汽水', () => {
    assert.ok(DETAIL.indexOf('(ne|kg|qq|qs|sp):') >= 0, '专辑前缀要含 qs');
    assert.ok(DETAIL.indexOf('/api/qishui/library/album/tracks?id=') >= 0, '专辑曲目走汽水端点');
    assert.ok(DETAIL.indexOf('/api/qishui/library/playlist/tracks?id=') >= 0, '歌单曲目走汽水端点');
    ['playLibraryAlbum', 'playLibraryPlaylist'].forEach(function (fnName) {
      const fn = MOD.slice(MOD.indexOf('function ' + fnName + '('), MOD.indexOf('function ' + fnName + '(') + 3000);
      assert.ok(fn.indexOf('/api/qishui/library/') > 0, fnName + ' 要处理汽水');
    });
  });

  await t.test('跨源头像的缓存必须在模块级（写在路由里会每次请求重建 -> 永不命中）', () => {
    // 这是本轮踩到的真坑：声明一度在路由分支内，实测 set 之后立刻 get 仍是 MISS。
    assert.match(SERVER, /^const qishuiArtistsResultCache = /m, '缓存要声明在模块级（顶格）');
    assert.match(SERVER, /^const qishuiArtistAvatarCache = new Map\(\);/m, '单条头像缓存也要模块级');
    assert.match(SERVER, /^let neteaseArtistIndexCache = /m, '网易云名单缓存也要模块级');
    // 且不得再出现在端点缩进层（两空格缩进）
    const inRoute = SERVER.split('\n').filter(function (l) { return /^  const qishuiArtistsResultCache = /.test(l); });
    assert.equal(inRoute.length, 0, '不得再有端点缩进层的缓存声明（那会导致每请求重建）');
  });

  await t.test('艺人列表结果要可缓存（有 fromCache 标记与 refresh 旁路）', () => {
    const i = SERVER.indexOf("pn === '/api/qishui/library/artists'");
    const fn = SERVER.slice(i, i + 4000);
    assert.ok(fn.indexOf('fromCache: true') > 0, '命中缓存要有标记');
    assert.ok(fn.indexOf('fromCache: false') > 0, '未命中也要标记');
    assert.ok(fn.indexOf("=== '1'") > 0 || fn.indexOf('refresh') > 0, '要有强制刷新旁路');
  });

  await t.test('汽水不提供艺人头像时按名字跨源补，并如实标注来源', () => {
    assert.ok(SERVER.indexOf('async function resolveQishuiArtistAvatar(') > 0, '要有跨源补头像的函数');
    const i = SERVER.indexOf('async function resolveQishuiArtistAvatar(');
    const fn = SERVER.slice(i, i + 3000);   // 函数较长，切片要够
    assert.ok(fn.indexOf('/api/qq/search') > 0, '先试 QQ（有艺人头像）');
    assert.ok(fn.indexOf('/api/qq/artist/detail') > 0, '再取 QQ 歌手详情');
    assert.ok(fn.indexOf('neteaseArtistIndex') > 0, '退到网易云名单');
    // 端点要如实标注头像不是汽水给的
    const ep = SERVER.slice(SERVER.indexOf("pn === '/api/qishui/library/artists'"), SERVER.indexOf("pn === '/api/qishui/library/artists'") + 4000);
    assert.ok(ep.indexOf("'avatar-from-'") > 0, '要标注头像来源');
    assert.ok(/imageFrom = got\.from/.test(ep), '要记录来自哪个源');
  });

  await t.test('汽水封面域名必须在取色代理名单里（douyinpic 不返回 CORS 头）', () => {
    const i = DETAIL.indexOf('var COVER_THEME_PROXY_HOSTS');
    const fn = DETAIL.slice(i, i + 900);
    assert.ok(fn.indexOf('douyinpic.com') > 0, '汽水封面域名要进名单');
    assert.ok(fn.indexOf("'y.qq.com'") > 0, 'QQ 仍在名单（回归）');
    // 实测返回 ACAO:* 的源不该进名单，避免无谓开销
    assert.ok(!/mzstatic/.test(fn), 'Apple 不该进名单');
    assert.ok(!/126\.net/.test(fn), '网易云不该进名单');
    assert.ok(!/kugou/.test(fn), '酷狗不该进名单');
  });
});
