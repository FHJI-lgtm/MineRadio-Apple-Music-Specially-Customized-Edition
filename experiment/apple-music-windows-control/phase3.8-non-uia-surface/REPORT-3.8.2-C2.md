# Phase 3.8.2-C 第 2 轮 — gate 化尝试（代理可装载，PS class factory 未取得）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED / INTERFACE_MARSHALING_BLOCKED**
（细分：activation ✅ / proxy DLL 可装载 ✅ / PS class factory **未取得** ❌ / QI 仍为 `REGDB_E_IIDNOTREG`）

证据：`evidence/proxy-insitu2.txt`、`evidence/proxy-insitu3.txt`。
**未写系统注册表、未装应用、未调用任何业务方法、无发包、无鼠标/键盘/前台动作。**

---

## 1. 逐 gate 结果（按你要求拆开，不合并成"COM failed"）

| Gate | 动作 | 结果 |
|---|---|---|
| **1** | `Copy-Item` 到 `%TEMP%\ampproxy-38c.dll`（42872 字节）后 `LoadLibraryW` | **LOADED，HMODULE 非零**（140730377830400）。原位 WindowsApps 路径装载失败、临时副本成功 → **代理 DLL 本身可被未打包进程装载** |
| 1 附注 | 成功后 `GetLastError=203` | 装载成功时 `GetLastError` 无意义（`LoadLibrary` 只在失败时保证其有效）→ **仅记录，不作失败依据** |
| **2** | `DllGetClassObject(classId=68E7097C-…, IID_IClassFactory)`（IAMPMusicLibrary 的 IID） | **0x80004002 = E_NOINTERFACE**，factory=0 |
| **2** | `DllGetClassObject(classId=F707A913-…, IID_IClassFactory)`（清单 `ProxyStub ClassId`） | **0x80004002 = E_NOINTERFACE**，factory=0 |
| **3** | `CoRegisterClassObject` | **NOT_EXECUTED**（无 PS class factory，按设计不假定映射） |
| **4** | `CoRegisterPSClsid` ×2 | **NOT_EXECUTED** |
| **5** | 全新 `CoCreateInstance` + `QI` | **NOT_EXECUTED**；最新 QI 结论仍为 **`0x80040155 REGDB_E_IIDNOTREG`** |

**这两个 `E_NOINTERFACE` 是 DLL 的真实答复**（句柄有效），与上一轮"null 句柄导致的 `0x80004005`"完全不同——上一轮的 B 已明确作废，本轮 B 才是有效阴性。

## 2. 由此可以确定/不能确定的

**可以确定**：
- 代理 DLL 能被装载；
- 它的 `DllGetClassObject` **既不接受 IAMPMusicLibrary 的 IID**、**也不接受清单声明的 `ProxyStub ClassId`** 作为它自己的 PS CLSID；
- 因此"MIDL 惯例 → PS CLSID = IID"和"清单 ClassId 直接喂 `DllGetClassObject`"这两条**都不成立**（这是本轮最硬的结论）。

**不能确定（保持为假设，不写进结论）**：
- 该 DLL 是否只能在实际的 **包身份/包运行时** 上下文中提供 PS class factory；
- 是否存在**第三个**（未在清单中出现的）PS CLSID 才是它接受的入口；
- 它导出的 `DllGetClassObject` 是否是标准 MIDL 那一个（DLL 内同时含 `NdrDllGetClassObject` 字符串）。

## 3. 下一轮候选（都是假设，需逐个验证；仍不碰业务方法）

1. **PE 导出表枚举**（只读）：列出 `AMPLibraryAgent.Proxies.dll` 的真实导出名/序号，确认 `DllGetClassObject` / `NdrDllGetClassObject` / `NdrDllRegisterProxy` 到底导出了什么——如果标准 MIDL 三件套齐全，那问题就落在"喂进去的 CLSID 不对"；如果只有 `Ndr*` 变体，则应该直接调 `NdrDllGetClassObject`（不同的调用约定/参数）。
2. **按 pack/上下文试**：在具备包身份的最小测试宿主里做同样两步（需要你批准新建/安装测试包，属重量级）。
3. **枚举 `HKCR\CLSID` 中全部指向 `AMPLibraryAgent.Proxies.dll` 的项**（本轮只搜了字符串 `AMPLibraryAgent`，未搜 `Proxies`），确认是否存在清单之外的 PS CLSID 注册。
4. 上述都排除后，才考虑"Packaged COM 的 marshalling 对未打包客户端不可用"这一否定结论——**现在还不能下**。

## 4. 纪律与状态

- 业务方法调用次数：**0**（`Play/Select/Open/SetCurrentItem` 及任何 `vtable[3+]` 均未触碰）
- 验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`
- `PackagedCom\Package\<PFN>` 的 `0x3e → 空` 差异：仍只记录、不推论
- 目标态不变：`Resolve-AmSong → IAMPMusicLibrary（后台选曲/播放）→ SMTC verification`

## 5. 与 UIA 线的对比（一句话）

UIA 线已得否定结论（`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`）；
COM 线目前是**部分打通**：Server 可激活、接口 IID 与代理来源都已确定，**唯一未解是"未打包客户端如何取得 PS class factory"**——
这是一个具体的、可继续攻关的工程问题，而不是能力否定。
