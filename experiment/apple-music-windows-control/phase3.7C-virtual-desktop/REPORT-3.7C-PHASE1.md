# Phase 3.7C — 虚拟桌面隔离 PoC：Phase 1 状态

**RESULT: INCONCLUSIVE**（缺少实验变量，不是"隔离失败"）

产物：`phase3.7C-virtual-desktop/`（`lib/vd-common.ps1`、`run-vd-poc.ps1`、`README.md`、`reports/vd-poc-*.{txt,json}`）
本轮**未提权、未建/删/移动虚拟桌面、未改注册表、未改系统文件、未碰 COM vtable[3+]/Packaged COM/MusicKit、未改 resolver 与播放逻辑**。

---

## 1. 本轮实际做了什么

1. 搭好**Virtual Desktop Observation 层**（`IVirtualDesktopManager`，**只用有文档的 API**：
   `IsWindowOnCurrentVirtualDesktop` / `GetWindowDesktopId`；**从不调用** `MoveWindowToDesktop`；
   无文档 API 的活动桌面 GUID 记为 `unavailable`，并以"前台窗口的桌面 id"作为**显式代理**）；
2. 搭好 runner：**复用现有冻结入口** `Invoke-AmPlaySong`（未重写 A-uia），每次运行**只发起一次**播放尝试；
3. 复用 3.7B 审计（`mouseMoved` / `keyboardInjected` / `foregroundChanged` / focus / cursor）；
4. 记录字段与判定规则**全部按你给的清单与阈值**内建；`-ObserveOnly` 用于先验证观察层。

## 2. 发现并修掉的两个真实缺陷

| # | 缺陷 | 根因 | 处理 |
|---|---|---|---|
| 1 | VD API 创建失败，报 `CLSID {00000000-...} Class not registered` | 用 **ProgID** `New-Object -ComObject 'VirtualDesktopManager'` → 未解析到 CLSID | 改为**按文档 CLSID** `AA509086-5CA9-4C25-8F95-589D3C07B48A` 创建（已不再报空 CLSID） |
| 2 | EnumWindows 永远返回 0 个候选窗口 | PowerShell **scriptblock 委托在不同作用域运行**，`$found +=` 不回写外层 | 改为 `System.Collections.ArrayList` + 回调内 `.Add()`（已验证语法通过） |

## 3. **仍未解决的一个缺陷 + 一个前置条件（= INCONCLUSIVE 的原因）**

**A. PS → ComImport 接口转换失败（本轮实测）**
```
vdApiAvailable=False
vdApiError=Cannot convert the "System.__ComObject" value of type "System.__ComObject"
            to type "AmVd.IVirtualDesktopManager".
```
说明：CLSID **已经成功创建了对象**，但 PowerShell **无法把 `__ComObject` 强转为 ComImport 接口**（PS 已知限制）。
→ `activeDesktopIdProxy` / `appleMusicDesktopId` / `appleMusicIsOnCurrentDesktop` 目前全部为 `unavailable`。
**确切修法（下一轮第一步，不改任何系统状态）**：把两个调用**整体搬进 C# 静态方法**
（`static bool IsOnCurrentDesktop(IntPtr)`、`static string GetDesktopId(IntPtr)`），由 C# 内部完成
CLSID 创建 + 接口调用，只回传 `bool`/`string`，**彻底绕开 PS 的接口转换**。

**B. Apple Music 当前未运行（本轮实测）**
```
appleMusicProcessRunning=False   smtcTitle=  smtcArtist=  smtcStatus=
appleMusicWin32FindError=no-applemusic-process
```
→ 即使观察层修好，**PoC 也无法执行**：需要 Apple Music 在 Desktop 2 上运行（并由你手工完成桌面准备）。

## 4. 缺哪一个实验变量（INCONCLUSIVE 的精确表述）

缺**两个**，二者都不是"隔离失败"的证据：

1. **VD API 包装未走通**（PS→ComImport 转换限制，修法已定位，属代码问题）；
2. **实验前置状态未就绪**：Apple Music 未运行、且**尚未手工完成**
   「建 Desktop 2 → 把 Apple Music 移过去 → 切回 Desktop 1」这一步。

在此之前，**不能**对"输入注入能否作用于非当前虚拟桌面"给出任何结论——尤其要记住：
**UIA 能否看到 Desktop 2 的窗口 ≠ 输入注入能否作用于 Desktop 2**，这两个问题在数据里必须分开看
（观察层已把它们拆成不同字段）。

## 5. 手工准备清单（下一步，你执行）

1. 启动 Apple Music，并让它播放/停留在一首歌；
2. 新建虚拟桌面 2（`Win+Ctrl+D`），把 **Apple Music 窗口**移到 Desktop 2；
3. 切回 **Desktop 1**（本脚本与 MineRadio 都在 Desktop 1）；
4. 先跑一次观察层确认读数为真实值（应看到 `vdApiAvailable=true`、
   `appleMusicProcessRunning=true`、`appleMusicIsOnCurrentDesktop=false`、
   `appleMusicDesktopId` 非 `unavailable`）：

```powershell
.\phase3.7C-virtual-desktop\run-vd-poc.ps1 -ObserveOnly
```

5. 确认无误后再跑正式 PoC（**一次尝试**）：

```powershell
.\phase3.7C-virtual-desktop\run-vd-poc.ps1 -Case A
```

## 6. 判定规则（已内建，不会放宽）

| 条件 | RESULT |
|---|---|
| 前后 `activeDesktopIdProxy` 变化 | **FAIL**（发生桌面切换；再判定是 UIA / SetForegroundWindow / SendInput / Apple Music 自身触发） |
| 桌面不变 + Apple Music 桌面 id 不变 + SMTC 目标曲目 `Playing` | **PASS** |
| 桌面不变但 SMTC 未达目标 | **FAIL**（再区分：UIA 看不到窗口 / Invoke·Select 无效 / SendInput 未作用于 Desktop 2 / 窗口不在活动桌面而被拒绝处理输入） |
| 操作前 `appleMusicIsOnCurrentDesktop=true` | **INCONCLUSIVE**（隔离性未被测试） |

## 7. 纪律与冻结

未自动创建/销毁/移动虚拟桌面；未做循环压力测试（每次运行仅一次尝试）；未使用管理员权限；
未改 MineRadio 播放逻辑与 Phase 3 resolver；未碰 `vtable[3+]` / Packaged COM / ProxyStub / MusicKit。
验收条件对所有后续阶段继续有效：`mouseMoved=false`、`keyboardInjected=false`、
`foregroundChangedByApplication=false`、`SMTC changed = expected`。
