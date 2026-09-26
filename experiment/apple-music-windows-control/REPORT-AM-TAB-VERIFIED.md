# AM tab in the search bar - runtime verification (2026-09-26 12:31)

Screenshot evidence from the app running out of F:\mineradio-apple-music.

| check | observed |
|---|---|
| top tab bar | `All` `NE` `QQ` `KG` `QS` `SP` `AM` `Podcast` - AM present and highlighted when selected |
| AM tab query | `how do i make you love me` |
| result area | Apple Music App section only (iTunes Search API), 4 rows |
| row content | artwork + title + `artist - album` + `trackId=... storefront=us` + mm:ss |
| play button | still absent (this slice is search/display only) |
| floating panel button | gone (module kept as opt-in debug entry: `?amcPanel=1` or `window.__AMC_PANEL_DEBUG`) |
| All tab | five-provider results plus the Apple Music App auxiliary section when it has results |
| other tabs | NE / QQ / KG / QS / SP / Podcast untouched |

So the dedicated AM tab works end to end in the real app:
search bar -> AM mode -> `window.mineradio.amc.searchTracks()` -> preload -> `ipcMain('amc:search')`
-> `desktop/apple-music-control.js` -> iTunes Search API -> own AM result model -> results area.

## Two defects found and fixed in this slice (honest record)

1. `b442b3c` - the AM-only branch called `doAmcOnlySearch(q, requestSeq)` **before** `var requestSeq = ++searchRequestSeq;`
   was executed, so the argument was `undefined` and the post-await guard
   `if (requestSeq !== searchRequestSeq) return;` dropped every reply: the tab displayed
   "正在搜索 Apple Music App…" forever. The All-tab auxiliary path was unaffected because it uses its
   own sequence argument, which also proved the IPC channel itself was healthy.
   Fixed by taking the sequence inside the AM branch: `var amRequestSeq = ++searchRequestSeq;`
   (plus `disconnectSearchLoadMoreObserver()` so a previous provider observer cannot fire).
2. `b056ed8` - cosmetic: my earlier insertion lost a newline and put the AM placeholder statement on the
   same line as `if (podcastBtn) {`. Split back onto its own line.

## Boundaries (unchanged by this slice)

`MUSIC_SEARCH_PROVIDER_ORDER` still holds exactly the five native providers; no amc entry in the provider
registry, no `searchProviderUrl` branch, no conversion of iTunes results into the song model, no
`playTrack` call in `07-search.js`; frozen `poc/lib/*` byte-identical to `0170bca`.