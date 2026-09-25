# Phase 3.8.6 — StateRepository 最小提权取证（副本已取得并扫描）

**PHASE_3_8 = … + PACKAGEDCOM_EXTERNAL_MAPPING_ABSENT + STATE_REPOSITORY_INSPECTED_STRINGS_ONLY**
（把原来的 `STATE_REPOSITORY_UNINSPECTED` 升级，但**仍不足以判定 mapping 是否存在**——原因见第 3 节）

证据：`evidence/staterepository-attempt.txt`；副本目录 `%TEMP%\StateRepository-evidence\`。

---

## 1. 执行过程（严格按你批准的最小提权）

| 步骤 | 记录 |
|---|---|
| 提权方式 | 把复制逻辑写成临时脚本 `%TEMP%\sr-copy.ps1`，`Start-Process powershell -Verb RunAs -Wait` 执行**一次** |
| 结果 | **`ELEVATION=GRANTED`** |
| 复制内容 | `StateRepository-Machine.srd` **7,340,032 B**；`-wal` **6,464 B**；`-shm` **32,768 B** → `%TEMP%\StateRepository-evidence\` |
| 分析权限 | **提权进程已退出**，后续扫描在**普通权限**下对副本进行 |
| 禁忌项 | 未 `takeown`、未 `icacls`、未改 ACL、未写注册表、未安装 SQLite、未改任何系统状态 |

## 2. 字符串级扫描结果（副本，ASCII + UTF-16 双编码）

| token | ASCII 命中 | UTF-16 命中 | 说明 |
|---|---|---|---|
| **`proxyStub`**（小写 p） | **284** | 0 | **扩展类别串存在**（`windows.activatableClass.proxyStub` 被 StateRepository 记录） |
| `ProxyStub`（大写 P/S） | 0 | 0 | 大小写敏感差异，属正常 |
| `activationClass` | 0 | 0 | 未以该片段出现 |
| `F707A913` | **0** | **0** | — |
| `68E7097C` | **0** | **0** | — |
| `AMPLibraryAgent` | 7 | 1 | Apple Music 包相关行存在 |
| `AppleMusicWin` | 67 | 6 | 包行大量存在（context 片段可见 `AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa`、`ms-resource://AppleInc.AppleMusicWin/…`） |

## 3. **必须坚持的诚实边界（本轮最重要的判断）**

`F707A913…` / `68E7097C…` 的 ASCII/UTF-16 命中为 0，**不能推出"StateRepository 里没有这两个 GUID"**：

- SQLite 里**GUID 通常以 16 字节 BLOB 存储**，而不是字符串；因此**字符串扫描对 GUID 天然无效**；
- 反过来，`proxyStub` 出现 **284** 次，说明**该扩展的类别声明确实被 StateRepository 记录了**。

所以本轮的可靠结论只有两条：
1. **扩展类别声明在 StateRepository 中存在**（284 次 `proxyStub`）；
2. **IID/PS-CLSID 未以可字符串扫描的形式出现**——但这是编码问题，**不是缺失证据**。

## 4. 立即可做、且能决定性的下一步（成本极低）

对同一份副本做**原始字节**扫描（无需 SQLite）：

- 两个 GUID 的 16 字节形式，各扫 **little-endian 与 big-endian** 两种：
  - `F707A913-E0CE-4FD4-BCE3-425DD153285B` → LE `13 A9 07 F7 CE E0 D4 4F BC E3 42 5D D1 53 28 5B`
  - `68E7097C-F969-4006-AAC3-95115F0ED1C4` → LE `7C 09 E7 68 69 F9 06 40 AA C3 95 11 5F 0E D1 C4`
- 以及围绕每个 `proxyStub` 命中取 ±200 B 上下文窗口（SQLite 页内相邻数据常能看到同类表行）。

判定：
- **命中字节** → mapping 确实被 StateRepository 记录 → 可解释"为何不在 HKCR/PackagedCom"；
- **两种字节序都未命中** → 才可以说"该映射未以该形式存在于该 StateRepository 副本中"（仍不等于"根本不存在"，但证据强度大幅提升）。
- 若两者都为空，缺的最后一块就是 **SQL 级查询**（需要 sqlite 能力；本机无引擎，且你已明确**不引入新依赖**，因此暂不进行）。

## 5. 已封存的结论（不再烧 token 的方向）

- `F707A913-…` = **IAMPLibrary 的 IID** = **ProxyStub 扩展的 ClassId**，**不是**"Proxies.dll 的可激活 COM class"；
  因此 `DllGetClassObject(F707A913, IClassFactory) → E_NOINTERFACE` **不能证明代理 DLL 有问题**；
- `DllGetClassObject(68E7097C, …) → E_NOINTERFACE` 同理：只说明该 DLL 不按这些 GUID 提供可直接取得的 `IClassFactory`；
- 6/6 manifest GUID 穷举已完成，**"再猜一个 PS CLSID"正式封存**。

## 6. 若字节扫描也为空，COM 线的收口措辞（按你给的版本，已可预置）

> 在当前 Windows build、Apple Music package、该 packaged-COM manifest、该 proxy DLL 与当前测试 host 条件下，
> 服务器对象能够成功激活，但其目标接口无法获得可用的 RPC marshaling；
> 现有可读的经典 COM 注册、PackagedCom 状态、Package Identity **均无法解释或修复该 IID resolution failure**。
> 剩余的 proxy resolution 状态属于 Windows packaged-COM activation/runtime 内部机制，
> 当前实验未能建立可利用的客户端访问路径。

→ 该结论下 COM 线标记为 **`OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED → PRACTICALLY CLOSED`**，
不再对 `vtable[3+]` 做任何试探。

## 7. 纪律累计（本轮唯一例外已在协议内获批）

业务方法 **0**｜`vtable[3+]` **0**｜代理 DLL 加载 **0**｜PS 注册调用 **0**｜注册表写入 **0**｜
输入模拟 **0**｜前台切换 **0**｜包注册净变化 **0**｜ACL/owner 修改 **0**｜
**提权：1 次，且仅用于只读复制，随后立即以普通权限分析**。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
