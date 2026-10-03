const fs = require('fs');
const OUT = 'F:/mineradio-apple-music/experiment/apple-music-alpha1/integration/poc-p1-user-playlists-raw.json';
(async () => {
  const r = await fetch('http://127.0.0.1:3000/api/apple/user/playlists?limit=50&offset=0');
  const t = await r.text();
  fs.writeFileSync(OUT, t, 'utf8');
  console.log('HTTP ' + r.status + ' bytes ' + t.length + ' -> ' + OUT);
})().catch((e) => console.log('ERR ' + e.message));