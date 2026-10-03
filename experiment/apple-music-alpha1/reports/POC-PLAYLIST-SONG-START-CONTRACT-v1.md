# MineRadio Apple Music「指定歌曲播放」v1 功能契约与验收决策清单（草案 v0.5）

> 状态：**设计草案（DRAFT v0.5）**，仅依据现有 POC 证据与只读代码整理；**未实现、未接入生产主线、未执行任何新操作**。
> 证据台账：`POC-PLAYLIST-SONG-START.md`（§0.x + §0.20）。本文件不修改、不覆盖台账。
> 凡标「拟议」= 尚未实现；NOT_DEFINED／待决策 = 证据不足，未用推测补齐。

### 修订记录

| 版本 | 变更 |
|---|---|
| v0.1 | 初稿（A 契约 / B 决策收敛 / C 补证计划 / D 验收矩阵） |
| v0.2 | 4 项 P0 + 4 项 P1：P1 拆层；FAIL/UNCERTAIN 语义统一；范围外状态与实验态分离；T-C 拆 C1/C2；已在播放定为严格操作型；一次请求仅一次点击；上下文未验证与异常分离；实验几何标注非契约；新增身份判据强度条款 |
| **v0.5** | 评审必修（状态机闭合）：① `ALREADY_PLAYING_NOOP` 不再在请求开始判定，改为**必须在 P1b 歌单身份确认之后**、且当前 SMTC 满足 v1 字符串级目标身份时成立（避免「同名曲恰好在播」绕过歌单身份）；② 状态机补上 `P1a exactMatches = 0 → FAIL_NAVIGATION_FAILED`（0 / >1 / =1 三分支明确） |
| v0.4 | 评审必修两项：① **P4 成功条件明确加入 `status == Playing`**（Paused/Stopped/状态未知一律不得进入 SUCCESS）；② **`ALREADY_PLAYING_NOOP` 明确限定在 v1 字符串级身份语义**，不代表 Track ID 级确认（与 A9 闭合）。另新增 **C.2 T-E 执行纪律**：只接受「不播放/不点击」即可建立关联的可追溯证据，宁可 T-E FAIL 也不接受推断 |
| v0.3 | ① `ALREADY_PLAYING_NOOP` 升为**独立第四类终态 NO_OP**（不属于 SUCCESS/FAIL/UNCERTAIN，禁止塞进 UNCERTAIN），并补入**状态机图**；② 明确 `P1a CARD_SELECTED` 仅表示操作行为已唯一确定、**不构成歌单身份**，身份只由 P1b 负责；③ 强化 **T-E 通过标准**（须能稳定区分两个同名 `p.*` 歌单，且与目标 Library playlist 有可追溯关系；看起来像身份的信号不算）；④ 新增 **C.0 分层**：T-C2 = 现有行为证据，B1/B3/B4 = 产品决定的首版行为边界，二者不得合并；⑤ A9 明确 Track ID 级映射是**未来能力、不是 v1 隐含前置条件** |

---

## 当前状态说明（终局封口；本轮仅记录，不改写契约正文）

```text
P1b 当前状态：无法补证。

由于 T-E、T-E2、T-E3 均未获得满足严格标准的
p.* ↔ UIA PID 可复核身份映射，后续不再继续身份信号探索。

因此，当前版本不得宣称：
「从指定 p.* 歌单中的指定歌曲开始播放」这一身份契约已经成立。

是否将 v1 契约永久收窄为「在用户可见的歌单页内从指定歌曲起播」，
属于独立的产品语义决策，本轮不直接修改契约正文。
```

依据：`POC-PLAYLIST-SONG-START.md` §0.21（T-E FAIL）、§0.22（T-E2 FAIL）、§0.23（T-E3 FAIL）——历史失败证据均原样保留。

## A. v1 功能契约

### A1. 功能目标与适用范围

- 目标：在 Apple Music（Windows）中，从**用户资料库歌单**里**指定的某一首歌曲**开始播放。
- 范围（首版）：用户资料库歌单；目标歌曲必须处于**当前已实现化、可操作的 UIA 列表范围内**。
- 不在范围：目录歌单、深层需滚动目标、随机/末尾/跨歌单语义、输入注入（PageDown/滚轮）、批量与队列编辑。

### A2. 承诺项（逐层验收；P1a 不等于歌单身份）

| # | 承诺 | 判定层级 | 证据要求 | 现状 |
|---|---|---|---|---|
| P1a | **操作行为已唯一确定**：选中了唯一一张卡片 | `CARD_SELECTED` | 选卡候选唯一、无歧义（现有 `exactMatches = 1`） | 已有证据（§0.13/§0.15/§0.16） |
| P1b | **确认当前页面就是目标歌单**（身份） | `PLAYLIST_PAGE_CONFIRMED` | 需要能**稳定区分同名歌单**、且与目标 Library playlist 有**可追溯关系**的信号 | **无法补证**：T-E/T-E2/T-E3 均未取得满足严格标准的可复核映射证据；身份信号路线已终局封口 |
| P2 | 目标歌曲行在已实现化范围内**唯一匹配** | `TARGET_ROW_UNIQUE` | `ListItem` 祖先 + 标题与艺人子串，匹配数 = 1 | 已有证据 |
| P3 | 执行**一次**经安全校验的行操作 | `TARGET_CLICK_ATTEMPTED` | 调用次数 = 1；不可独立观测时必须标 **INFERRED** | 已有证据 |
| P4 | 通过 SMTC 确认**正在播放**的就是目标歌曲 | `TARGET_PLAYING_CONFIRMED` | **`status == Playing`** **且** `Normalize(title)` 相等 **且** `Normalize(artist)` 包含目标艺人 | 已有证据（POC 实测均为 `Playing` + 标题/艺人一致） |

> **P1a 的唯一只说明操作层面唯一地选择了一张卡片，不说明这张卡就是目标 `p.*` 歌单。**
> 实验已证明页面内可同时出现多个同名歌单文本（实测 2/3/4 次）；身份确认**只由 P1b 负责**；T-E/T-E2/T-E3 均未取得满足严格标准的可复核映射证据 ⇒ P1b 记为 **无法补证**（身份信号路线已终局封口）。

### A3. 非承诺项

- `QUEUE_CONTEXT_CONFIRMED`（继续按该歌单顺序播放）——**独立验收，不得由 P4 推导**；
- 随机播放、歌单末尾、跨歌单边界；
- 深层目标（需滚动）：三种语义滚动 API 在本环境不可用（§0.17/§0.18/§0.19）；
- 仅标题匹配即可确认；
- 任何输入注入；
- **Apple Music 曲目唯一身份（Track ID）级确认**（见 A9：未来能力，非 v1 前置）。

### A4. 结果分类：三类判定 + 一类并列终态

| 类别 | 定义 | 状态名（v1 契约名） |
|---|---|---|
| **SUCCESS** | 已有充分证据证明承诺项全部满足（**含 P4 的 `status == Playing`**） | `SUCCESS_TARGET_PLAYING` |
| **FAIL** | **已有充分证据证明承诺条件未满足**（可归因） | `FAIL_NAVIGATION_FAILED`、`FAIL_CARD_AMBIGUOUS`、`FAIL_ROW_MULTIPLE_MATCH`、`FAIL_TARGET_MISMATCH` |
| **UNCERTAIN** | 无法证明成功，也无法归因为明确失败 ⇒ **安全退出**（绝不升级为 SUCCESS） | `UNCERTAIN_PLAYLIST_PAGE_UNCONFIRMED`、`UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE`、`UNCERTAIN_ROW_ELEMENT_INVALID`、`UNCERTAIN_AIM_INVALID`、`UNCERTAIN_SMTC_UNRESOLVED`、`UNCERTAIN_IDENTITY_INSUFFICIENT` |
| **NO_OP（并列终态，独立第四类）** | **P1b 已确认目标歌单之后**，SMTC 在 v1 字符串级身份下已满足目标；本次请求**不执行任何操作**，**不计 SUCCESS，也不计 FAIL/UNCERTAIN** | `ALREADY_PLAYING_NOOP` |

**禁止**：为了容纳状态而把 `ALREADY_PLAYING_NOOP` 硬塞进 `UNCERTAIN`（其状态是完全确定的）。三类判定与 NO_OP 互斥。

#### A4.1 状态机

```text
请求开始
  |
  +-- P1a CARD_SELECTED ------+-- =0 --> FAIL_NAVIGATION_FAILED            (找不到目标歌单卡片)
  |                           |-- >1 --> FAIL_CARD_AMBIGUOUS              (候选歧义)
  |                           |
  |                           +-- =1 --> P1b PLAYLIST_PAGE_CONFIRMED
  |                                       |-- 无法确认 --> UNCERTAIN_PLAYLIST_PAGE_UNCONFIRMED   (P1b 无法补证)
  |                                       |
  |                                       +-- 读取当前 SMTC 身份
  |                                             |-- 已满足 v1 字符串级目标身份
  |                                             |      --> ALREADY_PLAYING_NOOP   (NO_OP 并列终态，不操作)
  |                                             |
  |                                             +-- 非目标 --> P2 TARGET_ROW_UNIQUE
  |                                                             |-- =0 --> UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE
  |                                                             |-- >1 --> FAIL_ROW_MULTIPLE_MATCH
  |                                                             |
  |                                                             +-- P3 TARGET_CLICK_ATTEMPTED (一次请求仅一次)
  |                                                                   |-- aim 非法 --> UNCERTAIN_AIM_INVALID
  |                                                                   |-- 元素失效 --> UNCERTAIN_ROW_ELEMENT_INVALID
  |                                                                   |
  |                                                                   +-- P4 TARGET_PLAYING_CONFIRMED  (status=Playing + 标题相等 + 艺人包含)
  |                                                                         |-- 窗口完整且明确他曲 --> FAIL_TARGET_MISMATCH
  |                                                                         |-- 信息不足/不稳 ------> UNCERTAIN_SMTC_UNRESOLVED
  |                                                                         |-- 缺艺人/字段不足 ----> UNCERTAIN_IDENTITY_INSUFFICIENT
  |                                                                         |
  |                                                                         +--> SUCCESS_TARGET_PLAYING
  |
  +-- (上下文为独立承诺，见 A3；不进入本状态机)
```

### A5. 用户可见状态与提示（拟议）

| 情形 | 拟议文案 | 说明 |
|---|---|---|
| SUCCESS | `Apple Music 已开始播放：<曲目>` | 不附加任何可能引起误解的后缀 |
| **NO_OP** | `Apple Music 已在播放：<曲目>`（拟议） | 独立语义：条件已满足、本次未操作 |
| **上下文未验证** | **不显示任何提示**（首版本就不承诺验证上下文） | 与上下文异常严格分离 |
| **上下文异常**（未来主动验证后发现不一致） | `已开始播放，但后续曲目与歌单顺序不一致`（拟议，未来独立验收后启用） | 独立语义、独立文案 |
| 页面身份未确认 | `无法确认已进入目标歌单，已安全停止`（拟议） | 对应 `UNCERTAIN_PLAYLIST_PAGE_UNCONFIRMED` |
| 目标行不可达（范围外） | `这首歌不在 Apple Music 当前可操作范围内，已安全停止（不会盲点或反复重试）` | 对应 `UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE` |
| 匹配歧义 | `资料库里有多个同名条目，无法确定播哪一个` | 沿用现有语系 |
| 范围/登录 | `未能切入 Apple Music「你的资料库」范围，已中止播放` | 沿用现有语系 |
| 身份字段不足 | `Apple Music 未提供足够的曲目身份信息，已安全停止` | 对应 `UNCERTAIN_IDENTITY_INSUFFICIENT` |
| 起播未确认 | `已执行播放操作，但 Apple Music 未确认切歌（可能仍停在别的曲目）` | 沿用现有语系 |

### A6. 请求开始时目标已在播放：产品语义（严格操作型）与 NO_OP 终态

**契约选择：严格操作型。** 一次请求必须在本次请求内真实发生「非目标 → 目标」的切换，才可判 SUCCESS。

**NO_OP 的触发前提（v0.5 收紧）**：`ALREADY_PLAYING_NOOP` **只能在完成 P1a 且 P1b 歌单身份确认之后**判定；
即：必须已确认当前页面是目标歌单，且此刻 SMTC 满足 v1 字符串级目标身份时，才返回 NO_OP（不执行任何行操作）。

理由：v1 身份判据本身是字符串级的（A9），**在未确认 P1b 之前**，无法区分「当前播放的同名同艺人曲目」是否来自目标歌单；
若在请求开始就判 NO_OP，会把「正在播放相同字符串的歌」等价成「目标歌单中的目标歌曲已在播放」，与 A9 冲突。

- 因此 P1b **失败不会**因为 SMTC 恰好同名而提前返回 NO_OP（那种情况应返回 `UNCERTAIN_PLAYLIST_PAGE_UNCONFIRMED`）；
- 这是**产品规则**，不是 SMTC 技术限制；操作前目标未在播放是**产品前置条件**的特例（见下）；
- 备选（结果型：直接返回 SUCCESS 并跳过操作）本版**未采纳**；若未来采用需单独批准并重新验收；
- 现有 POC 记录中的 `INCONCLUSIVE_NOT_STARTED_FROM_TARGET` 在新语义下归为 `ALREADY_PLAYING_NOOP`（前提是 P1b 已成立）。

> **身份强度限定（与 A9 闭合）**：`ALREADY_PLAYING_NOOP` 的「目标已在播放」采用的是 **v1 字符串级身份判据**（标题归一化相等 + 艺人包含），它**不构成 Track ID 级唯一身份确认**；
> 即：SMTC 当前曲目与请求目标在字符串级匹配即可判 NO_OP，但不得据此推断「Library 中那一条精确歌曲已在播放」。
### A7. SMTC 身份校验要求

1. 操作前记录 `status`/`title`，并落实 A6 的产品前置条件；
2. 操作后记录 `title`/`artist`/`status`/时间戳；
3. **匹配规则（三者同时成立）**：**`status == Playing`** **且** `Normalize(title)` 相等 **且** `Normalize(artist)` 包含目标艺人；
3b. 若标题/艺人匹配但 **`status` 非 `Playing`**（`Paused`/`Stopped`/状态未知）⇒ **不得判 SUCCESS**；默认归 `UNCERTAIN_SMTC_UNRESOLVED`（无法证明正在播放），其边界由 **T-D** 界定；
4. 缺艺人、字段不足或歧义 ⇒ `UNCERTAIN_IDENTITY_INSUFFICIENT`，安全退出；
5. 观察窗口**完整结束**且 SMTC 明确为另一首歌 ⇒ `FAIL_TARGET_MISMATCH`；窗口内信息不足/不稳定 ⇒ `UNCERTAIN_SMTC_UNRESOLVED`；
6. 禁止：仅凭导航成功、UIA 调用返回成功或仍处于 `Playing` 宣告起播成功。

### A8. UIA 目标行可达性与点击安全条件

| 条件 | 契约要求 | 证据 |
|---|---|---|
| 歌单页面身份 | 见 P1b：须有**可追溯**的身份信号 | 无法补证（T-E/T-E2/T-E3 均 FAIL） |
| 目标唯一 | 匹配数 = 1（ListItem 祖先 + 标题与艺人子串） | §0.13/§0.15/§0.16 |
| 容器正确 | 目标行必须位于**歌单列表容器**（`ControlType.List`）内，不得是导航项 | §0.18 |
| 落点合法 | 优先标题文本中心；否则 `row.Left + 0.45×width`；点须在行内且距行边缘 **≥40px**、且在窗口内 | §0.13/§0.15/§0.16 |
| 执行前复验 | 元素有效、矩形有效、仍唯一 | 各记录 `rowStillValid` |
| **点击次数** | **一次用户请求生命周期内最多执行一次目标行播放操作**（不可叠加；失败后不得在同一请求内再次点击） | §0.13 起 |
| 点击证据 | 不可独立观测 ⇒ **必须标 INFERRED** | 各记录 `click.evidence` |

> **非契约值**：容器实测几何 `509,198 2050x1316`、行 `519,1062 2022x98` 等**仅为当前测试环境的历史样本**，不属于固定契约值；实现须按运行时测量与上述条件校验。

### A9. 身份判据强度（必须钉死）

**v1 的身份判据是字符串级**（标题归一化相等 + 艺人子串包含），**不构成 Apple Music 曲目唯一身份的证明**，不等价于 `Library Song ID` / `Catalog Song ID` 级确认。

**Track ID 级映射属于未来能力，不是 v1 的隐含前置条件**：
- v1 实现**不要求**建立 `p.*` 歌单 → UIA 行的真实 Track ID 映射；
- 该能力若要做，必须**单独立项**、单独验收（建立 Library Song ID ↔ UIA 行的可验证映射证据）；
- 实验已记录的同名风险：同名专辑歧义（§0.13）、同名歌单（P1b）、简介文本误命中（§0.12）。

### A10. 隔离要求

- 不得修改：`poc/lib/**`、`poc/play-song.ps1`、`desktop/apple-music-control.js`、`server.js`、`public/js/**`；
- POC 脚本与新记录只放 `experiment/apple-music-alpha1/**`；报告只追加、标题唯一；**不覆盖失败记录**；
- 完整性检查失败必须如实上报；进入生产集成需 **契约冻结 + 证据齐备** 后单独批准。

---

## B. 决策项收敛表（v0.5）

| # | 决策项 | 分类 | 现值与证据 | 结论 / 尚需回答 |
|---|---|---|---|---|
| B1 | **首版允许的总超时预算** | **仍需产品决策**（由 T-C2 提供行为证据，非自动确定） | 无（§20.2 NOT_DEFINED） | 首版是否接受各阶段各自超时、无整流程硬超时？见 C.0 分层 |
| B2 | 各阶段超时 | **可从现有代码/记录核实** | 6000 / 800 / 3000 / 2500+120 / 4000 ms、链默认 `-TimeoutMs 6000 -Retries 2 -SearchWaitMs 6000`、next 7000、滚动 900/≤12 | 首版沿用；是否提为配置常量由实现期决定 |
| B3 | **首版允许的重试边界** | **部分已定 + 仍需产品决策** | 目标行操作：**一次请求仅一次、不重试（已定）**；其余阶段无既定策略 | 搜索/UIA/SMTC 阶段是否重试、几次、总预算 ⇒ T-C2 取证后由产品冻结 |
| B4 | SMTC 观察窗口 | **需要专项测试（T-D）** | 现用 4 s，无论证 | 4 s 是否充分；`FAIL_TARGET_MISMATCH` 与 `UNCERTAIN_SMTC_UNRESOLVED` 的边界如何取 |
| B5 | 仅标题身份判级 | **已由产品边界确定** | §20.4 NOT_DEFINED | 首版 `UNCERTAIN_IDENTITY_INSUFFICIENT`，不确认 |
| B6 | 深层目标处理 | **已由产品边界确定（有实验依据）** | §0.17/§0.18/§0.19 | 首版不滚动；范围外 ⇒ `UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE` |
| B7 | 随机/末尾/跨歌单 | **非承诺** + 未来专项 | 未验证 | 首版不承诺 |
| B8 | 输入注入权限 | **仍需产品决策** | 未实验 | 首版禁止 |
| B9 | 失败提示文案 | **可从现有代码核实 + 部分拟议** | A5 | 拟议文案实现期定稿 |
| B10 | **歌单页身份强化信号（P1a 不承担身份）** | **已终局封口：无法补证** | T-E/T-E2/T-E3 均 FAIL（含 UIA 字段、本地数据/日志、ETL 与 SQLite 边车） | 不再继续身份信号探索；后续只能做产品语义决策 |
| B11 | 已在播放时的产品语义 | **已由产品边界确定** | A6 | 严格操作型 + **独立 NO_OP 终态** `ALREADY_PLAYING_NOOP`，且**触发前提 = P1b 已确认歌单身份** |
| B12 | 身份判据强度 | **已由契约确定** | A9 | 字符串级；Track ID 级 = **未来能力（非 v1 前置）** |

---

## C. 最小补证计划（需批准后才执行，且不得默认合跑）

### C.0 分层：测试证明什么 vs 产品决定什么（不得合并）

```text
T-C2 / T-D = 提供现有行为证据（阶段超时、是否重试、观察窗口表现）
        |
        v
B1 / B3 / B4 = 由产品决定首版允许的行为边界（例如总超时预算是不是 4 秒，不是测量自动决定的）
        |
        v
v1 contract = 把最终策略写入契约（冻结）
```

特别说明：**总超时预算是产品决策**。即使 T-C2 发现某路径 99% 在 4 s 内完成，也**不自动**等于首版总预算 = 4 s。

### C.1 测试清单

| 编号 | 目的 | 前置条件 | 通过标准 | 禁止副作用 |
|---|---|---|---|---|
| **T-E**（最高优先，唯一 P0 缺口） | 找到 **歌单页身份强化信号** | 存在两个同名歌单（本机实测有 `My Playlist` / `My Playlist2` 等） | 找到一个信号，能**稳定区分两个同名 `p.*` 歌单**，且与**目标 Library playlist 有可追溯关系**；并给出通过/失败判据。歌单名 + URL 路径看起来一样**不算通过**。执行纪律见 **C.2** | 只读观察；不播放、不点击、不改生产代码 |
| **T-D** | SMTC 判定边界 | 四态：旧曲在播 / 目标已切换 / 字段不足 / 观察窗口超时 | 四态可区分且无歧义；据此**供产品**确定观察窗口与 `FAIL`/`UNCERTAIN` 边界 | 不放宽匹配规则、不产生额外点击 |
| **T-A** | 身份字段不足时安全退出 | 构造/选取 SMTC 有标题无艺人的场景 | 返回 `UNCERTAIN_IDENTITY_INSUFFICIENT`；不发生错误切换 | 不点击目标行、不改生产代码 |
| **T-B** | 范围外目标安全退出（首版不滚动） | 目标行不在已实现化范围（如 #171 类） | 返回 `UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE`；**不调用任何滚动 API** | 不点击、不盲点、不重试 |
| **T-C1** | 正常路径重复性 | 同一目标、同一路径重复 5 次 | 每次结果一致、耗时无异常漂移 | 不改脚本默认值 |
| **T-C2** | 受控失败下的超时/重试**行为取证** | 分别构造：搜索超时、UIA 元素超时、SMTC 确认超时 | 记录：阶段超时 → 是否重试 → 重试次数 → 最终状态 → 总耗时；不无限重试 | 不引入输入注入、不额外点击目标行 |

> **约束**：T-E 是当前唯一 P0 缺口（若 P1b 无可靠身份信号，P2→P4 即使技术可行，也无法构成指定某个 `p.*` 歌单中的歌曲的完整契约）。
> 六项测试**不得默认一起跑**，须逐项批准、逐项记录、新增独立原始记录，不覆盖历史。

### C.2 T-E 执行纪律（只读关联，不得猜 ID）

T-E 必须在**不执行播放、不执行点击**的前提下建立关联。被接受的证据形态（示例）：

```text
Library API 的 p.* 歌单
        |
        v
某个 UIA 属性 / automation property / 可读元数据（运行时实测）
        |
        v
可稳定指向同一个 playlist（且能区分同名者）
```

**不被接受的证据形态**：名称一致 + URL 看起来一样 + 当前页面位置相似 + 「应该就是它」——即任何需要推断的关联。

**宁可 `T-E FAIL`，也不接受推断**：T-E/T-E2/T-E3 的结果即为 **T-E FAIL / T-E2 FAIL / T-E3 FAIL** ⇒ P1b **无法补证**；v1 契约**不得**宣称「从指定 `p.*` 歌单中的指定歌曲开始播放」成立；身份信号路线**终局封口**，不再推进 P2→P4。

---

## D. 验收矩阵（v0.5）

| 契约项 | 前置条件 | 可观察证据 | 通过条件 | 失败 / 不确定条件 | 记录或测试编号 |
|---|---|---|---|---|---|
| P1a 选卡（操作行为） | 歌单卡片可见 | 卡片候选与精确匹配数 | `exactMatches = 1`（**仅表示操作唯一，不表示身份**） | 歧义 ⇒ `FAIL_CARD_AMBIGUOUS` | §0.13/§0.15/§0.16 |
| **P1b 页面身份** | 存在同名歌单 | **可追溯的身份信号** | 信号成立 | 无法确认 ⇒ `UNCERTAIN_PLAYLIST_PAGE_UNCONFIRMED`；T-E/T-E2/T-E3 均 FAIL ⇒ **无法补证** | T-E/T-E2/T-E3（均 FAIL） |
| P2 唯一匹配 | 目标在实现化范围 | `rowMatch.count`、ListItem 祖先、列表容器内 | = 1 | 0 ⇒ `UNCERTAIN_ROW_NOT_FOUND_IN_IMPLEMENTED_RANGE`；>1 ⇒ `FAIL_ROW_MULTIPLE_MATCH` | §0.13/§0.15/§0.16 + T-B |
| P3 单次点击 | 落点合法（≥40px、窗口内） | `click.calls=1`、坐标、`rowStillValid` | 一次请求内 calls=1 且点合法 | `UNCERTAIN_AIM_INVALID` / `UNCERTAIN_ROW_ELEMENT_INVALID` | §0.13/§0.15/§0.16 |
| P4 SMTC 确认 | 见 A6 产品前置 | 前后 SMTC title/artist/**status**/ts | **`status == Playing`** + 标题相等 + 艺人包含 | 明确他曲 ⇒ `FAIL_TARGET_MISMATCH`；**非 Playing 或信息不足/不稳** ⇒ `UNCERTAIN_SMTC_UNRESOLVED`；缺艺人 ⇒ `UNCERTAIN_IDENTITY_INSUFFICIENT` | §0.13/§0.15 + T-A/T-D |
| **NO_OP**（并列终态） | **P1a + P1b 已成立**，且此刻 SMTC 满足字符串级目标身份 | P1b 身份信号 + 操作前 SMTC | 返回 `ALREADY_PLAYING_NOOP`，不操作 | 不得计为 SUCCESS/FAIL/UNCERTAIN；P1b 未成立时不得判 NO_OP | §0.14 前置记录（前提为 P1b 成立） |
| Q 上下文（独立承诺） | 起播 SUCCESS | 自然/受控 next 与 API 顺序比对 | 与 API 顺序一致 | 未验证 ⇒ 不提示；异常 ⇒ 独立文案（未来） | §0.14/§0.15（2 个歌单） |
| 范围外目标 | 目标不在实现化范围 | 可达性证据 | 安全失败且可解释 | 不得盲点/重试/宣称支持 | §0.16–§0.19 + T-B |

---

## E. 修改文件清单与隔离检查

- **本文件**：`experiment/apple-music-alpha1/reports/POC-PLAYLIST-SONG-START-CONTRACT-v1.md`（v0.5）
- **未修改**：`POC-PLAYLIST-SONG-START.md`（证据台账）、全部 `poc-p3-*record.json`、POC 脚本、生产代码、渲染层、冻结链
- **未执行**：任何 Apple Music UI/播放操作；T-A/T-B/T-C1/T-C2/T-D/T-E 均未运行
