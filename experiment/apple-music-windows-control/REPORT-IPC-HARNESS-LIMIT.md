# IPC harness limit (recorded, not a product defect)

Conclusion (operator-dictated): **an independent Electron harness cannot reliably obtain the same built-in
Electron module resolution as the app main process.**

Attempts, all of which left product code untouched:

| attempt | entry form | result |
|---|---|---|
| 1 | temp dir, `electron.cmd <script>` | Cannot find module electron |
| 2 | temp dir + NODE_PATH, then `desktop/<dotfile>` | require(electron) shadowed by the npm package -> ipcMain undefined; file not resolved |
| 3 | repo root script, absolute electron.exe, file logging | ELECTRON_TYPEOF=string (npm shim); runtime itself real (42.4.1, electron.exe) |
| 4 | proper app dir (package.json + main), `require(electron/main)` | see amc log line ELECTRON_VIA / ELECTRON_API_MISSING_FINAL |

What IS proven: the Electron runtime is real (42.4.1, execPath electron.exe) and the app dir is loaded;
the static seam (main.js + preload.js) is in place, syntax-checked and transport-only; the underlying
playTrack E2E is verified. What is NOT proven: the renderer -> preload -> ipcMain -> module round trip.

Decision: do not keep iterating on the harness. Either accept "IPC runtime unverified" or run the smoke
inside the real MineRadio process (needs explicit approval, since it launches the full app).

## CORRECTION (2026-09-26, same session): the true cause was ELECTRON_RUN_AS_NODE=1

The conclusion above is **retracted**. Measured afterwards:

```
ELECTRON_RUN_AS_NODE  PROCESS=1   USER=<unset>   MACHINE=<unset>
```

This shell is spawned by DSH and inherits `ELECTRON_RUN_AS_NODE=1`. With that variable set,
`electron.exe <anything>` runs as **plain Node**, so `require("electron")` is the npm shim and no
app runtime ever exists. That is why every harness form failed, and it also explains the direct
app-launch crashes captured on stderr:

```
desktop/wallpaper-engine-library.js:52  protocol.registerSchemesAsPrivileged([{
TypeError: Cannot read properties of undefined (reading "registerSchemesAsPrivileged")
  at Object.<anonymous> (desktop/main.js:52:1)
  ... at Module.executeUserEntryPoint [node:internal/modules/run_main]
```

So Electron module resolution was never the problem; the environment forced Node mode. A retry
requires launching Electron with `ELECTRON_RUN_AS_NODE` cleared. The IPC runtime row therefore
returns to "untested **for want of a clean launch**", not "untestable".

Separately: in a *clean* environment (variable cleared) the app exits **silently before writing any
startup state**. The exact path is `desktop/main.js:7123-7124`:

```js
if (!gotSingleInstanceLock) { app.quit(); }        // silent, and no writeStartupState
else { writeStartupState("module-loaded", {...}); ... }
```

That matches the symptom exactly (no stdout/stderr, `startup-state.json` unchanged), i.e. the
single-instance lock was not granted because another MineRadio instance held it. Reverting this
session's changes does not change that behaviour (A/B tested), so it is independent of this work.
