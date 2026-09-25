# Phase 3.8.2-C 第 4 轮 — provenance 补齐（完成）+ 6-GUID 穷举（**未执行**，我的编译 bug）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED + TARGET_INTERFACE_IDENTIFIED + PROXY_DLL_LOADABLE + PS_FACTORY_UNRESOLVED + INTERFACE_MARSHALING_BLOCKED**（不变）

---

## 1. ✅ provenance 缺口已补（本轮唯一的有效产出）

`evidence/pe-exports-flat.txt`（26 行，纯 `KEY=VALUE`，重新由 PE 解析器生成）：

```
FILE=%TEMP%\ampproxy-38c.dll
PE_ARCH=x64                      MACHINE=0x8664     SECTIONS=7
EXPORT_DIR_RVA=0x7A60            DLL_NAME=AMPLibraryAgent.Proxies.dll
EXPORT_COUNT_NAMES=2             EXPORT_COUNT_FUNCTIONS=2
EXPORT=DllCanUnloadNow   ORDINAL=0  RVA=0x1030
EXPORT=DllGetClassObject ORDINAL=1  RVA=0x1000
EXPORT_NAME_DllGetClassObject_PRESENT=true
EXPORT_NAME_DllCanUnloadNow_PRESENT=true
EXPORT_NAME_DllRegisterServer_PRESENT=false
EXPORT_NAME_DllUnregisterServer_PRESENT=false
EXPORT_NAME_NdrDllGetClassObject_PRESENT=false
EXPORT_NAME_NdrDllRegisterProxy_PRESENT=false
EXPORT_NAME_NdrDllUnregisterProxy_PRESENT=false
EXPORT_NAME_GetProxyDllInfo_PRESENT=false
CLSID_REGISTRY_MATCHES=0   WOW6432_CLSID_REGISTRY_MATCHES=0   INTERFACE_REGISTRY_MATCHES=0
```

→ 上一轮"REPORT 有数字、evidence 中途断掉"的缺口**已消除**，现在报告与证据一致。

## 2. ❌ 6-GUID 穷举 **未执行**（必须如实说明）

我这一轮的 C# 包装器有编译错误：

```csharp
public static int GetFactory(IntPtr h, Guid clsid, Guid iid, out IntPtr ppv) {
  ...
  return fn(ref clsid, ref riid, out ppv);   // <-- 应为 ref iid，参数名写错
}
```

→ `Add-Type` 报 `当前上下文中不存在名称"riid"` → **类型 `Am38g.Native` 从未创建** →
后续 6 次调用全部落到 `Unable to find type [Am38g.Native]`。
因此控制台打印的 `hr=0x`（空）与 `factory=0`、以及 `FOUND_COUNT=0`，
**是"类型不存在"的假象，不是 DLL 的答复**。

**`evidence/g6-dllgetclassobject.txt` 视为无效文件**（内容是同一批无意义值），**不得用于任何结论**；
下一轮必须删掉它并用修好的代码重新生成。

**修正只有一处**：把 `GetFactory` 的形参名与调用统一（`ref iid`，或把形参改名为 `riid`），其余逻辑不变。

## 3. 状态：本轮的 COM 结论与上一轮完全相同

| 项 | 状态 |
|---|---|
| Server activation | ✅ `CoCreateInstance(68E7097C, LOCAL_SERVER)` → S_OK，活的 IUnknown |
| 目标接口 IID | ✅ `IAMPLibrary F707A913-…`、`IAMPMusicLibrary 68E7097C-…` |
| Proxy DLL 可装载 | ✅ 临时副本装载成功（HMODULE 非零） |
| Proxy 导出/自注册 | ✅ 仅 `DllGetClassObject`+`DllCanUnloadNow`；无 `Ndr*`、无 `DllRegisterServer` |
| 经典注册表指向该 DLL | ❌ 0 条（HKLM/HKCU CLSID、Wow6432、Interface 全 0） |
| `DllGetClassObject(F707A913)` / `(68E7097C)` | ❌ 均为 `0x80004002 E_NOINTERFACE`（**这两个是有效答复**，来自第 3 轮的有效句柄实验） |
| **6-GUID 穷举** | ⏳ **NOT EXECUTED**（本轮编译 bug；上一轮也没做过） |
| QI(IID) | ❌ `0x80040155 REGDB_E_IIDNOTREG` |
| 业务 vtable[3+] | 🔒 **0 次调用** |

## 4. 下一轮（先修再跑，顺序不变）

1. 修 `GetFactory` 的形参/调用名 → **重跑 6-GUID 穷举**（判据：仅 `S_OK && factory != NULL` 记 FOUND，
   其余 HRESULT 一律只记录不解释）→ 重新生成 `evidence/g6-dllgetclassobject.txt`；
2. 若 6 个全 `E_NOINTERFACE` → "该代理的可用性依赖 Package COM runtime 而非 HKCR 注册"从假设升级为**强工程假设**；
3. 只有到那一步，才讨论**最小 Package Identity 宿主**（以"未打包 → REGDB_E_IIDNOTREG / 打包 → S_OK"为判据，需要你批准）；
4. 全程 `vtable[3+]` 继续锁死（无 proxy、无 typelib、无接口定义；错误调用约定可能打崩 `AMPLibraryAgent.exe` 或测试进程）。

## 5. 纪律

未写系统注册表、未装应用、未发包、无鼠标/键盘/前台动作；业务方法 **0 次**；
验收条件（`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`）继续有效；
UIA 线维持归档结论 `UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
