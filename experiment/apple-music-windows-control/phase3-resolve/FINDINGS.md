# phase3-resolve：从 title/artist/album 自动解析 Apple Music Song ID / URL

**目标**：不预先提供 URL，研究如何可靠地自动解析出正确的 Apple Music Song ID/URL，并用已冻结的 A/B/C 三首（60/60 基线）与一批中英文同名/翻唱歌曲交叉验证。
**边界**：不改 main、不做登录、不新增依赖、URL 不硬编码进最终接口；**冻结的 UIA 播放链路（Deeplink → Realize → 双击 → SMTC）本阶段一行未改**（只被只读复用）。
**数据**：`findings/phase3/id-correspondence-*.md`、`findings/phase3/cross-validate-*.md/.jsonl`。

## 1. 首要问题：iTunes `trackId` 是不是 Apple Music 的 Song ID？

**是。** 三条独立证据：

1. 把三首已验证歌曲的 **Apple Music id** 直接喂给公开 API `lookup?id=<id>`，返回的 `trackId` 与原 id **完全一致**（P1）。
2 . 这些 id 原样出现在**实测能播放**的 Apple Music URL 里（`.../song/<slug>/1603171530`、`.../song/晴天/535824738`、`.../album/...?i=1193701392`）。
3. `https://music.apple.com/<sf>/song/<任意 slug>/<id>` 与已验证 URL 达到同一页面（P3：UIA 找到同一目标行）—— **slug 不参与定位，id 才是定位键**。

### 但 id 的可用性是"按店面"的（重要）

| 歌曲 | id | default | us | cn | tw |
|---|---|---|---|---|---|
| A `How Do I Make You Love Me?` | 1603171530 | ✅ | ✅ | ✅ | ✅ |
| B `晴天` | 535824738 | ❌ | ❌ | ✅ | ✅ |
| C `Shape of You` | 1193701392 | ✅ | ✅ | ✅ | ✅ |

- B 的 id 在 default/us 查不到 → **必须用登录店面（或店面阶梯）去查/搜**。
- 同一 id 在不同店面返回的 `artistName` 也不同：A 在 us 是 `The Weeknd`、在 cn/tw 是 `Abel Tesfaye`（见第 3 节）。

## 2. 同一首歌 ≠ 同一个 id（版本/发行维度）

`trackId` 标识的是**某个发行版里的一轨**，不是"这首歌"。实测同一首歌的多个 id：

| 歌 | 已验证 id（期望） | 解析到的其它 id | 差异 |
|---|---|---|---|
| A | 1603171530（`Dawn FM`） | 1630220632 / 1641597510 / 1641739741 | 都在 `Dawn FM (Alternate World)` 等其它版本里 |
| C | 1193701392（`÷ (Deluxe)`） | 1193700767 | `÷`（非 Deluxe） |
| Blinding Lights | 1505683988 | 1615103220 | `After Hours (Deluxe)` 的另一版 |

→ **结论：解析必须带 album（发行）约束**；当多个版本的专辑名都"包含"目标专辑名时，应优先**完全相等**的专辑名，否则同分下会按 API 返回顺序任选一个版本。

## 3. artist 信用（credit）会在店面/版本间变化

- 英文：同一首歌在不同店面分别记为 `The Weeknd` 与 `Abel Tesfaye`（艺人本名）。
- 中文：`周杰伦 / 周杰倫`、`陈奕迅 / 陳奕迅`（简体/繁体）。

影响：
- 严格匹配会让**正确答案被拒**（A 用例按定义输入 `Abel Tesfaye`、目录里是 `The Weeknd` → 直接 FAIL）。
- 也会让**播放校验失败**：`Blinding Lights` 解析正确并播放成功，但 SMTC 报 `Abel Tesfaye — After Hours (Deluxe)`，而校验用 `The Weeknd` → 判成 `SMTC_WRONG_TRACK`。

→ 结论：artist 匹配必须"拉丁严格 + CJK 容错 + 允许别名集合"，或由调用方提供 `displayArtist`/`catalogArtist` 两个字段（MineRadio 两种都有）。

## 4. cn 店面的搜索接口是空的，lookup 却正常

- `search?term=晴天…&country=cn` 常返回 0 条（甚至 400），而 `lookup?id=535824738&country=cn` 正常返回。
- 因此**搜索必须走 tw/hk/us**，解析结果再用**登录店面的 lookup**做存在性校验。

加上 `cn → tw → hk → us → default` 的店面阶梯后，中文用例从 0/5 提升到 3/4（`后来/刘若英` 仍失败）。

## 5. 交叉验证结果（12 例，storefront=cn + 阶梯）

| 结论 | 数量 |
|---|---|
| PASS（id 与已验证一致，或无 expectId 时 artist+album+title 全中） | 9 |
| EDITION（同歌、同 artist+album，但另一个发行版的 id） | 1 |
| FAIL | 2 |
| **可用合计** | **10/12 = 83.3%** |
| 真机 UIA/SMTC 复核解析出的 URL | 首轮 2/3（第三次失败原因是第 3 节艺人信用差异，不是解析错） |

关键子集：

- **翻唱陷阱**：输入 `Shape of You / Fame on Fire / Shape of You - Single` → 解析到 **翻唱版 id 1848188008** ✓，真机播放 SMTC 确认 `Shape of You / Fame on Fire — Shape of You - Single` ✓（说明"按 artist 决定"是有效的，这正是最初朴素解析器栽跟头的地方）。
- **同名不同歌手**：`Hello / Adele / 25` → `1544494392`(Adele) ✓；`Hello / Lionel Richie` → `1440645209`(Lionel Richie) ✓ —— 两个用例各自命中正确歌手（runner-up 分别出现翻唱/现场版，说明候选里确实藏着同名干扰项）。
- **中文**：`晴天/周杰伦/叶惠美` → **id 与已验证值完全一致 535824738** ✓；`十年/陈奕迅` ✓、`富士山下/陈奕迅` ✓。
- **两个失败**：`后来/刘若英`（各店面都没找到可接受的候选）；A 用例（期望 id 属于另一个发行版 + 艺人信用是本名，被判定规则算作 FAIL，但解析到的确实是这首歌）。

## 6. 建议的最终接口形态（不硬编码 URL）

```
Resolve-AmSong -Title <t> -Artist <a> [-Album <al>] [-DisplayArtist <da>] [-CatalogArtist <ca>]
  -> { ok, songId, storefront, canonicalUrl, confidence, matchedTitle/Artist/Album,
       runnerUpId/Artist, evidence(steps[]), trackViewUrl }
```

设计要点（全部由本阶段实测支撑）：

1. **店面阶梯**：登录店面 → tw → hk → us → 默认；记录命中店面。
2. **打分**：artist（严格/CJK 容错/别名）为主权重 → title（精确 > 前缀 > 包含）→ album（**精确相等 > 包含**）→ kind=song。
3. **只接受** title 命中且 artist 命中的候选；把 runner-up 一并返回（暴露同名/翻唱风险）。
4. **返回前用 lookup 校验**：`lookup?id=<id>&country=<登录店面>` 必须能查到同一 track（廉价、无需打开 App），否则降级/继续搜索。
5. **URL 由 id 构造**（`https://music.apple.com/<sf>/song/<slug>/<id>`，slug 任意）或直接用 API 的 `trackViewUrl`；**不把任何具体 URL 写进接口**。
6. 把 `confidence` 暴露给调用方（例如"album 精确相等 + artist 命中"= high；仅 title 命中 = low，需要人工/回退）。
7. 播放仍交给**冻结的** UIA 链路：`songUrl → Invoke-AmPlaySong -Url`（本阶段未改动它）。

## 7. 尚未解决 / 下一步

- `后来/刘若英` 这类用例需要**更多候选来源**（例如 `attribute=artistTerm` 的定向搜索、或按 album 反查再取 track），当前只用 `entity=song` 的一般搜索。
- 版本选择需要"精确专辑名优先"的打分细则（本阶段只做了包含匹配）。
- 艺人别名表（The Weeknd ↔ Abel Tesfaye；简繁映射）目前靠"容错 + 调用方双字段"，没有内置别名表。
