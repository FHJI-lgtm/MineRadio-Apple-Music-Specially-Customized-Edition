# MineRadio x Apple Music 接入方案（MVP 第一刀）

目标：让 MineRadio 从"只能监听 Apple Music"变成"能主动让 Apple Music 播放指定歌曲"。
范围严格限定在这一刀：**搜索 → 点击结果 → UIA → SMTC 验证**。不碰队列/专辑/歌手页/后台激活/COM/Apple Music 授权/S2/激活优化。

## 1. 分层与落地文件

```
MineRadio 搜索框 (public/ 渲染层，待接)
      │
      ▼
iTunes Search API ────────────────► desktop/apple-music-control.js  searchTracks()
      │  归一化结果模型                  {source, trackId, title, artist, album,
      ▼                                 artworkUrl, durationMs, collectionId,
MineRadio 搜索结果 (待接 UI)             storefront, country, previewUrl}
      │  用户点击
      ▼
Apple Music Windows UIA ──────────► desktop/apple-music-control.js  playTrack()
      │  复用已验证引擎                  └─ spawn: experiment/apple-music-windows-control/
      │                                     poc/play-song.ps1 -Title -Artist -Retries 0
      ▼
Apple Music 真正播放
      │
      ▼
SMTC ────────────────────────────► playTrack() 复读 SMTC 并与期望值比对
      │                                verifyAgainstSmtc() -> verified / mismatch[]
      ▼
MineRadio 现有歌词 / 可视化 / Artwork （不变，仍由 desktop/smtc-bridge.ps1 供给）
```

新增文件只有一个：`desktop/apple-music-control.js`（CommonJS，Electron 主进程模块，无新依赖）。
监听侧一行不改；`apple-music-api.js` / credentials / MusicKit 一律不参与。

## 2. 两条硬规则（已在代码里强制）

1. **iTunes `trackId` 不是播放 ID。** 它是 MineRadio 自己的关联 ID；`playTrack()` 只把
   `title + artist` 交给播放器，`trackId` 既不拼 URL 也不传给 Apple Music。
   代码里 `playTrack` 的注释与参数列表即该规则的执行点（`result.trackId` 从未进入 args）。
2. **UI 动作是意图，SMTC 才是事实。** 播放后再读 SMTC 并比对：
   - 一致 → `verified: true`
   - 不一致 → `verified: false` + `mismatch: ['title'|'title-version'|'artist'|'status:...']` + 期望/实际原值，
     MineRadio 直接提示"Apple Music 播放结果与目标不一致"，**不静默播放相似歌曲**。

## 3. 已验证 / 未验证（写清楚，别把"能跑"当"已验证"）

| 部分 | 状态 |
|---|---|
| iTunes 搜索面 | **已真机验证**（Node v24.19.0，真实 API）：3 条结果、字段归一化正确 |
| `verifyAgainstSmtc` | **已单测验证** 7 例：match ✓、`(Live)` → `title-version` ✗、`Extended Edit` ✗、`status:Paused` ✗、`feat.` 装饰 ✓、艺人带专辑名 ✓、错艺人 ✗ |
| 播放面（模块 → 真实点击） | **未验证**：尚未从模块跑过一次真实播放 |
| Electron IPC / 搜索 UI | **未接** |

## 4. 必须先定的一个决策：播放用哪条导航

同一个已验证引擎里有**两条**导航方式，二者都在 `Invoke-AmPlaySong` 内：

| 导航 | 触发 | 被谁验证过 |
|---|---|---|
| **链内搜索**（应用内搜索框 + 结果行选择） | 只给 `-Title -Artist`（不给 `-Url`） | 引擎的**早期 PoC 路径**（findings 10–13）；**未**经过 G0–G4 门 |
| **深链**（`AppleMusic.exe /url <canonicalUrl>`） | 给 `-Url` | **G3 3/3 + G4 20/20**（`navMethod=AppleMusic.exe /url`） |

- 你这份方案描述的是**链内搜索**那条（"UIA 搜索框 → 输入 title + artist → Enter → 定位 → 双击"），
  同时又说"不要搞 deep link / 继续用已验证的 UIA 点击路径"——这两句指向不同分支。
- **技术上的调和**："deep link"作为**导航**步骤本来就是已验证链路的一部分（它不注入鼠标/键盘，
  只是 `/url` 协议调用），真正被砍掉的应该是"把深链当成播放成功证据"。
- **因此建议（二选一，我不自行决定）**：
  - **A（推荐，最省风险）**：MVP 也用 `-Url`（由 `trackId + storefront` 构造
    `https://music.apple.com/{storefront}/song/{trackId}`），因为这一条已被 43/43 次点击验证；
    失败集合与基线一致；UI 提示与 SMTC 验证完全复用。
  - **B（贴合你文字里的用户路径）**：用链内搜索，但**必须先跑一次一次性端到端验证**
    （1 首，`Retries 0`，看 `stage` / `matchedRow` / `ambiguous` / SMTC），再谈接入——
    它没进过 G 门，不能因为"代码存在"就当已验证。

## 5. 结果模型（MineRadio 内部统一）

```js
{ source:'itunes', trackId, collectionId, title, artist, album,
  artworkUrl /* 600x600 */, durationMs, country, storefront, previewUrl }
```
`trackId` 仅用于：去重、缓存键、歌词/封面关联。**不用于播放**。

## 6. 缓存与限流（Apple 文档建议）

- 搜索请求带 `limit`，默认 12，上限 50；
- 结果按 `term|country|limit` 做内存/SQLite 缓存（TTL 建议 1 天）——**尚未实现**，属下一刀；
- 单一入口 `searchTracks()` 便于以后统一加缓存/重试/退避。

## 7. 遗留接线（下一刀，明确到文件）

1. `desktop/main.js`：`ipcMain.handle('amc:search', ...)`、`ipcMain.handle('amc:play', ...)`；
2. `desktop/preload.js`：暴露 `window.mineradio.amc.searchTracks/playTrack`；
3. `public/`：搜索框 + 结果列表 + "播放"按钮 + 失败提示条（`mismatch` 文案）；
4. 打包：`play-song.ps1` 及其 `lib/*.ps1` 需随 `desktop/` 一起进 resources（当前指向仓库内路径，
   已用 `DEFAULT_CHAIN_SCRIPT` 隔离，便于改）。

## 8. 本刀明确不做

播放队列、专辑/歌手页播放、后台激活、COM、Apple Music API 授权、S2、激活层优化、
键盘自动化（Alt+N 那类快捷键留作 UIA 不稳定时的备选，**第一版不混入**以减少变量）。

## 9. 已知陷阱（来自实验，接入时直接引用）

- **别名署名**（`Abel Tesfaye` vs `The Weeknd`）与**语境标注**会造成 SMTC 假阴性——实验里已量化，
  产品侧按 §2 规则**报为 mismatch 并附原值**，不静默原谅；是否加白名单是后续独立决策。
- **版本标记名单**目前是 `apple-music-control.js` 里手写的第一版，
  必须与解析器的 `phase3-resolve/lib/version36-markers.json` 对齐，否则搜索面与验证面对"版本"的判定不一致。
- `storefront` 必须记录**请求用的 2 字母 country**（iTunes 返回的 `country` 字段是 `USA` 这类显示值，
  不能当 URL 里的 storefront）——此 bug 已在首次烟雾测试中被抓出并修复。

## 10. 台账更新（artist identity 落地后）

| 项目 | 状态 |
|---|---|
| iTunes -> trackId | OK |
| URL 构造 | OK `us/song/out-of-time/1603171870` |
| Deep Link 导航 | OK (`mode=deeplink`, `navigated=true`) |
| UIA 定位/点击链 | OK (`音轨 7 Out of Time 3 分钟，34 秒钟`, `candidateCount=1`, 无歧义) |
| Apple Music 实际播放 | OK |
| SMTC 标题 | OK `Out of Time` |
| SMTC 艺人原始字符串 | OK `Abel Tesfaye — Dawn FM`（不写成 The Weeknd） |
| verifyAgainstSmtc | **已修复别名假阴性**：该例现在 `verified=true` / `artistLayer=alias` |
| 单测 | **8/8 PASS**（7 例既有 + 1 例别名）；负对照 `Fame on Fire — Album` -> `layer=none, ok=false` |
| 播放链故障 / URL 导航故障 | 无 |
| 仍未做 | E2E 复跑（证明模块级 verified=true）、`amc:search`/`amc:play` IPC、搜索 UI |

identity 规则的来源（只读复用，未改冻结链）：`poc/lib/am-common.ps1:64` `Normalize-AmText`、
`:134` `Test-AmSmtcArtistMatch`（**没有别名层**，只做 相等/StartsWith/Contains）；别名的唯一来源是
`phase3-resolve/lib/resolve35.ps1:41-43` 的校验过的表 + `Test-AmArtistLayer` 的层级顺序。
模块里的层级与之对齐：`exact` / `normalized`（含 Contains 形式）/ `alias` / `none`，
别名表独立于验证器（`ARTIST_ALIASES`），验证器只消费其判定。

记录措辞（订正）：SMTC 实际播放与目标歌曲一致；艺人字段存在已知的 `The Weeknd ↔ Abel Tesfaye` 署名差异，
当前验证器因此产生假阴性 —— 而不是 "SMTC = Out of Time / The Weeknd"。
