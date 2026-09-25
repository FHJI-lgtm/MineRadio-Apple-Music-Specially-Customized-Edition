# Phase 3.8.3 — 最小 Package Identity 宿主（Gate 报告：前置条件已确认 + 精确方案）

**PHASE_3_8.3 = HOST_FEASIBILITY_CONFIRMED_NOT_YET_EXECUTED**
唯一待答问题：**Package Identity 本身是否足以让 Windows 为 `AMPLibraryAgent.Proxies.dll` 建立可用的 interface marshaling。**

证据：`evidence/package-identity-prereq.txt`（本轮**只读**：无注册表写入、无包安装、无 COM 调用）。

---

## 1. 前置条件（本轮实测）

| 检查 | 值 | 含义 |
|---|---|---|
| `AllowDevelopmentWithoutDevLicense` | **1** | **Developer Mode 已开启** → 允许 **loose-layout 注册**（不需要签名的 .msix） |
| `Add-AppxPackage` 可用 | **true** | 具备注册能力 |
| 以管理员运行 | false | 当前用户注册（一般不需要管理员） |
| MakeAppx / signtool / SDK bin | **均不存在** | **不影响本方案**——loose-layout 注册不需要它们 |
| Apple 包 | `AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa`，Family `…_nzyj5cx40ttqa`，`SignatureKind=Store` | 目标包已确认 |

→ **可行性结论：本实验可以在本机执行，且不需要安装 SDK、不需要签名证书、不需要管理员。**

## 2. 最小宿主方案（只增加 Package Identity，其他一律不加）

目录 `phase3.8-non-uia-surface/host/`：

```
host/
  AppxManifest.xml      最小身份 + runFullTrust + 一个无 UI 的 full-trust 应用
  host.exe              csc.exe 编译（.NET Framework 自带编译器，无需 SDK）
  host.cs               CoInitializeEx + CoCreateInstance + 两个 QI + 落盘 HRESULT
```

**AppxManifest.xml（要点）**
```xml
<Package xmlns="...appx/2010/manifest" xmlns:rescap=".../rescap/2017/06">
  <Identity Name="MineRadio.PsHost" Publisher="CN=MineRadioTest" Version="1.0.0.0" ProcessorArchitecture="x64"/>
  <Properties><DisplayName>MineRadio PsHost</DisplayName><PublisherDisplayName>Test</PublisherDisplayName>
              <Logo>logo.png</Logo></Properties>
  <Resources><Resource Language="en-us"/></Resources>
  <Applications><Application Id="PsHost" Executable="host.exe" EntryPoint="Windows.FullTrustApplication">
    <uap:VisualElements .../></Application></Applications>
  <Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
```

**host.cs（要点：唯一变量 = Package Identity）**
```
CoInitializeEx(STApartment)
CoCreateInstance(CLSID 68E7097C-…, LOCAL_SERVER, IID_IUnknown)   -> HR
QI(IAMPLibrary      F707A913-…)                                    -> HR, ptr null?
QI(IAMPMusicLibrary 68E7097C-…)                                    -> HR, ptr null?
```
输出（严格按你指定的扁平字段，与 3.7B 的审计风格一致）：
```
HOST_PACKAGED=true
PACKAGE_FAMILY=<由 GetCurrentPackageFamilyName 或 Host 自身读取>
COCREATE_HR=0x…
COCREATE_OBJECT_NONNULL=…
QI_IAMPLIBRARY_HR=0x…
QI_IAMPLIBRARY_NONNULL=…
QI_IAMPMUSICLIBRARY_HR=0x…
QI_IAMPMUSICLIBRARY_NONNULL=…
```
**不做**：UI、Apple Music 自动化、UIA、鼠标/键盘、前台窗口操作、注册表写入、业务方法调用、`vtable[3+]` 调用、额外 COM 注册。
**执行方式（零输入）**：`Add-AppxPackage -Register .\AppxManifest.xml` → 用 `shell:AppsFolder\<PFN>!PsHost` 激活（shell 激活 ≠ 输入注入，且不抢前台焦点）。

## 3. 判定（二分，与你的定义一致）

| 判据 | 结论 | 后续 |
|---|---|---|
| **A** `CoCreateInstance=S_OK` 且 `QI(IAMPLibrary)=S_OK` 且 `QI(IAMPMusicLibrary)=S_OK`（ptr 非空） | **Package Identity 充分** | 形成强因果链 `Package Identity → Packaged COM runtime → Proxy/Stub resolution → QI OK`；此后才研究 MineRadio 生产宿主如何合法获得同样环境 |
| **B** 打包后 `QI` 仍 `REGDB_E_IIDNOTREG` | **Package Identity 不是充分条件** | 转向 OS 机制调查：`windows.activatableClass.proxyStub → ProxyStub ClassId → Packaged COM registration/runtime → RPC proxy resolution` 究竟还缺什么，**而不是继续猜 GUID** |
| 附注 | 若 `COCREATE_HR != 0` | 与"Server 成功启动但 marshaling 失败"**意义完全不同**，必须分开记录（字段已按你要求拆开） |

## 4. 本轮做了什么 / 没做什么

**做**：前置条件只读检查（Developer Mode、Add-AppxPackage、SDK、Apple 包信息）。
**没做**：没有创建 host 目录/文件、没有注册包、没有运行任何宿主、**没有发起新的 COM 调用**。
累计纪律：业务方法 **0**、注册表写入 **0**、应用安装 **0**、Package 部署 **0**、鼠标 **0**、键盘 **0**、前台抢占 **0**、`vtable[3+]` **0**。

## 5. 下一步（一步就能给出 A/B 判定）

1. 建 `host/`（`AppxManifest.xml` + `host.cs` + logo 占位）→ 用 `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译 `host.exe`；
2. `Add-AppxPackage -Register` 注册（Developer Mode 已开，无需签名）；
3. 用 `shell:AppsFolder` 激活一次，读回落盘字段 → 得到 A 或 B；
4. 无论 A/B，**都不调用业务方法、不碰 `vtable[3+]`**；若为 A，再讨论生产宿主方案；若为 B，进入 Packaged COM runtime 机制调查。
