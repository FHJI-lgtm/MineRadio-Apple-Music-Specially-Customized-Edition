# G2 report: a controlled FOREGROUND_TIMEOUT blocks every downstream step

**Authorised scope**: G2 only — the negative-path safety test of the proposed W3 state
substitution. G3 (3-song dry run) and G4 (20-song experiment) are **not** authorised, and no
song was played, no click was sent, and the frozen chain was not modified.

## 1. How the timeout was produced (the requirement that mattered)

The timeout is **not** produced by hoping `SetForegroundWindow` fails, and the rig never calls any
activation API. The S1 predicate outcome is controlled by an explicit branch:

```
-Mode ForceTimeout   -> predicate forced false; the 350 ms / 10 ms polling loop itself is the real proposed code
-Mode ForceSatisfied -> predicate forced true (control run: proves the gate is the only differentiator)
-Mode Live           -> real predicate GetForegroundWindow == target (NOT part of G2, reserved for later)
```

## 2. Results

| | ForceTimeout (the negative path) | ForceSatisfied (control) |
|---|---|---|
| `s1Satisfied` | **false** | true |
| stage | **W3_FOREGROUND_TIMEOUT** | S1_SATISFIED |
| wait / polls | **354 ms** / 22 polls (cap 350 ms, requested poll 10 ms) | 3 ms / 1 poll |
| downstream steps reached | **0 / 9** | **9 / 9** |
| step order (control) | — | geometryRead > setCursorPos > w4Sleep200 > mouseDown > mouseUp > w5Sleep130 > mouseDown2 > mouseUp2 > smtcVerify |
| cursor before / after | (1383,578) / (1383,578) — **unchanged** | (1383,578) / (1383,578) |
| foreground before / after | 854844 / 854844 — **unchanged** | 854844 / 854844 |
| `mouseMoved` | **false** | false |
| system-wide last-input tick before / after | 6026718 / 6026718 → **no input of any kind was injected** | 6026718 / 6026718 |
| `keyboardInjected` | **false** | false |
| SMTC before / after (read-only, frozen lib) | status `Paused`, title `Mutual` / status `Paused`, title `Mutual` → `playbackOccurred=false`, `playbackMeasured=true` | same |
| **VERDICT** | **PASS** | **PASS** |

The 9 downstream step names mirror the frozen `Invoke-AmRowPlay` order exactly, so the eventual
production edit maps 1:1 onto them.

## 3. What G2 proves, and what it does not

**Proven**

1. **Control-flow reachability, with a controlled input**: with the predicate false for the whole
   deadline, the code takes `W3_FOREGROUND_TIMEOUT` and reaches **0 of 9** downstream steps — no
   geometry read, no cursor move, no click, no double-click, no SMTC verify.
2. **The block is not vacuous**: the *same* code with the predicate true reaches all 9 steps in the
   frozen order. The gate behaviour is therefore the only difference between the two runs.
3. **Real environment invariance**: cursor position, foreground window, and the system-wide
   last-input tick are all identical before and after the forced timeout. The last-input tick is a
   system-level check — it would have changed if *anything* had injected input during the window.
4. **Capability is absent by construction**: the rig declares no injection API and no activation API
   at all (see the scan below), so this file cannot inject even if it wanted to.

**NOT proven (stated so nobody over-reads this)**

- This rig's downstream steps are **non-executing, counted placeholders**. G2 therefore validates the
  *control flow* (that the gate blocks) plus environment invariance; it does **not** prove that a
  production edit wrapping the *real* `SetCursorPos` / `mouse_event` / UIA calls behind this gate is
  safe. That is exactly what G3/G4 must establish, with the real chain and SMTC verification.
- One wait measurement: the 350 ms cap produced **354 ms** at a requested 10 ms poll (22 polls). This
  is a single observation of the deadline overshoot (~one poll step), not a distribution.
- The control run reaching 9/9 in 3 ms is consistent with G1b (S1 holds at the first sample after a
  successful activation). Single observation; not a timing claim.

## 4. Static self-scan (code lines only, comments excluded)

| pattern | count |
|---|---|
| `SetCursorPos`, `mouse_event`, `SendInput`, `SendKeys`, `keybd_event` | **0** each |
| `GetCurrentPattern`, `InvokePattern`, `SetFocus(`, `Click(` | **0** each |
| `BringWindowToTop`, `ShowWindow(`, `SetForegroundWindow(` | **0** each |

## 5. Environment restoration (requested, and NOT part of the G2 measurement)

The inline restoration block **failed and changed nothing**: the harness shell's execution policy
blocked the inline dot-source of `poc/lib/am-common.ps1` and `am-smtc.ps1`
(`running scripts is disabled on this system`), so `Get-AmSmtcState` / `Invoke-AmPause` never
resolved. Consequently the `FINAL_STATE: smtcStatus=` / `smtcTitle=` lines printed empty strings —
**those two lines are not measurements and must not be read as "no session"**. No silent assumption
is made from them; the valid SMTC readings are the ones taken inside the rig (Bypass child process).

What the valid readings showed: the environment was **already** in the benchmark-gate state, so no
restoration action was needed or taken.

| requirement | state observed |
|---|---|
| Apple Music not foreground | foreground was **854844**, not 196682 → restoration branch reported `skipped` |
| target not Playing | SMTC status **Paused** (title `Mutual`) |
| cursor restorable | cursor at (1383,578); no click path ran, nothing moved it |

No additional activation and no additional programmatic transition was performed: the only
`SetForegroundWindow` in this session remains the single authorised G1b one.

## 6. Deliverables

| item | path |
|---|---|
| G2 rig (no injection/activation API declared) | `phase3.7E-benchmark/g2-negative-path.ps1` |
| forced-timeout run summary | `.../reports/g2-g2-timeout-20260926-100406-summary.txt` |
| control (forced-satisfied) run summary | `.../reports/g2-g2-control-20260926-100406-summary.txt` |
| design under test | `phase3.7E-benchmark/DESIGN-W3-STATE-SUBSTITUTION.md` (§6.3 gate G2) |

Gate status: G0 pass, G1 pass, G1b pass (Q1 closed), **G2 pass**. G3 and G4 remain unauthorised.
