# Phase 3.8.2 — COM IID acquisition 报告

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_VERIFIED_INTERFACE_BLOCKED_IIDNOTREG**

证据：`evidence/com-activation.txt`、`evidence/com-activation2.txt`（可复现）。
边界：**没有调用任何业务方法**；没有发包；没有注入；没有鼠标/键盘/前台动作。
冻结播放库 / resolver / analyzer 零改动。

---

## 1. 上轮的一个真实错误（先纠正）

3.8.1 里我写"清单里没有 CLSID"。**不准确**——我用 `<com:Class\s+Id="\{...\}"` 去匹配，
而清单里 **Id 没有花括号**，所以 0 命中，激活循环**根本没执行**。原始 comServer 段已抓到：

```xml
<com:Extension Category="windows.comServer">
  <com:ComServer>
    <com:ExeServer Executable="AMPLibraryAgent.exe" DisplayName="AMPLibraryAgent">
      <com:Class Id="68E7097C-F969-4006-AAC3-95115F0ED1C4" DisplayName="AMP.Core.IAMPMusicLibrary" />
    </com:ExeServer>
  </com:ComServer>
</com:Extension>
```

→ **Packaged COM 的 CLSID 就是 `68E7097C-F969-4006-AAC3-95115F0ED1C4`**（与 `IAMPMusicLibrary` 的 IID 复用同一 GUID，
DisplayName 明确写着 `AMP.Core.IAMPMusicLibrary`）。上轮的"无 CLSID"结论作废。

## 2. 激活结果（本轮真正的检查）

| 上下文 | HRESULT | 指针 |
|---|---|---|
| `CLSCTX_LOCAL_SERVER` (4) | **0x00000000 成功** | 活的 IUnknown |
| `CLSCTX_LOCAL_SERVER\|INPROC` (5) | **0x00000000 成功** | 活的 IUnknown |
| `CLSCTX_INPROC_SERVER` (1) | 0x80040154 `REGDB_E_CLASSNOTREG` | 0（符合预期：它是 exe server） |
| `4\|1\|ELEVATED` (21) | **0x00000000 成功** | 活的 IUnknown |

`.NET` 路径同样成功：`GetTypeFromCLSID` → `System.__ComObject`，`Activator::CreateInstance` 成功。
结合进程侧的 `AMPLibraryAgent.exe ... -Embedding`，**控制面已确认可被外部进程激活**（跨进程 out-of-proc COM）。

可读的 vtable（只读指针，未调用）：
`vtable@0x7FFE5D2EF470`，`vtable[0..9] = 0x7FFE5D2025D0 0x7FFE5D2020C0 0x7FFE5D2026B0 0x7FFE5D202690 0x7FFE5D118D80 0x7FFE5D11A040 0x7FFE5D119E10 0x7FFE5D1A9D30 0x7FFE5D35F860 0x7FFE5D35F850`
（这是返回的 **IUnknown** 的 vtable；前 3 项即 QI/AddRef/Release——未调用，故不宣称具体对应。）

## 3. 接口获取失败，但失败原因变了（关键）

| QI 目标 | 上轮结论（无 IID 时） | **本轮（有 IID）** |
|---|---|---|
| `IAMPLibrary` `F707A913-E0CE-4FD4-BCE3-425DD153285B` | E_NOINTERFACE | **0x80040155 = `REGDB_E_IIDNOTREG`** |
| `IAMPMusicLibrary` `68E7097C-F969-4006-AAC3-95115F0ED1C4` | E_NOINTERFACE | **0x80040155 = `REGDB_E_IIDNOTREG`** |

这是完全不同的结论：
- **不是**"对象不支持该接口"（那会是 `E_NOINTERFACE` 0x80004002）；
- **而是**"本机注册表里没有这两个 IID 的（代理/桩）注册"，因此**跨进程 QI 无法编排（marshal）**。
- 这与清单里 `windows.comInterface` + `<Path>AMPLibraryAgent.Proxies.dll</Path>` 的存在完全自洽：
  该接口的 marshalling 支持**随包注册**，包内调用者能过，**普通外部进程过不去**。

`AMPLibraryAgent.Proxies.dll` 静态分析补充：它只有 **42 KB**，是**通用 MIDL 桩**
（`CStdStub`、`NdrCStdStub`、`IUnknown_*_Proxy`），**不含**这两个 IID、**不含**方法名
→ **vtable 与方法签名无法从该 DLL 静态取得**（这条死路已排除，不是没找而是确实没有）。

## 4. 因此当前状态

`CONTROL_SURFACE_ACTIVATION_VERIFIED_INTERFACE_BLOCKED_IIDNOTREG`

- 控制面：**可激活**（CoCreateInstance 成功，out-of-proc）
- 接口：**未获取**，拦在 `REGDB_E_IIDNOTREG`（代理/桩注册缺失），**不是**接口不存在
- 业务方法：**一个都没调用**
- vtable/方法清单：**尚未取得**（预期来源：注册好 proxy 后的 QI，或包内调用上下文）

## 5. 第 3 轮建议（最小、连续、仍不调用业务方法）

1. **补上代理注册再 QI**：对这两个 IID 做 `CoRegisterPSClsid`（指向 `AMPLibraryAgent.Proxies.dll` 的
   `DllGetClassObject`），或在**具备包身份**的进程里激活（AppX 服务的代理注册对包内可见），重试 QI；
2. 若 QI 成功 → **只读**读 vtable（`ReadIntPtr` 列地址），再结合 `AMPLDCommandProcessor` /
   `AMP.Core.IAMPMusicLibrary` 字符串做**静态关联**，列出"可能的方法"清单（存在性→签名→语义→是否与选曲/播放相关）；
3. 只有前三步产出明确候选方法后，才进入 **3.8.5 First controlled invocation**，
   届时仍必须满足：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、
   `SMTC changed = expected`。
4. UDP 56215/56216：保持**不发包**，仅做 `AMPLDMediaSharing*` 字符串与端口的被动关联（本轮已记录：
   `AMPLDMediaSharingClientConnectioNotifyConfigC`、`AMPLDMediaSharingNotifyClientCountChanged`、
   `AMPLDMediaSharingPrefs`、`AMPLDSharingAdapter`、`AMPLDMediaAppsManager`、`AMPLDTVAppConnection`、
   `AMPLDMusicAppConnection`、`AMPLDCommandProcessor`、`AMPLDCommandData` 等 16 个 AMPLD* 字符串）。

## 6. 目标态（不变）

```
Resolve-AmSong → IAMPMusicLibrary / command interface（后台选曲·播放）→ SMTC verification
```
本轮把"到底有没有后台控制面"从猜测推进到：**存在、可激活、被代理注册挡住**——这是可继续攻克的具体障碍，
而不是一堵"没有接口"的墙。
