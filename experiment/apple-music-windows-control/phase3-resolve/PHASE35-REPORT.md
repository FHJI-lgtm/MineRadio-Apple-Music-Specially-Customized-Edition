# Phase 3.5 报告（Resolve 硬化）——未完成声明

**状态：部分完成。** 已交付硬化后的 resolver 与其单元测试；**20 首真实 E2E 压测与 Phase 2 回归尚未执行**，因此本阶段**不满足** READY 条件，没有输出 `PHASE_3_5_READY_FOR_LOGIN`。

## 1. 修改/新增文件（全部在 `experiment/` 内；main 未动；无新依赖；未接登录/token/MusicKit；未逆向）

| 文件 | 说明 |
|---|---|
| `phase3-resolve/lib/resolve35.ps1` | **新增**：硬化版 Resolve-AmSong（分层判定 + 6 种发现策略 + 店面阶梯 + lookup 校验 + confidence/runnerUp + AMBIGUOUS 安全拒绝） |
| `poc/resolve-test.ps1` | **新增**：resolver 单元测试（20 例，输出 PASS/FAIL/AMBIGUOUS/NOT_FOUND/EDITION_MISMATCH + JSON） |
| `phase3-resolve/phase35-cases.json` | **新增**：单测 20 例 + E2E 22 首（**全部不含 URL**） |
| `phase3-resolve/lib/resolve.ps1`、`id-correspondence.ps1`、`cross-validate.ps1`、`candidates.json`、`known-songs.json`、`FINDINGS.md` | Phase 3 产物，本阶段未改 |
| `poc/lib/am-play.ps1`、`am-uia.ps1`、`am-smtc.ps1` | **冻结基线，零改动**（`git diff HEAD -- poc/` 仅新增 test 脚本） |

## 2. Resolver 架构变化

```
title/artist/album
  → 6 种发现策略 × 店面阶梯(cn→tw→hk→us→default)
  → 每个候选分层打分（title / artist / album），不合格者直接丢弃
  → 去重(trackId) → 排序 → 版本优先(exact album) → 并列则 AMBIGUOUS
  → lookup(id, country) 存在性校验 → confidence
  → songId → 动态构造 /song/<slug>/<id>（URL 不落库、不硬编码）
```

## 3. Discovery strategy（泛化，无单曲补丁）

| 策略 | 用途 | 实测 |
|---|---|---|
| S1 title+artist+album / S2 title+artist / S3 title / S4 title+album | 常规 | 英文用例主要靠这条 |
| **S5 `attribute=artistTerm`**（term=歌手） | 纯 CJK 查询常返回空时的兜底 | 让 `十年/富士山下/青花瓷/稻香` 能进候选池 |
| **S6 album 搜索 → `lookup(collectionId, entity=song)` → 按标题匹配** | 专辑级反查 | 用于有 album 的 CJK 用例 |
| 早退 | 拿到"标题精确+艺人分层好+专辑精确"即停止 | 必需：公开 API 会 403/429 限流（实测踩到） |

**`后来 / 刘若英` 仍为 `RESOLVE_NOT_FOUND`（未解决）**。已试：title+artist、title、title+album、artistTerm、tw/hk/cn/us/default 店面 —— 均无可接受候选（该曲在公开 search 里主要出现为翻唱/合集，而 artist 分层不允许 contains/编辑距离，故安全拒绝）。**没有**为它写任何硬编码。

## 4. Storefront strategy

- 阶梯 `cn → tw → hk → us → default`，记录 `requested` 与 `resolved` 店面。
- 每个选中的 id 都经 `lookup?id=<id>&country=<sf>` 验证；`lookup` 成功但落在非请求店面时降 confidence。
- 实测（Phase 3 已记录、本阶段沿用）：同一 id 在不同店面 **title 稳定、albumName 稳定、artistName 会变**（`The Weeknd` ↔ `Abel Tesfaye`）；id `535824738` 仅 cn/tw 可查。
- **成功标准是"目标歌曲匹配"，不是"某店面有结果"**。

## 5. Artist normalization（分层，禁止宽松匹配）

1. exact（大小写无关原样相等）
2. normalized 相等（小写、全半角、去标点/空白/feat. 噪声）
3. **已验证目录别名表**（当前仅 `the weeknd ↔ abel tesfaye`，有实测依据）
4. CJK 信用变体（简体/繁体字符重叠 ≥0.6，仅当任一侧含 CJK 时启用）
- **不使用 contains、不使用 Levenshtein**；无法判定即 `AMBIGUOUS`。
- 结果：`The Weeknd` vs `Fame on Fire` 仍判不同 ✓；单测 **wrong-artist acceptances = 0** ✓（硬性要求达成）。

## 6. Edition ranking

`album exact > album exact-cjk（繁简） > album contains > 无 album`
- 指定 album 时，**精确专辑的候选整体优先于仅"包含"的候选**，即使后者先返回。
- 实测：`Shape of You / Ed Sheeran / ÷ (Deluxe)` → `1193701392`（HIGH，未被先出现的 `÷` 抢走）✓；`÷`（不带 Deluxe）→ **AMBIGUOUS**（拒绝乱选）✓。
- 本阶段修掉一个缺陷：**专辑名也有繁简差异**（请求 `叶惠美`、目录 `葉惠美`）→ 增加 `exact-cjk` 层后 `晴天` 由 AMBIGUOUS 变为 PASS ✓。

## 7-11. 单测结果（20 例，纯解析；E2E 未跑）

| 指标 | 值 |
|---|---|
| PASS | **14** |
| EDITION_MISMATCH | 0 |
| FAIL | **0** |
| AMBIGUOUS | 5（U04 ÷、U07/U08/U20 中文合集、U11 Hello/Lionel） |
| NOT_FOUND | 1（U09 后来/刘若英） |
| 可用（PASS+EDITION_MISMATCH） | 14/20 = **70%** |
| exact-id 命中 | 2/4（U01/U02 解析到同歌的其它发行版；U03/U05 精确命中） |
| lookup 校验通过 | 14/20 |
| **错误艺人被当成功** | **0** ✓ |

关键用例：`晴天/叶惠美` PASS ✓；`Shape of You/Fame on Fire` → 翻唱 id `1848188008` PASS HIGH ✓；`÷ (Deluxe)` PASS HIGH ✓；`÷` AMBIGUOUS ✓。

**未执行**：20+ 首 E2E（resolve→lookup→URL→UIA→SMTC）、p50/p95/max E2E 延迟、Phase 2 回归重跑。

## 12. Phase 2 baseline

冻结基线文件**零改动**（`poc/lib/{am-play,am-uia,am-smtc}.ps1` 无 diff），因此结构上不可能被本阶段破坏；但**回归未按你要求实测重跑**（A/B/C 已知 URL 的 60/60 基线复现）——这一点必须留到下一次。

## 13. 仍存在的问题

1. `后来/刘若英` 未解决；中文合集类用例在**不给 album** 时大量落入 AMBIGUOUS（安全但降低可用率）。
2. 公开 iTunes Search **限流（403/429）**：必须早退 + 控制请求量，否则结果不稳定。
3. E2E 与回归未跑，因此"20 首 E2E Resolve ≥95%"这条成功标准**尚未被验证**。
4. 单元测试里 U01/U02 解析到同歌的其它发行版（低 confidence），说明**同一首歌多发行版**仍需"发行版优先"策略或调用方给出 album。
5. 别名表只有 1 对（有实测依据）；扩充必须是"已验证"的，不能靠猜。

## 14. 下一阶段建议

1. 先做**受限回归**（A/B/C 已知 URL × 5 次）确认冻结链路仍是 100%，再动其他。
2. 再跑 `resolve-e2e-test.ps1`（22 首 × 1，失败按 13 类错误码归类）；如时间允许 ×3。
3. 为"同歌多发行版"补一条策略：给定 album 时用 `lookup(collectionId)` 的曲目序（`trackNumber`）与专辑精确度共同决定，而不是仅靠分数。
4. `后来/刘若英` 用**专辑级线索**（`entity=album` + artistTerm）或 `lookup` 反查（若调用方能给出任一真实发行信息）继续查；仍不写单曲补丁。
5. Confidence 规则再收紧：`LOW` 不应作为自动播放依据（建议 `LOW` 时返回 `ok=false, reason=RESOLVE_LOW_CONFIDENCE`）。

## 附：本阶段没有做的事（明确声明）

- 未输出 `PHASE_3_5_READY_FOR_LOGIN`（不满足全部成功标准）。
- 未执行 20 首 E2E 压测与 Phase 2 回归重跑。
- 未改 main、未接登录、未碰 token/MusicKit、未逆向、未加依赖、未硬编码任何 URL。
