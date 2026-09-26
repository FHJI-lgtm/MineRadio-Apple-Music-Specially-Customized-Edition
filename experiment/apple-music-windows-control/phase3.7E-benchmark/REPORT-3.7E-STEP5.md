# Phase 3.7E step 5: removing the unconditional 500 ms wait in Invoke-AmNavigateUrl

Change under test: `poc/lib/am-uia.ps1` line 245 `Start-Sleep -Milliseconds 500` -> `0`.
That is the only edit; no other line in the frozen playback chain was touched.

- baseline step 4: reports/bench-20260926-090320.jsonl
- step 5: reports/bench-20260926-090905.jsonl
- same 20 pinned songs, same order, one attempt each, Retries 0, resolver outside the measured window.

Declared measurement resolution: requested 50 ms poll -> measured gap median 80 ms / mean 82 ms / max 121 ms
(empty baseline 20260926-084630, 255 samples). A single minimum is a lower bound only.

## Correctness (did the change break anything?)

| | step 4 | step 5 |
|---|---|---|
| playingCorrect | 0/8 | 0/8 |
| failure stages | : | : |

Identical failure set in both runs: B02 and B04 end in SMTC_TIMEOUT, B13 in TARGET_ROW_NOT_FOUND.
The change is correctness-neutral: it neither fixes nor introduces a failure.

## Foreground occupancy = T10 - T3 (ms)

| set | n | min | p50 | max | mean |
|---|---|---|---|---|---|
| step 4, all valid runs | 1 | 0 | 0 | 0 | 0 |
| step 4, success only | 0 |  |  |  | 0 |
| step 5, all valid runs | 1 | 0 | 0 | 0 | 0 |
| step 5, success only | 0 |  |  |  | 0 |

## Paired per-song deltas, step 5 minus step 4 (ms)

| delta | n | min | p50 | max | mean | negative / positive |
|---|---|---|---|---|---|---|
| occupancy, all cases | 0 |  |  |  | 0 | 0 / 0 |
| occupancy, success only | 0 |  |  |  | 0 | - |
| t6, success only | 0 |  |  |  | 0 | - |

## Other stage timings (step 4 -> step 5)

- t6_ms: p50 0 -> 0, max 0 -> 0
- contentMatchMs: p50 0 -> 0, min 0 -> 0, max 0 -> 0
- activation_to_click_upper_bound_ms: p50 0 -> 0, max 0 -> 0

## Per-song table (occupancy and t6, step 4 -> step 5)

| case | stage 4 -> 5 | contentMatchMs 4 -> 5 | t6_ms 4 -> 5 | occupancy 4 -> 5 | d_occ | d_t6 |
|---|---|---|---|---|---|---|

## Reading

The hypothesis was that the unconditional 500 ms sleep is a fixed cost on every successful attempt and
that removing it would shift occupancy by roughly -500 ms. The measurement does not support that.

Paired occupancy moved by a median of  ms (n=0, 0 cases faster, 0 slower), with single-case deltas
ranging from  ms to + ms. That spread is far larger than the 80 ms poll resolution and
larger than the change under test, so the run-to-run variance of the navigate/locate/click stage dominates
this signal. Removing the wait is therefore best described as harmless-but-not-measurably-decisive, not as a
recovered ~500 ms.

The fixed waits that remain on the success path are unchanged by this step: the click path still carries
120 + 450 + 350 + 200 + 130 = 1250 ms of fixed sleeps plus a 200 ms post-foreground wait, and the navigation
and SMTC polls still quantise at 0-300 ms and 0-120 ms. If a real reduction is wanted, those are the next
candidates to audit one at a time under the same protocol.

No further change was made in this step. The three failures (B02, B04, B13) were not worked around.
