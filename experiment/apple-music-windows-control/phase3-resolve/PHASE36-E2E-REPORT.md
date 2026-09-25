# Phase 3.6 收尾报告 — E2E 验证（含 10 首门槛 + 22 首全量）

本轮对应你的 7 项要求。**Playback 链路一行未改**（`poc/lib/am-play.ps1`、`am-uia.ps1`、`am-smtc.ps1` diff 为空），Login 未触碰。

---

## 1. U01/U02/U12 的原始 lookup metadata（要求 1）

用 `resolve35` 直接取权威 lookup，逐 storefront 打印原始字段：

| case | 请求艺人 | cn | tw | hk | us |
|---|---|---|---|---|---|
| U01 | The Weeknd | **Abel Tesfaye** | **Abel Tesfaye** | **Abel Tesfaye** | The Weeknd |
| U02 | The Weeknd | （id 不含 cn） | **Abel Tesfaye** | **Abel Tesfaye** | The Weeknd |
| U12 | The Weeknd | **Abel Tesfaye** | **Abel Tesfaye** | **Abel Tesfaye** | The Weeknd |

曲名与专辑完全一致（`How Do I Make You Love Me? / Dawn FM`、`Blinding Lights / After Hours (Deluxe)`），**只有艺人署名是目录别名** `Abel Tesfaye`。

**这不是“目录改名”，是我守卫里的真 bug**：`$script:AmArtistAliases` 里写的是 `@{ a='the weeknd'; b='abel tesfaye' }`（**含空格**），而 `Get-AmArtistKey` 会把空格去掉后再比较 → 别名层**永远无法命中** → 守卫把已验证的别名署名判成 `RESOLVE_WRONG_ARTIST`。

修复（`resolve35.ps1`，双侧 key 归一化）：

```powershell
$ka = Get-AmArtistKey $al.a; $kb = Get-AmArtistKey $al.b
if (($wk -eq $ka -and $gk -eq $kb) -or ($wk -eq $kb -and $gk -eq $ka)) { ... }
```

修复效果（20 例回归，修复后重跑 `resolve-test-20260925-195421`）：

| 指标 | 修复前 | **修复后** |
|---|---|---|
| FAIL | 0 | **0** |
| NOT_FOUND | 3 | **0** |
| wrong-artist acceptances | 0 | **0** |
| PASS | 11 | **14** |
| AMBIGUOUS | 6 | 6 |
| usable | 55% | **70%** |

U12 现为 `PASS / MEDIUM / 1505683967`；U01/U02 同样由 `RESOLVE_WRONG_ARTIST` 变为 PASS。

## 2. 三个不可信字段已修（要求 2）

`poc/resolve-e2e-test.ps1` 重写：

| 原字段 | 问题 | 现在 |
|---|---|---|
| `wrongArtistAcceptance` | `Test-AmSmtcArtistMatch($artist,$smtc)` 参数序反了 | 运行器**不再自算**，只写原始行；由 analyzer 用正确参数序（并区分可解释/不可解释）判定 |
| `editionDifferent` | 把 hashtable 与 `0` 比较（`-le` 直接抛错，恒为 false） | 改用 `(Get-AmAlbumLayer ...).score` |
| `playbackMs` | 取了不存在的 `$r2.t.totalMs`，恒为 0 | 用 stopwatch 派生：`播放开始 → 结束` 的耗时差 |

同时运行器改用 resolver 的 `autoPlayable` 做拒绝策略：`LOW` → `RESOLVE_LOW_CONFIDENCE`；非 canonical 单版本 → `RESOLVE_NONCANONICAL_ONLY`。

## 3. Analyzer 成为唯一指标真相源（要求 3）

`poc/analyze-e2e.ps1` 现在负责**全部**指标：解决率 / 播放率 / E2E 率、失败分类计数、延迟分位（含派生 playbackMs）、身份与版本审计，并额外输出：

- `smtcExplainedFalseNegatives`：SMTC 报 `WRONG_TRACK`，但曲名匹配（exact / exact-context）且艺人按 resolver 层（含目录别名）匹配 → **播放的就是正确曲目**，冻结验证器看不到别名署名或语境标注；
- `smtcUnexplainedMismatch`：无法解释的分歧 → 计入 hard failure；
- `playbackVerifiedAudited` / `e2eRateAudited`：把可解释假阴性计为已核实播放（**原始数字同时保留**，不覆盖）。

运行器只写原始 JSONL，末尾调用 analyzer；**hard failure 时退出码 1**。任何报告数字都来自 analyzer。

## 4. 10 首针对性 E2E（要求 5）

`-Only E02,E03,E06,E11,E13,E16,E17,E19,E20,E22`：

- resolve **7/10**，playback **6/7**，E2E **6/10**；`WRONG_ARTIST=0`、`WRONG_VERSION_AUTO=0`、`WRONG_ALBUM=0`
- **E22 修复生效**：选中 `1190070744`（正片单曲）、`HIGH`、`autoPlayable=True`；SMTC 返回的正是该正片自己的目录名
- 3 例 `RESOLVE_AMBIGUOUS`（十年 / 富士山下 / 稻香，均无专辑约束）为安全拒绝

## 5. 22 首全量 E2E（要求 6，仅在 10 首无错误接受后执行）

权威审计（`e2e-22-*-metrics.json`）：

| 指标 | 3.5 | **3.6** |
|---|---|---|
| Resolve 成功 | 9/22 = 41% | **16/22 = 73%** |
| autoPlayable | — | **16** |
| 播放（原始 SMTC 判定） | 8/9 | 12/16 = 75% |
| 播放（审计：含可解释假阴性） | — | **15/16 = 94%** |
| 整体 E2E（原始） | 8/22 = 36% | 12/22 = 55% |
| 整体 E2E（审计） | — | **15/22 = 68%** |
| wrong-artist acceptances | 0 | **0** |
| wrong-version 自动接受 | **1（E22 Live）** | **0** |
| wrong-album 自动播放 | — | **0** |
| SMTC 无法解释的分歧 | — | **0** |
| **hardFailure** | — | **False** |

延迟（22 首）：resolve p50 **2515** / p95 5662 / max 6310 ms；playback p50 3841 / p95 26798 / max 26798 ms；整体 p50 **5719** / p95 23806 / max 29557 ms；SMTC 段 p50 **144** / p95 6090 / max 6090 ms。
（playback 的 p95/max 被 3 个假阴性拉长：冻结验证器要等完超时才敢判 `WRONG_TRACK`。）

失败分类：`RESOLVE_AMBIGUOUS=6`、`URL_NAVIGATION_FAILED=1`、`SMTC_WRONG_TRACK=3`（全部被判为可解释）；拒绝码只有 `RESOLVE_AMBIGUOUS` —— 3.5 那 7 个 LOW **全部**升级为 MEDIUM/HIGH 并进入播放。

三个 `SMTC_WRONG_TRACK` 的证据（stageDetail 原文）：

| case | 实际播放 | 判定原因 |
|---|---|---|
| E01 | `playing="How Do I Make You Love Me?" status=Playing sawWrong=True` | 曲名完全正确；差异只在目录别名 `Abel Tesfaye` vs `The Weeknd` |
| E04 | `playing="Blinding Lights" status=Playing sawWrong=True` | 同上 |
| E22 | `光年之外 (电影《太空旅客》主题曲)` | 曲名只差语境标注（电影主题曲），艺人一致 |

## 6. E10 —— 唯一的播放侧失败（不是 resolver 问题）

- 解析结果正确：`Someone Like You / Adele / 21`，id `403037927`，`MEDIUM`，`autoPlayable=True`
- 深链：`https://music.apple.com/cn/song/someone-like-you/403037927`，`navMethod=AppleMusic.exe /url`
- `stageDetail`：`page unchanged within 12000ms (nav=AppleMusic.exe /url) listItems=44`
- **可复现**：22 首全量与该 case 单独重跑各失败一次；同批 E01/E04 深链正常
- 关于我做的 URL-storefront 修复：id 有效性是 storefront-scoped，深链必须用**lookup 确认过的 storefront** 构造（已修）。但对 E10 **无效**——lookup 显示该 id 在 **cn 本身就有效**，URL 未变化，所以这是**播放侧导航问题**，需要在单独的播放阶段调查，且必须先经你同意才可触碰冻结的 `am-play`。

## 7. 仍未解决 / 下一步

1. **E10 深链导航**（播放侧，冻结范围内，需授权）；
2. **6 个无专辑同分拒绝**（E08 Hello/Lionel Richie、E16 十年、E17 富士山下、E18 后来、E20 稻香、E21 演员）：新 tie 规则下它们同分且属不同录音 → 安全拒绝。要提升需引入**新的确定性证据源**（例如“正片专辑”偏好），属新工作，不得用放宽阈值实现；
3. **冻结验证器的两处盲区**（目录别名署名、语境标注标题）：本阶段只在 analyzer 里做可解释分类，**没有**改动 `poc/lib/`；
4. 若允许改动 `poc/lib/am-common.ps1` 的 SMTC 匹配器（属冻结范围，本阶段未动），上述 3 例假阴性可直接消除。

**Login 相关工作继续冻结**，未开始。

数据：`findings/phase3/e2e-20260925-194608.*`（10 首）、`e2e-20260925-194743.*`（22 首）、`e2e-20260925-195212.*`（修复后定向重跑）、`e2e-22-20260925-19522*-metrics.*`（22 首权威审计）、`resolve-test-20260925-195421.*`（别名修复后 20 例回归）。
