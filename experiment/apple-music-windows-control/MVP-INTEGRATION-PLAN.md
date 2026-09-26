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

## 11. E2E 复跑（identity 落地后）：模块级链路闭环

命令规格：`Out of Time` / `The Weeknd` / `Retries 0` / 一首 / 走已验证的 `-Url` 路径 / 未动 IPC 与搜索 UI。

| 字段 | 实测 |
|---|---|
| navigated / mode | true / deeplink |
| candidateCount / ambiguous | 1 / false |
| matchedRow | `音轨 7 Out of Time 3 分钟，34 秒钟` |
| actualTitle / actualArtist | `Out of Time` / **`Abel Tesfaye — Dawn FM`** (raw SMTC) |
| **verified / artistLayer** | **true / alias** |
| artistObserved / artistObservedAlbum | `Abel Tesfaye` / `Dawn FM` |
| mismatch / titleOk / artistOk | [] / true / true |
| chainStage / chainOk | `SMTC_WRONG_TRACK` / false |
| **disagreement** | **true** |

**预期订正**：`stage` **不是** success。冻结链自己的艺人匹配器（`Test-AmSmtcArtistMatch`）没有别名层，
且我们不改冻结链，所以它仍报 `SMTC_WRONG_TRACK`；模块基于观测到的 SMTC 独立判定为 `verified=true`。
两者**并列报告**（`chainStage`/`chainOk` 与 `verified`/`artistLayer`），并用 `disagreement` 标出分歧。

**措辞（不得含糊）**：SMTC 返回的是 `Out of Time` / **`Abel Tesfaye — Dawn FM`**，不是 The Weeknd；
identity 层只是确认它与目标 `The Weeknd` 属于同一已知艺人别名对，
**不得**记成 "SMTC 返回了 The Weeknd"。

**结论**：`iTunes -> -Url -> Apple Music Windows -> 真实播放 -> SMTC -> verified` 模块级链路**闭环**。
仍未做：`amc:search`/`amc:play` IPC、搜索 UI。

## 12. 台账定稿（IPC runtime 记为 untested）

| 层 | 状态 | 依据 |
|---|---|---|
| 底层 Apple Music 播放链 | OK | `9461ce9`（真播放 E2E） |
| SMTC identity / alias | OK | 8/8 单测 + 真实 E2E（`artistLayer=alias`） |
| main/preload 静态接缝 | OK | `f0cf061`（纯搬运，`node --check` 通过） |
| Electron runtime 真实性 | OK | 42.4.1 / `electron.exe`（`process.versions.electron` + `execPath`） |
| Electron IPC runtime 跳 | **— untested** | 5 次 harness/app 启动尝试均止于环境墙，见 `REPORT-IPC-HARNESS-LIMIT.md` |
| IPC 透明性对照 | **— untested** | 依赖上一行 |

`—` 的字面含义是 **untested**：既不是失败，也不是"推测通过"。
为填这个勾而引入 `ws`、改依赖、研究 Electron 单实例与启动参数，属于扩大变量，已明确停止。

本轮边界复核：未碰 `public/js/modules/05-playback/07-search.js`、未碰 provider 注册表与 `provider-fallback`、
未碰 `server.js` / `apple-music-api.js` / 搜索 UI；`poc/lib` 与 `0170bca` 逐文件一致；`main` 与 `origin/main` 仍 `4a6ae2f`；
Apple Music 全程保持 Paused（无任何播放副作用）。

## 13. 下一步 ④-search（只接搜索，不接播放按钮）

隔离原则：**新增一个平行面板，不进入既有 provider 链**。

```
新面板搜索框
   -> window.mineradio.amc.searchTracks({ query, country, limit })
   -> amc:search (IPC, 静态接缝 f0cf061)
   -> desktop/apple-music-control.js searchTracks()
   -> iTunes Search API
   -> 结果列表（trackId/title/artist/album/artwork/durationMs/storefront）
```

- 只显示结果；**播放按钮这一刀不接**，避免把已验证的 `-Url -> SMTC -> identity` 链重新卷进 UI 变量。
- 失败时责任分层清晰：UI / preload / IPC（理论上）/ iTunes API —— 四者可单独定位。
- 需要先读 `public/index.html` 与一个既有模块，确认脚本挂载与命名约定（本仓库模块按编号目录组织），再落地。
- 已知风险：本仓库文档/JSON 的 PowerShell 读取陷阱（CONTROL-PLANE §7.5）——UI 调试输出请用浏览器 console 或 .NET 读取，别用 `Get-Content` 做行数判据。

## 14. 台账更新：04-search 已在真实 app 中验证（2026-09-26 12:06）

| 层 | 状态 | 依据 |
|---|---|---|
| 面板挂载与渲染 | OK | 真实 app 截图：浮动按钮 + 面板 + 结果列表 |
| **Electron IPC runtime 跳** | **OK** | 面板调用 `window.mineradio.amc.searchTracks()` 成功返回 iTunes 结果 |
| iTunes 数据面（UI 内） | OK | 每行含封面/标题/艺人—专辑/`trackId`/`storefront`/时长 |
| IPC 透明性（playTrack 那一跳） | **— 仍未验证** | 面板按设计没有播放按钮，未调用 `amc.playTrack`；模块级播放链另见 `9461ce9` |
| 既有 provider 链 | 未触碰 | `07-search.js` / provider 注册表 / `provider-fallback` / `server.js` / `apple-music-api.js` 均无改动 |

**长绕路的根因（存档）**：`node_modules\electron\dist\*` 是 OneDrive 按需占位符（`Archive, ReparsePoint`），
app 模式无法加载运行时，在任何 JS 之前以 `0x80000003 STATUS_BREAKPOINT` 静默死亡；Node 模式仍可运行，
于是出现"一种情况看到 shim 报错、另一种情况什么都没有"。项目已水合并迁移至 `F:\mineradio-apple-music`。

## 15. 旧 apple provider 移除：运行时 UI 已验证（2026-09-26 12:17，commit 6ab8c5f）

截图取自 F: 上运行的 app：

| 检查项 | 实测 |
|---|---|
| 搜索模式标签 | `All` `NE` `QQ` `KG` `QS` `SP` `Podcast` —— **`AM` 标签消失** |
| provider 顺序 | 其余五个未变 |
| amc 通道 | 左下角 `AM App 搜索` 仍存在 |
| app 启动 | 正常 |

未覆盖：逐 provider 的实际搜索请求（本次未输入查询）；`amc:playTrack` 的 IPC 跳（面板按设计无播放按钮）。

最终架构：5 个原生 provider（netease/qq/kugou/qishui/spotify）+ 独立 `amc` 通道（iTunes Search API → Apple Music Windows → SMTC → `verifyAgainstSmtc`）。

## 16. 搜索栏 AM 标签：运行时已验证（2026-09-26 12:31）

标签栏 `All NE QQ KG QS SP AM Podcast`；AM 标签下查询返回仅 Apple Music App 分区（4 条，含封面/trackId/storefront/时长）；无播放按钮；浮动按钮已移除。

链路：搜索栏 → AM 模式 → `window.mineradio.amc.searchTracks()` → preload → `ipcMain('amc:search')` → `apple-music-control.js` → iTunes Search API → 自有 AM 结果模型 → 结果区。

本刀修掉两个自身缺陷：`b442b3c`（AM 分支使用了声明在之后的 `requestSeq`，导致结果被守卫全部丢弃、永远停在加载文案）、`b056ed8`（换行丢失的格式瑕疵）。

边界未变：provider 注册表仍只有 5 个；无 `searchProviderUrl('amc')`、无 song 模型转换、`07-search.js` 内无 `playTrack`；frozen `poc/lib` 与 `0170bca` byte-identical。

## 18. 全自动端到端通过（2026-09-26 12:50，用户验收："我没动鼠标"）

点击 AM 结果后，链自行滚动定位折叠线下的曲目行 → 合成双击 → **Apple Music 自动最小化** → 行内绿色判定：
`SMTC 已验证 · 艺人匹配层：alias · 链与模块判定不一致 · SMTC 实际艺人：Abel Tesfaye — Dawn FM`。

链路：`搜索栏 AM 标签 → amc.searchTracks → 自有 AM 结果模型 → 点击 → amc.playTrack → canonicalUrl/-Url → Apple Music Windows → 自动滚动定位 → 合成双击 → 最小化 → SMTC → verifyAgainstSmtc`，全程无需人工介入，且不把 iTunes 结果转成 song、不碰 provider 注册表。

冻结链：`am-uia.ps1` / `am-smtc.ps1` / `am-common.ps1` 仍与 `0170bca` byte-identical；`am-play.ps1` 为**经授权例外**（materialize 滚动 + 点击后最小化），当前 SHA256 `5222963476E757089E3E2F32889461F74EF4B0C7A035603F57EBDCB6DF4A62DE`。

已知上限：materialize 最多 8 步、间隔 1000ms，超长歌单可能仍需更多（两个常量即可调整）。

## 19. Web 轴迁移：阶段状态（checkpoint 5014d4c，2026-09-26）

| 阶段 | 状态 | 证据 |
|---|---|---|
| Step 0 Web auth playlist probe | ✓ | 只读 GET：`/v1/me/library/playlists` + bearer + media-user-token → 200（4 条）；仅 bearer → 403；仅 media-user-token → 401 |
| Step 1 webAppleApi | ✓ | `desktop/apple-music-web-api.js`（复用 `getWebPlayerBearer`，不重造抓取器；`setCredentialSource` 注入；401/403 语义分离；模块内 `setReadOnly`） |
| Step 2 mapper compatibility shadow | ✓ | `scripts/apple-music-web-mapper-compat.js` + `REPORT-WEB-MAPPER-COMPAT.md`：Web JSON 直喂旧 mapper 产出完整 canonical 对象（playlist 13 键 / track 30 键），valueMismatch=0 |
| Developer retirement | **NOT STARTED** | 仅新增 1 行 testability 导出（`mapAppleLibraryPlaylist` 进 `_test`） |
| UI auth-axis migration | **NOT STARTED** | `appleLoginStatus.loggedIn` 等判据一行未动 |
| Write-operation probe | **NOT STARTED** | 未做任何 POST/PUT/DELETE；shadow 脚本强制 GET |

### 本轮钉死的两个事实

1. **ID 语义**：library track id = `a.<catalogId>`，且 `playParams.catalogId` 单独可用；library playlist id 是 `p.*`、其 `playParams.catalogId` 为 `undefined`。catalog 与 library 命名空间可区分，但**未经批准不得据此提前改播放层**（`amc.playTrack(trackId+storefront)` 的接入属后续阶段）。
2. **两个待追踪字段**：`isrc` 在 Web library payload 中**缺失**（canonical 的 isrc 由旧 mapper 派生/兜底）→ 应作为「Web API 数据缺失项」处理，**不为迁移人为补来源**；`trackCount` 同为 mapper 派生，属可后查、**非阻塞**项。

### 已冻结（本阶段未做，需单独批准）

Developer 退役 / UI 认证轴切换 / 写操作探测（`POST|DELETE /v1/me/library`）/ 旧 `/api/apple/*` 改动 / SMTC / AMC / `poc/lib/*`。

### 下一阶段候选（需批准后才动）

只读扩大 shadow：`GET /v1/me/library/albums` 与 `GET /v1/me/library/songs`（判断收藏/资料库读取能否迁到 Web 轴），**仍不碰写操作**。
