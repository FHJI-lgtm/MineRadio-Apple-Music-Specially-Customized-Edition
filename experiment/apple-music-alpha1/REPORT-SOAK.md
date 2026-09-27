# Phase Soak —— 30 分钟隐身状态长跑（Alpha=1 + WS_EX_LAYERED + WS_EX_TRANSPARENT）

- 运行：20260927-105155（`run-stealth-soak.ps1 -Minutes 30 -IntervalSec 10 -NavEverySec 180 -ResizeCount 4`）
- 窗口：hwnd 68306（0x10AD2）Apple Music / WinUIDesktopWin32WindowClass，PID 14392
- 证据：reports/20260927-105155-soak.jsonl（211 KB，逐条增量落盘）、-soak.txt、-soak-summary.json、20260927-105155.restore.json
- 冻结链 `poc/lib` 零改动；MineRadio 主线零改动（`git status` 只有 `experiment/apple-music-alpha1/`）

## 结论句

**30-minute soak completed with no observed Alpha / exStyle / UIA / SMTC / hit-test regression under the tested perturbations.**

（180 次定时采样 + 43 条扰动采样；`verdict = NO_VIOLATION`，`violations = 0`，`firstViolation = null`。不是笼统地说「稳定」，
 而是下面每一项都有逐次采样数据与明确定义的判据。）

## 采样清单

| 项 | 数量 |
|---|---|
| 定时采样（10s 间隔） | **180**（t = 1.8s → 1791s，覆盖 1800s 计划窗口） |
| 换页扰动（UIA 导航） | **9 次**，每次 3 条采样（before / applied / +2s）= 27 条 |
| 窗口变化扰动（SW_RESTORE + SetWindowPos + SW_MAXIMIZE） | **4 次**，每次 4 条采样 = 16 条 |
| 合计记录 | 225 条（jsonl 增量写入，进程中途死掉也不丢证据） |

## 不变量逐项核对（180 个采样）

| 不变量 | 结果 |
|---|---|
| alpha | **恒为 1**（取值集合 = {1}；无一次回弹 255、无一次不可读） |
| exStyle | **恒为 0x00080120**（取值集合单一；WS_EX_LAYERED 与 WS_EX_TRANSPARENT 全程在位） |
| stealthApplied | 180/180 = true |
| UIA root | **180/180 可用**；descendants 183 → 625（随页面变化），listItems / buttons 同步可读 |
| IsWindow | 180/180 = true |
| IsHungAppWindow | **0 次 true** |
| SMTC provider | 180/180 = ok；状态**恒为 Playing**；期间播了 10 首不同曲目（Mutual → … → Popular） |
| WindowFromPoint | 177 个有效采样 × 9 点 = **1593 次命中测试，命中 Apple Music 0 次** |
| DPI / 虚拟屏 | 恒为 168 / 「0,0 2560x1600」（未被扰动；见「未验证」） |
| 前台归属 | Apple Music 为前台的采样：**121/180**（见下面的观察，不计入已验证） |

## 扰动明细

换页（目标取自侧栏，按位置选择，非硬编码）：
`nav#1→主页@180`、`nav#2→新发现@360`、`nav#3→主页@540`、`nav#4→新发现@720`、`nav#5→主页@900`、
`nav#6→新发现@1080`、`nav#7→主页@1260`、`nav#8→新发现@1440`、`nav#9→主页@1621` —— 9/9 的 applied 采样：alpha=1、两位在位、UIA 可用、0 点命中 AM。

窗口变化（4 次，每次四帧，取值集合完全一致）：

| 帧 | rect | 次数 | alpha | exStyle | UIA | 命中 AM |
|---|---|---|---|---|---|---|
| resize-before | -12,-12 2584x1540（最大化） | 4 | 1 | 0x00080120 | 4/4 ok | 0 |
| resize-applied | 200,150 1914x900 | 4 | 1 | 0x00080120 | 4/4 ok | 0 |
| resize-hold-2s | 200,150 1914x900 | 4 | 1 | 0x00080120 | 4/4 ok | 0 |
| resize-restored | -12,-12 2584x1540 | 4 | 1 | 0x00080120 | 4/4 ok | 0 |

即：**窗口被真正缩放/移动（2584x1540 ↔ 200,150 1914x900）后，Alpha、两个样式位、UIA、穿透全部保持**。

## 判据定义（避免把「未测」偷偷变成「通过」）

**记为 VIOLATION（首次发生即写完整快照）**：alpha≠1 或不可读 / WS_EX_LAYERED 丢失 / WS_EX_TRANSPARENT 丢失 /
UIA root 不可用 / SMTC provider 丢失（ok=false）/ 任一采样点命中 Apple Music / IsWindow=false。

**只记为事件、不记为 violation**：SMTC 状态从 Playing 变化（歌可能自己放完）/ IsHungAppWindow 瞬时 true /
前台归属变化 / 扰动本身。本次这三类事件分别发生 0 次（状态从未离开 Playing）、0 次、9 次前台翻转。

## 一个外部事件（非计划扰动）

t≈35–70s（10:52:33–10:52:55）窗口被**外部最小化**（不是我做的：计划里首次扰动在 t=180）：3 个采样显示
`iconic=true`、rect 退化为 `-32000,-32000 276x45`，t=70 又恢复。这三条我记为 **pointsTotal=0（不适用）**，
而不是当作「通过」——退化矩形上的命中测试没有证明力。

这次事件反而是个正面证据：**最小化→还原没有清掉两个样式位，alpha 仍是 1**，连最小化状态下 UIA root 都还在（618 节点）。

## 一个必须写进限制的观察

180 个采样中有 **121 次 `GetForegroundWindow()` == Apple Music**（窗口完全不可见、鼠标穿透，但仍可持有前台）。
多发生在 SW_MAXIMIZE 之后。含义：**click-through ≠ 不抢键盘焦点** —— 鼠标不会打到幽灵窗口，但键盘输入仍可能进入 Apple Music。
这条归入「未验证」，而不是「已验证」。（也解释了为什么它不该被写成「完全不被感知」）

## 收尾与独立验证

| 步骤 | 结果 |
|---|---|
| Alpha → 255 | 是（alphaSetTo255=true） |
| 清 WS_EX_LAYERED / WS_EX_TRANSPARENT | 是（exStyle 0x00080120 → 0x00000100，matchesOriginal=true） |
| 恢复原始 exStyle | 是（expected = 0x00000100） |
| 恢复原始窗口状态 | 是（SW_MINIMIZE → iconic=true、rect -32000,-32000 276x45） |
| 终检 UIA | 是（还原后 root ok，197 节点；独立只读探针再测：516 节点） |
| 终检 SMTC | 是（Playing，Popular / Abel Tesfaye & Madonna） |

独立只读探针（probe-window-state.ps1，与 soak 不同的进程/时刻）复核：`layered=false`、`visible=true`、UIA rootOk=true。

---

# 分类清单

## 已验证（本实验有直接数据支撑）

- Alpha=1 持久性：30 分钟 / 180 采样恒为 1，无回弹、无不可读
- WS_EX_LAYERED 保持：全程在位（0 次丢失）
- WS_EX_TRANSPARENT 保持：全程在位（0 次丢失）
- 整窗鼠标穿透：1593 次固定点命中测试，命中 Apple Music 0 次（独立 B+ 实验另有 90 点整窗扫描与真实左右键/滚轮）
- 左键 / 右键 / 滚轮：B+ 实测被下层窗口接收（9/9 点左键、9/9 点右键、3/3 点滚轮）
- UIA root / 查询 / 交互：30 分钟内 180/180 可用；SetFocus、ScrollItemPattern.ScrollIntoView、SelectionItemPattern.Select 全部成功（B/B+ 与 soak 中反复验证）
- 页面切换：9 次 UIA 换页扰动，状态与穿透全部保持
- 播放 / SMTC：provider 全程在线、状态恒为 Playing、连续播放 10 首
- 窗口移动 / 缩放：4 次四帧扰动（2584x1540 ↔ 200,150 1914x900）全部保持
- 恢复机制：配方文件 + 严格还原 + 终检可用；另外一次真实事故（进程被外部中断）也用 `-RestoreOnly` 成功恢复

## 未验证（没有数据，不要当成通过）

- 系统 DPI 动态切换（本轮 DPI 恒为 168，未被扰动）
- 多显示器热插拔（本轮虚拟屏恒为 0,0 2560x1600，且本机没有第二块屏）
- 键盘 / 焦点隔离：**已观察到窗口可持有前台（121/180）**，但没有做键盘输入归属实验
- Alt-Tab / 任务栏行为：没有专门测（只观察到外部最小化/还原不影响样式位）
- z-order 长期行为：只做了 SW_MAXIMIZE 引起的常规前台变化，没有做置顶/置底压测
- 超过 30 分钟的持久性（含系统睡眠/唤醒、显示器休眠）

## 明确不属于本实验

- MineRadio 主线播放逻辑（`desktop/apple-music-control.js`、play-song/play-playlist 链）
- SMTC timeline / 歌词 / `currentPlaybackContext` / `playQueue`
- Apple Music 安装目录、注册表、二进制修改
- injection / hook / DLL / 任何进程内注入
- 产品化封装与 watchdog（按约定留到下一阶段，且先不做 watchdog）

## 本阶段方法学备注（供以后审计）

1. 采样逐条增量写 jsonl：这个设计在 soak 之前的一次事故里已经救过场（进程被杀，txt/summary 没写成，但 jsonl 完整）。
2. 真实输入测试不能让 PowerShell 的 WinForms 接收窗停在无消息泵状态，否则合成点击只会排队（会造成假阴性）；点击后必须 DoEvents 泵若干次。
3. PowerShell 变量名大小写不敏感：`[IntPtr]$H` 与局部 `$h`、参数 `$ResizeCount` 与计数器 `$resizeCount` 都曾互相覆盖，导致采样函数报错 / 扰动计划表为空。
4. 采样点必须与可见屏幕求交：最大化窗口的 GetWindowRect 会超出屏幕，屏幕外的点在 SetCursorPos 时被静默钳制，会让真实点击测试失效。
