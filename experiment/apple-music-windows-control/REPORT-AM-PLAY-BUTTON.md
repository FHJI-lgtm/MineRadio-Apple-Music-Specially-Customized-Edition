# AM result rows: click / hover-to-play, verdict by SMTC (2026-09-26)

Slice scope: wire playback for the Apple Music App result rows. Still no song-model conversion and still
no provider-registry contact.

## Interaction

- Hovering (or focusing) an AM row reveals a play affordance over the artwork.
- Clicking anywhere on the row plays it; Enter/Space also work (rows are `role="button"` + `tabindex="0"`).
- Rows carry `data-amc-index`, resolved against the module-local `amcCurrentResults` array, so the row's own
  AM model object is what gets handed to the IPC call.

## Call path

```
AM row click
  -> window.mineradio.amc.playTrack({ result: <AM model> })
  -> preload (window.mineradio.amc)  ->  ipcMain.handle('amc:play')
  -> desktop/apple-music-control.js playTrack(result, opts)
  -> canonicalUrl(trackId, storefront) -> -Url route
  -> Apple Music Windows (deep link) -> UIA -> SMTC
  -> verifyAgainstSmtc()  =>  verified / artistLayer / disagreement
```

The `amc:play` handler accepts `payload.result` (and falls back to the payload itself), confirmed by reading
`desktop/main.js:4914-4918` before writing the renderer side.

## What the UI reports

Per-row status line, driven by the returned object:

| state | text |
|---|---|
| in flight | `正在播放并等待 SMTC 判定…` (yellow) |
| verified | `SMTC 已验证` (+ `艺人匹配层：alias` when the layer is not `exact`) (green) |
| not verified | `SMTC 未验证 · 阶段：<stage>` (red) |
| both facts disagree | adds `链与模块判定不一致` |
| observed artist | appends `SMTC 实际艺人：<artist> — <album>` when present |

So the known `The Weeknd` vs `Abel Tesfaye` credit difference surfaces as `艺人匹配层：alias` rather than
being reported as a failure, and the UI never claims the track id was played - only SMTC can say that.

## Guardrails

- The row stays its own AM model: no `playlist.push`, no provider key, no `searchProviderUrl` branch, so the
  queue / provider-fallback / `13-playback-start-audio.js` / `/api/apple/song/url` cannot pick it up.
- The click handler is registered in the capture phase and calls `stopPropagation()`, so the existing search
  result click logic never receives an AM row click.
- One play at a time (`amcPlayBusy`); failures are caught, logged with `console.warn`, and rendered in the row.

## Verification status

`node --check` passes; the full call path needs one app restart to be observed at runtime (not yet done).
## Runtime verification (2026-09-26 12:38)

Screenshot evidence: AM tab, query `out of time`, first row clicked.

Row 1 (`Out of Time` / `The Weeknd - Dawn FM` / `trackId=1603164465 storefront=us 3:34`) rendered the verdict line:

```
SMTC 已验证 · 艺人匹配层：alias · 链与模块判定不一致 · SMTC 实际艺人：Abel Tesfaye — Dawn FM
```

So the whole path works end to end:
AM row click -> amc.playTrack -> -Url deep link -> Apple Music Windows -> UIA -> SMTC -> verifyAgainstSmtc.

Every element of that line is the expected result, not an error:

- `SMTC 已验证` - the independently observed SMTC track matches the requested target.
- `艺人匹配层：alias` - the known credit difference (`The Weeknd` vs `Abel Tesfaye`) resolved through the alias layer.
- `链与模块判定不一致` - reported honestly: the chain stage and the SMTC verdict disagree (`chainStage=SMTC_WRONG_TRACK` under a strict artist comparison), while the module verdict, which knows about the alias, says verified. Both facts are shown side by side instead of one being suppressed.
- `SMTC 实际艺人：Abel Tesfaye — Dawn FM` - what SMTC actually reported, never rewritten into the requested artist.

## Follow-up defect reported at the same time

Reported: when the target song is not visible, playback appears to hang, and scrolling until the song appears lets the pending click fire.

Fixed on the renderer side only (`f13f9ec`): a 20 s watchdog now explains the wait in the row
(`仍在等待 SMTC 判定…若 Apple Music 里目标歌曲尚未出现在可视区域，请先滚动到它（此等待不计失败）`)
instead of leaving a silent yellow line, and a second click while busy gets its own message.

The visibility dependency itself (UIA realize / ScrollIntoView before the synthesized click) lives in the
frozen chain (`poc/lib/am-uia.ps1`) and was NOT touched. The earlier passing E2E had
`candidateCount=1 ambiguous=false` with the row already realized, so this may be a window-state
dependent path rather than a regression. Investigating it would mean working inside the frozen chain,
which needs explicit authorisation.
