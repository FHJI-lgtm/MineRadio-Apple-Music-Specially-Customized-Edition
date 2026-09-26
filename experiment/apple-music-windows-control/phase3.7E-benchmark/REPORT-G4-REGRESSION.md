# G4 report: 20-song behaviour regression + S2 risk observation

**Scope**: G4 only, as authorised — 20 songs, the same fixture and order as ④, `Retries 0`, the frozen
chain with **only the W3 hunk** changed, and **no performance claim**. Apple Music was `Paused` before the
run (baseline precondition restored), so no gate ii interference.

**Verdict summary**: **G4-A (behaviour regression) PASS** — zero stage changes, failure set identical to ④.
**G4-B (S2 risk) no evidence of the failure mode** — 0 wrong-track outcomes in 20 runs; `clickRecomputed`
moved 4 -> 2 with **disjoint** sets, which is **not interpretable** from one run per condition.

## 1. Comparison with ④ (identical fixture, order and retry policy)

| case | stage ④ -> G4 | clickRecomputed ④ -> G4 | playing ④ -> G4 | occ ④ -> G4 (ms) | w3 sat / timeout / waitMs / polls / iconic |
|---|---|---|---|---|---|
| B01 | OK -> OK | False -> False | True -> True | 2527 -> 3459 | True/False/0/1/False |
| B02 | SMTC_TIMEOUT -> SMTC_TIMEOUT | False -> False | False -> False | 9012 -> 8745 | True/False/0/1/False |
| B03 | OK -> OK | **True -> False** | True -> True | 2944 -> 2236 | True/False/0/1/False |
| B04 | SMTC_TIMEOUT -> SMTC_TIMEOUT | False -> False | False -> False | 8957 -> 8299 | True/False/0/1/False |
| B05 | OK -> OK | False -> False | True -> True | 3587 -> 3812 | True/False/0/1/False |
| B06 | OK -> OK | False -> False | True -> True | 3459 -> 4323 | True/False/0/1/False |
| B07 | OK -> OK | **False -> True** | True -> True | 3239 -> 3296 | True/False/0/1/False |
| B08 | OK -> OK | **True -> False** | True -> True | 4103 -> 3379 | True/False/0/1/False |
| B09 | OK -> OK | False -> False | True -> True | 3919 -> 3319 | True/False/0/1/False |
| B10 | OK -> OK | False -> False | True -> True | 3024 -> 2822 | True/False/0/1/False |
| B11 | OK -> OK | **False -> True** | True -> True | 3422 -> 3530 | True/False/0/1/False |
| B12 | OK -> OK | False -> False | True -> True | 3565 -> 3036 | True/False/0/1/False |
| B13 | TARGET_ROW_NOT_FOUND -> TARGET_ROW_NOT_FOUND | False -> False | False -> False | 12421 -> 12439 | **null/null/null/null/null** |
| B14 | OK -> OK | **True -> False** | True -> True | 3199 -> 3147 | True/False/0/1/False |
| B15 | OK -> OK | False -> False | True -> True | 3532 -> 3211 | True/False/0/1/False |
| B16 | OK -> OK | **True -> False** | True -> True | 3358 -> 3199 | True/False/0/1/False |
| B17 | OK -> OK | False -> False | True -> True | 4060 -> 3321 | True/False/0/1/False |
| B18 | OK -> OK | False -> False | True -> True | 3241 -> 3212 | True/False/0/1/False |
| B19 | OK -> OK | False -> False | True -> True | 3756 -> 3546 | True/False/0/1/False |
| B20 | OK -> OK | False -> False | True -> True | 3601 -> 4048 | True/False/0/1/False |

## 2. G4-A: behaviour regression - **PASS**

| check | ④ | G4 |
|---|---|---|
| runs completed | 20 | 20 |
| playingCorrect | **17/20** | **17/20** |
| failure stages | B02:SMTC_TIMEOUT, B04:SMTC_TIMEOUT, B13:TARGET_ROW_NOT_FOUND | **identical** |
| per-case stage changes | - | **none (0)** |
| restore problems (foreground / cursor) | none | **none** |
| new failure codes (`W3_FOREGROUND_TIMEOUT`) | - | **0** |
| `SMTC_WRONG_TRACK` | 0 | **0** |
| control field `t3_ms` p50 | 699 ms | **693 ms** |

`w3Timeout = 0` in all 20 rows: the fail-safe branch never fired on the success path, so G4 does **not**
re-test "timeout => zero input" on the live chain (that property rests on G2's controlled rig).

**Do not over-read**: 17/20 correct is the *same* correctness as the ④ baseline. G4 shows the W3 substitution
did not introduce a regression; it does **not** show that W3 fixed anything, and the pre-existing B02/B04
(`SMTC_TIMEOUT`) and B13 (`TARGET_ROW_NOT_FOUND`) failures are unchanged and unexplained by this experiment.

## 3. G4-B: S2 ("layout settled") risk observation

**The 350 ms was never consumed waiting for S1.** In all 19 rows that reached the click path,
`w3Satisfied=true` with `w3WaitMs = 0` and `w3PollCount = 1`; `w3TargetIconicAtSatisfied=false` in all 19.
Together with G3 that is **22/22 click attempts** where the predicate was already true when the wait began.
(Not a duration claim - a first-poll hit is not a measured transition time.)

**The direct evidence of the S2 failure mode did not appear.** The named chain
`w3Satisfied=true -> geometry read too early -> wrong click -> SMTC_WRONG_TRACK` was **not observed in any of
the 20 runs**: `SMTC_WRONG_TRACK = 0`, `playingCorrect` unchanged, every OK run's SMTC title was the expected
track.

**`clickRecomputed` moved, but this comparison is not interpretable.** ④ flagged {B03, B08, B14, B16} (n=4);
G4 flagged {B07, B11} (n=2); the sets are **disjoint**. With only **one run per condition** the code effect
and run-to-run variation cannot be separated, and the mechanism would predict *fewer* recomputed events
(resuming earlier leaves less time for the rectangle to move) - which is what n=2 vs n=4 looks like, but that
is a single pair of numbers, not evidence. No claim is made in either direction.

**Therefore the honest statement is**: in this 20-song, one-attempt-per-song run under the current
environment, **no wrong click attributable to the earlier geometry read was observed**. This is **not**
"S2 is proven stable" - S2 remains an open, separately-testable question, exactly as the design intended.

## 4. No performance conclusion

Per CONTROL-PLANE §7.4 the occupancy deltas above are **not interpretable** and the deleted wait time is
**not** a gain estimate. `t3_ms` (a control downstream of nothing W3 touches) moved 699 -> 693 ms p50, i.e.
the load is comparable. Nothing here is reported as "faster" or "slower".

## 5. Where this leaves the disposition (operator decision, not taken here)

The W3 substitution is behaviour-neutral on the evidence so far (43/43 click attempts across G3+G4 with no
stage change and no wrong track), and it removes a real hazard: the old code clicked **blind** after a fixed
350 ms even if the window had never become foreground (that path injects clicks into whatever *is*
foreground). Against that, the change resumes the geometry read ~350 ms earlier, which is exactly the
exposure that the (unproven) S2 question covers, and it buys **no measured latency benefit** - the wait was
never consumed anyway.

Two defensible dispositions, for the operator:

1. **Revert** `poc/lib` to the ④ baseline `0170bca` (consistent with the project rule "an unproven behaviour
   change is reverted"; ⑤/⑥ precedent), keep the design, G1/G1b, G2, G3, G4 and this knowledge, and treat
   "does the earlier geometry read matter?" as the next, separately authorised study.
2. **Keep** the substitution as a fail-safe control-flow change (not a latency optimisation), accepting that
   the earlier geometry read then enters the product path before S2 has been studied.

The frozen chain currently **differs from `0170bca` by this one W3 hunk** (commit `477cafc`) pending that decision.

## 6. Evidence

| item | path |
|---|---|
| G4 run | `phase3.7E-benchmark/reports/bench-20260926-101106.jsonl` |
| G4 console log | `phase3.7E-benchmark/reports/g4-console.txt` |
| observer sample series (20) | `phase3.7E-benchmark/reports/B01..B20-20260926-101106.samples` |
| ④ baseline compared against | `phase3.7E-benchmark/reports/bench-20260926-090320.jsonl` |
| W3 change (one hunk) | `poc/lib/am-uia.ps1` (commit `477cafc`) |

**Method note (disclosed)**: two earlier comparison attempts of mine failed - one used `.NET` relative paths
(which resolve against the process CWD, not `Set-Location`), one collided on case-insensitive variable names
(`$pca` vs `$pcA`). Both produced invalid output that is **not** used here. The numbers in this report come
from a third run: a temp script using absolute paths and index-paired rows, plus the harness's own SUMMARY.

Gate status: G0 pass, G1 pass, G1b pass (Q1 closed), G2 pass, G3 pass (3/3), **G4 pass (20/20, G4-A clean,
G4-B no failure mode observed)**. Disposition pending.
