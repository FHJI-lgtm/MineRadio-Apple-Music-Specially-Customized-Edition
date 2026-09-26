# Apple Music 控制面架构（Resolve → Activation → SMTC 校验）

**目的**：把"Apple Music 数据/API 控制面 → 现有 Resolve → UIA fallback → SMTC 校验"这条链固定下来。
即使永远找不到 API 控制面，**Phase 2 冻结链路仍然完整可用**；一旦找到真正可用的控制 endpoint，
只需替换 **Activation 层**，Resolve 与 Verification 一行不改。

状态：本文档为**收敛性设计**，不引入新实验。所有"现状"栏均有实测出处（阶段/提交）。

---

## 1. 不变量（Invariants）

| # | 不变量 | 说明 |
|---|---|---|
| I1 | **成功 = SMTC 校验通过** | `PlaybackStatus=Playing` 且 标题匹配 且（提供艺人时）艺人匹配。**"深链已打开"永远不算成功** |
| I2 | **Resolve 层不因 Activation 而变** | 解析输出 `{songId, storefront, canonicalUrl, confidence, autoPlayable}` 是唯一契约；换后端不改解析 |
| I3 | **回退永远存在** | `A-uia`（Phase 2 冻结）是当前**唯一已验证**后端，任何新后端失败都必须回退到它，不得让产品失去播放能力 |
| I4 | **新后端的硬性审计** | `mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`、`SMTC changed = expected` |
| I5 | **不改冻结实现** | `poc/lib/am-play.ps1` / `am-uia.ps1` / `am-smtc.ps1` 只在"经批准的最小修改"下改动（已有先例：3.7A 的导航判据） |
| I6 | **不引入凭据** | 不使用 Apple ID / cookie / media-user-token / MusicKit token（用户明确约束） |
| I7 | **等待改动须可测** | 固定等待的墙上时长**不构成**"可优化 latency"的证据；任何 Activation 层等待/时序改动，一律按 **§7 的接缝约定与实验判据**评估（固定等待吸收原则 + 一次一个等待受控对比） |

---

## 2. 三层架构与接缝

```
调用方（MineRadio 主进程）
   │  请求：Title (+ Artist, Album)
   ▼
┌──────────────────────────────────────────────────────────────┐
│ L1  Resolve 层（已验证，冻结语义）                            │
│   phase3-resolve/lib/resolve35.ps1 + version36.ps1           │
│   输出 ResolvedSong:                                         │
│     songId · storefront · canonicalUrl · confidence          │
│     autoPlayable · version{canonical,classes} · runnerUp     │
└──────────────────────────────────────────────────────────────┘
   │  ResolvedSong（纯数据，无 UI 依赖）
   ▼
┌──────────────────────────────────────────────────────────────┐
│ L2  Activation 层（可插拔 —— 本文档定义的接缝）               │
│   backend.Play(ResolvedSong) -> AttemptResult               │
│                                                              │
│   ├── A-uia   ✅ 已实现且已验证（Phase 2 冻结）               │
│   │     URL 深链 → UIA 定位 → Realize/ScrollIntoView        │
│   │     → 左侧安全区双击 → SMTC 校验                          │
│   │     代价：移动光标 + 夺取前台（当前产品模式可接受，        │
│   │           但已确认**不是**无输入注入方案）                 │
│   │                                                          │
│   ├── A-api   ⏳ 目标（尚未找到任何可用 endpoint）             │
│   │     要求：I4 全部满足（不动鼠标/键盘/前台）                │
│   │                                                          │
│   └── 已排除： UIA 行级 activation（Invoke/Select/内部控件）、  │
│         Packaged COM `IAMPMusicLibrary`（见第 4 节）           │
└──────────────────────────────────────────────────────────────┘
   │  AttemptResult{ok, stage, detail, audits, timings}
   ▼
┌──────────────────────────────────────────────────────────────┐
│ L3  Verification 层（冻结，唯一裁决者）                        │
│   poc/lib/am-smtc.ps1：Get-AmSmtcState / Wait-AmPlayback     │
│   返回 MATCH / WRONG_TRACK / TIMEOUT，并附 sawPlaying 等原始证据│
│   指标裁决：poc/analyze-e2e.ps1（唯一真相源）                  │
└──────────────────────────────────────────────────────────────┘
```

**接缝契约（新后端只需实现这三件事）**

| 接口 | 形状 | 约束 |
|---|---|---|
| `Available()` | `bool` | 不产生副作用；用于选择策略 |
| `Play(ResolvedSong)` | `{ ok; stage; detail; audits; timings }` | `stage` 用既定错误码；**不得自行宣布成功**；必须返回审计三连 |
| `Audits` | `{ mouseMoved; keyboardInjected; foregroundChangedByApplication; cursorBefore/After; foregroundBefore/After }` | 形状复用 `phase3.7B-uia-no-mouse/lib/instrumentation.ps1` 的 `New-AmNmAudit / Compare-AmNmAudit` |

**选择策略（优先级）**：`A-api`（Available 且通过 I4）**>** `A-uia`（永远可用）**>** 失败即返回结构化错误，**不得**静默改用"没有校验的播放"。

---

## 3. 各层现状（实测，含出处）

| 层 | 指标 | 数值 | 出处 |
|---|---|---|---|
| L1 Resolve | 22 首 E2E 解析成功率 | **16/22 = 73%** | Phase 3.6（`e2e-22-20260925-195212-metrics.*`） |
| L1 Resolve | autoPlayable / wrong-artist / wrong-version | 16 / **0** / **0** | 同上 |
| L1 Resolve | 20 例单元回归 | PASS 14 / AMBIGUOUS 6 / **FAIL 0** / wrong-artist **0** | `resolve-test-20260925-195421.*` |
| L2 A-uia | Phase 2 冻结回归（已知 URL） | **15/15**，8 个失败码全 0 | `regression-20260925-201138.*` |
| L2 A-uia | 22 首 E2E 播放（原始 / 审计） | 12/16（75%）/ **15/16（94%）** | `e2e-22-…-metrics.json` |
| L2 A-uia | 导航判据 | 3.7A 已改为**内容判据**（title+artist）或签名变化；E10 不再误报 | 提交 `b9e4983` |
| L2 其他后端 | UIA 行级 activation | **UNAVAILABLE**（Invoke/Select/内部控件全部无效果；ItemContainer 支持但按名取不到项；Expand/Toggle 行不支持；Legacy 本机不可解析） | 3.7B / 3.7B.2 / 3.7B.3 |
| L2 其他后端 | Packaged COM `IAMPMusicLibrary` | **PRACTICALLY CLOSED**（Server 可激活；6/6 GUID `E_NOINTERFACE`；经典注册表 0 条；PackagedCom 仅包标记；Package Identity 不充分；StateRepository 四种 GUID 字节全 0） | `REPORT-3.8.8-FINAL.md` |
| L3 校验 | SMTC 段延迟 | p50 **144 ms** | 22 首 E2E |
| L3 校验 | 验证器盲区（已量化、已在审计层区分） | 目录别名署名（`Abel Tesfaye` vs `The Weeknd`）、语境标注标题（电影主题曲）→ 记为 explained false negative，**原样保留 raw 计数** | `poc/analyze-e2e.ps1` |

---

## 4. "API / 数据控制面"到底还剩什么可查

按**成本从低到高**，且每条都标注"它能做什么 / 不能做什么"：

| 候选 | 状态 | 能否构成播放入口 |
|---|---|---|
| **iTunes Search / Lookup API**（公开、无凭据） | ✅ 已在用（L1 Resolve 的基础） | ❌ **只是数据面**：能拿 id/元数据，不能触发播放 |
| Apple Music Web 读取接口（页面/JSON） | 未系统调查 | ❌ 读数据；播放仍需客户端 |
| **`AMPLibraryAgent` 本地 UDP `127.0.0.1:56215/56216`** | ⏳ 已观测到端点；**未发包** | ❓ 唯一尚未排除的"本地控制面"候选。静态线索：`AMPLDMediaSharingClientConnection` / `AMPLDMediaSharingPrefs` / `AMPLDMediaSharingNotifyClientCountChanged` → **更像媒体共享**，非播放控制 |
| 协议处理器（`music:` / `musics:`） | 仅 `/url <URL>`（Phase 1 已穷举 23 个 handler） | ❌ 无 track-selection 参数 |
| SMTC 会话控制 | Phase 1：**无 track 选择、无 MediaId** | ❌ 只能控制播放/暂停，不能选曲 |
| MusicKit / Apple API token | **用户明确排除**（不碰凭据） | — |

**现实的工程判断（写清楚以免反复投入）**：在"不使用凭据"的约束下，**第三方不存在公开的选曲/播放控制 endpoint**。
因此 v1 的结论应为：**Activation 层的实现 = A-uia**；`A-api` 保留为**接缝**，一旦 Apple 提供
受支持的接口（或本地控制面被证实）即可插入，而无需改动 L1/L3。

---

## 5. 任何新后端上线前必须跑的门（回归矩阵）

| 顺序 | 门 | 通过标准 |
|---|---|---|
| 1 | Phase 2 冻结回归（已知 URL × 15） | **15/15**，`SMTC_WRONG_TRACK/TIMEOUT/TARGET_ROW_NOT_FOUND/CLICK_FAILED` 全 0 |
| 2 | Resolve 单元回归（20 例） | **FAIL=0**、wrong-artist **0** |
| 3 | 小规模 E2E（10 首） | 无**新的**错误接受；审计三连成立 |
| 4 | 全量 E2E（22 首） | 指标以 `poc/analyze-e2e.ps1` 为**唯一真相源**；`hardFailure=false` |
| 5 | 新后端专属 | `mouseMoved=false` ∧ `keyboardInjected=false` ∧ `foregroundChangedByApplication=false` ∧ `SMTC expected` |

**注意**：`A-uia` **不满足**第 5 条（它按设计移动光标并夺取前台）。
因此它必须在配置里被**显式标注为"输入注入模式"**，而不是伪装成后台方案——这也是 3.7B 的结论带来的直接后果。

---

## 6. 下一步优先级（明确、有限）

1. **文档化 A-uia 为 v1 生产路径**（本文档即该项），并把"输入注入"标注进产品配置与 UI 提示；
2. 仅保留一项低成本只读调查：**UDP 56215/56216 的被动关联**（不发包，只做字符串/端口归属关联）；
3. 若第 2 项无结论，则 **v1 定版**：Resolve（已验证）+ A-uia（已验证）+ SMTC 校验；停止 activation 发现类投入；
4. 只有当出现**受支持的官方接口**或本地控制面被实证时，才启动 `A-api` 实现，并跑第 5 节的 5 道门。

---

## 7. 接缝约定与实验判据（Activation 层的等待 / 时序改动）

本节**不针对 Apple Music**，而是任何 Activation 后端、任何"固定等待"改动的通用判据；
MineRadio 其他激活层、Wallpaper Engine 侧遇到同类 `Sleep(500)` 均可直接复用。
出处：Phase 3.7E ⑤（500 ms → 0 的受控实验，结论为**无可稳定归因收益**，代码已回退）。

### 7.1 固定等待吸收原则（Wait Absorption Principle）

> **Fixed-wait latency is not equivalent to observable latency.**
> Before removing or shortening a fixed wait, identify the state transition it is intended to cover and
> determine whether a subsequent condition-poll absorbs part or all of that wall time. A wait may be
> redundant, partially absorbed, or synchronization-critical; its duration alone is not evidence of
> removable latency.

**中文定义**：后续条件轮询、UI 状态转换、导航、渲染或 SMTC 收敛，可能吸收固定等待的**部分或全部**墙上时间；
因此固定等待的时长**不能**直接作为"可优化 latency"的上限，也**不能**直接当作收益估计。

判断某个固定等待属于哪一类（冗余 / 部分被吸收 / 同步关键），按顺序回答五问：

1. **它在等什么状态？**（说不出状态，就不能改）
2. **那个状态什么时候真正发生？**（事件、轮询周期、realize/渲染完成）
3. **后面是否紧跟一个 condition-poll？** 若有，它多半已被**部分或完全吸收**
4. **删掉后真正改变的是哪个 stage？** 必须是可命名的 stage，而不是"感觉快了"
5. **这个改变能否在同一 benchmark、同一观测协议下被测出来？** 低于观测分辨率的差值不算证据

**禁止**按毫秒数从大到小排队删除：`450 > 350 > 200 > 130 > 120` 说明的是"显眼"，不是"可删"。
从**理论依据最清楚**的那一个开始，而不是从数字最大的那一个开始。

### 7.2 一次一个等待，一个假设，一次受控对比（One wait, one hypothesis, one controlled comparison）

> **One wait, one hypothesis, one controlled comparison.**
> Any activation-layer wait change must be evaluated against the same fixture, ordering, retry policy,
> correctness criteria, and external-observation protocol. Do not infer latency savings from the deleted
> milliseconds; measure the end-to-end observable effect.

协议（即 Phase 3.7E 已执行并冻结的形态）：

- 同一批歌曲夹具、**同序**、每首一次机会、`Retries 0`；resolver 在测量窗口之外
- **一次只改一个** sleep；其余实现一字不动
- 对比：correctness / 失败集合 / SMTC 结果 / occupancy（`T10 − T3`）/ 全部 `t.*` 字段
- **声明观测分辨率**（本机实测：请求 50 ms 轮询 → median 80 ms / mean 82 ms / max 121 ms；255 样本空跑基线）
  - 低于该分辨率的差值**不得**作为收益
  - 单次最小值只是下界；`T7` 不可观测，**禁止编造**
- 未证明收益的行为变化：**回退**，证据留档（mainline 只保留已证明的行为）

### 7.3 实证案例：Phase 3.7E ⑤（`am-uia.ps1:245` 500 ms → 0）

| 观测量 | 结果 |
|---|---|
| correctness | 17/20 → 17/20；失败集合**完全相同**（B02/B04 `SMTC_TIMEOUT`、B13 `TARGET_ROW_NOT_FOUND`） |
| occupancy 配对差值（⑤ − ④） | n=20，**p50 −153 ms**，min −885 ms，max **+1473 ms**，11 例快 / 9 例慢 |
| 成功子集 occupancy | n=17，p50 3459 → 3438 ms |
| 控制量 `t3_ms` | p50 699 → 699（改动全在其下游） |
| `contentMatchMs` | 均值 1789 → 1789（未出现固定 500 ms 位移） |

结论：**删除 500 ms 固定等待没有改变正确性，但在 20 首、每首一次的实验条件下，没有观察到可稳定归因于
该删除的 latency 收益** —— 该 500 ms 大部分被相邻等待吸收。

处置：`poc/lib` 已回退（提交 `19e881d`），与 ④ 基线 `0170bca` 逐文件一致；
证据留档于 `4317e3b`（实验改动）+ `phase3.7E-benchmark/reports/bench-20260926-090905.jsonl`（原始数据）
+ `phase3.7E-benchmark/REPORT-3.7E-STEP5-FINAL.md`（结论）。
点击路径剩余 1250 ms 固定 sleep（120+450+350+200+130）**不排期**；若恢复审计，先答 §7.1 第 1 问。

---

## 8. 文件与提交索引

| 层 | 关键文件 | 关键提交 |
|---|---|---|
| L1 Resolve | `phase3-resolve/lib/resolve35.ps1`、`version36.ps1`、`phase3-resolve/PHASE36-*.md` | `5d864a6`、`4c251ee` |
| L2 A-uia | `poc/lib/am-play.ps1`（含 3.7A 内容判据）、`am-uia.ps1` | `b9e4983` |
| L2 审计 | `phase3.7B-uia-no-mouse/lib/instrumentation.ps1`（`New-AmNmAudit/Compare-AmNmAudit`） | `03d165d`、`f2a2c29` |
| L2 已排除路线 | `phase3.7B-uia-no-mouse/REPORT-3.7B*.md`、`phase3.8-non-uia-surface/REPORT-3.8*.md` | `010be75`、`a0c001a` |
| L3 校验/指标 | `poc/lib/am-smtc.ps1`、`poc/analyze-e2e.ps1` | `b9e4983`、`4c251ee` |
| 等待/时序判据（§7） | `phase3.7E-benchmark/REPORT-3.7E-STEP5-FINAL.md`、`.../reports/bench-20260926-090320.jsonl`、`.../bench-20260926-090905.jsonl` | `4317e3b`、`e4a0082`、`19e881d`、`1d5d575` |
