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
