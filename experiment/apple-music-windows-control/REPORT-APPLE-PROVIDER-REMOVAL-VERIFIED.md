# Legacy apple provider removal - runtime verification (2026-09-26 12:17)

Screenshot evidence taken from the app running out of F:\mineradio-apple-music after commit 6ab8c5f.

| check | observed |
|---|---|
| search mode tabs | `All` `NE` `QQ` `KG` `QS` `SP` `Podcast` - **the `AM` tab is gone** |
| provider order | unchanged for the five remaining providers (NE, QQ, KG, QS, SP) |
| new channel | floating `AM App 搜索` toggle still present (bottom-left) |
| app boot | normal (window, home screen, starfield background) |

So the removal took effect in the running app and did not disturb the other providers' entries or
the amc panel.

## Not covered by this screenshot

- Per-provider search results were not exercised (no query typed): the tab set and layout are verified,
  the search request/response path for the five providers is not re-tested here.
- `amc:playTrack` over IPC remains unexercised by design (the panel has no play button).

## Scope recap (commit 6ab8c5f)

Removed: the legacy apple SEARCH provider (order entry, search UI tab + placeholder + history/mode,
`searchProviderUrl` apple branches, providerLimited apple case, appleSongs aggregation,
`/api/apple/search` route).
Preserved: the shared Apple Music API surface (credentials/login, lyric, playlists, albums, like,
`song/url`), the C-class apple semantics in `07-search.js` (song-level apple detection, matching-source
notices, login-notice token filter), the whole amc channel, and frozen `poc/lib/*` (byte-identical to 0170bca).