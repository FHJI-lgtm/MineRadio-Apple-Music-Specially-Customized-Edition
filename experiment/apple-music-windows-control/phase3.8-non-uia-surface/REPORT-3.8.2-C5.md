# Phase 3.8.2-C 第 5 轮 — 6-GUID 穷举（已执行，全部 E_NOINTERFACE）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED + TARGET_INTERFACE_IDENTIFIED + PROXY_DLL_LOADABLE + PS_FACTORY_UNRESOLVED + INTERFACE_MARSHALING_BLOCKED**

证据：`evidence/g6-dllgetclassobject.txt`（**本轮重新生成，有效**，36 行，含 6 个 TRY 块与 `FOUND_COUNT=0`）。
上一轮那个无效文件已被同路径覆盖，不再进入证据链。

---

## 1. 6-GUID 穷举结果（判据严格：仅 `S_OK && factory != NULL` 记 FOUND）

前置确认：`typeCompiled=True`（上一轮的编译 bug 已修：形参 `Guid rclsid, Guid riid` 与调用 `fn(ref rclsid, ref riid, out ppv)` 一致）、
`HMODULE_NONZERO=true`（临时副本装载成功）。

调用形式：`DllGetClassObject(GUID, IID_IClassFactory)`。

| # | GUID（全部来自 Manifest） | 角色 | HRESULT | factory | STRICT_FOUND |
|---|---|---|---|---|---|
| 1 | `F707A913-E0CE-4FD4-BCE3-425DD153285B` | IAMPLibrary / ProxyStub ClassId | `0x80004002` | null | false |
| 2 | `68E7097C-F969-4006-AAC3-95115F0ED1C4` | IAMPMusicLibrary / Server CLSID | `0x80004002` | null | false |
| 3 | `0A180672-967F-5B4E-9D67-8146D1200522` | EventDelegate ActivityState | `0x80004002` | null | false |
| 4 | `6F89C3B3-0C25-50C5-BECA-3D5086210E34` | EventDelegate BusyChanged | `0x80004002` | null | false |
| 5 | `C4C9DE7B-DE44-59DB-9805-54686C6DC298` | EventDelegate CloudLibrary | `0x80004002` | null | false |
| 6 | `E9AE66D5-042E-5058-BEAA-1355425C739A` | EventDelegate FetchInvalidation | `0x80004002` | null | false |

`FOUND_COUNT=0`，`FOUND=`（空）。
六个 HRESULT **完全一致**（`E_NOINTERFACE` = `0x80004002`），无歧义、无需解释任何"部分成功"。

## 2. 决策树走向：FOUND_COUNT = 0 分支

按你预先定义的决策树，现在进入"所有候选都失败"分支：

- ❌ "还有一个我们没猜到的 GUID" —— 这条**已被穷举关闭**（Manifest 里声明过的 GUID 只有这 6 个，全部试完）；
- ✅ **"该代理的可用性依赖 Package COM runtime，而不是 HKCR/普通 COM 注册"** —— 由"猜测"升级为**强工程假设**；
- ⏳ 下一步（需你批准）：**最小 Package Identity 宿主实验**，判据：
  - 未打包：`REGDB_E_IIDNOTREG`（已实测）
  - 打包后：若 `QI S_OK` → 变量锁定在 package identity；
  - 打包后仍然 `REGDB_E_IIDNOTREG` → 说明还有第三层机制，**不能**简单归因于 package identity。

研究问题也随之从"逆向 GUID 猜测"转为：**Windows 的 Packaged COM infrastructure 究竟如何把 Manifest 中的
`windows.activatableClass.proxyStub` 注册信息呈现给包内客户端**（这是 OS 机制问题，不是 Apple 特有行为）。

## 3. 本轮完整排除清单（都可复核）

| 假设 | 结果 |
|---|---|
| 存在普通 `InprocServer32` 只是没搜到 | ❌ 排除：HKLM/HKCU CLSID、Wow6432Node、Interface 全 0 命中 |
| 应改调 `NdrDllGetClassObject` | ❌ 排除：PE 导出表只有 `DllGetClassObject`+`DllCanUnloadNow`，无任何 `Ndr*` |
| 需要 `DllRegisterServer` 自注册 | ❌ 排除：未导出；且注册表中 0 引用 |
| "PS CLSID = IID"（MIDL 惯例）必然成立 | ❌ 排除：`DllGetClassObject(68E7097C)` → `E_NOINTERFACE` |
| Manifest 的 `ProxyStub ClassId` 就是它的 class id | ❌ 排除：`DllGetClassObject(F707A913)` → `E_NOINTERFACE` |
| 还有未试过的 Manifest GUID | ❌ 排除：6/6 全部试完，全部 `E_NOINTERFACE` |

## 4. 仍然成立的另一侧

`CoCreateInstance(68E7097C-…, CLSCTX_LOCAL_SERVER)` → **S_OK，活的 IUnknown**；
因此 **Server activation 与 interface marshaling 是两套独立的基础设施**，前者已通、后者未通。

## 5. 纪律（累计）

业务方法调用 **0**｜系统注册表写入 **0**｜应用安装 **0**｜Package 部署 **0**｜鼠标输入 **0**｜键盘输入 **0**｜前台抢占 **0**。
`vtable[3+]` 继续锁死：无 marshaling、无 typelib、无可靠接口定义之前，直接撞 vtable 的收益远低于风险
（可能打崩 `AMPLibraryAgent.exe` 或测试进程）。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
