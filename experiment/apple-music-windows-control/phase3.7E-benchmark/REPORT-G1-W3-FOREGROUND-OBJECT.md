# G1 report: which object is the foreground during Apple Music activation

**Question (G1)** — in this activation path, is `$Hwnd` the foreground object we want S1 to mean?
It does **not** ask "which comparison is better"; no condition was loosened to reduce hypothetical timeouts.

**Discipline** — read-only. The probe never activates, never changes Z-order, never calls a UIA pattern,
never injects input, never calls `SetForegroundWindow`/`SetWindowPos`. `HWND == 0` is recorded as
`foregroundIsNull=true` and means **S1 NOT SATISFIED** (never a wildcard, never a root fallback).
Static self-scan of both probe files: **0 injection-API call sites**.

**Sampling parameter** — requested `P = 10 ms`, probe-only: it is not a production recommendation and it
does not participate in any conclusion about whether W3 can be optimised. Measured gaps are reported below.

---

## 1. Runs

| run | seconds | samples | measured sample gap (median / mean / max) | AM foreground runs | directEqual samples | amProcess-but-not-direct | rootEqualOnly | null foreground |
|---|---|---|---|---|---|---|---|---|
| validation `validate-20260926-093656` | 12 | 748 | 16 / 16 / 48 ms | 0 | 0 | 0 | 0 | 0 |
| observation 1 `observe-20260926-093656` | 300 | 18 899 | 15 / 16 / 50 ms | 2 | 1 131 | **0** | **0** | 1 |
| observation 2 `observe2-20260926-094241` | 300 | 18 938 | 16 / 16 / 60 ms | 20 | 2 875 | **0** | **0** | 4 |

All (non-null) foreground samples that belonged to the Apple Music process were **196682 itself**:
`1 131` and `2 875` — identical to the `directEqual` counts, with **zero** samples where the foreground was
another Apple Music window.

## 2. The target object

Apple Music owns **6 top-level windows** (one process, pid 8312). Every one of them is its own root —
there is no parent/child relation between them:

| hwnd | root | visible | iconic | class | title |
|---|---|---|---|---|---|
| 330374 | 330374 | False | False | WinUIDesktopWin32WindowClass | WinUI Desktop |
| 264534 | 264534 | False | False | GDI+ Hook Window Class | GDI+ Window (AppleMusic.exe) |
| **196682** | **196682** | **True** | (varies) | WinUIDesktopWin32WindowClass | **Apple Music** |
| 196982 | 196982 | False | False | MSCTFIME UI | MSCTFIME UI |
| 197288 | 197288 | False | False | IME | Default IME |
| 328342 | 328342 | False | False | IME | Default IME |

`196682` is the first visible window with a non-empty title (the selection convention is printed in every
run's summary so it stays auditable), and it is exactly the handle the benchmark has always reported as
`hwnd=196682`.

## 3. Answer to Q1

**In every observed activation, the foreground object was `$Hwnd` itself (196682).**
`CASE_A=true`, `CASE_B=false` in both observation runs; `rootEqualOnlySamples = 0` in both.

Consequences, stated at exactly the strength the data supports:

1. For the observed activation path, **direct equality (`foregroundHwnd == targetHwnd`) is the correct S1
   definition**, and there is no evidence that `GA_ROOT` normalisation is needed.
2. `GA_ROOT` normalisation would only differ from direct equality if the foreground were a *child* of
   196682 — no such sample occurred (0 of 4 006 AM-foreground samples).
3. This is **not yet closed for the chain's own programmatic path**: all 22 observed AM foreground runs were
   produced by the operator (Alt+Tab / taskbar / mouse). The frozen chain activates with
   `IsIconic ? ShowWindow(SW_RESTORE)` followed by `SetForegroundWindow`, and that programmatic transition was
   never observed, because G1 was explicitly forbidden from activating anything.
   The honest statement is: **Q1 is answered for human activations and remains open for the programmatic one.**

## 4. What the second run added: S1 does not imply "restored"

`targetIconic` / `targetVisible` were added to the probe **before** observation 2 only. (Run 1's raw file has no
such field, so run-1 counts of it are not data and are not reported as such.)

In observation 2, of the 2 875 samples where the foreground was 196682, **3 samples still reported
`IsIconic(196682) = true`** — they are the first samples of the run's first three AM foreground runs
(starts at 34424, 43528, 76093 ms), i.e. the three activations that had to restore a minimized window.
After the window was restored once, no later activation showed `iconic=true`.

That is a real, measured nuance for the W3 design:

- **S1 (`foreground == $Hwnd`) can hold while the window is still minimized.** S1 therefore does **not** imply
  "restored and laid out", and it does not imply the click geometry read immediately after is valid.
- It reinforces keeping S2 ("geometry settled") as a **separate** question rather than silently folding a
  stability condition into S1.

## 5. Nothing was chosen leniently: the `hwnd = 0` transition is real

| run | null-foreground samples | null immediately before an AM foreground run |
|---|---|---|
| observation 1 | 1 (31 ms episode at 278863) | 0 |
| observation 2 | 4 (31 / 15 ms and two shorter) | **1** (15 ms null at 235667, AM at 235682) |

So a transition can pass through `GetForegroundWindow() == 0` for ~15 ms and then go straight to the target.
Under the fixed rule this is `S1 NOT SATISFIED` and the wait keeps polling — which is exactly the behaviour that
prevents the transition window from being mistaken for success.

Observed transition shape (both runs, descriptive only): a short-lived window `65970` (pid 17340) appears for
48–169 ms immediately before AM takes the foreground in most runs — consistent with a switcher/shell helper —
and in one case the sequence was `0 → 196682` directly. None of these intermediates was ever an Apple Music
window.

## 6. Field reliability of `activeDesktop`

Recorded as specified, but it is a low-reliability field at a 100 ms refresh cadence and is reported as such:

| run | desktop `7a8a789c-3926-4cb9-807f-dc11278c2841` | `unavailable` | all-zero GUID |
|---|---|---|---|
| observation 1 | 16 579 | 1 069 (5.7%) | 1 251 (6.6%) |
| observation 2 | 18 030 | 908 (4.8%) | 0 |

The real desktop GUID is `7a8a789c-3926-4cb9-807f-dc11278c2841` (same as earlier phases). `unavailable` and the
all-zero GUID are both "not a usable value" and were never treated as a desktop identity anywhere in this report.

## 7. Evidence

| item | path |
|---|---|
| probe runner | `phase3.7E-benchmark/probe-w3-foreground.ps1` |
| probe library (Win32 + documented desktop API, read side) | `phase3.7E-benchmark/lib/w3probe.ps1` |
| run 1 summary / window snapshots | `.../reports/w3probe-observe-20260926-093656-summary.txt`, `...-windows.json` |
| run 2 summary / window snapshots | `.../reports/w3probe-observe2-20260926-094241-summary.txt`, `...-windows.json` |
| validation summary / snapshots | `.../reports/w3probe-validate-20260926-093656-summary.txt`, `...-windows.json` |
| raw 10 ms series (run 1 / run 2 / validation) | `.../reports/w3probe-{observe,observe2,validate}-*.jsonl` |
| commit of the facility + small evidence | `d1e3517` |

The two observation raw series are ~19 000 samples each. They are **retained on disk but not committed**
(the 10 ms series is multi-MB per run); every number in this report is derivable from the committed summaries
plus the raw files, and the summaries contain the full window enumeration and the complete episode list.

## 8. What this changes in the W3 design

1. **S1 definition confirmed as direct equality** for the observed path; `GA_ROOT` is *not* adopted. The
   programmatic-path observation (below) would be the only thing that could reopen it.
2. **Add a metric, not a condition**: record `w3TargetIconicAtSatisfied` (the target's `IsIconic` at the
   instant S1 became true). If the substitution ever resumes while `iconic=true`, that is visible in the data
   instead of being hidden.
3. **`S1 AND NOT IsIconic($Hwnd)` is a declared candidate**, to be used only if the W3 experiment shows
   failures or wrong-row clicks attributable to resuming too early. It must not be folded into S1 silently —
   that would be two hypotheses in one experiment.
4. **`hwnd = 0` handling is now empirically grounded**, not defensive: it occurred 5 times across the runs and
   once immediately preceded the target becoming foreground.
5. Anything that would close the remaining gap — observing the chain's own
   `ShowWindow(SW_RESTORE) + SetForegroundWindow` transition — is an **activation**, which G1 was not
   authorised to perform. It needs a separate, explicit decision.
