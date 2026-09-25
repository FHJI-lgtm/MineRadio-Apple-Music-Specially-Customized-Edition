# phase3.7C-virtual-desktop — 虚拟桌面隔离 PoC

**问题**：A-uia 需要操作 Apple Music 的窗口/输入。如果 Apple Music 在**用户当前虚拟桌面**上，
操作就会打扰用户正在做的事。本 PoC 回答唯一一个问题：

> **Desktop 1 活跃 + Apple Music 在 Desktop 2 → A-uia 操作 → SMTC 成功切歌 → Desktop 1 全程不切换，是否成立？**

## 纪律（严格低侵入）

- **不自动创建/销毁/移动虚拟桌面** —— 桌面准备完全由用户手工完成；
- 不写注册表、不改 Apple Music 安装文件、不改系统文件、**不使用管理员权限**；
- 不碰 `COM vtable[3+]`、不重试 Packaged COM / ProxyStub / MusicKit、不改 Phase 3 resolver、不改 MineRadio 播放逻辑；
- **不重写** A-uia：runner 直接调用现有冻结入口 `Invoke-AmPlaySong`；
- 不做循环压力测试：**每次运行只发起一次**播放尝试；
- 虚拟桌面 API：只用**有文档的** `IVirtualDesktopManager`（`IsWindowOnCurrentVirtualDesktop` /
  `GetWindowDesktopId`）；**从不调用** `MoveWindowToDesktop`。活动桌面自身的 GUID 没有文档 API →
  记录 `unavailable`，并改用**显式代理**：`activeDesktopIdProxy = GetWindowDesktopId(前台窗口)`
  （前台窗口必然位于活动桌面），字段里写明这是 proxy，**不猜 GUID、不伪造**。

## 手工准备（用户执行）

1. 创建第二个虚拟桌面（`Win+Ctrl+D`）；
2. 把 Apple Music 窗口移到 Desktop 2；
3. 切回 Desktop 1；
4. 确认 Apple Music 仍在 Desktop 2 正常播放；
5. MineRadio（及本脚本）留在 Desktop 1。

## 运行

```powershell
# 只验证观察层（不发起播放；可在准备前先跑一次）
.\run-vd-poc.ps1 -ObserveOnly

# 正式 PoC：一次 A-uia 尝试
.\run-vd-poc.ps1 -Case A          # A = How Do I Make You Love Me?（已验证曲目）
.\run-vd-poc.ps1 -Case C          # C = Shape of You
```

产物：`reports/vd-poc-<stamp>.txt`（人读）+ `.json`（结构化）。

## 记录字段（每次运行）

`activeDesktopIdProxy` · `appleMusicWindowHandle` · `appleMusicDesktopId` · `appleMusicIsOnCurrentDesktop` ·
`appleMusicWin32Found`(+candidates) · `uiaWindowFound` / `uiaWindowName` / `uiaWindowClass` / `uiaWindowControlType` /
`uiaWindowEnabled` / `uiaWindowOffscreen` / `uiaWindowBounds` · `foregroundHwnd/Process/Title` ·
`mouseMoved` / `keyboardInjected` / `foregroundChanged` / `foregroundChangedByApplication` / `focusBefore/After` ·
`cursorBefore/After` · `smtcTitle/Artist/Status`（before 与 after）· attempt 的 `stage` / `stageDetail` /
`navMethod` / `navigated` / `contentMatchMs` / `matchedRow` / `clickRecomputed` / timings。

**关键区分**：`uiaWindowFound`（UIA 能不能**看到** Desktop 2 的窗口）与输入是否真正作用于 Desktop 2（`mouseMoved` +
`foregroundChanged` + SMTC 结果）是**两个独立问题**，必须分别看。

## 判定规则（脚本内置，必须严格）

| 条件 | RESULT |
|---|---|
| `activeDesktopIdProxy` 前后**变了** | **FAIL**（发生了桌面切换；需再判定是 UIA / SetForegroundWindow / SendInput / Apple Music 自身触发） |
| 前后桌面相同 + Apple Music 桌面 id 不变 + SMTC 目标曲目 `Playing` | **PASS** |
| 前后桌面相同 + SMTC 未达目标 | **FAIL**（随后区分：UIA 看不到窗口 / Invoke-Select 无效 / SendInput 未作用于 Desktop 2 / 窗口不在活动桌面而拒绝处理输入） |
| 操作前 `appleMusicIsOnCurrentDesktop=true` | **INCONCLUSIVE**（Apple Music 本来就在当前桌面，隔离性未被测试） |
| `-ObserveOnly` | **OBSERVATION_ONLY** |

## 已知边界

- 虚拟桌面**不是安全隔离**，也**没有独立鼠标**；"输入注入能否作用于非当前桌面"必须实测，**不预设结论**；
- 若 `activeDesktopIdProxy` 或 `appleMusicDesktopId` 显示 `unavailable`，则该维度**无法判定**，按 INCONCLUSIVE 处理，
  绝不伪造数值。
