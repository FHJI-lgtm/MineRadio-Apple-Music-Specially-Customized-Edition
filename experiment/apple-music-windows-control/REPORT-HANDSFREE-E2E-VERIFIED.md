# Hands-free end-to-end verified (2026-09-26 12:50)

User-reported acceptance: "好了，我没动鼠标" - one click on the AM result, no further mouse interaction.

## Observed

| step | result |
|---|---|
| search | `out of time` in the AM tab, iTunes results rendered |
| click | one click on row 1 (`Out of Time` / `The Weeknd - Dawn FM` / `trackId=1603164465 storefront=us 3:34`) |
| locate | the chain advanced Apple Music's virtualized album list on its own and located the row (previously this required the user to scroll) |
| click (chain) | synthesized double click on the row's safe area |
| window | Apple Music minimized itself after the click landed - the user's screen returned without any manual action |
| verdict | green row line: `SMTC 已验证 · 艺人匹配层：alias · 链与模块判定不一致 · SMTC 实际艺人：Abel Tesfaye — Dawn FM` |

Every field of that verdict is the expected result:
`verified` from independently observed SMTC state, `alias` for the known credit difference, the
chain-vs-module disagreement surfaced instead of hidden, and the observed artist reported as-is.

## What this closes

`搜索栏 AM 标签 -> amc.searchTracks -> 自有 AM 结果模型 -> 点击 -> amc.playTrack -> canonicalUrl/-Url ->
Apple Music Windows -> 自动滚动定位 -> 合成双击 -> 最小化 -> SMTC -> verifyAgainstSmtc`

i.e. the full path works with no manual intervention, without converting iTunes results into the song
model and without touching the provider registry.

## Commits in this slice

| commit | content |
|---|---|
| `20e6ed6` | amc auxiliary section in the All tab (side-channel, only when it has results) |
| `cbaae40` | dedicated AM tab; floating panel button off by default |
| `b442b3c` | fix: AM branch used `requestSeq` before its declaration - every reply was dropped, tab searched forever |
| `b056ed8` | style: restore the newline lost by that insertion |
| `0907392` | play AM results via `amc.playTrack` (hover/click, verdict from SMTC) |
| `f13f9ec` | renderer watchdog so a slow chain explains itself instead of freezing silently |
| `3cfb15c` | chain: bounded UIA materialize scroll for rows below the fold (authorised `am-play.ps1` exception) |
| `f5dd8fd` | chain: minimize Apple Music right after the song click lands |

## Frozen chain after this slice

`am-uia.ps1`, `am-smtc.ps1`, `am-common.ps1`: byte-identical to `0170bca`.
`am-play.ps1`: deviates (authorised exception) - materialize scroll + post-click minimize.
Current `am-play.ps1` SHA256: `5222963476E757089E3E2F32889461F74EF4B0C7A035603F57EBDCB6DF4A62DE`.

## Known limits (unchanged, for the record)

- The materialize step is bounded to 8 downward scrolls, 1000 ms apart. A very long playlist could still
  need more than that; the budget is a single pair of constants if it ever has to grow.
- The chain-vs-module disagreement (`chainStage=SMTC_WRONG_TRACK` vs `verified`) is by design: the chain
  compares artists strictly, the module knows the alias table. Both facts are shown.