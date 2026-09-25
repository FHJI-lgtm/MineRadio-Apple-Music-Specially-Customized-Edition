# Phase 3.8.2-C 第 3 轮 — PE 导出表 + 注册表反查（结论：PS 机制锁定为"包内提供"）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED + TARGET_INTERFACE_IDENTIFIED + PROXY_DLL_LOADABLE + PS_FACTORY_UNRESOLVED + INTERFACE_MARSHALING_BLOCKED**

⚠ 本轮原始捕获文件 `evidence/pe-exports-and-clsid-search.txt` **只落盘了前半段**：我的 `$L` 收集器在导出名循环处出错
（`[System.String] does not contain a method named 'Add'`），后续行只打印到控制台、未写入文件。
**本轮证据以本报告记录的确切数值为准**（下一轮会重新持久化一遍）。除此之外本轮全部只读。

---

## 1. ① PE 导出表（决定性）

`%TEMP%\ampproxy-38c.dll` = `AMPLibraryAgent.Proxies.dll`，**PE32+ / machine=0x8664 (x64)**，7 个节，
导出目录 RVA `0x7A60`、size 124，DLL 名 `AMPLibraryAgent.Proxies.dll`，
**NumberOfFunctions = 2，NumberOfNames = 2**：

| 导出名 | ordinal | RVA |
|---|---|---|
| `DllCanUnloadNow` | 0 | `0x1030` |
| **`DllGetClassObject`** | 1 | `0x1000` |

**未导出（逐个确认）**：`DllRegisterServer`、`DllUnregisterServer`、`NdrDllGetClassObject`、
`NdrDllRegisterProxy`、`NdrDllUnregisterProxy`、`NdrDllCanUnloadNow`、`GetProxyDllInfo`、`DllGetClassObjectInternal`
→ **全部 False**。

**这直接回答了你提的那个分支**：DLL **只有**标准 in-proc COM 两个入口，**没有** `Ndr*` 系列、**不能自注册**。
所以前两轮调用 `DllGetClassObject` 的方向**本来就是对的**，不存在"应该改调 NdrDllGetClassObject"的岔路；
而它对我们喂的两个候选 class id 都回 `E_NOINTERFACE`（0x80004002），意味着**它接受的是另一个 class id**（或需要包上下文）。

## 2. ② 注册表反查：没有任何 CLSID 注册了这个 DLL

对 `InprocServer32` 的默认值做 `/d`（数据）反查，命中数：

| 检索范围 | 命中 |
|---|---|
| `HKLM\SOFTWARE\Classes\CLSID` | **0** |
| `HKCU\SOFTWARE\Classes\CLSID` | **0** |
| `HKLM\SOFTWARE\Classes\Wow6432Node\CLSID` | **0**（顺手排除，确认非 x86） |
| `HKLM\SOFTWARE\Classes\Interface` | **0** |
| `HKCU\SOFTWARE\Classes\Interface` | **0** |

→ **经典注册表里根本没有任何 GUID 指向 `AMPLibraryAgent.Proxies.dll`**。
结合"该 DLL 不自注册 + 清单把它声明在 `windows.activatableClass.proxyStub` 下"，
可以确定：**这个 proxy/stub 的可用性完全由 Packaged COM 基础设施提供，经典注册表路径是空的**（不是我们没找到）。

## 3. 目前证据链（完整）

```
AppxManifest: windows.activatableClass.proxyStub
    ProxyStub ClassId = F707A913-…      -> AMPLibraryAgent.Proxies.dll
    IAMPLibrary      F707A913-…
    IAMPMusicLibrary 68E7097C-…

AMPLibraryAgent.Proxies.dll
    导出: DllGetClassObject(ord1,0x1000), DllCanUnloadNow(ord0,0x1030)   [仅此两个]
    不自注册; 经典注册表中 0 个 CLSID 指向它
    DllGetClassObject(F707A913) -> E_NOINTERFACE
    DllGetClassObject(68E7097C) -> E_NOINTERFACE

AMPLibraryAgent.exe (LocalServer, -Embedding)
    CoCreateInstance(68E7097C, LOCAL_SERVER) -> S_OK, 非零 IUnknown
    QI(IAMPLibrary / IAMPMusicLibrary) -> 0x80040155 REGDB_E_IIDNOTREG
    业务 vtable[3+] -> 0 次调用
```

## 4. 下一轮（都是假设，按"最便宜→最重"排序，仍不调用业务方法）

1. **把所有清单声明过的 GUID 都喂一遍 `DllGetClassObject`**：还剩 **4 个事件委托 IID**
   （`0A180672-967F-5B4E-9D67-8146D1200522`、`6F89C3B3-0C25-50C5-BECA-3D5086210E34`、
   `C4C9DE7B-DE44-59DB-9805-54686C6DC298`、`E9AE66D5-042E-5058-BEAA-1355425C739A`）
   加已知两个，共 6 个全部试完——**这是零风险、一次就能做完的穷举**，若其中某个返回 factory，PS CLSID 即确定；
2. 若穷举后仍全 `E_NOINTERFACE` → **假设升级为依据**：该 DLL 需要**包身份/包运行时**上下文才提供 PS factory
   （此时"最小测试包"才有讨论价值，且需要你批准）；
3. 只有在 1、2 都排除后，才考虑"Packaged COM marshalling 对未打包客户端不可用"的否定结论
   （**现在仍不下**——穷举还没做完）；
4. 期间 `vtable[3+]` 继续保持 🔒：无 proxy、无 typelib、无接口定义的情况下，错误调用约定足以把
   `AMPLibraryAgent.exe` 或测试进程打崩。

## 5. 状态与纪律

- 业务方法调用：**0**（`Play/Select/Open/SetCurrentItem` 与任何 `vtable[3+]` 均未触碰）
- 未写系统注册表、未装应用、未发包、无鼠标/键盘/前台动作
- 验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`
- UIA 线保持归档结论：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`
- 目标态不变：`Resolve-AmSong → IAMPMusicLibrary（后台选曲/播放）→ SMTC verification`
