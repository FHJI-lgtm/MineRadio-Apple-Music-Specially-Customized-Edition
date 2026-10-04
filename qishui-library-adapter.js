'use strict';
// ====================================================================
// 汽水音乐 → 音乐资料库 适配层
//
// 与其它三个源同一套策略：曲目/歌单/专辑/艺人 -> 既有资料库 schema。
//
// 与其它源的**关键差异**（都靠实测确定）：
//   1) duration 已经是**秒**（实测 157 / 235 / 257 …），不是毫秒 —— 不能再除 1000。
//   2) 曲目**没有 albumId**，只有专辑名。所以专辑标识用「专辑名 + 艺人」的确定性 slug。
//      这是诚实做法：不编造一个不存在的 id，但同一张专辑的曲目仍能稳定归并到一起。
//   3) 艺人标识用 artists[].id（实测 40/40 都有）。
// ====================================================================

const QISHUI_ID_PREFIX = 'qs:';

function normalizeText(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function validId(v) {
  const t = normalizeText(v);
  return (t && t !== '0') ? t : '';
}

// 专辑 slug：源内稳定、可读，且不冒充真实 id。
// 用名称+艺人的小写去空白串，再做短哈希 —— 仅用于归并，不作为对外身份。
function albumSlug(albumName, artist) {
  const raw = (normalizeText(albumName) + '\u001f' + normalizeText(artist)).toLowerCase();
  if (!normalizeText(albumName)) return '';
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) h = ((h * 33) ^ raw.charCodeAt(i)) >>> 0;
  return 'a' + h.toString(36);
}

// 曲目 -> 资料库曲目
function toLibrarySong(song) {
  if (!song) return null;
  const id = validId(song.id) || validId(song.providerSongId);
  const name = normalizeText(song.name);
  if (!id || !name) return null;              // 缺关键字段的条目直接丢弃，不占位
  const artistFirst = (Array.isArray(song.artists) && song.artists[0]) || {};
  const artistName = normalizeText(song.artist) || normalizeText(artistFirst.name);
  const albumName = normalizeText(song.album);
  // duration 已经是秒（实测）——只做整数化，绝不乘除
  const seconds = Math.max(0, Math.round(Number(song.duration) || 0));
  return {
    librarySongId: QISHUI_ID_PREFIX + id,
    provider: 'qishui',
    source: 'qishui',
    type: 'qishui',
    // 播放器按 provider 选源、按 id 取流（/api/qishui/song/url?id=）
    id: id,
    providerSongId: validId(song.providerSongId) || id,
    name: name,
    artist: artistName,
    artists: Array.isArray(song.artists) ? song.artists : [],
    artistId: validId(artistFirst.id),
    albumName: albumName,
    // 没有 albumId：用名称+艺人派生，仅用于归并
    albumId: albumSlug(albumName, artistName),
    cover: normalizeText(song.cover),
    durationMs: seconds > 0 ? seconds * 1000 : 0,
    duration: seconds,
    // 与其它源一致：没有可靠来源的一律留空/置 0
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
  return {
    provider: 'qishui',
    source: 'qishui',
    id: id,
    name: normalizeText(pl.name) || '未命名歌单',
    cover: normalizeText(pl.cover),
    trackCount: Number(pl.trackCount) || 0,
    creator: normalizeText(pl.creator),
    subscribed: pl.subscribed === true,
    virtual: pl.virtual === true,
    // 个人库只取"自己的"歌单：owned 的才是（推荐/最近播放是 virtual，属于系统）
    owned: pl.owned === true || (pl.virtual !== true && String(pl.shelfPane || '') === 'mine'),
    isLiked: /我的喜欢|我喜欢/.test(normalizeText(pl.name)) || String(pl.id) === 'qishui-liked',
    specialType: 0,
  };
}

// 专辑卡（Apple 资料库索引同形）
function toAppleShapedAlbumCard(album) {
  if (!album) return null;
  const slug = validId(album.albumId);
  if (!slug || !normalizeText(album.name)) return null;
  return {
    provider: 'qishui',
    id: QISHUI_ID_PREFIX + slug,
    libraryId: QISHUI_ID_PREFIX + slug,
    albumId: QISHUI_ID_PREFIX + slug,
    name: normalizeText(album.name),
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    // 汽水的曲目/歌单接口都不给发行日期 —— 留空
    releaseDate: '',
    dateAdded: '',
    trackCount: Number(album.trackCount) || 0,
    genreNames: [],
  };
}

// 从曲目归并专辑（按 slug；缺名称的不参与）
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

// 从曲目聚合艺人（身份键 artists[].id）
function artistsFromSongs(songs) {
  const byId = new Map();
  (Array.isArray(songs) ? songs : []).forEach(function (s) {
    let artists = Array.isArray(s && s.artists) ? s.artists : [];
    if (!artists.length && s && s.artistId) artists = [{ id: s.artistId, name: s.artist }];
    artists.forEach(function (a) {
      const id = validId(a && a.id);
      const name = normalizeText(a && a.name);
      if (!id || !name) return;
      if (!byId.has(id)) byId.set(id, { artistId: id, provider: 'qishui', name: name, songCount: 0, albumIds: {}, image: '', hasImage: false });
      const rec = byId.get(id);
      rec.songCount += 1;
      if (s && s.albumId) rec.albumIds[s.albumId] = 1;
    });
  });
  return Array.from(byId.values()).map(function (r) {
    return {
      artistId: r.artistId,
      provider: 'qishui',
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
  QISHUI_ID_PREFIX,
  albumSlug,
  toLibrarySong,
  toLibrarySongs,
  toLibraryPlaylist,
  toAppleShapedAlbumCard,
  albumsFromSongs,
  artistsFromSongs,
  validId,
};
