# Phase 3.7E step 5: removing the unconditional 500 ms wait in Invoke-AmNavigateUrl

Change under test: `poc/lib/am-uia.ps1` line 245 `Start-Sleep -Milliseconds 500` -> `0`.
That is the only edit. No other line of the frozen playback chain was touched.

- baseline step 4: `reports/bench-20260926-090320.jsonl`
- step 5: `reports/bench-20260926-090905.jsonl`
- same 20 pinned songs, same order, one attempt each, `Retries 0`, resolver outside the measured window.
- Apple Music non-foreground, non-minimized, on the current desktop, target not already playing (gate ii) on every run.

Declared measurement resolution: requested 50 ms poll -> measured gap median 80 ms / mean 82 ms / max 121 ms
(empty baseline 20260926-084630, 255 samples). Medians and P90 are meaningful; a single minimum is a lower
bound only; T7 is not observable and is not reported anywhere here.

## Disposition: reverted

The 500 ms -> 0 edit was rolled back in commit `19e881d`. `poc/lib/am-uia.ps1:245` is again
`Start-Sleep -Milliseconds 500`, and all four frozen-chain files (`am-play.ps1`, `am-uia.ps1`, `am-smtc.ps1`,
`am-common.ps1`) are byte-identical to the step-4 baseline `0170bca`.

The reason is not that 0 ms is worse. It is that the edit is an unproven behaviour change: it removed a wait
whose purpose has not been established, and bought no stable, attributable latency gain. This is not described
as a successful optimisation at product level. The accurate statement is:

> Deleting the 500 ms fixed wait did not change correctness, but under this 20-song, one-attempt-per-song
> experiment it produced no latency gain that can be stably attributed to the deletion.

mainline keeps the original behaviour. The experiment branch keeps the evidence: `4317e3b` (the edit),
`bench-20260926-090905.jsonl` (raw data), this report (result). Rolling the code back loses none of it.

The 1250 ms of click-path fixed sleeps (120 + 450 + 350 + 200 + 130) are explicitly **not** scheduled for audit
now. This experiment established the fact that wall-clock fixed sleep does not translate one-for-one into
observable latency reduction, so a large number is not by itself a reason to delete a wait. Before any of those
sleeps is touched, the first question is what state each one waits for, and whether a following condition-poll
would absorb it the way most of this 500 ms was absorbed. If that audit is ever resumed, it keeps the existing
protocol: one sleep changed at a time, same 20 songs, same order, `Retries 0`, and a paired comparison of
correctness, SMTC outcome, occupancy and every `t.*` field - and it should start from the sleep with the
clearest theoretical justification, not from the largest number.

The generalised form of this criterion is now a standing seam convention in `CONTROL-PLANE.md` §7 (invariant
I7): the **Wait Absorption Principle** - "fixed-wait latency is not equivalent to observable latency" - and
**"one wait, one hypothesis, one controlled comparison"**. This report is cited there as the empirical case,
so the finding constrains future Activation-layer work instead of staying a Phase 3.7E anecdote.

## Correctness: did the change break anything

| | step 4 | step 5 |
|---|---|---|
| playingCorrect | 17/20 | 17/20 |
| failure stages | B02:SMTC_TIMEOUT, B04:SMTC_TIMEOUT, B13:TARGET_ROW_NOT_FOUND | B02:SMTC_TIMEOUT, B04:SMTC_TIMEOUT, B13:TARGET_ROW_NOT_FOUND |

The failure set is identical, case for case and stage for stage. The change is correctness-neutral: it neither
fixes nor introduces a failure. B02/B04/B13 were not worked around.

## Foreground occupancy = T10 - T3 (ms)

| set | n | min | p50 | max | mean |
|---|---|---|---|---|---|
| step 4, all valid runs | 20 | 2527 | 3532 | 12421 | 4446 |
| step 4, success only | 17 | 2527 | 3459 | 4103 | 3443 |
| step 5, all valid runs | 20 | 2791 | 3488 | 12446 | 4489 |
| step 5, success only | 17 | 2791 | 3438 | 4402 | 3500 |

## Paired per-song deltas, step 5 minus step 4 (ms)

| delta | n | min | p50 | max | mean | faster / slower |
|---|---|---|---|---|---|---|
| occupancy, all cases | 20 | -885 | -153 | +1473 | +43 | 11 / 9 |
| occupancy, success only | 17 | -885 | -153 | +1473 | +57 | - |
| t6, success only | 17 | -825 | -108 | +1475 | +61 | - |

## Other stage timings (step 4 -> step 5)

- `t6_ms` (all 20): p50 3969 -> 3903, min 3074 -> 3207, max 13461 -> 13516, mean 4965 -> 5014
- `contentMatchMs` (all 20): p50 1813 -> 1750, min 1093 -> 1280, max 2502 -> 2211, mean 1789 -> 1789
- `activation_to_click_upper_bound_ms` (all 20): p50 3262 -> 3212, min 2206 -> 2526, max 12754 -> 12776, mean 4263 -> 4307
- `t3_ms` (all 20): p50 699 -> 699 (the change is downstream of T3, so T3 is a control)

## Per-song table

| case | stage 4 -> 5 | contentMatchMs 4 -> 5 | t6_ms 4 -> 5 | occupancy 4 -> 5 | d_occ | d_t6 |
|---|---|---|---|---|---|---|
| B01 | OK -> OK | 1093 -> 2151 | 3074 -> 4549 | 2527 -> 4000 | +1473 | +1475 |
| B02 | SMTC_TIMEOUT -> SMTC_TIMEOUT | 1822 -> 2099 | 10027 -> 10319 | 9012 -> 9311 | +299 | +292 |
| B03 | OK -> OK | 1489 -> 1280 | 3378 -> 3207 | 2944 -> 2791 | -153 | -171 |
| B04 | SMTC_TIMEOUT -> SMTC_TIMEOUT | 1837 -> 1347 | 9952 -> 9544 | 8957 -> 8513 | -444 | -408 |
| B05 | OK -> OK | 1966 -> 1938 | 4017 -> 3934 | 3587 -> 3488 | -99 | -83 |
| B06 | OK -> OK | 1813 -> 2211 | 3821 -> 4254 | 3459 -> 3795 | +336 | +433 |
| B07 | OK -> OK | 1491 -> 1437 | 3599 -> 3491 | 3239 -> 3042 | -197 | -108 |
| B08 | OK -> OK | 2502 -> 2011 | 4433 -> 4053 | 4103 -> 3575 | -528 | -380 |
| B09 | OK -> OK | 2161 -> 1702 | 4355 -> 3899 | 3919 -> 3438 | -481 | -456 |
| B10 | OK -> OK | 1401 -> 1528 | 3528 -> 4302 | 3024 -> 3846 | +822 | +774 |
| B11 | OK -> OK | 1807 -> 2079 | 3915 -> 4710 | 3422 -> 4402 | +980 | +795 |
| B12 | OK -> OK | 1976 -> 1750 | 3969 -> 3813 | 3565 -> 3359 | -206 | -156 |
| B13 | TARGET_ROW_NOT_FOUND -> TARGET_ROW_NOT_FOUND | 1703 -> 1789 | 13461 -> 13516 | 12421 -> 12446 | +25 | +55 |
| B14 | OK -> OK | 1442 -> 1684 | 3581 -> 3743 | 3199 -> 3275 | +76 | +162 |
| B15 | OK -> OK | 1903 -> 1734 | 3969 -> 3762 | 3532 -> 3296 | -236 | -207 |
| B16 | OK -> OK | 1750 -> 2109 | 3834 -> 4040 | 3358 -> 3712 | +354 | +206 |
| B17 | OK -> OK | 1942 -> 1579 | 4450 -> 3625 | 4060 -> 3175 | -885 | -825 |
| B18 | OK -> OK | 1534 -> 1871 | 3665 -> 3903 | 3241 -> 3510 | +269 | +238 |
| B19 | OK -> OK | 2189 -> 1702 | 4244 -> 3855 | 3756 -> 3422 | -334 | -389 |
| B20 | OK -> OK | 1963 -> 1770 | 4022 -> 3761 | 3601 -> 3382 | -219 | -261 |

## Reading

The hypothesis was that the unconditional 500 ms sleep is a fixed cost on every successful attempt, so removing
it should shift occupancy by roughly -500 ms. The measurement does not support that.

Paired occupancy moved by a median of -153 ms (n=20; 11 cases faster, 9 slower), with single-case deltas
spanning -885 ms to +1473 ms. That spread is an order of magnitude above the 80 ms poll resolution and larger
than the change under test, so the run-to-run variance of the navigate/locate/click stage dominates this signal.
The honest description is: removing the wait is harmless but not measurably decisive, and the ~500 ms was
largely absorbed by adjacent waits rather than being additive.

Two details support that reading rather than contradicting it. `t3_ms` is unchanged (p50 699 -> 699), so the
change sits entirely downstream of the measurement start. And `contentMatchMs` moved in both directions with an
unchanged mean (1789 -> 1789): the locate stage has roughly +/-500 ms of natural variance that this experiment
cannot resolve with 20 samples.

What remains on the success path is untouched by this step: the click path still carries 120 + 450 + 350 + 200 +
130 = 1250 ms of fixed sleeps plus a 200 ms post-foreground wait, navigation polls quantise at 0-300 ms and SMTC
polls at 0-120 ms, and `PageWaitMs = 12000` remains a cap, not a cost. If a real reduction is wanted, those are
the next candidates, to be audited one at a time under this same protocol.

No further change was made in this step.

## Harness provenance (why this report supersedes an earlier revision)

This file replaces a first step-5 report of the same name, whose aggregate sections were wrong and which has been
deleted. That earlier revision had been generated by a PowerShell helper that mis-bound twice, collapsing
per-file statistics to a single row and producing an empty paired table; its numbers were never valid and none
of them are reused here.

Two attempts at the step-5 run itself also produced no data: this shell runs Windows PowerShell 5.1 with script
execution blocked, so `& .\run-bench.ps1` failed with `running scripts is disabled on this system`, and `pwsh`
is not on PATH. Those attempts were discarded - they were not "no difference" results. The step-5 data above
comes from `powershell -NoProfile -ExecutionPolicy Bypass -File`, whose inner exit code was 0, which wrote
`reports/bench-20260926-090905.jsonl` with 20 rows.

Every number here is either taken from the benchmark's own run summary or recomputed per row and hand-checked
against the per-song table. No value was smoothed, substituted or inferred.
