# Phase 3.8.3 — 最小 Package Identity 宿主实验：结果 = **B（Package Identity 不是充分条件）**

**PHASE_3_8.3 = PACKAGE_IDENTITY_NOT_SUFFICIENT**
证据：`evidence/package-host-run.txt`、`evidence/pshost-result-unpackaged.txt`、`evidence/pshost-result.txt`、`host/`（源码 + 编译产物）。

---

## 1. 实验矩阵（**同一个 host.exe**，唯一变量 = Package Identity）

| 字段 | 未打包基线（直接运行 host.exe） | 打包（loose-layout 注册后经 `shell:AppsFolder` 激活） |
|---|---|---|
| `HOST_PACKAGED` | **false** | **true** |
| `GETPACKAGEFULLNAME_RC` | `0x00003D54`（15700 `APPMODEL_ERROR_NO_PACKAGE`） | `0x0000007A`（122，缓冲区查询成功） |
| `PACKAGE_FULL_NAME` | EMPTY | `MineRadio.PsHost_1.0.0.0_x64__xtcpgrbtgkf5t` |
| `COINITIALIZE_HR` | `0x80010106` | `0x80010106` |
| `COCREATE_HR` | **`0x00000000` S_OK** | **`0x00000000` S_OK** |
| `COCREATE_OBJECT_NONNULL` | true | true |
| `QI_IAMPLIBRARY_HR` | **`0x80040155`** | **`0x80040155`** |
| `QI_IAMPLIBRARY_NONNULL` | false | false |
| `QI_IAMPMUSICLIBRARY_HR` | **`0x80040155`** | **`0x80040155`** |
| `QI_IAMPMUSICLIBRARY_NONNULL` | false | false |
| `PROXY_DLL_LOADED` | false | false |
| `PS_REGISTRATION_CALLS` | 0 | 0 |
| `NO_BUSINESS_METHOD_CALLED` | true | true |
| `VTABLE_3PLUS_TOUCHED` | false | false |

`0x80040155` = `REGDB_E_IIDNOTREG`。**两种上下文结果完全一致。**

## 2. 判定（按你的二分）

**B**：打包后 `CoCreateInstance` 仍 `S_OK`，`QI` 仍 `REGDB_E_IIDNOTREG`（指针为空）
→ **Package Identity 不是 interface marshaling 的充分条件**。

同时得到两条同样重要的结论：
1. **Server activation 与身份无关**：未打包/打包都是 `CoCreateInstance = S_OK`（再次确认 Server 侧没问题）；
2. **失败点稳定且与身份无关**：两次 QI 的 HRESULT 完全相同，说明阻塞不在"客户端有没有包身份"，而在 OS 对
   **manifest 声明的 proxy/stub 的注册与解析**这一层。

## 3. 下一层该问什么（不再猜 GUID、不再折腾宿主）

问题应从"缺不缺包身份"改为：

```
windows.activatableClass.proxyStub
        ↓
ProxyStub ClassId = F707A913-…
        ↓
Packaged COM registration / runtime
        ↓
RPC proxy resolution（IID → PS CLSID → 加载 Proxies.dll）
        ↓
为什么连包内客户端也拿不到这个映射？
```

具体可查的 OS 侧线索（下一步，仍只读优先）：
- `windows.activatableClass.proxyStub` 的 schema 语义与**运行时**注册表镜像（如
  `HKCU\Software\Classes\PackagedCom\Package\<PFN>\...` 在**为该包激活时**是否被填充；
  我们此前在非激活上下文看到的是空/默认值——这条要与"包运行时上下文"对齐后再看一次）；
- 该扩展是否要求 **proxy/stub 的 ClassId 与某个已注册接口的 IID 一致**（我们的 6/6 穷举说明
  `Proxies.dll` 的 `DllGetClassObject` 不接受任何已声明 GUID，这与"映射根本未建立"一致）；
- 是否存在 **`RO_*` / `RoGetActivationFactory`** 之类的 packaged 路径才是该 proxy 的正规入口。

**明确不做的**：继续猜 GUID、手工 `CoRegisterPSClsid`/`CoRegisterClassObject`（那会污染"OS 是否自动提供"这个问题）。

## 4. 协议合规与清理（按你的要求纳入协议）

| 步骤 | 记录 |
|---|---|
| Package registration **before** | `PKG_REG_BEFORE_COUNT=0` |
| registration command | `Add-AppxPackage -Register host\AppxManifest.xml`（Developer Mode 已开，无需签名/SDK） |
| registration result | **`PKG_REGISTER=OK`**，`PKG_REG_AFTER_COUNT=1`，Family `MineRadio.PsHost_xtcpgrbtgkf5t` |
| activation | `ACTIVATE=OK`（`shell:AppsFolder\…!PsHost`） |
| **cleanup** | **`PKG_REMOVE=OK`**，**`PKG_REG_AFTER_CLEANUP_COUNT=0`** |
| Package registration **after** | **0 —— 与本实验前一致，系统恢复原状**（测试包已注销；`host/` 源码与 exe 仅留在仓库作为证据） |

`Add-AppxPackage -Register` 属系统状态改变，因此完整记录了 before / command / result / after 四段。

## 5. 一处诚实的技术保留

两次运行都是 `COINITIALIZE_HR=0x80010106`（`RPC_E_CHANGED_MODE`）：线程已在**不同的 apartment** 中初始化过，
我显式的 `CoInitializeEx(STA)` **没有生效**。它没有阻止 `CoCreateInstance` 成功，且两种上下文结果完全相同，
**因此不改变 B 判定**；但下一步若要更严谨，宿主应改为"已初始化则容忍 `RPC_E_CHANGED_MODE`、并明确 apartment"，
以免在更细的 marshaling 行为上留下疑点。

## 6. 纪律累计（本轮仍然干净）

业务方法调用 **0**｜`vtable[3+]` **0**｜`LoadLibrary(Proxies.dll)` **0**（宿主内明确未加载）｜
`CoRegisterClassObject`/`CoRegisterPSClsid`/`DllGetClassObject` **0**｜注册表写入 **0**｜鼠标 **0**｜键盘 **0**｜前台抢占 **0**｜
包注册**已注销**（净增 0）。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。

## 7. COM 线当前全貌

```
Server activation            ✅ 与身份无关（未打包/打包均 S_OK）
目标 IID                     ✅ 已知
Proxy DLL 可装载              ✅（临时副本）
Proxy 导出/自注册             ❌ 仅 DllGetClassObject + DllCanUnloadNow，不自注册
经典注册表引用                ❌ 0 条
6/6 manifest GUID 穷举        ❌ 全部 E_NOINTERFACE
Package Identity             ❌ 不充分（本轮实测）
QI(IAMPLibrary/IAMPMusicLibrary) ❌ REGDB_E_IIDNOTREG（两种上下文一致）
业务方法 / vtable[3+]         🔒 0
```

→ 阻塞点已收敛为一条 OS 机制问题：**Packaged COM runtime 如何为 manifest 声明的 proxy/stub 建立 IID→PS CLSID 映射**，
以及为什么它对该客户端不可见。这是本项目 COM 线上目前唯一悬而未决的变量。
