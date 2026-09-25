# Phase 3.8.2-A — proxy/stub 注册机制（只读）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED / INTERFACE_MARSHALING_BLOCKED**

证据：`evidence/proxy-registration.txt`（配合 `com-activation2.txt`）。
本轮**全部只读**：没有写注册表、没有 LoadLibrary/proxy 注册、没有调用业务方法、没有发包、无鼠标/键盘/前台动作。

---

## 1. 机制已查清（这就是 `0x80040155` 的来源）

| 检查项（只读） | 结果 |
|---|---|
| `HKLM\SOFTWARE\Classes\Interface\{68E7097C-…}`（IAMPMusicLibrary） | **不存在** |
| `HKCU\SOFTWARE\Classes\Interface\{68E7097C-…}` | **不存在** |
| `HKLM\SOFTWARE\Classes\Interface\{F707A913-…}`（IAMPLibrary） | **不存在** |
| `HKLM\SOFTWARE\Classes\Interface` 中任何含 `68E7097C` 的 `ProxyStubClsid32` | **0 命中** |
| `HKCU\…\PackagedCom\ClassIndex`（全量） | **空** |
| `HKCU\…\ActivatableClasses\Package`（搜 AppleMusicWin） | **无该包条目** |
| 客户端身份 | 我们的进程是 **unpackaged powershell**（无包身份 / 非 AppContainer） |

**`AMPLibraryAgent.Proxies.dll` 的静态证据（42 KB）**：
- **有** `DllGetClassObject`、`DllCanUnloadNow`、`NdrDllGetClassObject`，并引用 `RPCRT4`
  → 确认它是 **MIDL 生成的 proxy/stub 提供者**（这就是它能承担 marshalling 的原因）
- **没有** `DllRegisterServer` / `DllUnregisterServer` / `NdrDllRegisterProxy`
  → 它**不会自注册**，系统里也没有人为它写好 `ProxyStubClsid32`

**闭环解释**：对象可激活（`CoCreateInstance` S_OK），但 IID 在经典注册表中**没有代理/桩映射**，
而该映射在 Packaged COM 下由**包基础设施**为**包内客户端**提供；我们是 unpackaged，所以拿不到 →
`REGDB_E_IIDNOTREG`。它**不是**"对象拒绝接口"（那会是 `E_NOINTERFACE`）。

> 一处如实记录的差异：上一轮 `reg query …\PackagedCom\Package\AppleInc.AppleMusicWin_… /s` 显示
> `(Default) REG_DWORD 0x3e`；本轮同样的查询返回空。两次都是只读查询，未做任何写入，差异原因未查明
> （可能与 shell/注册表视图有关），照实记录，不作为任何结论依据。

## 2. 因此三条可选路线（下一步只做第 3 条，且**不写系统注册表**）

| 路线 | 说明 | 评价 |
|---|---|---|
| ① 系统级注册 proxy（写 `HKCR\Interface\{IID}\ProxyStubClsid32`） | 需要管理员且**修改系统注册表** | ❌ 越界，不做 |
| ② packaged-identity 客户端（写一个小包声明同样的 `com:Interface`） | 需要**打包/签名**应用 | 重量级，且需要额外授权；暂不做 |
| ③ **进程内临时 PS 注册**（只影响我们自己的进程） | `LoadLibrary(AMPLibraryAgent.Proxies.dll)` → `GetProcAddress("DllGetClassObject")` → 取 PS class object → `CoRegisterClassObject`(INPROC_SERVER, MULTIPLEUSE) → `CoRegisterPSClsid(IID, CLSID=IID)`（MIDL 惯例）→ **重试 QI** | ✅ **推荐**：不改系统注册表、不装应用；符合当前边界 |

## 3. 3.8.2-C 的精确计划（仍不调用任何业务方法）

```
CoCreateInstance(CLSID 68E7097C-…, LOCAL_SERVER)        -> IUnknown   (已证明 S_OK)
  ↓
LoadLibraryW(AMPLibraryAgent.Proxies.dll)
  ↓
DllGetClassObject(IID 68E7097C-…, IID_IClassFactory)    -> PS class object
  ↓
CoRegisterClassObject(IID 68E7097C-…, …, CLSCTX_INPROC_SERVER, REGCLS_MULTIPLEUSE)
  ↓
CoRegisterPSClsid(IID 68E7097C-…, CLSID 68E7097C-…)     (对 IAMPLibrary F707A913-… 同样处理)
  ↓
QI(IAMPMusicLibrary) / QI(IAMPLibrary)
  ↓
成功 → 只读枚举 vtable（ReadIntPtr 列地址；IUnknown 前 3 槽为 QI/AddRef/Release）
  ↓
再与 AMPLDCommandProcessor / AMPLDCommandData / AMPLDMediaSharing* / AMP.Core.IAMPMusicLibrary 交叉关联
```

**成功判据（本轮定义）**：QI 返回 `S_OK` 且拿到非零接口指针。
届时状态升级为 `CONTROL_SURFACE_INTERFACE_ACQUIRED_NOT_INVOKED`；**仍不调用业务方法**。

## 4. 交叉关联素材（已收集，静态）

`AMPLibraryAgent.exe` 内含：`AMPLDCommandProcessor`、**`AMPLDCommandData`**、`AMPLDEntireLibraryCommandDataCreator`(族)、
`AMPLDMediaAppsManager`、`AMPLDMusicAppConnection`、`AMPLDMediaSharingClientConnection`、`AMPLDMediaSharingPrefs`、
`AMPLDSharingAdapter`、`AMPLDServiceWin`、`AMPLDAppConnection`、`AMPLDArtwork`、`AMPLDDatabaseManager`、
`AMPLDLongOperation`、`AMPLDTVAppConnection`、`AMPLDeletedObjectsTracker`（16 个 AMPLD* 字符串）。
`AMPLDCommandProcessor` + `AMPLDCommandData` 这一对，是"命令路径"最强的静态候选——但**仍是候选，不是结论**，
必须在拿到真实接口后由方法清单/签名来证实。

## 5. 目标态（不变）

```
Resolve-AmSong → IAMPMusicLibrary（后台选曲/播放）→ SMTC verification
```
验收条件依旧对任何"真的能播放"的路线生效：
`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
到目前为止，**尚未调用任何一个业务方法**（Play/Select/Open/SetCurrentItem 均未触碰）。
