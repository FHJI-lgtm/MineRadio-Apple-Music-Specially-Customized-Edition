# Phase 3.8.2-C — 进程内 PS 注册尝试（本轮：映射已确定，装载未成功）

**PHASE_3_8 = CONTROL_SURFACE_ACTIVATION_CONFIRMED / INTERFACE_MARSHALING_BLOCKED**
（本轮把"阻塞点"从"不知道 PS CLSID"推进到"PS CLSID 已由清单确定，只差把代理装进本进程"）

证据：`evidence/proxy-insitu.txt`。本轮仍**没有**写系统注册表、**没有**调用任何业务方法、无发包、无鼠标/键盘/前台动作。

---

## 1. 你要求确认的那件事：IID → Proxy CLSID 的真实映射（**已由清单确定**）

```xml
<Extension Category="windows.activatableClass.proxyStub">
  <ProxyStub ClassId="F707A913-E0CE-4FD4-BCE3-425DD153285B">
    <Path>AMPLibraryAgent.Proxies.dll</Path>
    <Interface Name="IAMPLibrary"      InterfaceId="F707A913-E0CE-4FD4-BCE3-425DD153285B" />
    <Interface Name="IAMPMusicLibrary" InterfaceId="68E7097C-F969-4006-AAC3-95115F0ED1C4" />
  </ProxyStub>
</Extension>
```

→ **ProxyStub ClassId = `F707A913-E0CE-4FD4-BCE3-425DD153285B`（即 IAMPLibrary 的 IID）**。
→ 也就是说：

| Interface IID | Proxy/Stub CLSID（清单声明） |
|---|---|
| `IAMPLibrary` `F707A913-…` | **`F707A913-…`**（同名） |
| `IAMPMusicLibrary` `68E7097C-…` | **`F707A913-…`**（**不是** 68E7097C！） |

**你的提醒是对的，而且这次真的会踩坑**：若按"IID 与 CLSID 恰好相同"的假设用 `68E7097C` 去注册 IAMPMusicLibrary 的 proxy，
PS CLSID 就是错的。现在映射来自清单声明，不是推断。

## 2. 本轮 B/C 未成立（如实记录）

| 步骤 | 结果 |
|---|---|
| `LoadLibraryW("…\AMPLibraryAgent.Proxies.dll")` | **handle = 0（装载失败）**，未捕获 `GetLastError` |
| B：`DllGetClassObject(clsid=IID, iid=IClassFactory)` | 返回 `0x80004005`，但**这是我在空句柄上 GetProcAddress 失败的返回码**（我的 helper 自造错误），**不是 DLL 的答复** → B **不成立** |
| C：`CoRegisterPSClsid` + 重新 `CoCreateInstance` + QI | **未执行**（因为上一步未确认出 PS class factory，代码按设计拒绝继续，没有假定映射） |

因此本轮**没有**获得接口指针，也没有新的 HRESULT 证据（`0x80040155` 依旧是目前最新的 QI 结论）。

## 3. 3.8.2-C 第 2 轮：精确、最小、仍然不调用业务方法

1. **把代理拷到临时目录再装载**（WindowsApps 目录下的 DLL 对外部未打包进程通常拒绝 LoadLibrary；
   本轮已经证明"能读字节"但"不能装载"）：
   `Copy-Item $pkg\AMPLibraryAgent.Proxies.dll $env:TEMP\ampproxy.dll` → `LoadLibraryW($env:TEMP\ampproxy.dll)`
   → **捕获 `GetLastError`**（本轮缺失，必须补上）。
2. **只用清单声明的 PS CLSID**：`DllGetClassObject(F707A913-…, IID_IClassFactory)` 取 **PS class factory**
   （注意角色：这是 **proxy/stub** 的 class factory，**不是** AMPLibraryAgent 的服务端 class，
   与你的修正一致——服务端激活已经证明可用，不需要也不应该重新注册它）。
3. `CoRegisterClassObject(F707A913-…, psFactory, CLSCTX_INPROC_SERVER, REGCLS_MULTIPLEUSE)`
   → `CoRegisterPSClsid(IID_IAMPLibrary, F707A913-…)` 与 `CoRegisterPSClsid(IID_IAMPMusicLibrary, F707A913-…)`
   → **全新** `CoCreateInstance(CLSID 68E7097C-…, LOCAL_SERVER)` → `QI(IAMPLibrary)` / `QI(IAMPMusicLibrary)`
   → 记录精确 HRESULT。
4. 若 QI 返回 `S_OK` 且指针非零 → **只读** 读 vtable（`[0..2]` 为 QI/AddRef/Release，`[3+]` 仅**列地址**，
   **不调用**）→ 状态升级 `CONTROL_SURFACE_INTERFACE_ACQUIRED_NOT_INVOKED`。

**本轮边界不变**：不改系统注册表、不装应用、不调用 `Play/Select/Open/SetCurrentItem` 或任何 `vtable[3+]`。

## 4. 旁支处理（按你的要求）

`PackagedCom\Package\<PFN>` 那次 `(Default) 0x3e` → 空 的差异：**只记录，不做任何推论**，不参与主线判断。
（本轮同样的只读查询也没有复现出该值。）

## 5. 目标态与验收（不变）

```
Resolve-AmSong → IAMPMusicLibrary（后台选曲/播放）→ SMTC verification
```
`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`
继续对任何"真的能播放"的路线生效。到本轮为止，**业务方法一个都没调用**。
