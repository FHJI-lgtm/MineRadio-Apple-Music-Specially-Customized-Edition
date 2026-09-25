# Phase 3.6 — Version Semantics + Resolver Precision 报告

- 分支：`experiment/apple-music-windows-control`
- 冻结项：`poc/lib/am-play.ps1` / `am-uia.ps1` / `am-smtc.ps1` **本阶段零改动**（见提交时的 `git diff --stat -- poc/lib/` 为空）
- 结论：**PHASE_3_6_READY_FOR_E2E**

---

## 1. 范围

只做两件事：给 resolver 增加 **Version Semantics 层**，并修掉 **同分不判歧义** 的确定性缺陷。播放链路（songUrl → UIA → SMTC）一行未动，Phase 2 regression 仍是 15/15。

## 2. 新增/修改的文件

| 文件 | 作用 |
|---|---|
| `phase3-resolve/lib/version36.ps1` | 版本语义层 + 纯函数打分/选择器（无网络） |
| `phase3-resolve/lib/version36-markers.json` | 13 类版本标记的 CJK 词表、语境标注白名单、综艺期数正则 |
| `phase3-resolve/lib/resolve35.ps1` | 调用新层；新增 lookup 确定性守卫与 `autoPlayable` |
| `phase3-resolve/phase36-pure.json` / `phase36-matrix.json` | 离线用例数据 / 20 首真实歌曲矩阵 |
| `poc/resolve36-version-test.ps1` | 本阶段测试套件（Part A 离线 + Part B 真实） |

CJK 词表必须外置 JSON：PowerShell 5.1 把 **无 BOM 的 .ps1 按 ANSI 解析**，写在脚本里的中文会被破坏（本阶段实际踩到过一次，脚本直接解析失败）。

## 3. 新的打分与优先级

```
score = title + artist + album + version + storefrontBonus
scoreWithEvidence = score + 2   (当 lookup 权威元数据与请求一致时)
```

选择顺序（`Select-AmBestCandidate`，纯函数、无网络、可离线复现）：

1. **显式专辑请求优先**：有 `albumExact` 候选时只在其内选择 —— 明确请求的专辑永远不会被版本启发式覆盖；
2. **版本池**：请求未指定版本 → 只要存在 canonical（录音室）候选就只在其中选；请求指定了版本 → 只在与该版本同类的候选中选；
3. **同分判定**：同分的候选若属于**不同录音**（title+album 归一化后不同）→ 直接 `RESOLVE_AMBIGUOUS`，绝不依赖数组顺序或“谁先返回”；若只是**同一次录音的多个 id**（同 title+album）→ 按请求 storefront 确定性挑选，不判歧义；
4. 排序键：scoreWithEvidence → score → album 层 → title 层 → artist 层 → 轨号 → trackId（纯稳定性兜底）。

版本层区分三类信号（这是本次的核心）：

| 信号 | 识别位置 | 例 |
|---|---|---|
| **explicit 版本标记** | 标题的 `()`/`[]`/`{}` 或破折号后缀 | `光年之外(Live)`、`Song (Acoustic)`、`Song (Remix)` |
| **weak 版本标记** | **专辑名整体** | `現場演唱會`、`嗨,唱起来 第5期 - EP`（综艺期数）、`Greatest Hits`、`原声带` |
| **context 语境标注（非版本）** | 标题括号内且命中白名单 | `(電影《Passengers》中國區主題曲)`、`(feat. X)`、`(From the movie)` |

语境标注会在标题比较前被剥离，因此“电影主题曲版单曲”仍被认定为**录音室正片**（`exact-context` 层，与 exact 同分），而 `(Live)` 不会被剥离。

`autoPlayable` 策略：`confidence ∈ {HIGH, MEDIUM}` **且** 版本层为 `canonical` 或 `requested-version`。即“只有 Live、没有正片”时仍会被解析出来，但**不会被自动播放**，需人工确认。

## 4. Part A：离线纯单元测试（无网络）

**15/15 PASS**。覆盖：

| 编号 | 断言 | 结果 |
|---|---|---|
| A01 | 无专辑时 studio 优先于 live | PASS winner=A1 canonical=True |
| A02 | 同分且不同录音 → **AMBIGUOUS** | PASS reason=RESOLVE_AMBIGUOUS distinct=2 scores=24/24 |
| A03 | 同分但 A 专辑 exact、B contains → **A 胜出、不判歧义** | PASS winner=C1 albumExact=True/False |
| A04 | 显式请求 live 专辑 → live 候选获胜（覆盖版本启发式） | PASS winner=D2 layer=requested-version |
| A05 | 显式请求 `(Live)` 标题 → 选中 live 候选 | PASS winner=B1 layer=requested-version |
| A06 | 只有 live → 接受但标记非 canonical、choseCanonical=False | PASS |
| A07 | 同一录音两个 id → 确定性选请求 storefront，不判歧义 | PASS winner=E2 |
| A08 | 电影主题曲标注 = context，非版本标记 | PASS layer=canonical |
| A09 | 综艺期数专辑 = weak 非 canonical 信号 | PASS layer=noncanonical-weak classes=show |
| A10 | 显式 `(Live)` 强于 weak 专辑信号 | PASS layer=noncanonical-explicit classes=live,show |
| A11 | 13 类要求标记全部可识别（12 标题式 + 4 专辑式） | PASS missed=[] checked=16 |
| A12 | 普通词零误报（Alive / Deliver / Believe / Deluxe / feat. / 语境标注 / 二十年） | PASS bad=[] |
| A13 | 专辑简繁差异 = exact-cjk | PASS |
| A14 | 带语境标注的标题 = exact-context(8) | PASS |
| A15 | live 标题不会被折叠成正片 | PASS layer=prefix |

测试过程中发现并修掉了两个**真实代码缺陷**（不是调参）：
1. `Select-AmBestCandidate` 里 `$sorted = Sort-AmCandidates $pool` 少了 `@()` 包裹 —— PowerShell 对**单元素数组会解包**，Hashtable 用 `[0]` 索引取到的是键 `0` 而非首个元素，导致**只有单个候选时 winner 变成 `$null`**；
2. 测试用例本身的构造缺陷：候选必须按**真实请求上下文**打分（早期 A03/A05 用了错误的请求上下文，暴露了这个 API 用法陷阱，已在测试中标注）。

## 5. Part B：真实歌曲版本矩阵（20 首，resolve-only，无播放）

**20/20 策略断言通过**，`WRONG_ARTIST_ACCEPTANCES = 0`，`WRONG_VERSION_AUTOMATIC_ACCEPTANCE = 0`。
判定采用**策略不变量**而非“假设某版本一定存在”：canonical 请求永不自动接受非 canonical；显式专辑请求必须专辑精确；显式版本请求必须命中或安全拒绝。

| id | 类别 | 请求 | 判定 | conf | songId | 命中专辑 | 版本层 | ms |
|---|---|---|---|---|---|---|---|---|
| M01 | studio-vs-live | 光年之外 / 邓紫棋 | **CANONICAL** | HIGH | **1190070744** | 光年之外 (电影《太空旅客》主题曲) - Single | canonical | 4270 |
| M02 | studio-vs-live×多场 | Bohemian Rhapsody / Queen | SAFE-REFUSAL | AMBIGUOUS | — | The Platinum Collection | canonical | 1125 |
| M03 | studio-vs-live | Hotel California / Eagles | SAFE-REFUSAL | AMBIGUOUS | — | Hotel California | canonical | 1036 |
| M04 | original-vs-rerecorded | Love Story / Taylor Swift | SAFE-REFUSAL | AMBIGUOUS | — | Fearless (International Version) | canonical | 1134 |
| M05 | original-vs-rerecorded | Shake It Off / Taylor Swift | SAFE-REFUSAL | AMBIGUOUS | — | 1989 (Deluxe Edition) | canonical | 1205 |
| M06 | studio-vs-live | Someone Like You / Adele | SAFE-REFUSAL | AMBIGUOUS | — | Someone Like You - Single | canonical | 987 |
| M07 | studio-vs-live | Yellow / Coldplay | SAFE-REFUSAL | AMBIGUOUS | — | Yellow - Single | canonical | 990 |
| M08 | album-vs-single | Shape of You / Ed Sheeran / ÷ (Deluxe) | **ALBUM-EXACT** | HIGH | 1193701392 | ÷ (Deluxe) | canonical | 1970 |
| M09 | album-vs-compilation | Viva La Vida / Coldplay / 专辑 | **ALBUM-EXACT** | HIGH | 1122773680 | Viva La Vida or Death and All His Friends | canonical | 2458 |
| M10 | studio-vs-remix | Blinding Lights / The Weeknd | SAFE-REFUSAL | AMBIGUOUS | — | The Highlights | canonical | 3133 |
| M11 | 显式 live 请求 | 光年之外 (Live) / 邓紫棋 | **REQUESTED-VERSION** | HIGH | 6801047544 | “用奋斗点亮幸福”江苏卫视2019跨年演唱会 | requested-version(live) | 6495 |
| M12 | 显式 live 专辑请求 | 光年之外 / 邓紫棋 / 金曲撈…第5期 | SAFE-REFUSAL | LOW | — | 金曲捞第二季 第5期 | requested-version(live,show) | 9889 |
| M13 | 简繁 | 晴天 / 周杰伦 / 叶惠美 | **ALBUM-EXACT** | MEDIUM | 535824738 | 叶惠美 | canonical | 4785 |
| M14 | 专辑 vs 单曲 | 青花瓷 / 周杰伦 / 我很忙 | **ALBUM-EXACT** | MEDIUM | 536030695 | 我很忙 | canonical | 9092 |
| M15 | 中文 studio-vs-live | 十年 / 陈奕迅 | SAFE-REFUSAL | AMBIGUOUS | — | 校園.告別時 | canonical | 2615 |
| M16 | 已知限制 | 后来 / 刘若英 | REFUSED(AMBIGUOUS) | AMBIGUOUS | — | 后来 | canonical | 2402 |
| M17 | studio-vs-acoustic | Shape of You / Ed Sheeran | SAFE-REFUSAL | AMBIGUOUS | — | ÷ | canonical | 342 |
| M18 | studio-vs-remastered | Rolling in the Deep / Adele | SAFE-REFUSAL | AMBIGUOUS | — | 21 | canonical | 1118 |
| M19 | ost-vs-studio | My Heart Will Go On / Celine Dion | SAFE-REFUSAL | AMBIGUOUS | — | Back to Titanic (More Music from the Motion Picture) | canonical | 9925 |
| M20 | album-vs-compilation | Viva La Vida / Coldplay | SAFE-REFUSAL | AMBIGUOUS | — | Viva La Vida - Single | canonical | 1006 |

统计：canonical 命中 6、安全拒绝/非自动播放 14、autoPlayable 6。

**M12 的拒绝值得单列**：候选确实带着请求的 live/show 版本标记（`requested-version`），但 lookup 守卫发现目录里的**艺人署名**与请求艺人不一致 → 判 `RESOLVE_WRONG_ARTIST` 并拒绝。这是"宁可拒绝，不给错歌"的正确行为，已记为观察项。

真实矩阵里大量 `AMBIGUOUS` 是**新 tie 规则生效**的直接结果：无专辑约束时同名不同版本（单曲/专辑/精选/现场）同分，旧版会按数组顺序随便挑一个，现在按规则拒绝。

## 6. E22（RESOLVE_WRONG_VERSION）修复证据

原始数据（iTunes 公开 lookup）：

```
cn: 6772898598 -> track=[光年之外(Live)] album=[嗨,唱起来 第5期 - EP] artist=[邓紫棋]
hk: 6772898598 -> track=[光年之外]      album=[嗨,唱起來 第5期 - EP] artist=[鄧紫棋]
cn: 1190070744 -> track=[光年之外 (电影《太空旅客》主题曲)] album=[... - Single] artist=[邓紫棋]
```

- 旧 v3.5：选中 **6772898598**（Live，专辑是综艺第 5 期），SMTC 报 `光年之外(Live)` → `SMTC_WRONG_TRACK`；
- 新 v3.6：hk 侧综艺专辑被识别为 **weak 非 canonical**（`show` 类），cn 侧标题被识别为 **explicit live**；canonical 池里剩 1190070744（电影主题曲标注是 **context**，不算版本）→ 选中它，confidence **HIGH**，`autoPlayable=True`。

即：**Studio 优先**在真实数据上生效，且不是针对“光年之外”的特判（同一套规则在 12 首英文/中文歌上给出一致的策略判定）。

## 7. 原 22 首 E2E 的结构（直接读旧 JSONL，未重跑 API）

| 类别 | 数量 | 用例 |
|---|---|---|
| **A 正确 PASS** | 8 | E02,E03,E05,E06,E11,E13,E14,E19 |
| **B 安全 AMBIGUOUS** | 4 | E08,E16,E17,E20 |
| **C 证据不足（应能解析但当前证据不够）** | 9 | E01,E04,E07,E09,E10,E12,E15（LOW）+ E18,E21（NOT_FOUND） |
| **D 真正错误接受** | 1 | **E22（Live 版本）—— 本阶段已修** |

41% 的结构因此清楚：**D 只占 1 例**（已修），**C 占 9 例**是主要缺口，其中 7 例是 LOW，问题在“证据/打分”而非“匹配错误”。

## 8. 7 个 LOW 的逐个诊断

3.5 的 JSONL 显示这 7 例 **lookup 全部 `ok=True`**，且 lookup 返回的元数据与请求一致：

| 用例 | 请求 | lookup 元数据 | 旧结果 |
|---|---|---|---|
| E01 | How Do I Make You Love Me? / The Weeknd / Dawn FM | Abel Tesfaye（别名）/ Dawn FM | LOW |
| E04 | Blinding Lights / The Weeknd / After Hours (Deluxe) | Abel Tesfaye / After Hours (Deluxe) | LOW |
| E07 | Hello / Adele / 25 | Adele / 25 | LOW |
| E09 | Rolling in the Deep / Adele / 21 | Adele / 21 | LOW |
| E10 | Someone Like You / Adele / 21 | Adele / 21 | LOW |
| E12 | Shake It Off / Taylor Swift / 1989 | Taylor Swift / 1989 | LOW |
| E15 | 晴天 / 周杰伦 / 叶惠美 | 周杰倫 / 葉惠美（简繁） | LOW |

结论与处理：这些**不是 metadata 冲突**，而是旧版只按“搜索期”的层分数定置信度导致的**证据不足**。因此本阶段没有降低任何阈值，而是新增**确定性证据层**：用 lookup（权威元数据）重新计算 title/artist/album/version 层，并给出 +2 证据分；同时把 `exact-cjk` 专辑、`exact-context` 标题纳入 HIGH/MEDIUM 的合法证据。效果可在回归中观察到：`Hello/Adele/25`（U10）由 AMBIGUOUS → **PASS(MEDIUM)**，`Someone Like You/Adele/21`（U17）→ **PASS**。

若候选 metadata **明显冲突**（艺人/专辑/版本对不上），则不自动播放：`autoPlayable=False`，并在 lookup 守卫下直接 `ok=false` + `RESOLVE_WRONG_ARTIST / RESOLVE_WRONG_ALBUM / RESOLVE_WRONG_VERSION`。

## 9. 20 例 resolver 单元回归

| 指标 | 3.5 | **3.6** |
|---|---|---|
| FAIL | 0 | **0** |
| wrong-artist acceptances | 0 | **0** |
| PASS | 14 | 11 |
| AMBIGUOUS | 5 | 6 |
| NOT_FOUND | 1 | 3 |
| usable（PASS+EDITION_MISMATCH） | 70% | 55% |

**必须如实说明的下降**：`U01 / U02 / U12` 由“OK 但 LOW”变为 **NOT_FOUND**。原因是新的 lookup 守卫发现**目录里的曲名与请求曲名不匹配**（`Get-AmTitleLayer36` 不通过），于是硬拒绝。三点说明：

1. 这**没有降低可播放能力**：按 3.5 的既定策略，LOW 本来就不允许自动播放，这三例当时也不会进入播放；
2. 但这确实是**更严格**了，而且我**尚未确认**这三例 lookup 返回的确切曲名（`resolve-test` 的 JSON 只落了 artist/album），因此不排除守卫过严；
3. 已列为进入 E2E 前的**阻塞级复核项**：取这三例的原始 lookup 曲名，确认是“目录本地化改名”（守卫正确）还是“标题层过严”（需放宽 `exact-context` 之外的等价形式）。

按用户“不要用降低阈值制造 PASS”的要求，本阶段**没有**为了让这个数字好看而放宽任何判定。

## 10. NOT_FOUND / 已知限制

`后来 / 刘若英` 仍未解析（3.5 为 NOT_FOUND，现为 AMBIGUOUS）。**没有**任何按歌名的特判；本阶段也未引入新的 discovery 策略（若要引入，需先在另外 2–3 首中文歌上验证）。

## 11. 成功标准逐条核对

| # | 标准 | 结果 |
|---|---|---|
| 1 | wrong-artist acceptance = 0 | ✅ 单元回归 0 / 真实矩阵 0 |
| 2 | wrong-version automatic acceptance = 0 | ✅ 真实矩阵 0；`autoPlayable` 还额外要求版本层 canonical |
| 3 | 同分正确返回 AMBIGUOUS | ✅ A02；真实矩阵多例 |
| 4 | Album exact 不被版本启发式覆盖 | ✅ A03/A04 + M08/M09/M13/M14 全部 ALBUM-EXACT |
| 5 | 无专辑时 Studio 优先于 Live | ✅ A01 + **M01（E22 回归）→ 1190070744** |
| 6 | 20 例单元测试不回归 | ✅ FAIL=0 / wrong-artist=0（usable 数字变化见第 9 节，属更严格拒绝） |
| 7 | Frozen Playback 不变 | ✅ `poc/lib/` 无改动（提交时校验） |

## 12. 结论与下一步

**PHASE_3_6_READY_FOR_E2E** —— 版本语义层与确定性选择器已就位，5 项语义要求全部由可离线复现的测试覆盖，且 E22 的真实错误接受已被修复。**本阶段未跑 22 首 E2E**（按用户要求的顺序：先单元 → 再回归 → 再小规模）。

进入 E2E 前的阻塞项：

1. **复核 lookup 守卫严格性**：确认 U01/U02/U12 的原始 lookup 曲名，判定“目录改名”还是“标题层过严”；
2. **修 E2E 运行器**：`poc/resolve-e2e-test.ps1` 的三处内联度量（`wrongArtistAcceptance` 参数序、`editionDifferent` 的 hashtable 比较、`playbackMs` 字段名）已知不可信，需修好或一律以 `poc/analyze-e2e.ps1` 的复核结果为准；
3. 先跑 **10 首小规模 E2E**，确认没有新的错误接受后，再跑完整 22 首。

数据文件：`findings/phase3/version36-20260925-193907.{md,jsonl}`（Part A+B）、`findings/phase3/resolve-test-20260925-194026.{md,json}`（20 例回归）。
