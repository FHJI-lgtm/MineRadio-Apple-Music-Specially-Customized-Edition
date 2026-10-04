'use strict';
// ====================================================================
// 网易云 → 音乐资料库 适配层
//
// 目标：把网易云的个人库映射成**既有资料库曲目 schema**，让音乐资料库页面
// 不改渲染代码就能展示非 Apple 源的数据。
//
// 数据不确定就**留空**，绝不用推测值填充（例如发行日期、专辑内序号）——
// 宁可空着，也不呈现错误信息。
//
// schema 对照（左侧为资料库既有字段，Apple 轴定义于 mapRawSong）：
//   librarySongId  曲目唯一键（带 ne: 前缀，避免与 Apple 的 l.* 形式混淆）
//   name / artist / albumName / cover / duration / durationMs
//   发行日期与专辑内序号：网易云未提供 → 留空（UI 有回退）
// ====================================================================

const NETEASE_ID_PREFIX = 'ne:';

function normalizeText(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

// 有效 ID：'' / 0 / '0' / null 都算缺失。
// 注意 String(0) === '0' 是**真值**，直接用它做判断会把 id=0 当成有效 ID。
function validId(v) {
  const t = normalizeText(v);
  return (t && t !== '0') ? t : '';
}

// 网易云歌单里「喜欢的音乐」用 specialType 标记，不需要单独接口
const NETEASE_SPECIAL_LIKED = 5;

function isLikedPlaylist(pl) {
  return Number(pl && pl.specialType) === NETEASE_SPECIAL_LIKED;
}

// 曲目 -> 资料库曲目
function toLibrarySong(song) {
  if (!song) return null;
  const id = validId(song.id);
  const name = normalizeText(song.name);
  if (!id || !name) return null;   // 缺关键字段的条目直接丢弃，不占位
  const durationMs = Math.max(0, Number(song.duration) || 0);
  return {
    librarySongId: NETEASE_ID_PREFIX + id,
    provider: 'netease',
    source: 'netease',
    // 播放入口按 songProviderKey(song) 选源，并用 song.id 取流（/api/song/url?id=）。
    // 所以这里必须给**裸 id**，不能只给带前缀的 librarySongId。
    id: id,
    sourceSongId: id,
    name: name,
    artist: normalizeText(song.artist),
    artists: Array.isArray(song.artists) ? song.artists : [],
    albumName: normalizeText(song.album),
    albumId: validId(song.albumId),
    cover: normalizeText(song.cover),
    durationMs: durationMs,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    // 以下两项网易云未提供 —— 留空，不用推测值冒充满
    trackNumber: 0,
    releaseDate: '',
    genre: '',
    // 播放权：fee 只表示"是否付费曲目"，不等于实际能播。
    // 真正的可播性在取直链时才确定，这里不预判、不假装。
    playable: false,
    fee: (song.fee === undefined || song.fee === null) ? null : Number(song.fee),
    hasPlayParams: false,
  };
}

function toLibrarySongs(songs) {
  return (Array.isArray(songs) ? songs : []).map(toLibrarySong).filter(Boolean);
}

// 歌单 -> 资料库歌单（字段命名与既有 /api/user/playlists 保持一致）
function toLibraryPlaylist(pl) {
  if (!pl) return null;
  const id = validId(pl.id);
  if (!id) return null;
  return {
    provider: 'netease',
    source: 'netease',
    id: id,
    name: normalizeText(pl.name) || '未命名歌单',
    cover: normalizeText(pl.cover),
    trackCount: Number(pl.trackCount) || 0,
    playCount: Number(pl.playCount) || 0,
    creator: normalizeText(pl.creator),
    subscribed: !!pl.subscribed,
    isLiked: isLikedPlaylist(pl),
    specialType: Number(pl.specialType) || 0,
  };
}

// 专辑 -> 资料库专辑卡
// releaseDate 留空：网易云的曲目/收藏接口都不提供发行日期，
// 拿"收藏时间"或"上架时间"冒充会把 2015 年的专辑显示成 2024 年。
function toLibraryAlbum(album) {
  if (!album) return null;
  const id = validId(album.id);
  if (!id) return null;
  return {
    libraryAlbumId: NETEASE_ID_PREFIX + id,
    provider: 'netease',
    source: 'netease',
    albumId: id,
    name: normalizeText(album.name) || '未命名专辑',
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    trackCount: Number(album.trackCount) || 0,
    releaseDate: '',
  };
}

// 从曲目列表归并出专辑（用于"收藏专辑"之外，按曲目推导专辑墙的场景）
// 只用**曲目里确实存在的** albumId / cover；同一个专辑取第一条有封面的。
function albumsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    const id = validId(s && s.albumId);
    const albumName = normalizeText(s && s.albumName);
    if (!id || !albumName) return;
    if (!byId.has(id)) {
      byId.set(id, { id: id, name: albumName, artist: normalizeText(s.artist), cover: '', trackCount: 0 });
    }
    const rec = byId.get(id);
    rec.trackCount += 1;
    if (!rec.cover && s.cover) rec.cover = normalizeText(s.cover);
  });
  return Array.from(byId.values()).map(toLibraryAlbum).filter(Boolean);
}

// ---- 输出成「Apple 资料库索引」兼容形状 ----
// 音乐资料库页面是按 /api/apple/library/index 的 albums 形状渲染的，
// 这里产出同形数据，前端切源时无需改渲染代码。
function toAppleShapedAlbumCard(album) {
  if (!album) return null;
  const id = validId(album.albumId || album.id);
  if (!id) return null;
  return {
    provider: 'netease',
    id: NETEASE_ID_PREFIX + id,
    libraryId: NETEASE_ID_PREFIX + id,
    albumId: NETEASE_ID_PREFIX + id,
    name: normalizeText(album.name) || '未命名专辑',
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    // 发行日期网易云不提供 —— 留空。UI 会省略该行，不会显示错误年份。
    releaseDate: '',
    // 加入日期同样没有可靠来源，留空而不是拿别的时间冒充
    dateAdded: '',
    trackCount: Number(album.trackCount) || 0,
    genreNames: [],
  };
}

// 从曲目列表聚合艺人（与 Apple 资料库同一语义：艺人来自己保存的曲目）。
// 身份键用**网易云 artistId**，不用名字 —— 同名不同人是常见情况。
function artistsFromSongs(songs) {
  var byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    var artists = Array.isArray(s && s.artists) ? s.artists : [];
    if (!artists.length && s && s.artistId) {
      artists = [{ id: s.artistId, name: s.artist }];
    }
    artists.forEach(function (a) {
      var id = validId(a && a.id);
      var name = normalizeText(a && a.name);
      if (!id || !name) return;                 // 缺 id 或名字的条目直接丢弃，不占位
      if (!byId.has(id)) {
        byId.set(id, { artistId: id, name: name, songCount: 0, albumIds: {}, cover: '' });
      }
      var rec = byId.get(id);
      rec.songCount += 1;
      if (s && s.albumId) rec.albumIds[s.albumId] = 1;
      if (!rec.cover && s && s.cover) rec.cover = s.cover;   // 仅作占位，最终头像以 artist_detail 为准
    });
  });
  return Array.from(byId.values()).map(function (r) {
    return {
      artistId: r.artistId,
      provider: 'netease',
      name: r.name,
      songCount: r.songCount,
      albumCount: Object.keys(r.albumIds).length,
      // 曲目封面**不是艺人头像**，这里不冒充。头像由 artist_detail 提供，取不到就留空。
      image: '',
      hasImage: false,
    };
  });
}

module.exports = {
  NETEASE_ID_PREFIX,
  NETEASE_SPECIAL_LIKED,
  isLikedPlaylist,
  toLibrarySong,
  toLibrarySongs,
  toLibraryPlaylist,
  toLibraryAlbum,
  albumsFromSongs,
  toAppleShapedAlbumCard,
  artistsFromSongs,
  validId,
};
