const fs = require('fs');
(async () => {
  const id = 'p.2P6Wg5KCVWOK3m2';
  const r = await fetch('http://127.0.0.1:3000/api/apple/playlist/tracks?id=' + id + '&limit=100&offset=0');
  const j = await r.json();
  const out = { playlist: { name: '音乐回忆 2025', libraryPlaylistId: id }, total: j.total, hasMore: j.hasMore, tracks: j.tracks || [] };
  fs.writeFileSync('F:/mineradio-apple-music/experiment/apple-music-alpha1/integration/poc-playlist2-identity.json', JSON.stringify(out, null, 2), 'utf8');
  console.log('HTTP ' + r.status + ' total=' + j.total + ' returned=' + (j.tracks || []).length);
  (j.tracks || []).slice(0, 6).forEach((t, i) => console.log('#' + (i + 1) + ' ' + t.name + ' | ' + t.artist + ' | ' + t.id));
})().catch((e) => console.log('ERR ' + e.message));