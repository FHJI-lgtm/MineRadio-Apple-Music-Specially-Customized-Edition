# Phase 3.8.5 — PackagedCom 完整枚举 + StateRepository 取证（后者被权限阻挡）

**PHASE_3_8 = SERVER_ACTIVATION_CONFIRMED + TARGET_INTERFACES_IDENTIFIED + PROXY_DLL_LOADABLE + CLASSIC_COM_REGISTRATION_ABSENT + MANIFEST_PROXY_DECLARATION_CONFIRMED + ALL_MANIFEST_GUID_DllGetClassObject_TRIALS_FAILED + PACKAGE_IDENTITY_NOT_SUFFICIENT + INTERFACE_MARSHALING_BLOCKED + OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED**

本轮**无任何 COM 调用**（`RPC_E_CHANGED_MODE` 不参与本轮）、无注册表写入、无宿主、无包注册、无提权尝试。
证据：`evidence/packagedcom-and-staterepository.txt`（31 行，**本轮完整落盘**）。

---

## 1. ① PackagedCom 完整枚举（不再用过滤器）——结论：结构里根本没有 mapping

```
HKCU\SOFTWARE\Classes\PackagedCom
└── Package                       ← 唯一的一级键（topLevelKeyCount=1）
    ├── AppleInc.AppleDevices_1.1540.24088.0_x64__nzyj5cx40ttqa
    ├── AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa
    ├── AppleInc.iCloud_15.9.60.0_x64__nzyj5cx40ttqa
    ├── B9ECED6F.ASUSPCAssistant_… / B9ECED6F.Glidex_…
    ├── Goversoft.PrivaZer_… / MaxInstallOrder
    ├── Microsoft.DesktopAppInstaller_… / Microsoft.GamingApp_…
    └── Microsoft.MicrosoftOfficeHub_… / Microsoft.Office.ActionsServer_…
```

- **没有** `ClassIndex`、**没有** `ProxyStub`、**没有** `Interface`、**没有** `CLSID` 层级的任何键；
- Apple Music 包键下**只有一条** `(Default) REG_DWORD 0x3e`（本轮第三次复现该值）；
- 全库**值搜索** `ProxyStub` → **0 命中**；`ProxyStubClsid32` → **0 命中**。

**判读（有界）**：`PackagedCom` 是一个**按包的存在性/标记存储**，不是 IID→PS CLSID 的映射存储。
→ 上一轮"是不是过滤器没搜到"的疑虑**彻底消除**：即使不过滤，整个结构里也不存在 proxy/interface registration 痕迹。

## 2. ② StateRepository —— **被权限阻挡（Access is denied）**

```
srdPath=C:\ProgramData\Microsoft\Windows\AppRepository\StateRepository-Machine.srd
Test-Path  → Access is denied
（-wal / -shm 同样 Access is denied）
```

- 连"文件是否存在"都无法判定，更谈不上只读复制 → **本轮未能取证**；
- 我**没有**尝试任何提权、`takeown`、`icacls` 或写操作（越界）；
- 这是三项里**唯一尚未被检查的存储**，也是目前信息增益最高的一项——但它需要**以管理员身份做一次只读复制**
  （`Copy-Item` 到 `%TEMP%` 后对副本做字符串/SQLite 查询），这一步需要你决定是否授权提权操作。

## 3. ③ 官方 sample manifest 对照 —— 本轮未做（按优先级让位给 ①②）

已知事实已足够避免误套 schema：Apple 用的是 **`windows.activatableClass.proxyStub`**（token 计数 1），
`com:ProxyStub` / `com2:ProxyStubDll` **均为 0**。因此后续只在**这一代 schema**的运行时注册机制上调查，
不拿新 schema 行为反推 Apple。

## 4. 模型固化（有证据支撑的部分）

```
AppxManifest windows.activatableClass.proxyStub
  ProxyStub ClassId = F707A913-…   Path = AMPLibraryAgent.Proxies.dll
  Interface = IAMPLibrary F707A913-… , IAMPMusicLibrary 68E7097C-…
        │
        ├─ 经典注册表 HKLM/HKCU Classes\Interface  → 0 条
        ├─ HKCU\Classes\PackagedCom                → 无 Class/Interface/Proxy 结构（仅包标记 0x3e）
        ├─ HKCU\Classes\ActivatableClasses         → 无该包条目
        ├─ Proxies.dll 导出                        → 仅 DllGetClassObject + DllCanUnloadNow（6/6 GUID 全 E_NOINTERFACE）
        └─ StateRepository                         → **未能取证（权限）**
        ▼
Windows packaged-COM runtime 内部构建的 IID → PS CLSID 映射（外部可读存储中不可见）
        ▼
QI → REGDB_E_IIDNOTREG（未打包与打包客户端**结果一致**）
```

## 5. 最终结论的措辞（按你的逻辑边界）

本阶段能负责地写下的结论是：

> **Windows 的 packaged-COM proxy registration/resolution 通道，对当前测试客户端未产生可用的 IID marshaling。**

**不写**："Packaged COM 对第三方客户端不可用"。
因为实测到的是一个**具体环境命题**：`Apple Music package + 该 ProxyStub + 当前 Windows build + 当前 host → QI = REGDB_E_IIDNOTREG`。

## 6. 下一步（保持只读；两条并行可选）

1. **（需你授权提权）StateRepository 只读取证**：管理员下 `Copy-Item` 三个文件（`.srd` / `-wal` / `-shm`）到 `%TEMP%`，
   对**副本**做 token 扫描（`ProxyStub` / `F707A913` / `68E7097C` / `AMPLibraryAgent` / `AppleMusicWin`）。
   本机无 sqlite 引擎，因此 SQL 级查询仍需另外准备（或用 `Microsoft.Data.Sqlite`/Node 侧工具，**不引入新依赖**的话就先用字符串扫描）。
   - 若命中 → 说明映射存在于 OS 状态数据库，可解释"为何不在 HKCR"；
   - 若无命中 → "映射存在于更内部的 runtime/activation 基础设施"这一方向进一步增强。
2. **官方 schema 对照**（文档级，不需要机器状态）：确认 `windows.activatableClass.proxyStub` 这一代
   `Interface[]` 的运行时构建语义，作为"我们是否看错了注册位置"的基准。

两项都做完仍无映射痕迹时，第 5 节那句结论即可作为 COM 线的**最终结论**，并据此决定是否转向其它后台控制面。

## 7. 纪律累计

业务方法 **0**｜`vtable[3+]` **0**｜代理 DLL 加载 **0**｜PS 注册调用 **0**｜注册表写入 **0**｜
鼠标/键盘/前台 **0**｜包注册 **净增 0**｜提权尝试 **0**。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
