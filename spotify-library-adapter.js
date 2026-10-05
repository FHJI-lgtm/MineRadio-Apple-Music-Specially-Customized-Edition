'use strict';
// ====================================================================
// Spotify → 音乐资料库 适配层
//
// 与其它五个源同一套策略：曲目/歌单/专辑/艺人 -> 既有资料库 schema。
//
// 实测（Spotify Web API，用户 token）：
//   曲目: { id/spotifyId/uri/spotifyUri, name, artist, artists[{id,name,uri}],
//           album, albumId, albumUri, cover, duration(毫秒), durationMs, playable, ... }
//   专辑: { id/albumId, name, artist, artists[], cover, releaseDate(YYYY-MM-DD), trackCount, spotifyUrl }
//   身份与取流都基于 **Spotify 的 base62 id**（22 字符）。
// ====================================================================

const SPOTIFY_ID_PREFIX = 'sp:';

function normalizeText(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}

function validId(v) {
  const t = normalizeText(v);
  return (t && t !== '0') ? t : '';
}

// 曲目 -> 资料库曲目
function toLibrarySong(song) {
  if (!song) return null;
  const id = validId(song.id) || validId(song.spotifyId);
  const name = normalizeText(song.name);
  if (!id || !name) return null;              // 缺关键字段的条目直接丢弃，不占位
  const durationMs = Math.max(0, Number(song.durationMs) || Number(song.duration) || 0);
  const artists = Array.isArray(song.artists) ? song.artists : [];
  const first = artists[0] || {};
  return {
    librarySongId: SPOTIFY_ID_PREFIX + id,
    provider: 'spotify',
    source: 'spotify',
    type: 'spotify',
    // 播放器按 provider 选源、按 id/uri 取流
    id: id,
    spotifyId: id,
    uri: normalizeText(song.uri) || ('spotify:track:' + id),
    spotifyUri: normalizeText(song.spotifyUri) || normalizeText(song.uri) || ('spotify:track:' + id),
    name: name,
    artist: normalizeText(song.artist),
    artists: artists,
    artistId: validId(first.id),
    albumName: normalizeText(song.album),
    albumId: validId(song.albumId),
    cover: normalizeText(song.cover),
    durationMs: durationMs,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : 0,
    // 与其它源一致：没有可靠来源的一律留空/置 0
    trackNumber: 0,
    releaseDate: '',
    genre: '',
    fee: null,
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
    provider: 'spotify',
    source: 'spotify',
    id: id,
    name: normalizeText(pl.name) || '未命名歌单',
    cover: normalizeText(pl.cover),
    trackCount: Number(pl.trackCount) || 0,
    creator: normalizeText(pl.creator || (pl.owner && pl.owner.display_name)),
    subscribed: pl.subscribed === true,
    // 「喜欢的歌曲」是虚拟条目（id=spotify-liked），沿用它的标记，不用名字猜
    virtual: pl.virtual === true || String(id) === 'spotify-liked',
    isLiked: String(id) === 'spotify-liked',
    owned: pl.owned === true || pl.virtual !== true,
    specialType: 0,
  };
}

// 专辑卡（Apple 资料库索引同形）
function toAppleShapedAlbumCard(album) {
  if (!album) return null;
  const id = validId(album.albumId || album.id);
  const name = normalizeText(album.name);
  if (!id || !name) return null;
  return {
    provider: 'spotify',
    id: SPOTIFY_ID_PREFIX + id,
    libraryId: SPOTIFY_ID_PREFIX + id,
    albumId: SPOTIFY_ID_PREFIX + id,
    name: name,
    artist: normalizeText(album.artist),
    cover: normalizeText(album.cover),
    // Spotify 专辑详情提供 releaseDate（实测 2020-03-20）；从曲目归并时没有
    releaseDate: normalizeText(album.releaseDate),
    dateAdded: '',
    trackCount: Number(album.trackCount) || 0,
    genreNames: [],
  };
}

// 从曲目归并专辑（按 albumId；缺的不参与）
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
      if (!byId.has(id)) byId.set(id, { artistId: id, provider: 'spotify', name: name, songCount: 0, albumIds: {}, image: '', hasImage: false });
      const rec = byId.get(id);
      rec.songCount += 1;
      if (s && s.albumId) rec.albumIds[s.albumId] = 1;
    });
  });
  return Array.from(byId.values()).map(function (r) {
    return {
      artistId: r.artistId,
      provider: 'spotify',
      name: r.name,
      songCount: r.songCount,
      albumCount: Object.keys(r.albumIds).length,
      // 曲目封面不是艺人头像 —— 头像由 Spotify /v1/artists/{id} 提供
      image: '',
      hasImage: false,
    };
  });
}

module.exports = {
  SPOTIFY_ID_PREFIX,
  toLibrarySong,
  toLibrarySongs,
  toLibraryPlaylist,
  toAppleShapedAlbumCard,
  albumsFromSongs,
  artistsFromSongs,
  validId,
};
