# Phase 3.7E-② — 20 首预解析结果（**不改代码**，只调用一次/首）

**结果：KEEP 6 / REPLACE 14** —— 而且 14 首**全部**是 `RESOLVE_AMBIGUOUS`，不是"解析不到"。
证据：`reports/preresolve-20260926-083752.txt`。

---

## 1. 逐首结果

| id | 判定 | conf | songId | 解析到的曲目 / 专辑 | 备注 |
|---|---|---|---|---|---|
| B01 Birds of a Feather | **KEEP** | HIGH | `1739659142` | BIRDS OF A FEATHER / HIT ME HARD AND SOFT | ✅ |
| B02 Espresso | REPLACE | AMBIGUOUS | — | Espresso / Espresso - Single | 并列 |
| B03 Good Luck, Babe! | **KEEP** | HIGH | `1737497080` | Good Luck, Babe! / Good Luck, Babe! - Single | ✅ |
| B04 Houdini | REPLACE | AMBIGUOUS | — | Houdini / Houdini - Single | 并列 |
| B05 we can't be friends… | REPLACE | AMBIGUOUS | — | we can't be friends (wait for your love) / eternal sunshine | 并列 |
| B06 Cruel Summer | **KEEP** | HIGH | `1468058171` | Cruel Summer / Lover | ✅ |
| B07 vampire | REPLACE | AMBIGUOUS | — | vampire / GUTS | 并列 |
| B08 Locked Out of Heaven | REPLACE | AMBIGUOUS | — | Locked Out of Heaven / 2014 GRAMMY® Nominees | 并列（合辑 vs 专辑） |
| B09 Abracadabra | **KEEP** | MEDIUM | `1792667005` | Abracadabra / MAYHEM | ✅ |
| B10 As It Was | **KEEP** | HIGH | `1615585008` | As It Was / Harry's House | ✅ |
| B11 Believer | REPLACE | AMBIGUOUS | — | Believer (feat. Lil Wayne) / … - Single | 并列（不同版本） |
| B12 Counting Stars | REPLACE | AMBIGUOUS | — | Counting Stars / Native (Gold Edition) | 并列（版本） |
| B13 Numb | REPLACE | AMBIGUOUS | — | Numb / Meteora | 并列 |
| B14 Sugar | REPLACE | AMBIGUOUS | — | Sugar / Sugar (Deluxe Single) - Single | 并列（版本） |
| B15 Circles | REPLACE | AMBIGUOUS | — | Circles / Hollywood's Bleeding | 并列 |
| B16 Beautiful Things | REPLACE | AMBIGUOUS | — | Beautiful Things / Beautiful Things - Single | 并列 |
| B17 Anti-Hero | REPLACE | AMBIGUOUS | — | Anti-Hero (feat. Bleachers) / … - Single | 并列（版本） |
| B18 Flowers | **KEEP** | MEDIUM | `1674691586` | Flowers / Endless Summer Vacation | ✅ |
| B19 Kill Bill | REPLACE | AMBIGUOUS | — | Kill Bill / SOS | 并列 |
| B20 A Sky Full of Stars | REPLACE | AMBIGUOUS | — | A Sky Full of Stars / … - Single | 并列 |

耗时：每首 **0.95–2.24s**（解析本身与前台无关）。

## 2. 关键发现（比歌单本身更重要）

14 首被拒的**原因完全一致**：解析器**已经找到了正确曲目**（如 `Numb / Meteora`、`Kill Bill / SOS`、
`Counting Stars / Native (Gold Edition)`），但**同一首歌的"专辑版"与"单曲/合辑版"两侧同分** →
按 Phase 3.6 的严格规则（同分 + 不同录音 → AMBIGUOUS）被拒。

根因在 `recordingKey = normalize(title) | normalize(album)`：**键里含专辑名**，于是
"同一录音的专辑版 vs 单曲版"被判成**不同录音**，触发并列拒绝。

这不是"解析不到冷门下架歌"，而是**严格 tie 规则在"只给 Title+Artist、不给 Album"的主流歌曲上拒签率很高**：
- 22 首审计（多为带专辑或已验证曲目）：AMBIGUOUS **6/22**
- 本批全新主流歌曲（纯 Title+Artist）：AMBIGUOUS **14/20**

→ 记录为**解析器实践层发现**（Phase 3.6 严格性的代价）。**按你的纪律，本轮不动 resolver**，
只把它作为事实记录 + 影响 benchmark 夹具的决策。

## 3. 对 benchmark 的影响：**建议"钉住 URL"，不要把 resolver 放进测量窗口**

两条路，必须选一条（我建议 A）：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（建议）** | 先用 resolver/iTunes 数据面把 20 首的 **songId + canonical URL 钉住**，benchmark 只喂 URL 给冻结链 | 与 Phase 2 回归（15/15）完全同构；测量量**纯粹是 A-uia 的前台占用**；AMBIGUOUS 不影响基准 | 需要先做一次"钉 URL"步骤 |
| B | benchmark 让冻结链走 resolver（Title+Artist） | 端到端更"真实" | resolver 耗时 1–2s **且它不碰前台**，会把 resolved 的时间混进总时长，污染 foreground occupancy 对比；且 14/20 直接拒签 |

**理由**：本 benchmark 的问题是"**AM 抢占前台多久**"。resolver 不抢前台 → 必须排除在测量窗口之外。
Phase 2 冻结回归本来就是"已知 URL"模式，方案 A 与它同构、可比。

## 4. 下一步（②的收尾）

1. 对 20 首做一次**钉 URL**（数据面：iTunes search+lookup，取 `trackId`/`canonicalUrl`；
   对 B08/B11/B12/B14/B17 这类"有明确版本冲突"的，钉**录音室正片**，并在 cases 里标注 edition）；
2. 钉完后**复核**：20/20 都有 id + url，且每首都是**录音室/正片**版本（避免 Live/Remix/feat. 版本）；
3. 之后才进入 ③（observer + 空轮询基线）与 ④（20 组 baseline，每首一次、失败不覆盖）。

**本轮未改任何代码**；未改 resolver / A-uia / 播放 / SMTC；未跑 benchmark。
