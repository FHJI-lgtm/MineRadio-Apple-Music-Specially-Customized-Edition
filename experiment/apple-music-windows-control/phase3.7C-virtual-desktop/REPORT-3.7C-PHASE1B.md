# Phase 3.7C — 第 2 轮：PS→COM 修复已生效；准入条件未满足 → **停止，未运行 Case A**

**RESULT: STOPPED_AT_PRECONDITION**（不是隔离失败，也不是 API 失败）

本轮严格限定范围内完成：**只**修 PS→COM 类型转换。未改 A-uia、未改 resolver、
**未创建/删除/移动虚拟桌面**、未增加任何新输入方式、未跑 Case A。

---

## 1. 修复内容（唯一改动）

把 VirtualDesktop 的全部动作**移入 C# 静态方法**，PowerShell 只接收最终结果：

```
C# 内部： Type.GetTypeFromCLSID(AA509086-5CA9-4C25-8F95-589D3C07B48A)
       → Activator.CreateInstance
       → (IVirtualDesktopManager)raw        ← 关键：转换在 C# 内完成
       → GetWindowDesktopId / IsWindowOnCurrentVirtualDesktop
PowerShell 只收： "true" / "false" / "unavailable" / GUID 字符串
```

新增 C# 静态方法：`VdInit()`、`VdIsOnCurrentDesktop(IntPtr)`、`VdGetDesktopId(IntPtr)`、`VdInitError()`。
PowerShell 侧 `Initialize-AmVd` / `Get-AmVdIsOnCurrentDesktop` / `Get-AmVdWindowDesktopId`
**不再出现任何 `__ComObject` 强转**。

## 2. 修复验证（有效）

```
vdApiAvailable=True
vdApiError=ok
activeDesktopIdProxy=7a8a789c-3926-4cb9-807f-dc11278c2841     ← 真实 GUID（此前为 unavailable）
```

→ 文档化 VD API 通路**已打通**：创建、QueryInterface、两个调用全部成功，且能返回真实桌面 GUID。

## 3. 准入条件核对（**5 项中 4 项不满足**）

| # | 要求 | 实测 | 结果 |
|---|---|---|---|
| 1 | `vdApiAvailable = true` | `True`（`vdApiError=ok`） | ✅ **PASS** |
| 2 | `appleMusicProcessRunning = true` | **False** | ❌ **FAIL** |
| 3 | `appleMusicDesktopId != unavailable` | **unavailable** | ❌ **FAIL** |
| 4 | `appleMusicIsOnCurrentDesktop = false` | **unavailable** | ❌ **FAIL** |
| 5 | SMTC 当前歌曲非空 | `smtcTitle=`（空）、`smtcStatus=`（空） | ❌ **FAIL** |

其它相关读数：`appleMusicWin32Found=False`、`appleMusicWin32FindError=no-applemusic-process`、
`appleMusicWindowHandle=0`、`uiaWindowFound=False`。

**→ 按你的指令：停止，不运行 `-Case A`。**

## 4. 缺失项定位（单一根因）

四项失败**同源**：**Apple Music 当前未运行**——
没有进程 → 没有顶层窗口 → 无法取 `appleMusicDesktopId` / `appleMusicIsOnCurrentDesktop`；
没有 SMTC 会话 → 当前歌曲为空。
此外，**手工的桌面准备也尚未进行**（Desktop 2 未创建 / Apple Music 未移过去 / Desktop 1 未确认）。

## 5. 需要你完成的动作（下一步才能继续）

1. **启动 Apple Music**，让它停在某首歌（`smtcTitle` 应非空）；
2. `Win+Ctrl+D` 新建虚拟桌面 2，把 **Apple Music 窗口**移到 Desktop 2；
3. 切回 **Desktop 1**（脚本与 MineRadio 均留在 Desktop 1）；
4. 重跑（**只跑观察层**）：
   `.\phase3.7C-virtual-desktop\run-vd-poc.ps1 -ObserveOnly`
   期望：`vdApiAvailable=True`、`appleMusicProcessRunning=True`、`appleMusicDesktopId=<GUID>`、
   `appleMusicIsOnCurrentDesktop=False`、`smtcTitle` 非空；
5. 五项**全部满足后**，才运行一次：`.\phase3.7C-virtual-desktop\run-vd-poc.ps1 -Case A`

## 6. 本轮未做的事（纪律）

未运行 `-Case A`；未修改 A-uia / resolver / 播放逻辑；未创建/删除/移动虚拟桌面；
未增加任何输入方式；未调用 `MoveWindowToDesktop`；未提权；未改注册表或系统文件；
未碰 `vtable[3+]` / Packaged COM / ProxyStub / MusicKit；未做循环压测。

产物：`reports/vd-poc-20260925-214624.{txt,json}`（含 `activeDesktopIdProxy` 真实 GUID 证据）。
