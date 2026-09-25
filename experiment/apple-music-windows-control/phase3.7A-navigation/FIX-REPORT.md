# Phase 3.7A — 最小修复 before/after

**PHASE_3_7A = FIX_VERIFIED**

改动范围：**仅** `poc/lib/am-play.ps1` 的深链导航成功判据（一处）。Resolver、version semantics、
candidate scoring、storefront ladder、SMTC 判定、retry 次数、12s timeout、target matching threshold、
analyzer、鼠标激活逻辑均**未改动**。未开始 3.7B。

---

## 1. 改了什么

```powershell
# before
$sigNow = Get-AmTreeSignature $root
if ($sigNow -ne $sigBefore) { $navigated = $true }      # 结构签名是唯一判据

# after（Phase 3.7A）
if ($sigNow -ne $sigBefore) { $navigated = $true }      # 结构签名：辅助证据
# + 内容判据（身份约束：归一化 title AND artist，绝不只看 title）
if ($contentTitle -and ($contentArtist -or (-not $Artist))) {
  $navigated = $true
  if ($contentMatchMs -lt 0) { $contentMatchMs = [int]$tPage.ElapsedMilliseconds }
}
```

即：`navigated = structuralSignatureChanged OR contentMatch`，**结构签名不再能单独判定导航失败**。
新增诊断字段：`navigated`、`contentTitleVisible`、`contentArtistVisible`、`contentMatchMs`。

**过渡态处理**：内容判据**只用于成功判据**，循环的终止条件依然是
`$pick.ok -and $pick.hadGeometry`（真实化 + 有几何）——所以 T+500 的半成品 UI 出现目标串也不会提前结束，
也没有新增任何固定 sleep。polling 间隔（300ms）与 12s 上限原样保留。

失败分支的 `detail` 也补上了内容标志，便于以后一眼看出“是没导航还是没找到行”。

## 2. E10 before/after

| | before（Phase 3.6） | after（本次修复） |
|---|---|---|
| stage | `URL_NAVIGATION_FAILED` | `TARGET_ROW_NOT_FOUND` |
| detail | `page unchanged within 12000ms (nav=AppleMusic.exe /url) listItems=44` | `page changed but no row matched "Someone Like You" (listItems=44)` |
| navigated | False | **True** |
| 目标内容可见 | 未检测 | **title=True，artist=True，T+2054 ms** |
| 播放 | 失败（导航被判失败，未进入找行） | 仍失败，但**失败点后移一层**：页面正确、目标文本可见，是**行未实现/无几何** |

- **要求核对**：旧消息 `page unchanged within 12000ms` **不再出现** ✅
- 目标可见时间：冻结链的内容检测在 **T+2054 ms** 命中（300ms 轮询粒度）；3.7A 独立仪器测得的“稳定页面出现”是 **T+1000 ms**（T+500 为过渡态）。两个数字来源不同，均如实记录。
- **没有把其他 Adele 歌曲误判成 E10** ✅：内容判据要求 title（归一化相等或以 title 开头）**且** artist 命中；
  E10 之前的用例（E09 Rolling in the Deep）不会命中 "Someone Like You"。
  更重要的是：**内容判据只影响失败分类，不能导致错误播放**——真正播放仍需 `Select-AmCandidateWithGeometry`
  选中行 + 双击 + SMTC 校验，本阶段没有放宽任何一处。
- E10 剩余问题（`TARGET_ROW_NOT_FOUND`，44 个 ListItem 中无可用几何的目标行）属 realization/geometry 层，
  **超出本次批准范围，未修**，留给 3.7B。

## 3. A/B/C 回归（同一冻结链、同一代码路径）

| case | 歌曲 | ok | stage | navigated | contentTitle | contentArtist | contentMatchMs | SMTC |
|---|---|---|---|---|---|---|---|---|
| A | How Do I Make You Love Me? | True | OK | True | True | True | 1881 | `How Do I Make You Love Me?` |
| B | 晴天 | True | OK | True | True | **False** | -1 | `晴天` |
| C | Shape of You | True | OK | True | True | True | 1023 | `Shape of You` |

- B 的 artist 未命中说明内容判据是**保守**的（没有产生误判）：B 依靠“结构签名变化 + 行几何 + SMTC”照常成功，
  证明 `OR` 语义按设计工作，也证明内容判据不会轻易误报。
- A/C 的 contentMatchMs（1881 / 1023 ms）与 3.7A 预测的“约 1 秒可见”一致。

## 4. Phase 2 冻结回归（15 次）

| | before（Phase 3.5 基线） | after |
|---|---|---|
| 成功率 | 15/15 | **15/15** |
| `zeroFailureCodes` | True | **True** |
| SMTC_WRONG_TRACK / TIMEOUT / TARGET_ROW_NOT_FOUND / CLICK_FAILED / REALIZE_FAILED / URL_NAVIGATION_FAILED / BOUNDS_INVALID / APP_NOT_RUNNING | 全 0 | **全 0** |
| e2e mean / median / p95 / max | 2966 / 2673 / 5455 / 5455 ms | 3144 / 2731 / 5893 / 5893 ms |

延迟变化如实记录：mean **+178 ms**、median +58 ms、p95/max +438 ms。原因是每轮 polling 多了一次全树内容扫描
（成功用例在找到行后即退出，影响主要落在首页冷启动的那一次）。**没有缩短任何超时**，也没有减少 retry。

产物：`findings/phase3/regression-20260925-201138.{md,jsonl,json}`。

## 5. 边界与未做

- 未修改：Resolver / version semantics / candidate scoring / storefront ladder / SMTC verification /
  retry / timeout 上限 / target matching threshold / analyzer / 鼠标激活。
- 未开始 3.7B（No-Mouse Activation），按指示单独开。
- E10 现在停在 `TARGET_ROW_NOT_FOUND`：页面正确、目标内容可见，但 44 个 ListItem 里没有可用的目标行几何。
  这正好是 3.7B（realization / 无鼠标激活）的输入，本阶段不越界修改。

## 6. 最终状态

**PHASE_3_7A = FIX_VERIFIED**
