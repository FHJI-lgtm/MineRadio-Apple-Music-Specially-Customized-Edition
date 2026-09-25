# Phase 3.8.4 — Windows Package COM registration 只读取证

**PHASE_3_8 = SERVER_ACTIVATION_CONFIRMED + TARGET_INTERFACES_IDENTIFIED + PROXY_DLL_LOADABLE + CLASSIC_COM_REGISTRATION_ABSENT + MANIFEST_PROXY_DECLARATION_CONFIRMED + ALL_MANIFEST_GUID_DllGetClassObject_TRIALS_FAILED + PACKAGE_IDENTITY_NOT_SUFFICIENT + INTERFACE_MARSHALING_BLOCKED + OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED**

本轮**无任何 COM 调用**（因此 `RPC_E_CHANGED_MODE` 与本轮无关）、无注册表写入、无宿主、无包注册。

⚠ **证据文件缺陷（如实说明）**：`evidence/os-package-com-registration.txt` 只落盘 **1 行**——
我的 `function Say($t){ $L.Add($t) }` 收集器再次在该作用域下失效（`[System.String] does not contain a method named 'Add'`），
后续行只打印到控制台。**本报告记录的确切数值即为本轮证据**；修法明确：去掉该 helper、改用 `$script:L` 或 `$lines += …` 数组追加。

---

## 1. Apple 用的是哪一套 schema（回答你的问题）

对 Apple 包清单做 token 计数：

| schema token | 出现次数 |
|---|---|
| **`windows.activatableClass.proxyStub`** | **1** |
| `com:ProxyStub` | 0 |
| `com2:ProxyStubDll` | 0 |
| `ProxyStubDll` | 0 |
| `windows.comServer` | 1 |
| `com:ComServer` / `com:ExeServer` / `com:Class` | 2 / 2 / 1 |
| `ProcessorArchitecture` | 1（包身份属性，非 proxy 架构声明） |

→ **Apple 用的是较老的 `windows.activatableClass.proxyStub`**（不是新的 `com:ProxyStub` / `com2:ProxyStubDll`）。
按你查到的文档语义：这里的 `ClassId` 是 **"the unique ID of the proxy"**，`Interface` 子元素各自声明关联 IID——
**这与我们 6/6 `DllGetClassObject(ClassId)` 全 `E_NOINTERFACE` 完全不矛盾**，也不需要"再猜一个 CLSID"。

原始块（verbatim，空白折叠）：
```xml
<com:Extension Category="windows.comServer"><com:ComServer>
  <com:ExeServer Executable="AMPLibraryAgent.exe" DisplayName="AMPLibraryAgent">
    <com:Class Id="68E7097C-F969-4006-AAC3-95115F0ED1C4" DisplayName="AMP.Core.IAMPMusicLibrary"/>
  </com:ExeServer></com:ComServer></com:Extension>
```
（`windows.activatableClass.proxyStub` 块见 `REPORT-3.8.2-C3.md` / `-C.md`：`ProxyStub ClassId=F707A913-…`，`Path=AMPLibraryAgent.Proxies.dll`，两个 `Interface` 子元素。）

## 2. Windows 把它放在哪里？（只读取证结果）

| 位置 | 结果 |
|---|---|
| `HKCU\SOFTWARE\Classes\PackagedCom` 中 **名字含 ProxyStub 的键** | **0 命中** |
| `HKCU\…\PackagedCom\ClassIndex` | **空**（0 行） |
| `HKCU\…\PackagedCom\Package\AppleInc.AppleMusicWin_…` | **只有 `(Default) REG_DWORD 0x3e`**（该 `0x3e` 现象本次**复现**） |
| `HKCU\…\ActivatableClasses\Package` 搜 AppleMusicWin | **0 命中** |
| `HKLM\…\Classes\Interface\{F707A913-…}` / `{68E7097C-…}` | **0 行** |
| `HKCU\…\Classes\Interface\{F707A913-…}` / `{68E7097C-…}` | **0 行** |

**结论（有界、不越界）**：在我可读的**按用户包 COM 注册存储**里，Apple 包对应的
class / interface / proxy 条目**都不存在**——只有一条包级默认值（`0x3e`）。
也就是说，这个 manifest proxyStub **没有被物化到经典注册表，也没有被物化到 `PackagedCom` 的
Class/ClassIndex 结构**（至少对当前用户、当前读取上下文而言）。

这与实测到的 `REGDB_E_IIDNOTREG` **完全自洽**：COM 找不到 IID→PS CLSID 映射，因为它不在注册表里。

## 3. 由证据支持的模型（修正后的认知）

```
AppxManifest  windows.activatableClass.proxyStub
    ProxyStub ClassId = F707A913-…   （= "the unique ID of the proxy"，不是可直接激活的 server class）
    Path              = AMPLibraryAgent.Proxies.dll
    Interface         = IAMPLibrary F707A913-… , IAMPMusicLibrary 68E7097C-…
              │
              ▼
    Windows packaged-COM runtime（**不经过 HKCR / PackagedCom 注册表的物化**）
              │
              ▼
    IID → PS CLSID 映射（在 OS 内部构建，外部可读存储里看不到）
              │
              ▼
    RPC proxy 解析 → 为何对未打包**以及**打包客户端都未生效 = 未解
```

因此"还有没有没猜到的 CLSID"这一支**可以彻底关闭**：不是 GUID 不足，而是**映射本身没有出现在
我们可读的任何注册存储中**。

## 4. 下一步（保持只读，不再建宿主、不再猜 GUID）

1. **枚举 `HKCU\SOFTWARE\Classes\PackagedCom` 的完整键结构**（不带 `/f` 过滤，先看它到底长什么样，
   再判断 Apple 包为何只有一条默认值）——上一轮只做了过滤搜索，结构本身还没看过；
2. **StateRepository 只读取证**：`%ProgramData%\Microsoft\Windows\AppRepository\StateRepository-Machine.srd`（SQLite），
   只做**只读复制后查询**，查 proxyStub/interface/class 扩展是否记录在案（需注意文件被系统占用、可能需管理员只读权限）；
3. **对照微软官方 sample 的 manifest**（文档级，不需要机器状态）：确认 `windows.activatableClass.proxyStub` 下
   `Interface` 子元素的语义（IID 列表）与运行时构建映射的方式，作为判断"我们是否看错了注册位置"的基准；
4. 若 1–3 都显示"映射确实不在外部可读存储里"，则本问题的定性即为：
   **Packaged COM 的 proxy 解析通道对该第三方客户端不可用**——那时才谈是否需要非 UIA/非 COM 的其它后台控制面。

## 5. 让下一次取证干净的两件事（工具纪律）

1. 去掉 `function Say` 收集器缺陷：改用 `$script:L` 或 `$lines += '...'`；
2. 未来任何更细的 marshaling 测试前，先修宿主 apartment：本轮之前那两次 `COINITIALIZE_HR=0x80010106`
   （`RPC_E_CHANGED_MODE`）说明显式 STA 初始化未生效——**先处理 apartment 再谈更细行为**。
   （本轮为纯注册表取证，**未发起任何 COM 调用**，故该问题不参与本轮判定。）

## 6. 纪律累计

业务方法 **0**｜`vtable[3+]` **0**｜代理 DLL 加载 **0**（自 3.8.2-C 第 3 轮起不再加载）｜PS 注册调用 **0**｜
注册表写入 **0**｜鼠标/键盘/前台 **0**｜包注册 **净增 0**（测试包已注销）。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
