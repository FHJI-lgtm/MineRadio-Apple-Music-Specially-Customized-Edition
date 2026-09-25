# Phase 3.7D Z-Order PoC

**RESULT: FAIL — `FAIL_ZORDER_REACTIVATED`**

> **Z-order cannot suppress the activation requirement of the existing A-uia click path.**

一次 ObserveOnly（5/5 通过）后，**一次** Case A，无重跑、无第二次 SetWindowPos、无第二次点击、无压测。
证据：`reports/zorder-poc-20260925-215539.{txt,json}`。

---

## Environment

| 项 | 值 |
|---|---|
| Windows | Windows 11（本机，未提权；`AllowDevelopmentWithoutDevLicense=1` 仅记录） |
| Apple Music | Store 包 `AppleInc.AppleMusicWin 1.1540.23042.0`，HWND `5571982`，class `WinUIDesktopWin32WindowClass` |
| MineRadio | 未参与运行（本实验只调用冻结入口 `Invoke-AmPlaySong`，未启动 App） |
| Current Desktop | Desktop 1 —— `activeDesktopIdProxy = 7a8a789c-3926-4cb9-807f-dc11278c2841` |

## BEFORE

```
foregroundProcess = msedge   (为 Apple Music 定制 Mineradio 版本 — DeepSeek Harness…)
appleMusicIsForeground = False
appleMusicIsOnCurrentDesktop = True
appleMusicDesktopId = 7a8a789c-3926-4cb9-807f-dc11278c2841   (== 用户当前桌面)
appleMusicIconic = False    appleMusicVisible = True
zOrderObservation = index=42 topLevelCount=42 isTop=False topTitle=[MSCTFIME UI]
uiaWindowFound = True
smtc = Talk (feat. Disclosure) / Khalid — Free Spirit / Playing
cursor = 1019,947
```

## Z-order operation

```
SetWindowPos(hwnd=5571982, hwndInsertAfter=HWND_BOTTOM(1), 0,0,0,0,
             SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW)   -> ok
zOrderOperationHr = ok
STEP 3（调用后立即观察）: foregroundProcess = msedge, appleMusicIsForeground = False,
                          activeDesktopIdProxy 未变, appleMusicDesktopId 未变
```
✅ **重要**：`SetWindowPos(HWND_BOTTOM, …, SWP_NOACTIVATE)` 自身**没有**让 Apple Music 成为前台，也没有切换桌面。
（Z-order 是辅助观察量：`isTop=False`，窗口处于堆栈底部。）

## A-uia（现有冻结入口，一次调用，未做任何修改）

```
stage = OK                          ok = True
navMethod = AppleMusic.exe /url     navigated = True     contentMatchMs = 3072
matchedRow = 音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟
clickRecomputed = False
uiaTargetFound = True
mouseMoved = True     (cursor 1019,947 -> 819,928)
physicalKeyboardInput = False
```

## AFTER

```
foregroundProcess = AppleMusic        <-- 变为前台
foregroundTitle = Apple Music
appleMusicIsForeground = True         <-- 关键
foregroundChanged = True
activeDesktopIdProxy = 7a8a789c-3926-4cb9-807f-dc11278c2841   (未变)
appleMusicDesktopId = 7a8a789c-3926-4cb9-807f-dc11278c2841    (未变)
appleMusicIsOnCurrentDesktop = True
zOrderObservation = index=31 topLevelCount=31 isTop=False topTitle=[MSCTFIME UI]
smtc = How Do I Make You Love Me? / Abel Tesfaye — Dawn FM / Playing
targetPlaying = True
```

## Result

| # | PASS 条件 | 实测 | |
|---|---|---|---|
| 1 | `activeDesktopIdBefore == After` | 相同 | ✅ |
| 2 | `appleMusicDesktopIdBefore == After` | 相同 | ✅ |
| 3 | Apple Music 始终在当前 Desktop | `onCurrentBefore/After = True/True` | ✅ |
| 4 | `foregroundWindowBefore != Apple Music` | msedge | ✅ |
| 5 | `foregroundWindowAfter != Apple Music` | **Apple Music** | ❌ |
| 6 | `foregroundChanged == false` | **true** | ❌ |
| 7 | `mouseMoved == false` | **true**（1019,947 → 819,928） | ❌ |
| 8 | `physicalKeyboardInput == false` | false | ✅ |
| 9 | UIA / A-uia 找到目标歌曲 | `matchedRow` 命中 | ✅ |
| 10 | SMTC 变成目标歌曲 | 是 | ✅ |
| 11 | `targetPlaying == true` | true | ✅ |

→ **FAIL_ZORDER_REACTIVATED**（即使目标歌曲成功播放，也判 FAIL：本实验目标是"后台播放"，不是"能播放"）

## Failure classification

**`FAIL_ZORDER_REACTIVATED`** —— Apple Music 在尝试过程中被重新置前/激活：
`foreground: msedge → AppleMusic`，`appleMusicIsForeground: false → true`。

其它分类均已排除：
`FAIL_FOREGROUND_CHANGED`（前台变化的**就是** Apple Music，故优先归为 REACTIVATED）｜
`FAIL_DESKTOP_CHANGED`（桌面前后同一 GUID，未发生）｜
`FAIL_MOUSE_INJECTION`（确有鼠标移动，但顺序上先发生的是"重新激活"，按你的分类优先级归 REACTIVATED，鼠标数据完整记录）｜
`FAIL_UIA_TARGET`（未发生，`matchedRow` 命中）｜
`FAIL_PLAYBACK`（未发生，SMTC 已切到目标曲目）。

## Mechanism

1. **Z-order 是否成功压低**：✅ 成功。`index=42/42 → isTop=False`，且 `SetWindowPos` 返回 ok。
   Z-order 是辅助观察量，`isTop=False` 说明窗口不在堆叠顶部。
2. **A-uia 是否能看到窗口**：✅ 能看到（`uiaWindowFound` 前后均 True，`matchedRow` 命中）。
   —— 因为窗口本来就在**当前**桌面（与 3.7C 的"非当前桌面看不到"形成对照）。
3. **是否触发 foreground**：❌ **触发了**。`msedge → AppleMusic`，`foregroundChanged=True`。
   这是本实验的核心发现：**压低 Z-order 不能免除 A-uia 的前台要求**。
4. **是否触发鼠标移动**：❌ 触发了（`1019,947 → 819,928`）——冻结链按设计把光标移到目标行并双击。
5. **是否最终播放**：✅ 播放成功（`How Do I Make You Love Me?` / Playing）。
6. **哪一步破坏了"后台交互"条件**：**A-uia 的点击路径本身**。Z-order 操作（STEP 2/3）是干净的：
   调用后前台仍是 msedge；破坏发生在 STEP 5 —— 冻结链在双击前需要把 Apple Music 置前，
   于是它被重新激活。**没有其它机制参与**（未改窗口样式、未用 WS_EX_*、未改 owner、未用 PostMessage/SendMessage）。

**结论（按你预置的措辞）**：

> Z-order cannot suppress the activation requirement of the existing A-uia click path.

## 本轮之后

按阶段第十六节的纪律：**不再尝试虚拟桌面 × Z-order 组合、窗口样式组合（`WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW` /
`WS_EX_TRANSPARENT` / `WS_EX_LAYERED`）、owner 变更、`AttachThreadInput` / `SetThreadDesktop` /
`AllowSetForegroundWindow` / `LockSetForegroundWindow` 等重复机制**——它们改变的是同一个变量（窗口激活语义），
而本轮的证据已经说明：**只要点击路径依赖"窗口被激活 + 真实光标输入"，后台交互条件就不成立**。

保留的两条可用事实：
- **URL 深链（`AppleMusic.exe /url`）与桌面/Z-order 无关，可稳定送达**（`navigated=True`, `contentMatchMs=3072`）；
- **不注入输入的后台控制面**仍只有 `A-api` 一条理想路线，而 3.8 已证其当前不可用（`PRACTICALLY CLOSED`）。

## 纪律

Case A 只运行**一次**；无自动 retry；无第二次 SetWindowPos；无第二次点击；无循环压测。
未调用 `MoveWindowToDesktop`、未创建/删除/移动虚拟桌面（VD API 仅**只读**读取两个本阶段要求的桌面字段）；
未修改窗口样式 / owner；未用 `AttachThreadInput` / `SetThreadDesktop` / `AllowSetForegroundWindow` /
`LockSetForegroundWindow`；未用 `PostMessage` / `SendMessage`；未提权；未改注册表或系统文件；
未改 A-uia / resolver / 播放逻辑 / SMTC 逻辑；未碰 Packaged COM / `vtable[3+]` / ProxyStub / MusicKit。
