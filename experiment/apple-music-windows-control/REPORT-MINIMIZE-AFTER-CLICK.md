# Minimize Apple Music after the song click (2026-09-26)

Requested by the user: after the automation clicks the song, Apple Music should not be left in front.

## Change (same authorised file, `poc/lib/am-play.ps1` only)

- new top-level helper `Minimize-AmWindow([IntPtr]$Hwnd)` -> `ShowWindow(hwnd, SW_MINIMIZE = 6)`,
  with its own guarded `Add-Type` (`AmPlayNative.Win`) so no other `poc/lib` file has to change;
- called only on the path where the click succeeded (`$ck.ok`), after a 250 ms settle and **before**
  the SMTC wait, recorded as `$result.minimizedAfterClick`.

## Why that placement is safe

- SMTC verification (`Wait-AmPlayback` / `am-smtc.ps1`) reads the system media session; it does not need
  the window visible, so the user gets their screen back while verification is still running.
- Any retry attempt restores/foregrounds the window first (`Restore-AmWindow` / `Invoke-AmForeground` at
  the top of the attempt loop), so minimizing cannot break a subsequent attempt.
- The minimize is deliberately NOT done earlier (e.g. after the navigation click): the materialize
  scroll and the synthesized clicks rely on the window being on screen, so it must stay visible until the
  song click has landed.

## Frozen-chain status

`am-uia.ps1`, `am-smtc.ps1`, `am-common.ps1` still byte-identical to `0170bca`; only `am-play.ps1` deviates
(the authorised exception). New `am-play.ps1` SHA256 is recorded in the commit.