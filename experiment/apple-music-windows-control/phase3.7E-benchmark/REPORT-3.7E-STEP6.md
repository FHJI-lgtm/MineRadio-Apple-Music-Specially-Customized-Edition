# Phase 3.7E step 6 (W2): am-uia.ps1:415 450 ms -> 0

Selected wait per the read-only audit (AUDIT-5WAITS-5Q.md): the only one of the five click-path waits with a
definite following condition-poll, hence the only one with a sharp, falsifiable prediction.

- single change: poc/lib/am-uia.ps1:415 Start-Sleep -Milliseconds 450 -> 0. Line 477 (250 ms) and everything else untouched.
- baseline step 4: reports/bench-20260926-090320.jsonl   step 6: reports/bench-20260926-092741.jsonl
- same 20 pinned songs, same order, one attempt each, Retries 0, resolver outside the measured window.
- declared resolution: requested 50 ms poll -> measured gap median 80 / mean 82 / max 121 ms.

## Result

| | step 4 | step 6 |
|---|---|---|
| playingCorrect | 17/20 | 17/20 |
| failure stages | B02:SMTC_TIMEOUT, B04:SMTC_TIMEOUT, B13:TARGET_ROW_NOT_FOUND | B02:SMTC_TIMEOUT, B04:SMTC_TIMEOUT, B13:TARGET_ROW_NOT_FOUND |
| stage changes per case | none |  |

Paired occupancy delta (6 - 4): n=20 min=-408 p50=-2 max=2114 mean=205; faster=10 slower=10
Paired t6 delta: n=20 min=-447 p50=-41 max=1561 mean=161

| case | stage 4 -> 6 | occupancy 4 -> 6 | d_occ | d_t6 |
|---|---|---|---|---|
| B01 | OK -> OK | 2527 -> 4641 | 2114 | 1561 |
| B02 | SMTC_TIMEOUT -> SMTC_TIMEOUT | 9012 -> 8998 | -14 | -5 |
| B03 | OK -> OK | 2944 -> 2917 | -27 | -79 |
| B04 | SMTC_TIMEOUT -> SMTC_TIMEOUT | 8957 -> 9082 | 125 | 108 |
| B05 | OK -> OK | 3587 -> 3669 | 82 | 22 |
| B06 | OK -> OK | 3459 -> 4372 | 913 | 897 |
| B07 | OK -> OK | 3239 -> 3625 | 386 | 463 |
| B08 | OK -> OK | 4103 -> 3695 | -408 | -447 |
| B09 | OK -> OK | 3919 -> 3724 | -195 | -193 |
| B10 | OK -> OK | 3024 -> 3052 | 28 | -64 |
| B11 | OK -> OK | 3422 -> 3573 | 151 | 92 |
| B12 | OK -> OK | 3565 -> 4358 | 793 | 769 |
| B13 | TARGET_ROW_NOT_FOUND -> TARGET_ROW_NOT_FOUND | 12421 -> 12419 | -2 | -41 |
| B14 | OK -> OK | 3199 -> 2936 | -263 | -173 |
| B15 | OK -> OK | 3532 -> 3517 | -15 | -103 |
| B16 | OK -> OK | 3358 -> 3111 | -247 | -269 |
| B17 | OK -> OK | 4060 -> 4375 | 315 | 370 |
| B18 | OK -> OK | 3241 -> 3185 | -56 | -71 |
| B19 | OK -> OK | 3756 -> 4272 | 516 | 501 |
| B20 | OK -> OK | 3601 -> 3509 | -92 | -121 |

## Verdict: NO_ATTRIBUTABLE_GAIN

Rule fixed before looking at the data: any per-case stage change, any drop in playingCorrect, or any new
failure stage counts as a regression; a GAIN requires median d_occ <= -121 ms (beyond the declared
resolution) with at least 14 of 20 cases faster; anything else is NO_ATTRIBUTABLE_GAIN.

## Exposure caveat (must be quoted with any reading of this result)

Scroll-AmView runs only when the target row is outside the viewport or its visible ratio is below 0.7, and the
benchmark rows do not record scrollSteps or how often that branch was taken. A near-zero aggregate delta is
therefore ambiguous between "the 450 ms was absorbed by the following Wait-AmRect poll" and "this song never
took the scroll branch". Where the two cannot be separated, this report says so and does not assert either.

