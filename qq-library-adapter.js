'use strict';
// ====================================================================
// QQ 音乐 → 音乐资料库 适配层
//
// 与 netease/kugou-library-adapter.js **同一套策略**：
//   曲目/歌单/专辑/艺人 -> 既有资料库 schema，字段不确定就留空。
//
// 与另两个源的关键差异：QQ 一律用 **mid（字符串）** 作为身份与取流标识，
// 不用数字 id。所以：
//   曲目取流标识 = mid（播放器按 provider='qq' 走 /api/qq/song/url?mid=）
//   专辑标识     = albumMid
//   艺人标识     = artistMid
// ====================================================================

const QQ_ID_PREFIX = 'qq:';

function normalizeText(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

// '' / 0 / '0' / null 都算缺失
function validId(v) {
  const t = normalizeText(v);
  return (t && t !== '0') ? t : '';
}

// 曲目 -> 资料库曲目
function toLibrarySong(song) {
  if (!song) return null;
  const mid = validId(song.mid) || validId(song.songmid) || validId(song.id);
  const name = normalizeText(song.name);
  if (!mid || !name) return null;               // 缺关键字段的条目直接丢弃，不占位
  const durationMs = Math.max(0, Number(song.duration) || 0);
  return {
    librarySongId: QQ_ID_PREFIX + mid,
    provider: 'qq',
    source: 'qq',
    type: 'qq',
    // 播放器按 provider 选源、按 mid 取流（/api/qq/song/url?mid=）
    id: mid,
    mid: mid,
    songmid: mid,
    mediaMid: normalizeText(song.mediaMid),
    albumId: validId(song.albumMid),
    albumMid: validId(song.albumMid),
    name: name,
    artist: normalizeText(song.artist),
    artists: Array.isArray(song.artists) ? song.artists : [],
    artistId: validId(song.artistId),
    artistMid: validId(song.artistMid),
    albumName: normalizeText(song.album),
    cover: normalizeText(song.cover),
    durationMs: durationMs,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    // 与另两个源一致：没有可靠来源的一律留空/置 0
    trackNumber: 0,
    releaseDate: '',
    genre: '',
    fee: (song.fee === undefined || song.fee === null) ? null : Number(song.fee),
  };
}

function toLibrarySongs(songs) {
  return (Array.isArray(songs) ? songs : []).map(toLibrarySong).filter(Boolean);
}

// 歌单 -> 资料库歌单
function toLibraryPlaylist(pl) {
  if (!pl) return null;
  const id = validId(pl.id);
  if (!id) return null;
  const name = normalizeText(pl.name) || '未命名歌单';
  return {
    provider: 'qq',
    source: 'qq',
    id: id,
    name: name,
    cover: normalizeText(pl.cover),
    trackCount: Number(pl.trackCount) || 0,
    creator: normalizeText(pl.creator),
    subscribed: pl.subscribed === true,
    // QQ 的「我的喜欢」是 virtual 条目（id='liked'）；沿用它的标记，不用名字猜
    virtual: pl.virtual === true,
    isLiked: pl.virtual === true || /我的喜欢|我喜欢/.test(name),
    specialType: Number(pl.specialType) || 0,
  };
}

// 专辑卡（Apple 资料库索引同形）
function toAppleShapedAlbumCard(album) {
  if (!album) return null;
  const id = validId(album.albumMid || album.mid || album.albumId || album.id);
  if (!id) return null;
  return {
    provider: 'qq',
    id: QQ_ID_PREFIX + id,
    libraryId: QQ_ID_PREFIX + id,
    albumId: QQ_ID_PREFIX + id,
    name: normalizeText(album.name) || '未命名专辑',
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    // 专辑详情端点提供 releaseDate（实测形如 2017-09-08）；从曲目归并时没有，留空
    releaseDate: normalizeText(album.releaseDate),
    dateAdded: '',
    trackCount: Number(album.trackCount) || 0,
    genreNames: [],
  };
}

// 从曲目归并专辑（按 albumMid；缺的不参与）
function albumsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    const id = validId(s && s.albumId);
    const albumName = normalizeText(s && s.albumName);
    if (!id || !albumName) return;
    // 同时给出 albumId 与 albumMid：toAppleShapedAlbumCard 按 albumMid 取（QQ 的语义），
    // 少写一个就会让专辑卡静默变成 null（专辑轴全空）。
    if (!byId.has(id)) byId.set(id, { albumId: id, albumMid: id, name: albumName, artist: normalizeText(s.artist), cover: '', trackCount: 0 });
    const rec = byId.get(id);
    rec.trackCount += 1;
    if (!rec.cover && s.cover) rec.cover = normalizeText(s.cover);
  });
  return Array.from(byId.values());
}

// 从曲目聚合艺人（身份键 artistMid —— 同名不同人靠 mid 区分）
function artistsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    let artists = Array.isArray(s && s.artists) ? s.artists : [];
    if (!artists.length && s && s.artistMid) artists = [{ mid: s.artistMid, id: s.artistId, name: s.artist }];
    artists.forEach(function (a) {
      // 身份键优先 mid（QQ 的稳定标识），没有才退回数字 id
      const id = validId(a && a.mid) || validId(a && a.id);
      const name = normalizeText(a && a.name);
      if (!id || !name) return;
      if (!byId.has(id)) byId.set(id, { artistId: id, artistMid: validId(a && a.mid), provider: 'qq', name: name, songCount: 0, albumIds: {}, image: '', hasImage: false });
      const rec = byId.get(id);
      rec.songCount += 1;
      if (s && s.albumId) rec.albumIds[s.albumId] = 1;
    });
  });
  return Array.from(byId.values()).map(function (r) {
    return {
      artistId: r.artistId,
      artistMid: r.artistMid,
      provider: 'qq',
      name: r.name,
      songCount: r.songCount,
      albumCount: Object.keys(r.albumIds).length,
      // 曲目封面不是艺人头像 —— 头像由 /api/qq/artist/detail 提供
      image: '',
      hasImage: false,
    };
  });
}

module.exports = {
  QQ_ID_PREFIX,
  toLibrarySong,
  toLibrarySongs,
  toLibraryPlaylist,
  toAppleShapedAlbumCard,
  albumsFromSongs,
  artistsFromSongs,
  validId,
};
