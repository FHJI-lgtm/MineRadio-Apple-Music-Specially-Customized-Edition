# G1b report: one programmatic transition (ShowWindow + SetForegroundWindow), observed read-only

**Authorisation** — exactly **one** programmatic transition, to close the remaining part of Q1.
Allowed action: `if IsIconic($Hwnd) -> ShowWindow($Hwnd, SW_RESTORE)` then `SetForegroundWindow($Hwnd)`,
mirroring the frozen chain's `Invoke-AmForeground` order.
Prohibited and absent: mouse, keyboard, wheel, UIA `Invoke`/`Click`, `SetCursorPos`, `SendInput`,
`SendKeys`, and any click on an Apple Music control.
This is **not** a W3 performance test; nothing here measures or removes the 350 ms wait.

## 1. The single transition

| observation | value |
|---|---|
| foreground before the call | 854844 (not Apple Music) |
| target at that moment | `IsIconic(196682)` = **true** (minimized) |
| `ShowWindow(196682, SW_RESTORE)` | called = true, returned **true** |
| `SetForegroundWindow(196682)` | returned **true**, call duration t1 − t0 = **1 ms** |
| first sample with `foregroundHwnd == 196682` | t0 **+ 2 ms** (tMs 3033) |
| `targetIconic` at that instant | **false** (already restored) |
| `hwnd = 0` samples in the whole run | **0** (before and after the call) |
| final foreground at end of window | **196682** (held for the whole 8 s) |
| samples / directEqual | 693 / 503 |
| measured sample gap | median **16** / mean 16 / max 44 ms (requested 10 ms) |

**Resolution caveat that must be quoted with the "+2 ms"**: with a ~16 ms sample gap, "S1 satisfied at
t0 + 2 ms" means *S1 held at the first sample taken after the call*. It is **not** a measured transition
duration and must never be reported as "the programmatic transition takes ~2 ms". One observation, single
sample — no distribution.

## 2. Answer to the open part of Q1

The programmatic path puts **196682 itself** in the foreground, exactly like the 22 human activations:
`directEqual` held, `CASE_B` (root-equal but handle-different) remains **0 observations**.

**Q1 is therefore closed**: `S1 := GetForegroundWindow() == $Hwnd` is adopted as the S1 definition, and
`GA_ROOT` normalisation is **not** adopted. Total evidence: 23 activations (22 human + 1 programmatic),
4 509 AM-foreground samples, 0 samples where the foreground belonged to Apple Music while being a handle
other than 196682.

What this run does **not** establish, and must not be read into it:

- Nothing about the 350 ms wait, and nothing about layout (S2). `targetIconic=false` at the S1 instant here
  versus 3 samples with `iconic=true` in the human path is one sample against three, at the resolution limit;
  neither is a finding about ordering.
- `SetForegroundWindow` returning `true` here does **not** mean it always will. This call came from a process
  whose parent chain owned the foreground, which is one of the documented conditions for success. Q2
  ("Windows may refuse") stays open as a general risk; it simply did not fire in this one observation.

## 3. Disclosure: the probe's own scan block was defective (fixed after the run, probe not re-run)

The scan lines printed by the transition run were **not valid evidence**:

- `forbidden 'SetCursorPos' = 1`, `SendInput = 1`, `SendKeys = 1` were **false positives** — they matched the
  prose in the file's header comment, which names the prohibited APIs, not any call site.
- `allowed 'ShowWindow(' = 0` and `'SetForegroundWindow(' = 0` were **false negatives** — the patterns were
  built by array concatenation (`('Show','Window') + '('`), and PowerShell joins that array with a space.

The block was rewritten (code lines only, patterns built with explicit string concatenation) and a corrected
standalone scan was produced. **The probe was not re-run**: only one transition was authorised and it had
already happened. The corrected evidence:

| check | result |
|---|---|
| probe forbidden call sites (`SetCursorPos` / `mouse_event` / `SendInput` / `SendKeys` / `Cursor.Position` / `MoveTo(` / `BringWindowToTop`) | **0** each |
| probe `ShowWindow(` / `SetForegroundWindow(` | **2** each (1 P/Invoke declaration + 1 call site) |
| probe UIA / click APIs (`GetCurrentPattern`, `InvokePattern`, `ScrollItemPattern`, `VirtualizedItemPattern`, `SetFocus(`, `Click(`) | **0** each |
| shared lib `lib/w3probe.ps1`: forbidden call sites and activation APIs | **0** |

## 4. Evidence

| item | path |
|---|---|
| one-shot probe (the only file declaring the two activation entry points) | `phase3.7E-benchmark/probe-w3-programmatic-transition.ps1` |
| raw 10 ms series (693 samples) | `phase3.7E-benchmark/reports/w3prog-prog-20260926-095949.jsonl` |
| run summary (contains the defective scan lines, with this report as the correction) | `.../reports/w3prog-prog-20260926-095949-summary.txt` |
| corrected static scan | `.../reports/w3prog-prog-20260926-095949-staticscan.txt` |
| read-only G1 probe + its two observation runs | `REPORT-G1-W3-FOREGROUND-OBJECT.md` |

## 5. Effect on the W3 design

1. **Q1 closed** — §5's open item is resolved: adopt `S1 := GetForegroundWindow() == $Hwnd`; do not adopt `GA_ROOT`.
2. `w3TargetIconicAtSatisfied` is **kept as a metric**, and `S1 AND NOT IsIconic($Hwnd)` stays an
   **unadopted candidate** (it would be a second hypothesis in the same experiment).
3. The W3 substitution body remains **not authorised**. The planned order is unchanged: G2 (force
   `W3_FOREGROUND_TIMEOUT`, verify zero input injection) -> G3 (3-song dry run) -> G4 (20-song experiment).
