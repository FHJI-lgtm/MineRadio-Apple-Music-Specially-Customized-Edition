# 04-search verified in the running app (2026-09-26 12:06)

Screenshot evidence: MineRadio running with the parallel panel open.

| observed | value |
|---|---|
| floating toggle | `AM App 搜索` (bottom-left, fixed 18px/56px) |
| panel title | `Apple Music App 搜索 (iTunes Search API)` |
| panel note | `只做搜索与展示；播放按钮故意未接（播放链已单独验证）。` |
| query | `out of time` |
| results | 4 rows, each with artwork + title + `artist — album` + `trackId=… storefront=us` + mm:ss |
| example row | `Out of Time` / `The Weeknd — Dawn FM` / `trackId=1603164465 storefront=us 3:34` |
| play button | **absent by design** |

## What this proves

1. **Module mounting**: the loader entry works in the real app (panel builds, styles inject, no interference with existing UI).
2. **IPC runtime - the row that was untested: now VERIFIED.** The panel calls
   `window.mineradio.amc.searchTracks(...)`, so the whole chain
   `renderer -> preload (window.mineradio.amc) -> ipcMain('amc:search') -> desktop/apple-music-control.js -> iTunes Search API`
   demonstrably ran end to end in the real Electron main process.
3. **Data plane in the UI**: `trackId` / `storefront` / duration / artwork arrive as designed.

## What this does NOT prove (unchanged)

- `amc:playTrack` over IPC is still not exercised from the UI: the panel deliberately has no play button,
  so the IPC transport for the playback call remains untested (the module-level playback chain itself is
  verified separately, commit 9461ce9).
- No behavioural change to the existing search provider chain: `07-search.js`, the provider registry,
  `provider-fallback`, `server.js` and `apple-music-api.js` are untouched.

## Note on track ids

The same title/artist/album can legitimately appear under different `trackId`s across editions/comps
(e.g. `1603164465` for this panel query vs `1603171870` in the earlier E2E). That is exactly why the
design keeps the id as an association/navigation value only - SMTC remains the judge of what played.

## Root cause of the long detour (for the record)

`node_modules\electron\dist\*` were **OneDrive Files-On-Demand placeholders** (`Archive, ReparsePoint`),
so Electron could not load its runtime in app mode and died before any JavaScript with
`0x80000003 STATUS_BREAKPOINT`, silently. Node mode still worked, which is why the shim error appeared in
one case and nothing in the other. The project has since been hydrated and moved to `F:\mineradio-apple-music`.