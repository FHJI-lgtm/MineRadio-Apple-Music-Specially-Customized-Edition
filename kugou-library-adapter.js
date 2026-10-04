'use strict';
// ====================================================================
// 酷狗 → 音乐资料库 适配层
//
// 与 netease-library-adapter.js **完全同一套策略**：
//   曲目/歌单/艺人/专辑 -> 既有资料库 schema，字段不确定就留空。
// 两个源的曲目字段几乎一一对应（见下），所以映射逻辑是同一形状。
//
// 酷狗曲目的取流标识是 hash（播放器按 provider='kugou' 走 /api/kugou/song/url?hash=）。
// ====================================================================

const KUGOU_ID_PREFIX = 'kg:';

function normalizeText(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

// '' / 0 / '0' / null 都算缺失（String(0) === '0' 是**真值**，不能直接判断）
function validId(v) {
  const t = normalizeText(v);
  return (t && t !== '0') ? t : '';
}

// 曲目 -> 资料库曲目
function toLibrarySong(song) {
  if (!song) return null;
  // 酷狗用 hash 作为取流标识；没有 hash 时退回 id
  const hash = validId(song.hash) || validId(song.fileHash) || validId(song.id);
  const name = normalizeText(song.name);
  if (!hash || !name) return null;   // 缺关键字段的条目直接丢弃，不占位
  const durationMs = Math.max(0, Number(song.duration) || 0);
  return {
    librarySongId: KUGOU_ID_PREFIX + hash,
    provider: 'kugou',
    source: 'kugou',
    type: 'kugou',
    // 播放器按 provider 选源、并按 hash 取流（/api/kugou/song/url?hash=）
    id: hash,
    hash: hash,
    fileHash: hash,
    albumId: validId(song.albumId || song.album_id),
    albumAudioId: normalizeText(song.albumAudioId || song.album_audio_id || song.mixSongId),
    mixSongId: normalizeText(song.mixSongId),
    name: name,
    artist: normalizeText(song.artist),
    artists: Array.isArray(song.artists) ? song.artists : [],
    artistId: validId(song.artistId),
    albumName: normalizeText(song.album),
    cover: normalizeText(song.cover),
    durationMs: durationMs,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    // 与网易云一致：以下留空/置 0，不用推测值
    trackNumber: 0,
    releaseDate: '',
    genre: '',
    // playable 由酷狗自己给出，但我们仍不在资料库层预判权益
    fee: (song.fee === undefined || song.fee === null) ? null : Number(song.fee),
    hasPlayParams: false,
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
  return {
    provider: 'kugou',
    source: 'kugou',
    id: id,
    name: normalizeText(pl.name) || '未命名歌单',
    cover: normalizeText(pl.cover),
    trackCount: Number(pl.trackCount) || 0,
    creator: normalizeText(pl.creator),
    subscribed: false,
    // 酷狗没有 specialType 这套，用名字识别"我喜欢"（仅用于展示，不参与身份判定）
    isLiked: /我喜欢/.test(normalizeText(pl.name)),
    specialType: 0,
  };
}

// 专辑卡（Apple 资料库索引同形）
function toAppleShapedAlbumCard(album) {
  if (!album) return null;
  const id = validId(album.albumId || album.id);
  if (!id) return null;
  return {
    provider: 'kugou',
    id: KUGOU_ID_PREFIX + id,
    libraryId: KUGOU_ID_PREFIX + id,
    albumId: KUGOU_ID_PREFIX + id,
    name: normalizeText(album.name) || '未命名专辑',
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    // 发行日期/加入日期没有可靠来源 —— 留空
    releaseDate: '',
    dateAdded: '',
    trackCount: Number(album.trackCount) || 0,
    genreNames: [],
  };
}

// 从曲目归并专辑（按 albumId；缺 albumId 的不参与）
function albumsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    const id = validId(s && s.albumId);
    const albumName = normalizeText(s && s.albumName);
    if (!id || !albumName) return;
    if (!byId.has(id)) byId.set(id, { albumId: id, name: albumName, artist: normalizeText(s.artist), cover: '', trackCount: 0 });
    const rec = byId.get(id);
    rec.trackCount += 1;
    if (!rec.cover && s.cover) rec.cover = normalizeText(s.cover);
  });
  return Array.from(byId.values());
}

// 从曲目聚合艺人（身份键 artistId）
function artistsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    let artists = Array.isArray(s && s.artists) ? s.artists : [];
    if (!artists.length && s && s.artistId) artists = [{ id: s.artistId, name: s.artist }];
    artists.forEach(function (a) {
      const id = validId(a && a.id);
      const name = normalizeText(a && a.name);
      if (!id || !name) return;
      if (!byId.has(id)) byId.set(id, { artistId: id, provider: 'kugou', name: name, songCount: 0, albumIds: {}, image: '', hasImage: false });
      const rec = byId.get(id);
      rec.songCount += 1;
      if (s && s.albumId) rec.albumIds[s.albumId] = 1;
    });
  });
  return Array.from(byId.values()).map(function (r) {
    return {
      artistId: r.artistId,
      provider: 'kugou',
      name: r.name,
      songCount: r.songCount,
      albumCount: Object.keys(r.albumIds).length,
      // 曲目封面不是艺人头像
      image: '',
      hasImage: false,
    };
  });
}

module.exports = {
  KUGOU_ID_PREFIX,
  toLibrarySong,
  toLibrarySongs,
  toLibraryPlaylist,
  toAppleShapedAlbumCard,
  albumsFromSongs,
  artistsFromSongs,
  validId,
};
