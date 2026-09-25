# Phase 3.8 — 非 UIA 控制面调查（第 1 轮：只读盘点）

**PHASE_3_8 = CONTROL_SURFACE_LOCATED_NOT_YET_INVOKED**

本轮**只做只读盘点**：没有调用任何 COM 接口、没有连接任何 IPC、没有注入、没有反编译。
冻结播放库 / resolver / analyzer 零改动；3.7B 的验收条件继续有效（见第 5 节）。

证据（全部可复现，均为静态读取）：
- `evidence/surface-inventory.txt`（进程、PackagedCom、管道、端口、协议处理器）
- `evidence/com-registration.txt`（CLSID / Interface / TypeLib / AppID 注册表检索）
- `evidence/manifest-and-strings.txt`（包内模块清单、AppxManifest 的 comServer 段、二进制 ASCII 字符串）

---

## 1. COM（优先级 1）—— 控制面已精确定位

| 证据 | 内容 |
|---|---|
| 进程 | `AMPLibraryAgent.exe` pid 14252，**命令行 `... -Embedding`** ← COM local server 的标准启动参数，证明它**正被作为 COM 服务器使用** |
| 经典注册表 | **HKLM 与 HKCU 的 `SOFTWARE\Classes\CLSID` 中，0 条**指向 `AMPLibraryAgent.exe`；`Interfaces`/`TypeLib` 中亦无 `AMPMusicLibrary` → 它**不是经典 COM 注册**，而是 **Packaged COM**（所以此前"查不到 CLSID"不是没注册，而是注册位置不同） |
| 真正的注册处 | 包清单 `AppxManifest.xml`：`<com:Extension Category="windows.comServer">` + `<com:ExeServer Executable="AMPLibraryAgent.exe" DisplayName="AMPLibraryAgent">`，并有 `<Application Id="LibraryServer" Executable="AMPLibraryAgent.exe" EntryPoint="Windows.FullTrustApplication">` |
| **接口契约（IID）** | **`IAMPLibrary` = `F707A913-E0CE-4FD4-BCE3-425DD153285B`**<br>**`IAMPMusicLibrary` = `68E7097C-F969-4006-AAC3-95115F0ED1C4`**<br>事件委托：`ActvityStateEventDelegate` `0A180672-967F-5B4E-9D67-8146D1200522`、`BusyChangedEventDelegate` `6F89C3B3-0C25-50C5-BECA-3D5086210E34`、`CloudLibraryEventDelegate` `C4C9DE7B-DE44-59DB-9805-54686C6DC298`、`FetchInvalidationEventDelegate` `E9AE66D5-042E-5058-BEAA-1355425C739A` |
| 代理/桩 |清单声明 `<Path>AMPLibraryAgent.Proxies.dll</Path>` ← **接口的 proxy/stub**，是 vtable/marshalling 元数据的落点 |
| 二进制字符串 | `AMPLibraryAgent.exe`（18.4 MB）中确实含 `IAMPMusicLibrary`；另有一整套 `AMP*` 实现名：`AMPLDCommandProcessor`、`AMPLDMediaAppsManager`、`AMPLDMediaSharingClientConnection`、`AMPLDServiceWin`、`AMPLDArtwork`、`AMPLDAppConnection`、`AMPLEntireLibraryCommandDataCreator` … |
| 其他 Apple 包 | 同机还有 `AppleInc.AppleDevices_1.1540.24088.0`、`AppleInc.iCloud_15.9.60.0` 的 PackagedCom 条目（与播放控制无关，仅记录） |

**状态**：控制面**位置与 IID 已确定**，但**尚未调用**（本轮不越界）。
下一步才是：通过 Packaged COM 激活该类 → `QueryInterface(IAMPMusicLibrary, 68E7097C-…)` → 用 `AMPLibraryAgent.Proxies.dll` 提供的接口定义调用"播放/选曲/定位"方法。Phase 1 曾记录"可达但 `E_NOINTERFACE`/无 IDispatch/无 typelib"——那时是**没有 IID**，现在 IID 已拿到，值得用 IID 直查重试（这将是 3.8 第 2 轮的第一项）。

## 2. IPC（优先级 2）—— 本轮否定/待办

| 面 | 结果 |
|---|---|
| Named Pipe | **未发现任何 Apple 相关管道**（`\\.\pipe\` 全量枚举中匹配 apple/music/amp/agent/itunes 的只有一条无关的 Steam 管道） |
| localhost TCP 49892/49893 | **当前无监听**（这两个端口本轮没有任何 listener；此前记录不能作为"当前存在控制面"的依据） |
| localhost UDP | `AMPLibraryAgent`(14252) 占 **127.0.0.1:56215 与 56216**（UDP）。⚠ 本轮**没有**向它们发送任何数据——探测内容属于 IPC 调用，留给下一步 |
| AppService / packaged IPC | 清单里的 `com:ExeServer` 与 `Application Id="LibraryServer"` 是**同一条 Packaged COM 路径**，未发现独立的 AppService 声明 |

## 3. Apple Music 自身控制入口（优先级 3）—— 本轮无新增

- 注册的协议处理器：`music`、`musics`、`apple-icloudapp`（与 Phase 1 结论一致）
- 进程命令行：`AppleMusic.exe`（pid 8928）命令行只有 WindowsApps 别名路径，**没有暴露额外命令参数**；父进程为 WindowsApps 启动器 stub（19496）
- `AMPLibraryAgent.exe` 的命令行只有 `-Embedding`（COM 服务器），无其他开关
- → **未发现 `/url` 之外的命令路径**（这不等于不存在，只是本轮只读盘点没找到）

## 4. 私有 API / 深层逆向（优先级 4）

**未开始**，按你的边界执行。

## 5. 验收条件（继续对任何"真的能播放"的路线生效）

3.7B 留下的三条硬性条件继续有效，任何新路线都必须同时满足：

```
mouseMoved = false
keyboardInjected = false
foregroundChangedByApplication = false
```

即：非 UIA 路线也不能靠"把 Apple Music 拉到脸上 + 模拟输入"来换播放成功。
3.7B 的结论档案：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`（UIA 已验证但不适合作后台 activation contract）。

## 6. 第 2 轮建议（严格按你的优先级，不扩大范围）

1. **COM 优先**：用拿到的 IID 重试 `QueryInterface(IAMPMusicLibrary)`；读 `AMPLibraryAgent.Proxies.dll` 的接口定义（方法名/vtable 顺序）；只读式列出可用方法后再决定是否调用（调用前仍先报告拟调用内容）。
2. **IPC 次之**：先在**不发送数据**的前提下核实 UDP 56215/56216 的用途线索（例如与 `AMPLDMediaSharing*` 字符串的对应关系）；再决定是否需要抓包/试探。
3. **协议处理器**：复核 `music:` 处理器在 manifest 中声明的完整动作集合（是否只有 `/url`）。
4. 第 1–3 步都无"后台选曲/播放"入口，才考虑私有 API / 更深逆向。

## 7. 目标态（不变）

```
MineRadio → Resolve-AmSong → Apple Music 控制面（后台选曲/播放）→ SMTC verification
```
而不是"把 Apple Music 拉到脸上 → 模拟人类点击 → 抢回窗口"。本轮的盘点就是为了把第二条路彻底关掉之后，
用硬元数据（IID / proxy-stub / 清单）去打开第一条路。
