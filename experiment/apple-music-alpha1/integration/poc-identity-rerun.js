(async () => {
  const base = 'http://127.0.0.1:3000';
  const pls = await (await fetch(base + '/api/apple/user/playlists?limit=50&offset=0')).json();
  const list = (pls && pls.playlists) || [];
  const target = list.find((p) => /My Playlist/.test(p.name || '')) || list[0];
  console.log('PLAYLIST_FIELDS ' + JSON.stringify(Object.keys(target || {})));
  console.log('PLAYLIST_OBJ ' + JSON.stringify(target).slice(0, 700));
  const tr = await (await fetch(base + '/api/apple/playlist/tracks?id=' + encodeURIComponent(target.id) + '&limit=3&offset=0')).json();
  console.log('TRACKS_TOTAL ' + JSON.stringify({ total: tr && tr.total, hasMore: tr && tr.hasMore }));
  const urlish = (tr && tr.tracks || []).map((t) => ({ name: t.name, id: t.id, catalogId: t.catalogId, appleUrl: t.appleUrl || '' }));
  console.log('TRACK_SAMPLE ' + JSON.stringify(urlish));
  console.log('ROOT_KEYS ' + JSON.stringify(Object.keys(tr || {})));
})().catch((e) => console.log('ERR ' + String(e && e.message || e)));