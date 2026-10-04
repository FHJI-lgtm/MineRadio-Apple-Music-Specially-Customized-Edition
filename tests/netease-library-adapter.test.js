'use strict';
// 网易云 → 音乐资料库 适配层的契约测试。
// 重点：数据不确定时必须留空，绝不用推测值填充。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const A = require(path.join(__dirname, '..', 'netease-library-adapter.js'));

const RAW_SONG = {
  provider: 'netease', source: 'netease', type: 'song',
  id: 27072697, name: 'Next (Original)', artist: 'The Weeknd',
  artists: [{ id: 185858, name: 'The Weeknd' }], artistId: 185858,
  album: 'Echoes Of Silence (Original)', albumId: 2581857,
  cover: 'https://p3.music.126.net/x.jpg', duration: 361687,
  popularity: 25, fee: 1,
};

test('网易云适配：曲目映射成资料库 schema', async (t) => {
  await t.test('关键字段逐个就位', () => {
    const s = A.toLibrarySong(RAW_SONG);
    assert.equal(s.librarySongId, 'ne:27072697', '唯一键带 ne: 前缀，避免与 Apple 的 l.* 混淆');
    assert.equal(s.id, '27072697', '播放取流按 song.id，必须是裸 id（不带前缀）');
    assert.equal(s.name, 'Next (Original)');
    assert.equal(s.artist, 'The Weeknd');
    assert.equal(s.albumName, 'Echoes Of Silence (Original)', 'album -> albumName');
    assert.equal(s.albumId, '2581857');
    assert.equal(s.cover, 'https://p3.music.126.net/x.jpg');
    assert.equal(s.provider, 'netease');
    assert.equal(s.durationMs, 361687);
    assert.equal(s.duration, 362, 'duration 由毫秒换算成秒（详情页 fmtDuration 期望秒）');
    assert.ok(s.duration < 3600, '必须是秒；若误留毫秒会显示成 3600+ 分钟（曾出现 3576:53）');
  });

  await t.test('数据不确定的字段留空，不用推测值填充', () => {
    const s = A.toLibrarySong(RAW_SONG);
    assert.equal(s.releaseDate, '', '网易云不给发行日期 -> 留空（不拿别的时间冒充）');
    assert.equal(s.trackNumber, 0, '不给专辑内序号 -> 0（UI 回退到列表位置）');
    assert.equal(s.genre, '');
  });

  await t.test('不预判可播性', () => {
    const s = A.toLibrarySong(RAW_SONG);
    assert.equal(s.playable, false, 'fee 只表示是否付费曲目；真正可播性要取直链时才确定');
    assert.equal(s.fee, 1, '原始 fee 保留，供上层判断');
  });

  await t.test('缺关键字段的条目直接丢弃，不占位', () => {
    assert.equal(A.toLibrarySong(null), null);
    assert.equal(A.toLibrarySong({ id: 1 }), null, '没有 name');
    assert.equal(A.toLibrarySong({ name: 'x' }), null, '没有 id');
    assert.equal(A.toLibrarySongs([RAW_SONG, null, { id: 1 }]).length, 1);
  });
});

test('网易云适配：歌单映射', async (t) => {
  await t.test('specialType=5 识别为「喜欢的音乐」', () => {
    const liked = A.toLibraryPlaylist({ id: 1, name: 'x', specialType: 5 });
    assert.equal(liked.isLiked, true);
    const normal = A.toLibraryPlaylist({ id: 2, name: 'y', specialType: 0 });
    assert.equal(normal.isLiked, false);
    assert.equal(A.isLikedPlaylist({ specialType: 5 }), true);
    assert.equal(A.isLikedPlaylist({}), false);
  });

  await t.test('字段照搬既有命名，缺失时给安全默认值', () => {
    const p = A.toLibraryPlaylist({ id: 9, name: '歌单', cover: 'c', trackCount: 8, creator: 'me' });
    assert.equal(p.id, '9');
    assert.equal(p.cover, 'c');
    assert.equal(p.trackCount, 8);
    assert.equal(p.creator, 'me');
    assert.equal(A.toLibraryPlaylist({ name: '没有 id' }), null);
  });
});

test('网易云适配：由曲目推导专辑', async (t) => {
  await t.test('按 albumId 归并，取第一条有封面的', () => {
    const songs = A.toLibrarySongs([
      { id: 1, name: 'a', album: 'A', albumId: 10, artist: 'x', duration: 1000 },
      { id: 2, name: 'b', album: 'A', albumId: 10, artist: 'x', duration: 1000, cover: 'cover-a' },
      { id: 3, name: 'c', album: 'B', albumId: 11, artist: 'y', duration: 1000, cover: 'cover-b' },
    ]);
    const albums = A.albumsFromSongs(songs);
    assert.equal(albums.length, 2, '两个 albumId 归并成 2 张');
    const a = albums.filter(x => x.albumId === '10')[0];
    assert.equal(a.trackCount, 2, '同专辑曲目数正确');
    assert.equal(a.cover, 'cover-a', '第一条没有封面时，用后面有的那张');
    assert.equal(a.releaseDate, '', '发行日期留空');
  });

  await t.test('缺 albumId 的曲目不参与专辑归并', () => {
    const songs = A.toLibrarySongs([{ id: 1, name: 'a', album: 'A', albumId: 0, duration: 1000 }]);
    assert.equal(A.albumsFromSongs(songs).length, 0);
  });
});

test('网易云适配：输出成 Apple 资料库索引兼容形状', async (t) => {
  await t.test('专辑卡字段与 /api/apple/library/index 对齐', () => {
    const card = A.toAppleShapedAlbumCard({ albumId: '2581857', name: 'Album', artist: 'X', cover: 'c', trackCount: 3 });
    assert.equal(card.provider, 'netease');
    assert.equal(card.id, 'ne:2581857');
    assert.equal(card.libraryId, 'ne:2581857', '渲染层按 libraryId 取用');
    assert.equal(card.albumId, 'ne:2581857');
    assert.equal(card.name, 'Album');
    assert.equal(card.cover, 'c');
    assert.equal(card.trackCount, 3);
    assert.equal(card.releaseDate, '', '不确定就留空');
    assert.equal(card.dateAdded, '', '加入日期同样没有可靠来源，留空');
    assert.deepEqual(card.genreNames, []);
  });

  await t.test('缺 id 的专辑不产出卡片', () => {
    assert.equal(A.toAppleShapedAlbumCard({ name: 'x' }), null);
    assert.equal(A.toAppleShapedAlbumCard(null), null);
  });
});
