# G3 report: three-song dry run with the real W3 substitution in the click chain

**Scope**: G3 only. Three songs, pinned URLs, `Retries 0`, same frozen chain, **only W3 changed**,
no performance claim. G4 remains unauthorised.

**Change under test (one hunk in the frozen chain)**

`poc/lib/am-uia.ps1` `Invoke-AmRowPlay`, W3 only: `Start-Sleep -Milliseconds 350` becomes a wait for
the observable state `GetForegroundWindow() == $Hwnd`, capped at the **same 350 ms**, with a fail-safe
timeout. On timeout the function returns `stage = W3_FOREGROUND_TIMEOUT` **before** the geometry read,
cursor move, click and double-click. No layout condition was added (S1 only). `Invoke-AmForeground`
(ShowWindow/SW_RESTORE + SetForegroundWindow) is untouched, W4/W5/geometry/click/SMTC/resolver untouched.
Result: `git diff --stat -- poc/lib` = **1 file, 27 insertions, 1 deletion, one hunk**.

No new P/Invoke was needed: `AmUiaNative.GetForegroundWindow` (line 36) and `IsIconic` (line 37) already
existed, so the Add-Type block was not touched.

`w3*` values reach the benchmark row through a side channel (`$global:AmW3Last`, reset before each
attempt) because the frozen `am-play.ps1` aggregation is deliberately not modified. Harness change
(`run-bench.ps1`, not frozen): 8 insertions / 1 deletion - `-Case` accepts a comma list, the side channel
is reset per attempt, and five `w3*` fields plus one console line are emitted.

## 1. Selection and results

Songs chosen from the ④/⑤/⑥ baselines where the chain was **OK**, so any deviation would be attributable
to the W3 change rather than to a known-bad case.

| case | stage | result | SMTC | playingCorrect | w3Satisfied | w3Timeout | **w3WaitMs** | **w3PollCount** | **w3TargetIconicAtSatisfied** | clickRecomputed | navigated | contentMatchMs | t3 | t6 | occupancy | restoreFg / restoreCursor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B01 | OK | OK | Playing / BIRDS OF A FEATHER | true | true | false | **0** | **1** | false | false | true | 3421 | 816 | 5591 | 5064 | ok / ok |
| B03 | OK | OK | Playing / Good Luck, Babe! | true | true | false | **0** | **1** | false | false | true | 1481 | 686 | 3059 | 2586 | ok / ok |
| B05 | OK | OK | Playing / we can't be friends (wait for your love) | true | true | false | **0** | **1** | false | false | true | 1977 | 700 | 3645 | 3220 | ok / ok |

Summary line from the harness: `runs=3 playingCorrect=3/3 timingValid=3`, no failure stages.

## 2. The notable result: S1 was already true when the wait began

`w3WaitMs = 0` with `w3PollCount = 1` in **all three** runs: the predicate was satisfied on the very
first evaluation, i.e. the foreground was already the target window by the time W3 started polling.

**What this does and does not mean**

- It means the fixed 350 ms was **not** being spent waiting for S1 in these three runs.
- It does **not** mean "the transition takes 0 ms", and it does **not** by itself prove what the 350 ms
  was covering. A single first-evaluation hit is not a duration measurement.
- It is consistent with G1b (the programmatic transition put the target in the foreground immediately:
  `SetForegroundWindow` returned true, and S1 held at the first sample after the call).

## 3. Stop-condition checklist (any failure would have blocked G4)

| stop condition | observed | verdict |
|---|---|---|
| input occurred after a W3 timeout | **no timeout occurred** (0/3 rows with `w3Timeout=true`) | not triggered - see caveat below |
| click continued although the foreground was not the expected window | all 3 had `w3Satisfied=true` and SMTC confirmed the **expected** track | clean |
| unexplained wrong click after `w3Satisfied=true` | 3/3 played the correct song (SMTC title == target, `playingCorrect=3/3`) | clean |
| SMTC wrong track | none (`SMTC_WRONG_TRACK` never appeared) | clean |
| cursor / foreground restore abnormality | `restoreCursor=ok`, `restoreForeground=ok` on all 3; no `INVALID_RESTORE` | clean |
| benchmark gate broken | `gate1 ok` on all 3; no `INVALID_PRECONDITION` | clean |
| extra diff in the frozen chain outside W3 | one hunk only, at the W3 block (27+/1-) | clean |

**Caveat that must travel with the first row**: because no real timeout occurred, G3 did **not** re-test
"timeout => zero input" on the live chain. That property rests on G2's controlled forced-timeout rig
(0/9 downstream, cursor/foreground/last-input-tick/SMTC all unchanged). G3 tested the success path.

## 4. Second observation to carry into G4: the geometry re-read now happens earlier

In ④ (fixed 350 ms) B03 reported `clickRecomputed=true`; in G3 it is `false`, and B01/B05 were `false`
in both. With the wait collapsed to ~0 ms, the post-foreground geometry re-read now happens much closer
to the foreground call, so it can observe a rectangle that has not finished moving. All three G3 songs
still played the correct track, but:

- n=3 is not a clearance for this risk;
- this is exactly the S2 ("layout settled") question the design deliberately kept **separate** from S1;
- G4's 20-song set includes the songs whose geometry did move in the baselines, so G4 is the first place
  where an early re-read could plausibly produce a wrong-row click - and `SMTC_WRONG_TRACK` plus
  `clickRecomputed` are the fields that would show it.

## 5. What G3 does NOT establish

- **No performance claim.** Occupancy here is B01 5064 / B03 2586 / B05 3220 ms; in ④ the same songs were
  2527 / 2944 / 3587 ms. At n=3 with per-song run-to-run spread of ±500-2000 ms (CONTROL-PLANE §7.4)
  these differences are not interpretable, and the deleted milliseconds are not a gain estimate.
- No claim that the frozen chain's other failure modes (B02/B04 `SMTC_TIMEOUT`, B13
  `TARGET_ROW_NOT_FOUND`) changed: none of those three cases was run.
- No claim about the production behaviour of the A-uia backend beyond these three songs.

## 6. Evidence

| item | path |
|---|---|
| 3-song run report | `phase3.7E-benchmark/reports/bench-20260926-100739.jsonl` |
| harness (w3 capture, `-Case` list) | `phase3.7E-benchmark/run-bench.ps1` |
| frozen chain (W3 hunk only) | `poc/lib/am-uia.ps1` |
| design under test | `phase3.7E-benchmark/DESIGN-W3-STATE-SUBSTITUTION.md` |
| G2 rig that carries the timeout-safety property | `phase3.7E-benchmark/g2-negative-path.ps1` |

**Note on the working tree**: the frozen chain currently differs from the ④ baseline `0170bca` by this
one W3 hunk. Per the ⑤/⑥ precedent it stays a separate experiment commit until G4 (if authorised)
decides keep-or-revert.

Gate status: G0 pass, G1 pass, G1b pass (Q1 closed), G2 pass, **G3 pass (3/3)**, G4 not authorised.
