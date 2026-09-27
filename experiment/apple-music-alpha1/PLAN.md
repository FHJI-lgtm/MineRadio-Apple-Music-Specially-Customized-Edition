# Alpha=1 隐身方案 —— 侦察结论 + 实验设计（待确认后实施）

> 结论先行：**仓库里没有任何 Alpha / 分层窗口实验代码**，而 Apple Music 的窗口当前**没有** WS_EX_LAYERED、没有 Alpha。
> 现有的 UIA / 窗口链完整可复用（冻结库），窗口样式修改技术在本仓库 MineRadio 自己的窗口上已经跑通（可照抄签名）。
> 本阶段只做了只读侦察 + 一个只读探针；**没有对 Apple Music 做任何状态修改**。

---

## 一、侦察：现有窗口 / UIA 控制链（问题 A–F）

### A. 当前 Apple Music HWND 如何获取（两条既有路径，都不按类名过滤）

| 路径 | 位置 | 做法 |
|---|---|---|
| 主链（app 用的） | `poc/lib/am-uia.ps1:53-83` `Get-AmProcess` / `Ensure-AmRunning` | `Get-Process -Name AppleMusic` → `.Refresh()` → **`$p.MainWindowHandle`**；未运行则按包名 `shell:AppsFolder\AppleInc.AppleMusicWin_nzyj5cx40ttqa!App` 启动 |
| 枚举全部顶层窗口 | `phase3.7C-virtual-desktop/lib/vd-common.ps1:119-147` `Find-AmVdAppleMusicWindow` | `EnumWindows` + `GetWindowThreadProcessId` 过滤 AppleMusic 的 PID，返回全部候选（hwnd/title/visible/iconic） |

实测（本机，10:18）：PID **14392**；6 个顶层窗口，其中两个是 `WinUIDesktopWin32WindowClass`：
`0x4A0B16 "WinUI Desktop"`（隐藏，1216x608）、**`0x10AD2 "Apple Music"`**（可见但已最小化，158x26 @ -18286,-18286）——`MainWindowHandle` = 68306 = 0x10AD2。
类名由 UIA `Current.ClassName` 与新增的 `GetClassNameW` 双路确认 = `WinUIDesktopWin32WindowClass`（与你的前提一致）。

### B. 当前 UIA root 如何获取
`poc/lib/am-uia.ps1:135-144` `Get-AmRoot`：`[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)`，6 次重试 × 400ms，失败返回 `AM_UI_NOT_FOUND`。
实测 root：name=`Apple Music`、class=`WinUIDesktopWin32WindowClass`、ControlType.Window、**descendants=673**、Button=112、Edit=1（**窗口最小化时树依然在**）。

### C. 已经验证过的 UIA 操作（都在冻结库里，可直接复用）
- 搜索：`Invoke-AmSearch`（InvokePattern on AutomationId `Search_Button` → ValuePattern on enabled Edit → SendKeys ENTER）
- 导航：`Invoke-AmNavigateUrl`；列表/行：`Get-AmListItems` / `Get-AmRowSignals` / `Select-AmCandidate*` / `Realize-AmRow` / `Scroll-AmView` / `Wait-AmRect`
- 真实点击：`Invoke-AmRowPlay`（安全点击点 + 合成双击）；歌单链 `am-play-playlist.ps1`（自建 `Invoke-AmSingleClick`）
- 模式清单（3.7B 实测，`reports/E10-pattern-inventory.json`）：行暴露 **InvokePattern / SelectionItemPattern / ScrollItemPattern / VirtualizedItemPattern**
- 事实判定：`am-smtc.ps1` `Get-AmSmtcState` / `Get-AmPlaybackStatus` / `Wait-AmPlayback`

### D. 是否已有窗口样式修改函数
**对 Apple Music：没有。** `poc/lib` 从不改样式（3.7D 明确写 "no window styles"）。
**但技术在本仓库已跑通**：`desktop/desktop-native-icon-layer-runtime.js:62-64,147-163`（`GWL_EXSTYLE` / `WS_EX_LAYERED` / `SetLayeredWindowAttributes` / `GetLayeredWindowAttributes` / `GetWindowLongPtr` / `SetWindowLongPtr`，且 :258-264、:296-308、:356-360 演示了「先存原始 exStyle+attributes → 改 → 还原」）——**照抄签名，不动这个文件**。

### E. 是否已有恢复窗口状态函数
- `am-uia.ps1:89-132`：`Get-AmWindowState`（iconic/zoomed/visible/foreground/rect）+ `Restore-AmWindow`（仅在最小化/隐藏时 SW_RESTORE；仅当窗口跑到屏幕外时 SW_MAXIMIZE）
- `am-play.ps1:Minimize-AmWindow`；3.7C/3.7D 各自有 BEFORE/AFTER 观察与 `-ObserveOnly`
- **exStyle / Alpha 的还原不存在**（从没有人改过它们）→ 必须由本次实验自己拥有（try/finally + 落盘 restore 记录）。

### F. 是否已有 Alpha 实验代码
**没有。** 全仓 `LWA_ALPHA` = 0 命中；`SetLayeredWindowAttributes` 只出现在 MineRadio 自己的图标层运行时（+ 其测试 + `scripts/quick-check.js`）。
实验树里已有 z-order(3.7D) / 虚拟桌面(3.7C) / 导航(3.7A) / 无鼠标 UIA(3.7B) / 非 UIA 面(3.8)，**没有任何透明/Alpha 相关实验**。

---

## 二、实测基线（本次侦察证据，只读）

| 字段 | 值 |
|---|---|
| at | 2026-09-27 10:18 |
| process | AppleMusic 运行中，PID 14392 |
| main hwnd | 68306 (0x10AD2) `WinUIDesktopWin32WindowClass` "Apple Music" |
| style / exStyle | `0x34CF0000` / **`0x00000100`**（仅 WS_EX_WINDOWEDGE） |
| WS_EX_LAYERED | **false**（两个 WinUI 窗口都是 false） |
| LWA Alpha | **不可读**（非分层窗口） |
| visible / iconic / hung | true / **true（当前最小化）** / false |
| rect | -18286,-18286 158x26（最小化位置） |
| UIA | root OK，673 descendants，112 buttons，1 edit |
| SMTC | Playing — "Ordinary Life" / "Abel Tesfaye — Starboy"，pos 02:49 / 03:48 |

证据文件：`recon/baseline-202609270218.json` / `.txt`（由 `tools/probe-window-state.ps1` 生成，纯读）。

---

## 三、实验设计（隔离、可逆、不碰主线）

```
experiment/apple-music-alpha1/
  PLAN.md                       本文件
  README.md                     怎么跑
  tools/probe-window-state.ps1  只读探针（已写好，基线就是它出的）
  lib/alpha-common.ps1          新增：P/Invoke + 快照/施加/还原 + 观察记录（ASCII-only）
  run-alpha-probe.ps1           实验入口：-ObserveOnly（默认）| -Apply | -ApplyZero | -RestoreOnly
  reports/                      <stamp>.txt / <stamp>.jsonl / <stamp>.restore.json / shots/
```

复用方式：`.` 点源冻结库（**只读复用，绝不修改**）——`poc/lib/am-common.ps1`、`am-smtc.ps1`、`am-uia.ps1`，以及 `phase3.7C-virtual-desktop/lib/vd-common.ps1`（枚举全部 AM 窗口）、`phase3.7B-uia-no-mouse/lib/instrumentation.ps1`（光标/前后审计）。
libraries`lib/poc` 的冻结校验（CONTROL-PLANE I5）在实验跑完后仍用 `git diff --quiet` 复核。

### 执行序列（`-Apply`，Alpha=1）

| STEP | 动作 | 记录 |
|---|---|---|
| 0 | 选 hwnd：WinUI 类、优先「visible 且非 iconic」，否则退回 MainWindowHandle | 全部候选 |
| 1 | **Baseline**（READ-ONLY）：快照 + UIA root + 树签名 + SMTC + 两张证据图 | exStyle/style/alpha/visible/rect/hung、UIA、SMTC、shots |
| 2 | 若窗口最小化/隐藏 → `Restore-AmWindow`（冻结库）恢复可见（否则「视觉隐身」无从判定） | before/after 窗口状态、`windowVisibilityChangedByExperiment` |
| 3 | **施加**：非 layered 时 `SetWindowLongPtr(exStyle \| WS_EX_LAYERED)` → `SetLayeredWindowAttributes(hwnd,0,1,LWA_ALPHA)` | 调用返回、GetLastWin32Error、回读 exStyle/alpha |
| 4 | **Alpha 持久性**：立即 / 1s / 3s / 5s / 10s 各读一次 exStyle+alpha，判断 Apple Music 是否自己改回 255 | 每次时间戳与实际值 |
| 5 | **UIA 操作**（`-AllowUiAction` 才做）：SetFocus 搜索框 + 已实体化行的 `ScrollItemPattern.ScrollIntoView()`（不改数据、不切歌） | 操作返回、HasKeyboardFocus 回读、树签名变化 |
| 6 | **播放/SMTC**：state、title/artist、position 是否继续前进；`IsHungAppWindow` | 两个时间点的 pos 差 |
| 7 | **渲染真相 vs 视觉真相**：屏幕截图（AM 窗口矩形，视觉真相）+ PrintWindow 截图（WinUI 是否还在画）+ 像素差统计 | shots/ + 差异计数 |
| 8 | **还原（finally）**：alpha → 255；若本次加了 WS_EX_LAYERED 则清除；回读 exStyle 必须等于原始值 | original/after exStyle 对比 |
| 9 | 落盘：`reports/<stamp>.jsonl` + `.txt` + `REPORT-ALPHA1.md` | — |

`Alpha=0` 只在 Alpha=1 跑完且无异常后，用 `-ApplyZero` 单独跑一次作对照（同一套观察项），明确标注「对照，不是最终方案」。

### 安全 / 可逆
- STEP 3 之前先把「还原配方」（hwnd、original exStyle、是否由我们添加 LAYERED、original attributes）写入 `reports/<stamp>.restore.json`；崩溃/Ctrl+C 后可用 `-RestoreOnly -From <file>` 或 `-Hwnd <n>` 兜底还原。
- try/finally 包住 STEP 3–7；任何异常都先还原再抛。
- 不碰：`poc/lib/**`（冻结）、`desktop/apple-music-control.js`、SMTC store、播放/歌词/currentPlaybackContext、Developer/Web token、Apple Music 安装与注册表；无注入/无 hook/无 patch。
- 不改 z-order、不抢前台（除 UIA SetFocus 明确需要外不调用 SetForegroundWindow）。

### 验证矩阵（对应你给的 9 项）
1 窗口仍存在 → `IsWindow` + EnumWindows 候选仍在
2 UIA 树仍在 → root + descendants 计数 + 树签名
3 UIA 仍能定位控件 → AutomationId/ControlType 查询（Search_Button/Edit/Button 抽样）
4 UIA 仍能操作 → SetFocus / ScrollIntoView（可选：一次真实点击，需显式开关）
5 播放正常 → SMTC status + position 前进
6 SMTC 正常 → title/artist/status/pos/dur 两次采样
7 Alpha 是否被改回 → 立即/1/3/5/10s 采样
8 是否真的隐身 → 屏幕截图（窗口矩形内应看不到 Apple Music）+ 像素差
9 渲染死区/黑屏/输入异常 → PrintWindow 截图对比 + IsHungAppWindow + 还原后 UIA/截图是否恢复正常

---

## 四、需要你确认的 5 件事

1. **窗口可见性**：为了测「视觉隐身」，我必须先把当前最小化的 AM 窗口 SW_RESTORE。实验结束默认**保持可见**（不重新最小化），要不要改成还原成最小化？
2. **「安全 UIA 操作」的尺度**：默认 = SetFocus + ScrollItemPattern.ScrollIntoView（不改数据、不切歌）。要不要允许一次 frozen `Invoke-AmRowPlay` 的真实点击（会切歌）？
3. **截图**：屏幕截图只截 AM 窗口矩形（可能包含该矩形内的桌面内容），存到 `reports/shots/`。可以吗？还是只保留 PrintWindow（不含桌面）？
4. **Alpha=0 对照**：默认先只跑 Alpha=1，确认无异常后另跑 0。
5. **Alpha=1 期间（约 10 秒）AM 会看不见**：这期间你若要用这台机器，告我一声我就把时长压到最短。
