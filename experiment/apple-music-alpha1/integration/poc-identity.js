// Experiment A: identity data from the Library API only (no UIA scrolling).
(async () => {
  const base = 'http://127.0.0.1:3000';
  const pls = await (await fetch(base + '/api/apple/user/playlists?limit=50&offset=0')).json();
  const list = (pls && pls.playlists) || [];
  console.log('PLAYLISTS ' + JSON.stringify(list.map((p) => ({ name: p.name, id: p.id, tracks: p.trackCount })).slice(0, 8)));
  const target = list.find((p) => /My Playlist/.test(p.name || '')) || list[0];
  if (!target) { console.log('NO_PLAYLIST'); return; }
  const tr = await (await fetch(base + '/api/apple/playlist/tracks?id=' + encodeURIComponent(target.id) + '&limit=100&offset=0')).json();
  const tracks = (tr && tr.tracks) || [];
  console.log('TARGET ' + JSON.stringify({ name: target.name, libraryPlaylistId: target.id, total: tr && tr.total, hasMore: tr && tr.hasMore, returned: tracks.length }));
  const fields = tracks[0] ? Object.keys(tracks[0]) : [];
  console.log('TRACK_FIELDS ' + JSON.stringify(fields));
  const pick = [0, 1, 2, Math.floor(tracks.length / 2), tracks.length - 2, tracks.length - 1].filter((i) => i >= 0 && i < tracks.length);
  for (const i of pick) {
    const t = tracks[i];
    console.log('TRACK ' + JSON.stringify({ idx: i + 1, name: t.name, artist: t.artist, id: t.id, catalogId: t.catalogId, appleId: t.appleId, providerSongId: t.providerSongId, appleUrl: t.appleUrl || '' }));
  }
  require('fs').writeFileSync('F:\\mineradio-apple-music\\experiment\\apple-music-alpha1\\integration\\poc-playlist-identity.json', JSON.stringify({ playlist: target, tracks: tracks }, null, 2));
  console.log('SAVED identity json');
})().catch((e) => console.log('ERR ' + String(e && e.message || e)));