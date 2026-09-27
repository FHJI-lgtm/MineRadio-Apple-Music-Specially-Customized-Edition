// Round-1 integration driver: exercises MineRadio's OWN Apple Music control chain
// (desktop/apple-music-control.js -> experiment/apple-music-windows-control/poc/play-song.ps1)
// while the Apple Music window is held at Alpha=1 + WS_EX_TRANSPARENT.
// It does not modify any MineRadio logic; it only calls the same exports main.js uses.
const fs = require('fs');
const path = require('path');
const REPO = 'F:/mineradio-apple-music';
const amc = require(path.join(REPO, 'desktop', 'apple-music-control.js'));
(async () => {
  const term = process.argv[2] || 'Blinding Lights';
  const outFile = process.argv[3] || path.join(__dirname, 'amc-driver-result.json');
  const chainScript = process.argv[4] || '';   // failure injection: bogus path
  const out = { startedAt: new Date().toISOString(), term: term, steps: {} };
  try {
    const tracks = await amc.searchTracks(term, { country: 'us', limit: 5 });
    out.steps.search = { count: Array.isArray(tracks) ? tracks.length : -1, first: Array.isArray(tracks) && tracks[0] ? { title: tracks[0].title, artist: tracks[0].artist, trackId: tracks[0].trackId, storefront: tracks[0].storefront } : null };
    const pick = Array.isArray(tracks) ? tracks[0] : null;
    if (!pick) { out.steps.play = { ok: false, error: 'no search result' }; }
    else {
      const opts = { retries: 0, timeoutMs: 12000, searchWaitMs: 8000 };
      if (chainScript) opts.chainScript = chainScript;
      const play = await amc.playTrack(pick, opts);
      out.steps.play = { ok: !!play.ok, chainOk: !!play.chainOk, verified: !!play.verified, stage: play.stage, url: play.url, mismatch: play.mismatch || [], expected: play.expected, actual: play.actual, artistLayer: play.artistLayer, error: play.error || '' };
    }
  } catch (e) { out.steps.error = String(e && e.stack || e); }
  out.finishedAt = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ search: out.steps.search && out.steps.search.count, play: out.steps.play && { ok: out.steps.play.ok, verified: out.steps.play.verified, stage: out.steps.play.stage, actual: out.steps.play.actual } }));
})();