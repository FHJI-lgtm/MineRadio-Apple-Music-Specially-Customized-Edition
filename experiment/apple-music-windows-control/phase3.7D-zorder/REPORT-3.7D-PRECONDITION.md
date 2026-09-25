# Phase 3.7D Z-Order PoC — ObserveOnly 检查结果

**RESULT: INCONCLUSIVE — STOPPED_AT_PRECONDITION**（未运行 Case A）

本轮只跑了**一次** `-ObserveOnly`（**零状态变更**：没有 SetWindowPos、没有动窗口、没有播放尝试）。

---

## 1. ObserveOnly 原始读数（`reports/zorder-poc-20260925-215422.{txt,json}`）

| 字段 | 值 | 判定 |
|---|---|---|
| `appleMusicProcessRunning` | **True** | ✅ |
| `appleMusicWindowHandle` | **5571982** | ✅ 有效 HWND |
| `appleMusicWindowTitle` | `Apple Music` | ✅ |
| `appleMusicWindowClass` | `WinUIDesktopWin32WindowClass` | ✅ |
| `appleMusicVisible` | True | ✅ |
| **`appleMusicIconic`** | **True（窗口处于最小化）** | ❌ **前置不满足** |
| `appleMusicDesktopId` | `7a8a789c-3926-4cb9-807f-dc11278c2841` | ✅ |
| `activeDesktopIdProxy` | `7a8a789c-3926-4cb9-807f-dc11278c2841` | ✅ **与 Apple Music 同一桌面（Desktop 1）** |
| `appleMusicIsOnCurrentDesktop` | **True** | ✅ |
| `foregroundWindow` / `foregroundProcess` | `1050912` / **msedge** | ✅ 前台是 Edge，不是 Apple Music |
| `appleMusicIsForeground` | **False** | ✅ |
| `zOrderObservation` | `index=40 topLevelCount=40 isTop=False topTitle=[MSCTFIME UI]` | ✅ 观察层可用（窗口在 Z-order 最底部，与"最小化"一致） |
| `uiaWindowFound` | True | ✅ 同桌面时 UIA 可见（与 3.7C 结论一致） |
| `smtcTitle` / `smtcArtist` / `smtcStatus` | `Talk (feat. Disclosure)` / `Khalid — Free Spirit` / **Playing** | ✅ SMTC 会话存在 |

## 2. 缺失的前置条件（唯一项）

Phase 3.7D 第五节明确要求 Apple Music：**窗口正常存在、不要最小化、不要最大化、保持普通可见窗口状态**。
实测 **`appleMusicIconic=True`（最小化）** → 不满足。

若在此状态下强行跑 Case A，会引入两个混淆变量，破坏本实验的因果性：
1. 最小化窗口的"普通可见窗口状态"不成立，Z-order 基线（`index=40/40`）本身也是最小化态造成的；
2. 冻结链 `Invoke-AmPlaySong` 在发现 `iconic` 时会**先还原窗口**——那一步本身就是一次窗口状态操作，
   会与 `SetWindowPos(HWND_BOTTOM)` 的效果混在一起，无法判断到底是哪一步影响了前台。

**因此按阶段规则：停止，不运行 Case A，不做任何 retry。**

## 3. 需要你做的（一步，之后我重跑）

1. 把 **Apple Music 窗口从最小化恢复**（任务栏点开、或 `Win+Shift+M` 恢复所有最小化窗口），
   保持**普通可见窗口**状态（不要最大化）；
2. 保持 Apple Music 在 **Desktop 1**（当前已是），保持前台为 Edge/其它应用（不要手动点 Apple Music）；
3. 之后我重跑**一次** ObserveOnly 确认如下全绿，再运行**一次** Case A：

```
appleMusicProcessRunning = true
appleMusicIconic         = false        <-- 目前缺这一项
appleMusicIsOnCurrentDesktop = true
appleMusicIsForeground   = false
smtcTitle                != (empty)
```

## 4. 本轮纪律与冻结

未调用 `SetWindowPos`；未移动/最小化/还原/置前任何窗口；未创建/删除/移动虚拟桌面（VD API 仅用于**只读**读取
`appleMusicDesktopId` / `activeDesktopIdProxy` 这两个**本阶段字段清单要求**的值）；
未改 A-uia / resolver / 播放逻辑 / SMTC 逻辑；未提权；未改注册表或系统文件；
未碰 Packaged COM / `vtable[3+]` / ProxyStub / MusicKit；未做循环压测；**Case A 运行次数 = 0**。

下一步严格按你规定的顺序：**一次 ObserveOnly → 通过后一次 Case A → 完整记录 → 按失败分类关闭或进入下一阶段**。
