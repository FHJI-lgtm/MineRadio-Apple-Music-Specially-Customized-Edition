const fs = require('fs');
(async () => {
  const id = 'p.YJXV7dvIerGlQ2X';
  const r = await fetch('http://127.0.0.1:3000/api/apple/playlist/tracks?id=' + id + '&limit=200&offset=0');
  const j = await r.json();
  const out = { playlist: { name: 'My Playlist', libraryPlaylistId: id }, total: j.total, hasMore: j.hasMore, tracks: j.tracks || [] };
  fs.writeFileSync('F:/mineradio-apple-music/experiment/apple-music-alpha1/integration/poc-playlist3-identity.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('HTTP ' + r.status + ' total=' + j.total + ' returned=' + (j.tracks || []).length);
})().catch((e) => console.log('ERR ' + e.message));