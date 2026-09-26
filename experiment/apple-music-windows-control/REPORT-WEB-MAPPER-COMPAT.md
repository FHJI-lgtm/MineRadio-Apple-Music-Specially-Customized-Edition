# Web API mapper/schema compatibility shadow test (2026-09-26)

Scope of this phase: **mapper compatibility**, not an old-vs-new A/B test. Read-only, GET only, no
Developer JWT, no UI change, no auth-axis switch. Files added:

- `desktop/apple-music-web-api.js` (new layer: AMPWeb bearer + media-user-token -> amp-api)
- `scripts/apple-music-web-mapper-compat.js` (new read-only shadow script)
- `apple-music-api.js`: **one added line** - `mapAppleLibraryPlaylist` added to the existing
  `_test` export block (testability-only, no behaviour change)

## How the run was made possible (credential handling)

The media-user-token is read from a file passed with `--token-file=` (here `F:\USER TOKEN.txt`), never
printed and never written: the script reports only its length (246) and a short SHA-256 fingerprint
(`6a6ad665`). The bearer is obtained through the existing `apple-music-web-lyrics.js#getWebPlayerBearer`
- there is exactly one AMPWebPlay scraper in the project. Two defects were found and fixed in the new
layer while wiring it: `getWebPlayerBearer()` returns the bearer **cache object** (`{token,exp,...}`),
and the first version stringified the whole object (401 `Bearer [object Object]`).

## Layer A - the legacy mappers consumed the WEB JSON

| input | mapper | result |
|---|---|---|
| 4 library playlists from `GET /v1/me/library/playlists` (200, `meta.total=4`) | `_test.mapAppleLibraryPlaylist` | object, 13 keys each (e.g. `id,name,provider,source,cover,trackCount,creator,public,subscribed,appleUrl,applePlayParamsId,playCount,shelfPane`) |
| 5 tracks from `GET /v1/me/library/playlists/<id>/tracks` (200) | `_test.mapAppleTrack` | object, 30 keys each (e.g. `appleId,appleUrl,artist,albumName,durationMs,isrc,name,provider,storefront,...`) |

No throw, no `null`, no `undefined`-only object: the web payloads are structurally consumable by the
existing canonical mappers.

## Layer B - legacy mapper vs the minimal web probe mapper

Counts (same web JSON through both):

| object | oldKeys | webKeys | missing | extra | typeMismatch | valueMismatch | oldUndefined |
|---|---|---|---|---|---|---|---|
| playlist[0..1] | 13 | 7 | 10 | 4 | 1 | 0 | 0 |
| track[0..1] | 30 | 7 | 26 | 3 | 1 | 0 | 0 |

**Interpretation (important):** the `missing`/`extra` counts are dominated by the deliberate shape of
the probe mapper, which only reads raw Apple attribute names (`attributes.name`, `attributes.artistName`,
...). They are **not** evidence of a schema gap: the legacy mapper produced a complete object from the
same JSON in layer A. What the probe mapper's names do show is a **naming** difference
(`title`/`artistName`/`artwork` versus the canonical `name`/`artist`/`cover`), which is the mapper's job.

The two `typeMismatch` entries are the genuinely interesting signals, and both point the same way:

```
trackCount  old:number  web:undefined     (playlist)
isrc        old:string  web:undefined     (track)
```

The legacy mapper produced values where the raw web payload field was absent, i.e. the legacy mappers
**derive or fall back** for at least `trackCount` and `isrc`. This is recorded as a follow-up question
(verify the derivation path), not as a defect, and nothing was "aligned" by touching the old mapper.

## Layer C - ID semantics (no normalization, no merging)

| object | id | type | playParams.id | playParams.kind | playParams.catalogId | isrc | url |
|---|---|---|---|---|---|---|---|
| playlist[0] | `p.2P6Wg5KCVWOK3m2` | library-playlists | `p.2P6Wg5KCVWOK3m2` | playlist | undefined | absent | absent |
| playlist[1] | `p.0YU0g1DPaJ` | library-playlists | `p.0YU0g1DPaJ` | playlist | undefined | absent | absent |
| track[0] | `a.1499378607` | library-songs | `a.1499378607` | song | **1499378607** | absent | absent |
| track[1] | `a.1499378615` | library-songs | `a.1499378615` | song | **1499378615** | absent | absent |
| track[2] | `a.1440826383` | library-songs | `a.1440826383` | song | **1440826383** | absent | absent |

Observations recorded without normalizing anything:

- a **library track id is `a.<catalogId>`** and the bare catalog id is separately available as
  `playParams.catalogId` - the two namespaces are distinguishable in this payload;
- the library **playlist** id carries a `p.` prefix and its `playParams.catalogId` is `undefined`
  (a user playlist has no catalog counterpart);
- `isrc` and `url` are **absent** in this payload, while the legacy mapper emitted an `isrc` string
  (see layer B) - so at least one field the canonical model carries is not present in the web payload;
- all of the above is marked `UNKNOWN - do not normalize/merge` in the script output; no ID was joined
  or rewritten.

## Read-only enforcement (honest note)

The script wraps `webApi.request` to reject non-GET, but that wrapper is **not** what protects the
internal helpers: `getLibrary`/`getCatalog` call the module's internal closure, so the wrapper counted
0 calls. The effective guard is `webApi.setReadOnly(true)` inside the module itself, which throws
`APPLE_WEB_READ_ONLY` for any non-GET - including internal paths. Both are kept.

## Not done in this phase (frozen)

Developer API removal, UI changes, `appleLoginStatus` / auth-axis switch, like/favorite writes,
old `/api/apple/*` endpoints, SMTC, AMC, `poc/lib/*`.