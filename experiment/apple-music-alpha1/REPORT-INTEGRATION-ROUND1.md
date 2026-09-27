# MineRadio 集成测试 —— Round 1（最小集成验证）

日期：2026-09-27 11:30–11:35 CST · 分支 `experiment/apple-music-windows-control` · HEAD `29e8d79`（Alpha checkpoint）

**一句话结论：`Alpha=1` 与 MineRadio 全链路兼容；`WS_EX_TRANSPARENT` 会打断 AMC 播放链 —— 因为该链条靠真实合成点击播放歌曲，而点击穿透让这些点击落到了后面那个窗口。**

## 测试方法

- MineRadio 以 dev 方式启动（`node_modules/electron/dist/electron.exe .` + 清掉 `ELECTRON_RUN_AS_NODE`），stdout 落到 `integration/mineradio-*.log`；**没有改动任何 MineRadio 代码**。
- 被验证的链条就是主线那条：`desktop/apple-music-control.js`（`searchTracks` / `playTrack`）→ `experiment/apple-music-windows-control/poc/play-song.ps1`。
- 三轮对照，同一驱动、同一窗口、只改窗口样式位（`integration/round1-attribution.ps1`）：

| 轮次 | 窗口状态 | exStyle | 链结果 | 歌曲是否真的切换 |
|---|---|---|---|---|
| **A 无隐身** | alpha 255，未分层 | `0x00000100` | `ok=true chainOk=true verified=true stage=OK` | **是**（Can't Feel My Face → Blinding Lights） |
| **B 只有 Alpha=1** | LAYERED + LWA_ALPHA=1，**无透明** | `0x00080100` | `ok=true chainOk=true verified=true stage=OK` | **是**（Blinding Lights → Levitating） |
| **C Alpha=1 + 透明** | LAYERED + TRANSPARENT | `0x00080120` | `ok=false chainOk=false verified=false stage=SMTC_WRONG_TRACK`，mismatch=[title,artist] | **否**（仍是 Levitating） |

证据文件：`integration/amc-phase-{A,B,C}.json`、`integration/round1-attribution-summary.json`、`integration/mineradio-20260927-113012.log`。

## 机制（为什么 C 会失败）

冻结链条的播歌方式就是**真实鼠标点击**，不是 UIA Invoke：

- `poc/lib/am-play.ps1:294` → `Get-AmSafeClickPoint`；`:301` → `Invoke-AmRowPlay $hwnd $cand.element $pt.x $pt.y`
- `poc/lib/am-uia.ps1:532-536` → `SetCursorPos(x,y)` + `mouse_event(LEFTDOWN/LEFTUP)`

而 `WS_EX_TRANSPARENT` 的语义就是「命中测试跳过这个窗口」（B+ 实验已实测：WindowFromPoint 不再命中 AM，真实点击被下层窗口收到）。
两者叠加 ⇒ 链条把点击打到了 Apple Music **后面**的窗口上（很可能是 MineRadio 自己或桌面），AM 自然没有任何反应，SMTC 仍是上一首。

顺带的风险提示：这轮出现了**落到别的窗口上的杂散点击**；做产品时如果保留透明位，必须考虑这一点。

## 同时验证通过的（A/B 两轮，尤其 B 就是「隐身=只有 Alpha=1」的形态）

| 项目 | 证据 |
|---|---|
| AMC 搜索（iTunes 解析） | B 轮 `search.count=4`，拿到 title/artist/trackId/storefront |
| AMC 播放 + SMTC 校验 | B 轮 `verified=true`、`artistLayer=exact`，SMTC 真的切到目标曲 |
| SMTC 状态被 app 持续接收 | 应用日志 74 条 `IPC sent (T4)`，标题依次出现 `Can't Feel My Face` → `Blinding Lights` → `Levitating` |
| 缩略图/身份链 | 日志 3 次 `thumbnail identity changed`（切歌时先清旧封面再解析） |
| 外部音频捕获（WASAPI 进程回环 + AMPLibraryAgent） | 174 条 `[AUDIO] native metrics received` / `bridge metrics parsed rms=… bass=… mid=… treble=… spectrum=64` / `IPC metrics sent`；`[AUDIO] metrics connected` 一次；**0 次 CAPTURE_START_FAILED、0 次 NON_FINITE_METRICS**；`MineRadioAudioCapture.exe` 自启动起一直存活 |
| MineRadio 自己的窗口 | `hwnd=4197400 Chrome_WidgetWin_1`，`exStyle=0x00280000`（自带 layered，**alpha=255**）、`transparent=False`、visible、**foreground** —— 隐身层只作用于 68306，没有碰它 |
| 关闭隐身后的恢复 | `exStyle 0x00080120 → 0x00000100`、`matchesOriginal=true`、alpha→255、SW_MINIMIZE → AM `iconic=true`；MineRadio 全程存活 |

## 本轮**没有**验证到的（不要当成通过）

- **歌词链**：应用没有歌词相关的日志/IPC 输出；`%APPDATA%` 下只有 `.apple-music-lyrics-credential.json`（凭据）与 `lyrics-source-window-position.json`，AM 包目录里没找到 ttml 缓存文件 ⇒ 需要只读 debug 钩子或人眼看界面。
- **currentPlaybackContext**：渲染进程内部状态无法从外部读取；其**输入**（SMTC 身份 + 缩略图变化）本轮确认在更新，但 store 本身没证据。
- **播放/暂停/下一首 控制**：本轮未跑（协议已知：`desktop/smtc-bridge.ps1` stdin `{"command":"play|pause|toggle|next|previous|refresh"}`）。
- 键盘焦点隔离（沿用 soak 结论：窗口仍可持有前台）。

## 方法学备注

1. 影子日志是 UTF-16LE：按 UTF-8 读会「看不见」`[AUDIO]` 行，我一开始就被这个骗过一次（计数 0），解码后是 174 条。分析脚本必须显式按 UTF-16LE 解。
2. `EnumWindows` 回调里 `Write-Output` 不会进管道（委托在别的执行范围）；要用容器对象累积再打印（脚本里已改成 `ArrayList.Add`）。
3. 天真的 `powershell -Command "…$var…"` 会被外层吃掉 `$`；一律走 `-File` + 脚本文件。
4. 探针脚本：`tools/probe-process-windows.ps1 -Pid2 <pid>`（读任意进程可见顶层窗口的 style/exStyle/layered/transparent/alpha）。

## 对产品化设计的直接含义

| 方案 | 视觉隐身 | 鼠标不被幽灵窗口吃掉 | AMC 播放链 | 备注 |
|---|---|---|---|---|
| 只有 `Alpha=1` | 是 | **否**（B+ 实测窗口仍接收点击） | **正常** | 最省事，但会挡住那块区域的点击 |
| `Alpha=1 + TRANSPARENT`（本实验方案） | 是 | 是 | **坏**（点击穿透让链条点空） | 本轮的发现 |
| 透明位做**门控**：AMC 操作前摘掉、之后戴上 | 是 | 是（空闲时） | 正常 | 位增删已被证明即时可逆；产品侧需在 play 前后包一层 |
| 改走 **UIA-only** 播歌链（InvokePattern/SelectionItemPattern） | 是 | 是 | 需新链 | B+ 已证明透明下 UIA 可用；但不能再复用冻结的 `poc/play-song.ps1` |

Round 1 到此停（测试 → 停）。下一轮选哪条路线由你定；我不会自行改 MineRadio 代码或冻结链。
