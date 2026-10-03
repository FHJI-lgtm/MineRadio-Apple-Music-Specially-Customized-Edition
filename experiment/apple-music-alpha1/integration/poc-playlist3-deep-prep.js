const fs = require('fs');
(async () => {
  const id = 'p.YJXV7dvIerGlQ2X';
  const cands = [];
  for (const offset of [100, 200, 300]) {
    const r = await fetch('http://127.0.0.1:3000/api/apple/playlist/tracks?id=' + id + '&limit=100&offset=' + offset);
    const j = await r.json();
    const tr = j.tracks || [];
    for (const ord of [Math.min(offset + 70, offset + tr.length - 1)]) {
      const t = tr[ord - offset];
      if (t) cands.push({ ordinal: ord + 1, title: t.name, artist: t.artist, librarySongId: t.id });
    }
  }
  fs.writeFileSync('F:/mineradio-apple-music/experiment/apple-music-alpha1/integration/poc-playlist3-deep-candidates.json', JSON.stringify({ playlist: 'My Playlist', libraryPlaylistId: id, candidates: cands }, null, 2), 'utf8');
  console.log(JSON.stringify(cands));
})().catch((e) => console.log('ERR ' + e.message));