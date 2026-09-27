# experiment/apple-music-alpha1

Apple Music Windows 主窗口 **Alpha=1 隐身方案**的隔离实验。

- `PLAN.md` —— 侦察结论（A–F）+ 实测基线 + 实验设计（**实施前先读这个**）
- `tools/probe-window-state.ps1` —— 只读探针（窗口/样式/Alpha/UIA/SMTC，不做任何修改）
- `recon/` —— 只读基线证据
- `lib/`、`run-alpha-probe.ps1`、`reports/` —— 待确认后实施

硬规则：只读复用 `../apple-music-windows-control/poc/lib/**`（冻结，不得修改）；不碰 MineRadio 主线
（播放 / 歌词 / SMTC store / currentPlaybackContext / Developer / Web token）；无注入、无 hook、无 patch；
任何 Alpha/exStyle 改动必须在 finally 中还原，并在 `reports/<stamp>.restore.json` 留下还原配方。

运行（Windows PowerShell 5.1）：
```
powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe-window-state.ps1          # 只读
powershell -NoProfile -ExecutionPolicy Bypass -File tools/probe-window-state.ps1 -Json    # 只读 + JSON
```
