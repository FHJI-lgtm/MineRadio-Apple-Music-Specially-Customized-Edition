# Phase 3.7E-② 收尾 — 20 首 canonical URL 已钉住（benchmark 夹具与 resolver 解耦）

产物：`cases/songs-20-pinned.json`（20/20，含 `songId / storefront / canonicalUrl / catalogTitle / catalogArtist / catalogAlbum / titleLayer / artistLayer / editionPenalty / lookupOk / lookupTitle / lookupAlbum`）。

**20/20 pinned，20/20 `lookupOk=True`，20/20 `editionPenalty=0`（正片）**。取号走的是**公开 iTunes 数据面**，
**不经过 resolver 的 tie 规则** —— 所以"专辑版 vs 单曲版并列"**不再阻塞 benchmark**。

---

## 1. 钉住结果

| id | 曲目 | songId | sf | 目录专辑 | lookup |
|---|---|---|---|---|---|
| B01 | BIRDS OF A FEATHER | `1739659142` | tw | HIT ME HARD AND SOFT | ✅ |
| B02 | Espresso | `1744253558` | tw | Espresso - Single | ✅ |
| B03 | Good Luck, Babe! | `1737497080` | tw | Good Luck, Babe! - Single | ✅ |
| B04 | Houdini | `1714502827` | tw | Houdini - Single | ✅ |
| B05 | we can't be friends (wait for your love) | `1725913689` | tw | eternal sunshine | ✅ |
| B06 | Cruel Summer | `1468058171` | tw | Lover | ✅ |
| B07 | vampire | `1694768031` | tw | GUTS | ✅ |
| B08 | Locked Out of Heaven | `573962551` | tw | **Unorthodox Jukebox**（非 GRAMMY 合辑） | ✅ |
| B09 | Abracadabra | `1792667005` | tw | MAYHEM | ✅ |
| B10 | As It Was | `1615585008` | tw | Harry's House | ✅ |
| B11 | Believer | `1411628233` | tw | **Evolve**（非 feat. Lil Wayne 版） | ✅ |
| B12 | Counting Stars | `1822898484` | tw | **The Collection**（合辑专辑，但为录音室录音 — 见下） | ✅ |
| B13 | Numb | `528437514` | tw | Meteora | ✅ |
| B14 | Sugar | `1440855562` | **us** | **V (Deluxe)**（非 Deluxe Single） | ✅ |
| B15 | Circles | `1477887285` | tw | Hollywood's Bleeding | ✅ |
| B16 | Beautiful Things | `1736051619` | tw | Fireworks & Rollerblades | ✅ |
| B17 | Anti-Hero | `1645937758` | tw | **Midnights**（非 Bleachers feat. 版） | ✅ |
| B18 | Flowers | `1674691586` | tw | Endless Summer Vacation | ✅ |
| B19 | Kill Bill | `1658650488` | tw | SOS | ✅ |
| B20 | A Sky Full of Stars | `829910927` | tw | **Ghost Stories**（非单曲版） | ✅ |

## 2. 需要如实标注的两点

1. **B12 `Counting Stars` 的目录专辑是 `The Collection`（合辑）**：它是**录音室录音**（`editionPenalty=0`，
   标题无 Live/Remix/feat. 标记），只是所属发行是合辑。我的 edition 惩罚词表未包含 `collection`，
   因此未被标记 —— **按事实记录**，不算错误，但报告里要注明"该曲来自合辑发行"。
2. **storefront 分布：19× `tw`，1× `us`（B14）**。即这些主流曲目在 **cn** storefront 多数不可取号，
   实际取到的是 **tw**。这与 3.7A 的结论一致且无冲突：**深链的 storefront/slug 不影响导航结果**
   （同一 id 在 cn/tw/us 落到同一页面），所以 tw URL 对 benchmark 完全可用。

## 3. 实验窗口现在非常干净

```
Benchmark Window
   canonicalUrl (pinned)
        ↓
   Deep Link (AppleMusic.exe /url)
        ↓
   Apple Music UIA → Realize → 安全双击
        ↓
   SMTC = Playing
        ↓
   Restore original foreground + cursor
        ↓
     T10 / T11

Resolver（Title+Artist → canonical URL）→ **在窗口之外**
```
理由不变：resolver 每首耗 0.95–2.24s 且**完全不碰前台**；把它放进窗口会让"1–2 秒是谁烧的"无法回答，
而且 14/20 会被 tie 规则拒签，20 组根本跑不完。

**副产品记录（本轮不动产品代码）**：既然 resolver 不碰前台且可后台完成，
未来产品侧可以"**搜索结果出现时就后台预解析 canonical URL**"，用户点击后直接 deep link ——
把 1–2s 提前吃掉。这轮 benchmark 不碰此优化。

## 4. 下一步（按你确认的 ③ → ④ → ⑤）

**③ 建立测量能力**
- 外部 50ms observer：`T3`（AM 成为 foreground）、`T10`（恢复原前台）、`T11`（鼠标恢复），并声明
  **measurement resolution ≈ 50ms + 采样开销**；
- 内部（**只读返回值，不改代码**）：`t.*`/`a.*`（ensureApp/uiRoot/list/select/realize/click/smtc/e2e）、
  `contentMatchMs`、`navigateMs`；
- **空轮询基线**（不播放，只跑 observer 30s）用来量化采样开销。

**④ 20 组 baseline**：每首一次、失败**不覆盖**；产出
`Activation→UIA / Activation→click(upper bound = T6−T3) / Activation→SMTC / Foreground Occupancy / Total`
及其 **median / P90 / min / max**（并声明 min 只作下界、T5/T6 仅近似、**T7 不可得、绝不伪造**）。

**⑤ 一次只砍一刀**：`am-uia.ps1:245` 的 `Start-Sleep -Milliseconds 500` → `0`，其余一字不动，
同 20 首重跑，出对照表：`成功率 / 正确歌曲率 / SMTC Playing / Foreground Median / P90 / Min / Max / t.* / navigateMs / 失败阶段`。

**本轮未改任何代码**（resolver / A-uia / 播放 / SMTC 均未动）；未跑 benchmark。
