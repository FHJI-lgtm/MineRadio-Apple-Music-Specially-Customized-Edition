# Phase 3.8.8 — 终局：修正版 GUID 字节扫描 + 284 邻域统计 → **分支 B，COM 线封档**

**PHASE_3_8 = … + STATE_REPOSITORY_INSPECTED_STRINGS_AND_BYTES + OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED → PRACTICALLY CLOSED**

证据：`evidence/staterepository-bytescan2.txt`（修正版，**本轮有效**；`bytescan.txt` 的 GUID 部分仍作废）。
本轮**未提权、未改副本、无 COM 调用、无注册表写入**。

---

## 1. 修正后的字节扫描（本次结果有效）

脚本修正：`PatB` 改用 `[Convert]::ToByte($_,16)`；ASCII 形式不再经过字节解析器。

| 文件 | `F707A913_LE` | `F707A913_BE` | `68E7097C_LE` | `68E7097C_BE` |
|---|---|---|---|---|
| `StateRepository-Machine.srd`（7,340,032 B） | **0** | **0** | **0** | **0** |
| `…-wal`（6,464 B） | 0 | 0 | 0 | 0 |
| `…-shm`（32,768 B） | 0 | 0 | 0 | 0 |

（ASCII 字符串形式此前已扫：`F707A913`=0、`68E7097C`=0、无连字符形式=0。）

## 2. 284 个 `proxyStub` 偏移的 ±512 B 邻域统计（全量，不是抽样）

```
proxyStub offset count      = 284
nearby AppleMusicWin        = 0
nearby AMPLibraryAgent      = 0
nearby Interface            = 21
nearby Path                 = 0
nearby F707A913_LE / _BE    = 0 / 0
nearby 68E7097C_LE / _BE    = 0 / 0
```

- **两条 GUID 的任何二进制表示都没有出现在任何 proxyStub 记录附近**；
- `AppleMusicWin` / `AMPLibraryAgent` 在 proxyStub 邻域内**也是 0** → 说明这些 `proxyStub` 记录**不与 Apple 包名行相邻**
  （更像"扩展类别串"按类别存储，而非按包存储）；
- 唯一弱结构线索：**`Interface` 出现在 21/284 个邻域中**——仍只是邻近性线索，**不构成关系证明**；
- 之前"offset 1405810 处 `AppleMusicWin`+`AMPLibraryAgent` 同窗"是**另一个 token 的邻域**，与本轮 proxyStub 邻域无关，二者不可混用。

## 3. 判定：分支 **B**

> **在当前 `.srd` / `.wal` / `.shm` 副本中，未发现这两个 GUID 的上述二进制表示（LE/BE 原始字节，以及 ASCII 有无连字符形式）。**

结合全部既有证据：

| 证据 | 状态 | 说明 |
|---|---|---|
| `proxyStub` = 284 | ✅ | StateRepository 确有 packaged-COM proxyStub 元数据 |
| `AppleMusicWin` = 67 / `AMPLibraryAgent` = 7 | ✅ | Apple Music 包/agent 相关记录存在 |
| `Interface` = 68（邻域 21）/ `Path` = 26 | ✅ | interface/path 类字段存在 |
| `ClassId` = 0 | ✅ | 不以 ASCII/UTF-16 键名形式出现 → 不是 manifest 的文本镜像 |
| GUID 字符串 / 原始字节（4 种表示） | **0** | 未在该副本中发现 |
| 直连 IID/CLSID 关联 | **未证明** | — |

**最终措辞（按你预置的版本）**：

> 在当前 Windows build、Apple Music package、该 packaged-COM manifest、该 proxy DLL 与当前测试 host 条件下，
> 服务器对象能够成功激活，但其目标接口无法获得可用的 RPC marshaling；
> 现有可读的经典 COM 注册、PackagedCom 状态、Package Identity **均无法解释或修复该 IID resolution failure**。
> 剩余的 proxy resolution 状态属于 Windows packaged-COM activation/runtime 内部机制，
> 当前实验未能建立可利用的客户端访问路径。

## 4. 保留的边界（不越界声称）

"副本中未发现该字节表示" **不等于** "StateRepository 中不存在该映射"，仍可能存在于：
其他编码 / 间接 ID + 外键关系 / WAL 历史页 / runtime 自行构造的映射。
但作为**可读面上的最后一层**，本阶段的取证已到边界。

## 5. COM 线封档状态

```
Server activation                 ✅ 与身份无关（未打包/打包均 S_OK）
目标 IID                          ✅ 已知（IAMPLibrary F707A913 / IAMPMusicLibrary 68E7097C）
Proxy DLL 存在且可装载             ✅
Proxy DLL COM factory（6/6 GUID）  ❌ 全 E_NOINTERFACE
代理自注册 / Ndr* 路线             ❌ 不导出
经典 COM 注册（Interface/CLSID）    ❌ 0 条
PackagedCom 外部映射               ❌ 结构里无 Class/Interface/Proxy，仅包标记 0x3e
Package Identity                   ❌ 不充分（实测）
StateRepository 文本层             ✅ proxyStub 元数据在（284）
StateRepository 二进制层           ❌ 未发现两个 GUID 的四种表示，且不在 proxyStub 邻域
QI(IAMPLibrary / IAMPMusicLibrary) ❌ REGDB_E_IIDNOTREG
业务方法                           🔒 0
vtable[3+]                         🔒 0
```

→ **`OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED` → `PRACTICALLY CLOSED`**。
不再对 `vtable[3+]` 做任何试探（无 marshaling / 无 typelib / 无接口定义，错误调用约定足以打崩
`AMPLibraryAgent.exe` 或测试进程）。

## 6. 纪律累计（整条 COM 线）

业务方法 **0**｜`vtable[3+]` **0**｜代理 DLL 注册 **0**｜PS 注册调用 **0**｜注册表写入 **0**｜
输入模拟 **0**｜前台切换 **0**｜应用安装 **0**｜包注册净变化 **0**（测试包已注销）｜ACL/owner 修改 **0**｜
提权 **1 次**（3.8.6，仅用于只读复制；之后各轮 0 次）。
观察项保留：`ELEVATED_PROCESSES_STILL_RUNNING=2`（未确认归属、未终止、不再扩大操作面）。
验收条件继续有效：`mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected`。
UIA 线维持归档：`UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。

**结论**：两条非输入注入的后台控制路线（UIA activation、Packaged COM via IAMPMusicLibrary）在当前环境下均未建立可用路径；
MineRadio 的播放能力继续以已验证的 Phase 2 冻结链路（URL → UIA → 双击 → SMTC 校验）为唯一可用实现。
