# Phase 3.5 — Resolve Hardening + E2E 真实歌曲压测报告

- 分支：`experiment/apple-music-windows-control`（base `197e31e`）
- 冻结基线：Phase 2 播放链路 60/60
- 本次运行时间戳：回归 `20260925-192424`，E2E `20260925-192545`
- 结论：**PHASE_3_5_NOT_READY**

---

## 1. 方法与范围

- **冻结链路零改动**：`poc/lib/am-play.ps1`、`am-uia.ps1`、`am-smtc.ps1` 在本次验证中**未被修改**（`git diff --stat HEAD -- poc/lib/` 为空）。Phase 2 的 URL→UIA→ScrollIntoView/Realize/SetFocus→左侧安全区双击→SMTC 链路原样使用。
- **Resolver 零改动**：本阶段只做验证，没有为了让 PASS% 好看而改匹配阈值。`phase3-resolve/lib/resolve35.ps1` 保持 `197e31e` 状态。
- 本阶段**只新增测试脚本**：`poc/phase35-regression.ps1`（冻结回归）、`poc/resolve-e2e-test.ps1`（E2E）、`poc/analyze-e2e.ps1`（事后权威复核）。
- 测试歌曲数据只含 Title/Artist/Album（`phase3-resolve/phase35-cases.json`），**不预置任何 URL**；URL 只由 resolver 产出。
- 未触碰登录、cookie、media-user-token、MusicKit、Apple API token；未加 npm 依赖；未做逆向/注入/内存读取。
- 环境：单显示器；Apple Music MSIX 1.1540.23042.0；公开 iTunes Search/Lookup API（无凭据）。
- **LOW 置信度策略（步骤 3）**：`LOW` 一律不自动播放，在 E2E 运行器侧记为 `RESOLVE_LOW_CONFIDENCE`（若 lookup 已执行且失败则记 `LOOKUP_FAILED`）。这是运行器策略，不改 resolver 本体。

---

## 2. 步骤 1：Phase 2 冻结播放回归（已知 URL，不走 resolver）

3 首已知正确 URL（A/B/C）× 5 = **15/15 全部成功**。完整数据：`findings/phase3/regression-20260925-192424.{md,jsonl}`。

| 失败码 | 次数 |
|---|---|
| SMTC_WRONG_TRACK | 0 |
| SMTC_TIMEOUT | 0 |
| TARGET_ROW_NOT_FOUND | 0 |
| CLICK_FAILED | 0 |
| REALIZE_FAILED | 0 |
| URL_NAVIGATION_FAILED | 0 |
| BOUNDS_INVALID | 0 |
| APP_NOT_RUNNING | 0 |

延迟（15 次，端到端）：

| 指标 | e2e ms | SMTC 段 ms |
|---|---|---|
| mean | 2966 | 256 |
| median | 2673 | 141 |
| p95 | 5455 | 837 |
| max | 5455 | 837 |

说明（非美化，如实）：15 次里每首歌的**第 1 次**含冷启动 / 深链导航（A 5455、B 3511、C 3620），第 2–5 次稳定在 2605–2699 ms。热态中位 ≈2665 ms，与 Phase 2 基线 2662 ms 一致，**未发现冻结链路退化**。→ 门槛 A 满足，无需停下诊断。

---

## 3. 步骤 3/4 前置：Resolver 单元回归（20 例）

来自 `findings/phase3/resolve-test-20260925-191842.md`（`poc/resolve-test.ps1`）：

- PASS **14** / EDITION_MISMATCH 0 / FAIL 0 / AMBIGUOUS **5** / NOT_FOUND **1**
- wrong-artist acceptances **0**
- lookup 校验通过 14/20；exact-id 命中 2/4
- `晴天 / 周杰伦 / 叶惠美` 在补上 `exact-cjk` 专辑层后由 AMBIGUOUS 转为 **PASS**（专辑名简繁差异：叶惠美 ↔ 葉惠美）
- 仍未解：`后来 / 刘若英` = NOT_FOUND（记录为已知限制，**未加任何按歌名特判**）

---

## 4. 步骤 2：Resolve → Playback E2E（22 首，无预置 URL）

| 指标 | 数值 |
|---|---|
| Resolve 成功率 | **9/22 = 41%** |
| 播放成功率（仅在解析成功的曲目上） | **8/9 = 89%** |
| 整体 E2E 成功率 | **8/22 = 36%** |
| wrong-artist acceptances | **0** |
| 明显错误版本被自动接受 | **1（E22，Live 现场版）** |

延迟：

| 阶段 | p50 | p95 | max | mean |
|---|---|---|---|---|
| Resolve | 3228 ms | 16195 ms | 19416 ms | 6169 ms |
| Playback | 4345 ms | 18271 ms | 18271 ms | 5731 ms |
| 整体 E2E | 4331 ms | 20672 ms | 34285 ms | 8514 ms |

说明：本次运行器的 `playbackMs` 字段为 0（`am-play` 未暴露独立的播放耗时字段，运行器取的 `t.totalMs` 名字不存在），因此 Playback 延迟由 `e2eMs - resolveMs` 逐条推导，属可复算的派生值，不是原始测量字段。Resolve 的 p95/max 偏高与公开 API 命中 403/429 限流后仓库阶梯重试有关（最长 E21 19.4 s、E12 16.2 s）。

---

## 5. 失败分类计数（13 码）

| 错误码 | 次数 | 备注 |
|---|---|---|
| RESOLVE_NOT_FOUND | 2 | E18 后来/刘若英、E21 演员/薛之谦 |
| RESOLVE_AMBIGUOUS | 4 | E08 Hello/Lionel Richie、E16 十年、E17 富士山下、E20 稻香 |
| RESOLVE_WRONG_ARTIST | 0 | — |
| RESOLVE_WRONG_ALBUM | 0 | — |
| RESOLVE_LOW_CONFIDENCE | 7 | E01、E04、E07、E09、E10、E12、E15 |
| LOOKUP_FAILED | 0 | — |
| URL_NAVIGATION_FAILED | 0 | 深链导航 9/9 全部成功 |
| TARGET_ROW_NOT_FOUND | 0 | — |
| REALIZE_FAILED | 0 | — |
| BOUNDS_INVALID | 0 | — |
| CLICK_FAILED | 0 | — |
| SMTC_TIMEOUT | 0 | — |
| SMTC_WRONG_TRACK | 1 | E22（错误版本导致，非错误艺人） |
| APP_NOT_RUNNING | 0 | — |

按用户要求，**resolver 的拒绝不计入播放失败**：9 次解析成功中播放 8 次成功，唯一一次播放失败（E22）是 resolver 接受了错误版本导致。

---

## 6. 步骤：wrong-artist acceptances

**权威值 = 0。**

透明说明：`resolve-e2e-test.ps1` 首次统计时打印了 “wrong-artist acceptances: 8”，这是**我运行器自己的度量 bug**，不是真实发现。两个原因：

1. `Test-AmSmtcArtistMatch(smtcArtist, targetArtist)` 参数序被我写反（`$artist, $smtcArtist`），导致 8 次播放成功全部被误判为艺人不符；
2. `Test-AmArtistLayer` / `Get-AmAlbumLayer` 返回的是 hashtable，我直接与 `0` 比较，比较恒为 false（专辑比较还抛了 `NotIComparable`）。

用 `poc/analyze-e2e.ps1`（正确的参数序 + 取 `.score`）对同一份 `e2e-20260925-192545.jsonl` 重算，**不重跑、不重打 API**：

```
WRONG_ARTIST_ACCEPTANCES=0
SMTC_ARTIST_MISMATCH=0
REFUSAL_CODES: OK=9, RESOLVE_AMBIGUOUS=4, RESOLVE_LOW_CONFIDENCE=7, RESOLVE_NOT_FOUND=2
```

即：9 次解析成功中，艺人层全部为 `exact`(10) 或 `cjk`(7)，SMTC 上报艺人 0 次不符。**没有为了通过而放宽任何判定**——这份更正同时把两个方向都改了（原本虚高的 8 归零）。

> 待办（阻塞项之一，非 resolver）：`resolve-e2e-test.ps1` 内的 `wrongArtistAcceptance` / `editionDifferent` / `playbackMs` 三处内联度量仍是旧写法，下一次 E2E 必须先用 `analyze-e2e.ps1` 复核，或先修脚本再跑。

---

## 7. 版本（edition）错误

**E22 —— 真实、严重、且属通用缺陷：**

- 请求：`光年之外 / 邓紫棋`（**未给专辑约束**）
- 接受：songId `6772898598`，标题 `光年之外`，专辑 `嗨,唱起来 第5期 - EP`，storefront `hk`，confidence **MEDIUM**，score 15
- runnerUp：`1190070744`，`光年之外 (電影《Passengers》中國區主題曲)` / 同名 Single，score 12
- 播放结果：SMTC 报 `光年之外(Live) / 邓紫棋 — 嗨,唱起来 第5期 - EP` → 不符请求标题 → `SMTC_WRONG_TRACK`

诊断：候选来自综艺/现场合辑，“Live/现场”信息只体现在**专辑名**里，而 `Get-AmAlbumLayer` 只做字面简繁/包含比较，**版本标记（Live / 現場 / 综艺合辑 / Remix / Acoustic）不参与打分，也不会触发歧义**。当请求没有专辑约束时，一个综艺现场版可以凭“标题精确 + 艺人精确”拿到与录音室单曲相同甚至更高的分数。这是**通用逻辑缺陷**（任何“歌名相同 + 现场版专辑名不同”的歌都会中招），不是单曲特判问题。

**E19 观察（非阻塞，但需复查 tie 规则）：**

- 请求：`青花瓷 / 周杰伦 / 我很忙`，接受 `1721455873`（score 21），runnerUp `536030695`（score 21，**同专辑 我很忙**，同名）
- 本次播放结果正确（SMTC `青花瓷 / 周杰伦 — 我很忙`），两个 id 指向同一录音
- 但“同分且不同 trackId → RESOLVE_AMBIGUOUS”的规则在这里**没有触发**，原因待查（可能被早期高置信退出绕过）。记录为观察项，不计入失败。

**为什么本阶段没有直接修 resolver**：用户指令是“只有测试证明是通用逻辑缺陷时才修”。缺陷确已证明，但（a）本阶段门槛已因 C 失败而不可能通过，（b）任何新的版本判别规则都必须先在 2–3 首其它中文歌上验证、并重跑 20 例单元回归后才能提交。为了不在同一阶段既改判定又改基线，我选择**提交诊断、不提交未经验证的修改**。建议的通用修复（下一步验证后实施）：在打分中引入“候选专辑/节目标题包含现场/综艺/伴奏类标记，而请求标题不含相应标记”时的降权，并使此类候选不得进入 HIGH/MEDIUM 自动播放；中文侧优先验证 `光年之外`、`富士山下`、`十年` 三首。

---

## 8. 逐曲明细

拒绝（13 首，未播放）：

| id | tag | 请求（Title / Artist / Album） | 结果 | confidence | songId | storefront | resolveMs |
|---|---|---|---|---|---|---|---|
| E01 | english/album | How Do I Make You Love Me? / The Weeknd / Dawn FM | RESOLVE_LOW_CONFIDENCE | LOW | 1603164232 | us | 2828 |
| E04 | english/deluxe | Blinding Lights / The Weeknd / After Hours (Deluxe) | RESOLVE_LOW_CONFIDENCE | LOW | 1615102595 | us | 6080 |
| E07 | same title/same artist | Hello / Adele / 25 | RESOLVE_LOW_CONFIDENCE | LOW | 1051332387 | tw | 2979 |
| E08 | same title/other artist | Hello / Lionel Richie / — | RESOLVE_AMBIGUOUS | AMBIGUOUS | — | — | 209 |
| E09 | english/album | Rolling in the Deep / Adele / 21 | RESOLVE_LOW_CONFIDENCE | LOW | 403037877 | tw | 4157 |
| E10 | single vs album | Someone Like You / Adele / 21 | RESOLVE_LOW_CONFIDENCE | LOW | 1544491998 | us | 3147 |
| E12 | english/album | Shake It Off / Taylor Swift / 1989 | RESOLVE_LOW_CONFIDENCE | LOW | 1440936016 | us | 16195 |
| E15 | chinese/simplified-traditional | 晴天 / 周杰伦 / 叶惠美 | RESOLVE_LOW_CONFIDENCE | LOW | 1721464906 | hk | 4177 |
| E16 | chinese/no album | 十年 / 陈奕迅 / — | RESOLVE_AMBIGUOUS | AMBIGUOUS | — | — | 1930 |
| E17 | chinese/no album | 富士山下 / 陈奕迅 / — | RESOLVE_AMBIGUOUS | AMBIGUOUS | — | — | 3381 |
| E18 | chinese/phase-3 failure | 后来 / 刘若英 / — | RESOLVE_NOT_FOUND | NOT_FOUND | — | — | 2145 |
| E20 | chinese/no album | 稻香 / 周杰伦 / — | RESOLVE_AMBIGUOUS | AMBIGUOUS | — | — | 3228 |
| E21 | chinese/no album | 演员 / 薛之谦 / — | RESOLVE_NOT_FOUND | NOT_FOUND | — | — | 19416 |

解析成功并播放（9 首）：

| id | 请求（Title / Artist / Album） | songId | sf | confidence | lookup 元数据（标题 / 专辑） | runnerUp（id / 标题 / 专辑 / score） | 播放 | reason(阶段) | resolveMs | e2eMs |
|---|---|---|---|---|---|---|---|---|---|---|
| E02 | Shape of You / Ed Sheeran / ÷ (Deluxe) | 1193701392 | tw | HIGH | Shape of You / ÷ (Deluxe) | — / — / — / 0 | OK | OK | 1429 | 4650 |
| E03 | Shape of You / Fame on Fire / Shape of You - Single | 1848188008 | tw | HIGH | Shape of You / Shape of You - Single | — / — / — / 0 | OK | OK | 1201 | 4331 |
| E05 | Perfect / Ed Sheeran / ÷ (Deluxe) | 1193701400 | tw | HIGH | Perfect / ÷ (Deluxe) | — / — / — / 0 | OK | OK | 1487 | 5301 |
| E06 | bad guy / Billie Eilish / When We All Fall Asleep, Where Do We Go? | 1450695739 | tw | HIGH | bad guy / WHEN WE ALL FALL ASLEEP, WHERE DO WE GO? | — / — / — / 0 | OK | OK | 2128 | 5951 |
| E11 | Love Story / Taylor Swift / Fearless | 1440924808 | tw | HIGH | Love Story / Fearless | 1440748753 / Love Story / Fearless (International Version) / 20 | OK | OK | 9920 | 14516 |
| E13 | Viva La Vida / Coldplay / Viva la Vida or Death and All His Friends | 1122773680 | tw | HIGH | Viva La Vida / Viva La Vida or Death and All His Friends | 1774282354 / Viva La Vida / Viva La Vida - Single / 18 | OK | OK | 10261 | 14762 |
| E14 | Yellow / Coldplay / Parachutes | 1122782283 | tw | HIGH | Yellow / Parachutes | — / — / — / 0 | OK | OK | 8608 | 12953 |
| E19 | 青花瓷 / 周杰伦 / 我很忙 | 1721455873 | hk | MEDIUM | 青花瓷 / 我很忙 | 536030695 / 青花瓷 / 我很忙 / 21 | OK | OK | 14795 | 20672 |
| E22 | 光年之外 / 邓紫棋 / — | 6772898598 | hk | MEDIUM | 光年之外 / 嗨,唱起来 第5期 - EP | 1190070744 / 光年之外 (電影《Passengers》中國區主題曲) / 光年之外 (電影《Passengers》中國區主題曲) - Single / 12 | FAIL（SMTC 报 光年之外(Live)） | SMTC_WRONG_TRACK | 16014 | 34285 |

字段级完整记录（含每个候选、evidence、stageHistory、SMTC 原始状态）：`findings/phase3/e2e-20260925-192545.jsonl`。

其它如实记录的运行器小缺陷（不影响上述计数）：`canonicalUrl` 的中文标题 slug 退化为 `song`（`https://music.apple.com/cn/song/song/6772898598`）——导航仍然成功（9/9）；`evidence` 字段因 join 的是对象而显示为空串；`playbackMs` 见第 4 节。

---

## 9. 结论与阻塞项

门槛判定：

| 门槛 | 要求 | 实测 | 结论 |
|---|---|---|---|
| A 冻结回归 | 15/15 | 15/15，失败码全 0 | ✅ |
| B wrong-artist acceptances | 0 | 0（权威重算） | ✅ |
| C E2E Resolve 成功率 | ≥95% | **41%（9/22）** | ❌ |
| D 无错误版本被自动接受 | 无 | E22 接受 Live 现场版 | ❌ |
| E resolver 无回归 | 无 | 单元回归与 3.5 一致（14 PASS），但 E22 暴露新缺陷 | ❌ |

**PHASE_3_5_NOT_READY**

阻塞项（按优先级）：

1. **C：Resolve 成功率 41% ≪ 95%。** 主要构成：LOW 7（其中 E01/E04/E09/E10/E12/E15 都解析出了候选，只是置信度不足）、AMBIGUOUS 4、NOT_FOUND 2。没有专辑约束的中文歌（E16/E17/E20/E21）与 `Hello/Lionel Richie` 是重灾区。**注意**：这不是“把阈值调松”就能解决的——LOW 里存在 (a) 真正指向同曲不同版本的情况，和 (b) lookup 未通过的边缘候选；需要提高的是**证据质量**（版本判别 + 中文侧检索策略），不是放宽判定。
2. **D：版本（Live/现场/综艺）判别缺失**（E22，通用缺陷，见第 7 节）。修复需先在其它 2–3 首中文歌上验证并重跑 20 例单元回归。
3. **E：tie 规则在 E19 未触发**（同分、不同 trackId、同专辑）需复查，确认早期高置信退出的边界。
4. **测试工具**：`resolve-e2e-test.ps1` 内联的三处度量字段（`wrongArtistAcceptance`、`editionDifferent`、`playbackMs`）已知不可信，下一次 E2E 前必须先修或强制以 `analyze-e2e.ps1` 复核结果为准。
5. 已知限制：`后来 / 刘若英` NOT_FOUND（保留为限制，未特判）。

本阶段**未修改 resolver、未修改冻结播放链路、未触碰 main**，也没有为了让指标变好而放宽任何阈值。在拿到 `PHASE_3_5_READY_FOR_LOGIN` 之前，不开展任何登录相关工作。
