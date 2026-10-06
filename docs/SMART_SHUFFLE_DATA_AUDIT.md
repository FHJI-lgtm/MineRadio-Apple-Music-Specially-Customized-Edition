# MineRadio Smart Shuffle 可用数据审计

> 审计日期：2026-10（只读审计，未改动任何业务代码）
> 审计对象：MineRadio (Apple Music Edition) `F:\mineradio-apple-music`
> 方法：全仓 grep/read，所有结论附 `文件:行号` 证据。区分 **(a) 可读** / **(b) 可写可控** / **(c) 不存在**。

---

## 0. 一句话结论

MineRadio 今天能**稳定**拿到的用户行为数据只有一份：**渲染进程 localStorage 里的本地收听统计**
（`mineradio-listen-stats-v1` + `mineradio-listen-rollup-v2`）和**当前队列快照**（`mineradio-last-playback-v1`）。

其余全部是**状态读取**（SMTC 现在在放什么、平台库里有什么），不是**行为记录**。
最关键的三类负反馈信号——**跳过（尤其短跳过）、seek、播放失败**——今天**完全没有落盘**；
Apple Music 侧**没有任何官方推荐 API、没有红心读写、没有最近播放**，且 Developer/MusicKit 轴已整体退休。

**结论：Smart Shuffle 的第一步不是写算法，而是先补一个 append-only 的本地播放事件表。**
但"补埋点"**不阻塞**写算法——P0（黑匣子）与 P1（Fewer Repeats）可以**同一天开工**，P2 的框架也能立刻用固定/模拟数据写完并跑通单测；
真正需要等两周的只有**权重**，不是**代码**。详见 §5.7 / §5.8。

---

## 1. 数据源盘点

| # | 数据源 | 实现位置 | 性质 |
|---|---|---|---|
| 1 | SMTC（Windows 系统媒体会话） | `desktop/smtc-bridge.ps1`、`public/js/modules/12-smtc/00-smtc-store.js` | 只读状态 + 播放控制 |
| 2 | Apple Music Windows 控制链（AMC / UIA） | `desktop/apple-music-control.js`、`experiment/apple-music-windows-control/poc/*.ps1` | 可控（合成点击） |
| 3 | 当前播放队列 | `public/js/modules/00-state/00-core-stores.js` `playQueue`/`currentIdx` | 自有内存态 + 快照落盘 |
| 4 | 播放历史 / 行为统计 | `public/js/modules/05-playback/02-listen-stats.js` | 本地 JSON（**唯一真行为数据**） |
| 5 | MineRadio 本地存储 | localStorage + Electron userData | 本地文件 |
| 6 | Apple Music API / 登录能力 | `desktop/apple-music-web-api.js`、`apple-music-web-reads-api.js`、`apple-music-library-cache.js` | 非官方 Web 私有接口，**只读** |

补充数据源（审计中发现，对候选池有用）：
- 各家平台资料库适配器：`netease-library-adapter.js` / `qq-library-adapter.js` / `kugou-library-adapter.js` / `qishui-library-adapter.js` / `spotify-library-adapter.js`
- 本地导入音乐：`desktop/local-music-library.js`（`<userData>/local-music-library.json`）
- 本地音频分析（BPM/节拍）：`public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js`（vendor `music-tempo`）、`01-audio-beat-analysis.js`、缓存 `mineradio-local-beatmaps-v1`

---

## 2. 每个源能拿到的数据

### 2.1 SMTC

**契约**（`desktop/smtc-bridge.ps1:180`）：每行 compact JSON —
`{ type, active, title, artist, album, status, isPlaying, durationMs, positionMs, lastUpdatedMs, aumid, thumbnail }`

| 能拿到 | 证据 |
|---|---|
| 曲名 / 艺人 / 专辑（**字符串**） | `smtc-bridge.ps1:185-187` |
| 时长、播放位置、采样时间戳 | `smtc-bridge.ps1:220-222` |
| 播放状态（Playing/Paused/…） | `smtc-bridge.ps1:210-211` |
| 来源应用 AUMID | `smtc-bridge.ps1:181` |
| 专辑封面（base64 data URL） | `smtc-bridge.ps1:70-120, 191-202` |
| 事件：媒体属性 / 播放信息 / 时间轴变化 | `smtc-bridge.ps1:130-139`（150ms 节流 `:24, :163`） |
| 控制：play / pause / toggle / next / previous / refresh | `smtc-bridge.ps1:240, 264-...` |
| 渲染端平滑后的进度 | `00-smtc-store.js:98-106`（锚点外推 v4） |

**拿不到**：曲目 ID、专辑 ID、**播放队列**、喜欢状态、跳过事件。

**三个必须知道的限制**：
1. Apple Music 的 SMTC position 采样间隔约 2~4s（`00-smtc-store.js:53-54`），不能当精确播放时钟。
2. 切歌判定只比较 `title/artist/album/aumid` 字符串（`00-smtc-store.js:175-178`）⇒ **同一首歌连续重播不会触发 track-reset**，从 SMTC 侧无法区分"重播"与"回拖"。
3. SMTC 只反映**外部 Apple Music 应用**的播放；MineRadio 内部播放器（网易云/QQ/酷狗/汽水/Spotify/本地）走的是自己的 `<audio>`，与 SMTC 无关。

### 2.2 Apple Music Windows 控制链（AMC）

链路（`apple-music-control.js:7-12`）：搜索走 **iTunes Search API** → 结果模型 → **Apple Music Windows UIA 合成点击** → **SMTC 校验**。

| 能力 | 证据 |
|---|---|
| 目录搜索（公开，无鉴权） | `apple-music-control.js:32, 76-86` |
| 播放单曲（应用内搜索路径，只传 title+artist） | `playTrack` `apple-music-control.js:452` |
| 播放资料库专辑 | `playAlbumInLibrary` `:519` |
| 播放歌单 / **歌单随机播放** | `playPlaylist` `:571`、`playPlaylistShuffled` `:661` |
| **意图 vs 事实** 判定 | `verifyAgainstSmtc` `:385`，「UI action is INTENT; SMTC is the FACT」`:18-19` |

**硬规则**：不涉及任何 Apple 凭据 / Developer token / MusicKit（`:20`）。
**注意**：这条链天然产出"MineRadio 请求播放 X，实际播放 Y"的差异信息（`SMTC_WRONG_TRACK` 等 verdict，`:427-501`），**但目前完全没有持久化**——这是最便宜的一份行为数据，现在是丢掉的。

### 2.3 当前播放队列

- 表示：`var playQueue = [], currentIdx = -1`（`00-core-stores.js:22`），**MineRadio 自有数组**，不是平台歌单+索引。
- 当前项取用：`currentQueueSong()`（`06-track-detail-lyrics-actions.js:3-6`）。
- 歌曲身份：`queueItemKey(song)`（`09-queue-snapshot-autoplay.js:2-12`）——**已有跨源归一键**，Apple/Spotify/QQ/酷狗/本地各分支。

| 能拿到 | 证据 |
|---|---|
| 队列全量、当前索引 | `00-core-stores.js:22` |
| 下一首（尾部可能分页未加载） | `14-player-controls.js:664-665`；分页 `:650-652` |
| 队列快照落盘 | `09-queue-snapshot-autoplay.js:49-60` |
| 播放模式 | `playMode ∈ {loop, shuffle, single}` `14-player-controls.js:760-770` |

**快照字段**（`mineradio-last-playback-v1`）：`version, savedAt, reason, currentIdx, currentTime, duration, playing, current, queue`（`09-queue-snapshot-autoplay.js:50-60`），`queue` 最多 120 首，白名单字段见 `:16-28`。

**限制**：
- `reason` 是"最后一次写入者"的标签（2.5s 节流），**不是事件流**。
- 外部 Apple Music 播放**不写** MineRadio 进度（`currentQueueSong` 注释 `06-track-detail-lyrics-actions.js:1-2` 刻意如此）。
- 失败会跳索引（`11-provider-fallback.js:590-601`）。

### 2.4 播放历史 / 行为统计（**今天唯一的真行为数据**）

**`mineradio-listen-stats-v1`**（`02-listen-stats.js:140-159`，key `00-core-stores.js:228`）：
- `history[]`：≤180 条，**按 key 去重**（`02-listen-stats.js:261`）⇒ 每首歌只保留最近一次，**不能当播放流水**
- `songs{key: {plays, listenMs, completed, lastPlayedAt}}`（`:262-271`）
- `artists{name: {plays, listenMs, lastPlayedAt}}`（`:272-280`）

**`mineradio-listen-rollup-v2`**（`:30-47`）：`totalListenMs, sessions, daily{listenMs, sessions, completed}`

**单条记录字段**（`:236-260`）：`sessionId, key, id, mid, mediaMid, hash, mixSongId, albumId, providerSongId, spotifyId, uri, type, sourceKey, provider, resolvedPlaybackProvider, name, artist, cover, source, playedAt, listenMs, completed, context`

**listenMs 的算法**：靠 `audio.currentTime` 增量与墙钟取小（`:202-214`），单帧上限 4.2s，快进不计入。

**记录门槛（关键缺陷）**（`:232-233`）：
```js
var effective = completed || session.listenMs >= 45000 || session.maxProgress >= 0.5 || ...;
if (!effective) return;   // ← <45s 且 <50% 的跳过早退，不留任何记录
```

**服务端**：`/api/listen/report`（`server.js:4867`）**不落本地历史**，只做平台上报（网易云 scrobble / 汽水 recent-play），其余平台直接返回 `PLATFORM_DURATION_WRITE_UNAVAILABLE`（`server.js:4768-4771`）。
唯一的服务端持久化文件是 `listen-sync-journal.json`（`server.js:200, 256-269`）：仅 `{provider, songId, submittedAt, accountDurationSync, historySynced}`，≤600 条，且**只在网易云/汽水成功提交时写入** ⇒ 不是通用播放历史。

### 2.5 MineRadio 本地存储

**行为相关 localStorage key**：

| Key | 内容 |
|---|---|
| `mineradio-listen-stats-v1` | 收听统计（见 2.4） |
| `mineradio-listen-rollup-v2` | 每日收听汇总 |
| `mineradio-last-playback-v1` | 队列 + 进度快照 |
| `mineradio-startup-resume-mode-v1` / `-startup-autoplay-v1` | 启动恢复偏好 |
| `mineradio-search-history` | 搜索历史 |
| `mineradio-playback-quality-v1` | 音质偏好 |
| `mineradio-custom-covers` / `mineradio-custom-lyrics-v1` | 用户自定义封面/歌词 |
| `mineradio-local-beatmaps-v1` | 本地 BPM/节拍缓存（**仅本地文件、上限 12 条**，`03-local-beat-cache-modal.js:126-149`） |
| `mineradio-playlist-reorder-v1` | 歌单排序 |
| `mineradio-cuefield-automix-v1` | AutoMix 设置 |
| `mineradio-provider-vip-audit-v1` | VIP 审计缓存 |

**userData 文件**（`desktop/main.js`）：`.apple-music-lyrics-credential.json`、`apple-music-library-cache.json`、`apple-music-artist-cache.json`、`apple-playlist-counts.json`、`local-music-library.json`、`listen-sync-journal.json`、`current-fx-autosave.json`、`startup-state.json`、`apple-music-stealth.json`、各平台 cookie/`.spotify-token.json` 等。

> 注意：**`playMode` 不落盘**，重启永远回到 `'loop'`。

### 2.6 Apple Music API / 已有登录能力

**认证（两条腿，都不需要 Developer 凭据）**：
1. **AMPWeb bearer** —— 从 `music.apple.com` 主 bundle 抓取 `iss === 'AMPWebPlay'` 的 JWT（`apple-music-web-lyrics.js:212-234`），**纯内存缓存，不落盘**（`:194, 207-210`）。
2. **media-user-token** —— 登录窗口从 `persist:mineradio-apple-login` 分区读 cookie（`main.js:195-199, 3252-3268`），或手动粘贴（`06-apple-account-settings.js:421-462`）。
   落盘：`<userData>/.apple-music-lyrics-credential.json`，`{v, enc, mediaUserToken, updatedAt}`，`safeStorage`(DPAPI) 加密（`apple-music-lyrics-credential.js:33, 122-127`）。

**基址与端点封装**：`AMP_API = 'https://amp-api.music.apple.com'`（`apple-music-web-api.js:21`）；`getLibrary() → /v1/me/library<path>`（`:143-145`）；`getCatalog() → /v1/catalog/<sf><path>`（`:137-140`）。

**实际调用的读端点**：

| URL | 返回 | 证据 |
|---|---|---|
| `GET /v1/me/library/playlists` | 资料库歌单列表 | `apple-music-web-reads-api.js:93` |
| `GET /v1/me/library/playlists/<id>/tracks` | 歌单曲目 | `:161` |
| `GET /v1/me/library/songs` | 资料库已保存歌曲 | `:160` |
| `GET /v1/me/library/albums` | 资料库专辑（含 `dateAdded`） | `:357` |
| `GET /v1/me/library/albums/<id>/tracks` | 专辑曲目 | `:490` |
| `GET /v1/catalog/<sf>/albums/<id>?include=tracks` | 目录专辑详情 | `:415` |
| `GET /v1/catalog/<sf>/{songs,artists}/<id>` | 艺人关系 / 艺人对象 | `apple-music-library-cache.js:571, 598` |
| `GET /v1/catalog/<sf>/songs/<id>/syllable-lyrics` | 逐词 TTML 歌词 | `apple-music-web-lyrics.js:1108` |
| `https://itunes.apple.com/search`（非 Apple Music API） | 目录搜索 | `apple-music-control.js:32, 76-86` |

**只读是硬门禁**：`setReadOnly(true)` 打开后，非 GET 在模块内直接抛错（`apple-music-web-api.js:37, 99-102`；开启于 `main.js:5817`、`apple-music-web-reads-api.js:67`）。

**稳定性警告**（`apple-music-web-api.js:8-10` 原文）：bearer 是从 Apple 网页播放器 bundle 里抓的，**不是稳定公开 API，Apple 任何一次前端发版都可能失效**。

### 2.7 其它平台的库 / 喜欢能力（对照）

`server.js:4822-4863`（`/api/platform/capabilities`）：

| 平台 | 歌单 | 喜欢读 | 喜欢写 | 专辑收藏 | 上报收听 |
|---|---|---|---|---|---|
| netease | ✅ | ✅ | ✅ | ✅ | `experimental-unverified` |
| qq | ✅ | ✅ | ❌ | ❌ | ❌ |
| kugou | ✅ | ✅ | ✅ | ❌ | ❌ |
| qishui | ✅ | ✅ | 需登录 | 需登录 | `recentPlayReport`（不带上报时长） |
| spotify | ✅ | ✅ | 视 scope | 视 scope | ❌ |
| **apple** | ✅ | ✅ | **⚠️ 描述过期** | **⚠️ 描述过期** | ❌ |

**Apple 的"喜欢读"名不副实**：`APPLE_LIKED_PLAYLIST_ID = 'apple-liked'`（`apple-music-api.js:25`）虽然常量叫 liked，UI 名是「Apple Music 资料库」（`apple-music-web-reads-api.js:104-116`），内容实际读 `/v1/me/library/songs`（`:159-160`）——**不是红心**。

> 另注：Apple 的"资料库艺人"不是 Apple 端点。全仓**没有** `/v1/me/library/artists`；`/api/apple/library/artists`（`server.js:5819`）是从本地索引聚合，再用 `catalogId` 去 `/v1/catalog/<sf>/artists/<id>` 补艺人对象（`06-music-library.js:613`、`apple-music-library-cache.js:598`）。

---

## 3. 拿不到的数据（硬边界）

**不要假设 Apple Music 有 Spotify 那种推荐 API。** 审计结果：

**Apple 轴：Apple 侧不存在的能力**
1. **无官方推荐 API**：`/v1/me/recommendations`、similar、For You、station 全仓 **0 命中**。
2. **无 MusicKit、无 Developer Token / Team ID / Key ID / P8 / ES256 JWT**：已整体退休（`apple-music-api.js:6-12`、`server.js:5752-5761`，附 `experiment/apple-music-windows-control/REPORT-DEVELOPER-API-RETIREMENT-AUDIT.md`）。
3. **无红心/loved 读取**：无 `/v1/me/ratings/*`。
4. **无红心/收藏写入**：`/api/apple/song|album/like*` 四条路由已删（`server.js:5785-5787`），UI 入口置灰。
5. **无最近播放**：无 `/v1/me/recent/played`。资料库的"最近添加"是 `dateAdded` 排序，是**加入时间**不是播放历史。
6. **无播放队列 / now playing API**（`apple-music-control.js:21` 明示 "No queue … in this slice"）——只能靠 SMTC。
7. **无用户 profile**：`nickname: ''`（`apple-music-web-reads-api.js:282`）。
8. **无无 DRM 直链**：`/api/apple/song/url` 是纯 stub，`playable: false`（`apple-music-api.js:189-215`）⇒ Apple 曲目实际播放靠**换源**。

**全平台：MineRadio 不存在的能力**
9. **无任何平台的"最近播放"读取**（唯一例外是汽水支持**写** recent-play）。`record_recent_voice` 只服务播客（`server.js:4185`）。
10. **无云端用户画像 / 无账号级行为**：所有收听数据只在本地 localStorage，服务端不落历史。
11. **无播放事件流**：无 end reason、无 next/prev 方向、无 seek、无 pause、无 error、无播放模式。
12. **无短跳过记录**：<45s 且 <50% 的跳过**零记录**。
13. **无曝光日志**：推荐了但没播的曲目无处记录 ⇒ **今天无法评估任何推荐效果**。

**审计中发现的 3 个真实不一致（建议顺手修，都不属于重构）**

| # | 问题 | 证据 |
|---|---|---|
| 1 | `/api/platform/capabilities` 声称 `apple.likeWrite: true, albumCollect: true`，但对应路由已删除、UI 已置灰 —— **过期描述** | `server.js:4855-4862` vs `:5785-5787` |
| 2 | `appleWebCredentialSnapshot()` 调用 `store.read()` / `store.get()`，而凭证 store 只暴露 `getStatus()` 与 `readTokenForMainProcess()` ⇒ `snap` 恒为 `{}`，`storefront`/`authorizedAt` 恒空（不影响 `loggedIn`，token 另有来源） | `apple-music-web-reads-api.js:265` vs `apple-music-lyrics-credential.js:144, 153` |
| 3 | 工作区有 untracked 目录 `%SystemDrive%/`（内含 Windows Caches 的 .db）——变量未展开产生的垃圾目录 | `git status` 显示 `?? %SystemDrive%/` |

---

## 4. 我们自己必须开始记录的数据

**原则：先记录，后推荐。** 建议新增一个 append-only 模块 `public/js/modules/05-playback/02b-play-events.js`，与现有 `02-listen-stats.js` 并存（不替换，避免回归）。

### 4.1 播放事件表（最小充分集）

每次"一首歌的播放会话结束"写一条（**不做去重、不做门槛丢包**）：

```js
{
  v: 1,
  sessionId,                      // 已有 createListenSessionId()
  key,                            // 已有 queueItemKey() —— 跨源归一键，直接复用
  provider, sourceKey, resolvedPlaybackProvider,
  name, artist, album, albumId, durationMs,

  startedAt, endedAt,
  listenMs,                       // 已有算法，直接用
  maxProgress,                    // ← 现在只在内存里，必须补进记录（02-listen-stats.js:213 vs :236-260）
  endReason,                      // 'ended' | 'next' | 'prev' | 'error' | 'quality-switch'
                                  // | 'source-fallback' | 'queue-jump' | 'shutdown'
  userInitiated,                  // ← 调用链里已有！nextTrack(userInitiated) 14-player-controls.js:639
  playMode,                       // loop | shuffle | single
  insertedBy,                     // 'user' | 'shuffle' | 'smart-shuffle' | 'radio' —— 推荐 provenance
  scoreBreakdown,                 // 仅当 insertedBy !== 'user' 时写入
  context                         // 已有 activeRadioContext 通道，原样带上
}
```

**为什么这些真的拿得到**（不是设计幻想）：
- `userInitiated` 今天已经在 `nextTrack(userInitiated)` / `prevTrack(userInitiated)` 的入参里（`14-player-controls.js:639, 670`），UI 按钮传 `true`（`index.html:1472, 1480`），自动前进 `nextTrack(undefined)`（`13-playback-start-audio.js:887`）——**只差把它写下来**。
- `ended` 今天已经能区分（`finalizeListenSession(true)`，`:884, :1283`）。
- `maxProgress` 今天已经在算（`:213`），只是没进 record。
- provenance 字段已有先例：`playbackMode` / `recommendationSource` 已在快照白名单里（`09-queue-snapshot-autoplay.js:21`）。

### 4.2 补埋点清单（按性价比排序）

| 优先级 | 埋点 | 现状 | 落点 |
|---|---|---|---|
| P0 | 短跳过（<45s） | **完全丢弃**（`02-listen-stats.js:233`） | 去掉门槛，改为按 `endReason` 分类 |
| P0 | next/prev 方向 | 未记录 | `nextTrack`/`prevTrack` 传入 `endReason` |
| P0 | 播放失败/换源 | 仅内存 `_lastPlaybackFailAt`（`11-provider-fallback.js:571-575`） | finalize 时带上 |
| P1 | seek 事件 | 仅瞬时快照 `reason:'seek'`（`04-progress-seek.js:442`，被下一 tick 覆盖） | 独立计数 |
| P1 | `playMode` 持久化 | 重启丢失 | 一个 localStorage key |
| P1 | 曝光日志（推荐了但没播） | 无 | 插入候选时写一条 pending |
| P2 | 请求 vs 实际（AMC verdict） | 未持久化（`apple-music-control.js:385-501`） | 播放后写一条 |
| P2 | 暂停事件 | 仅播放器状态 | 可选 |

**存储建议**：事件量级（每天几十条）远超 localStorage 的合适体量，建议放 **IndexedDB**（`mineradio-play-events`，按 `startedAt` 建索引），保留 90 天或 5 万条滚动淘汰；聚合结果（每首/每艺人的统计）仍写回 localStorage 供 UI 同步读取。

---

## 5. 推荐方案

**约束前提**：不重构推荐系统；不引入云端；不动 provider 播放链路。所有改动收敛到"一个埋点模块 + 一个评分模块 + 两个接入点"。

### 5.1 本地行为统计

以 `songs{key}` 为聚合粒度，从 4.1 的事件流离线算出：

| 指标 | 定义 | 用途 |
|---|---|---|
| `plays` | 有效会话数 | 偏好强度 |
| `completionRate` | `completedPlays / plays`，贝叶斯平滑到 0.5 先验（`(c + α) / (n + 2α)`） | 正反馈 |
| `earlySkipRate` | `endReason ∈ {next,prev} && maxProgress < 0.3` 占比 | **最强负反馈** |
| `skipRate` | 任意用户主动切歌占比 | 负反馈 |
| `avgListenRatio` | `mean(listenMs / durationMs)` | 真实喜爱度 |
| `lastPlayedAt` / `lastCompletedAt` | 时间戳 | 冷却 |
| `errorRate` | `endReason === 'error'` 占比 | 可播性降权 |

艺人级同构；时段分布可直接复用已有的 `daily` rollup（`02-listen-stats.js:30-47`）。

### 5.2 候选歌曲池（候选源 = 非 Apple）

**角色先分清楚，否则整个架构会歪：**

| 角色 | 由谁担任 | 说明 |
|---|---|---|
| **播放 provider** | Apple Music（Windows App / SMTC）、各平台、本地文件 | "把这首指定的歌放出来" |
| **候选 provider** | 网易云 / QQ / 酷狗 / Spotify（可选）/ 本地音乐库 / MineRadio 自身历史 | "下一首该推荐什么" |
| **推荐引擎** | **MineRadio 自己** | 评分 + 冷却 + 插入，全在本机 |

**Apple Music candidate provider：明确不做。**

理由（审计事实，不是偏好）：
1. Apple 没有可用推荐接口——`/v1/me/recommendations`、similar、For You、station 全仓 **0 命中**（§3）。
2. Apple 曲目在本项目里 `playable: false`，播放必须换源（`apple-music-api.js:189-215`）⇒ 它连"能播的候选"都产生不了。
3. Apple 只有"资料库已保存"的静态快照（`/v1/me/library/*`），没有新歌发现能力，做成池等于把用户已有的歌再推给他。

> 反过来，AM 的位置因此非常明确：**它只答"现在在放什么 / 用户要求放什么 / 怎么把这首交给 Windows Apple Music"**，完全不参与"下一首推荐什么"。

```
                 MineRadio Smart Shuffle
                          │
              ┌───────────┴───────────┐
         本地行为模型              外部候选池
              │                       │
     play / skip / 完成率      网易云 / QQ / 酷狗
     artist / album / recency  Spotify（可选换源）
              │                + 本地音乐库
              └───────────┬───────────┘
                          ↓
                  本地评分 + 冷却
                          ↓
                    推荐候选
                          ↓
              MineRadio 播放（必要时换源）
                          ↓
        Apple Music = 播放目标之一（不是推荐来源）
```

**池定义（最终收窄版）：Smart Shuffle = "个人歌单智能乱序"。**

候选只来自**用户自己建 / 收藏的歌单**，不做全网发现：

| # | 池 | 来源 | 现成入口 |
|---|---|---|---|
| 1 | **四个国内源的个人歌单** | QQ / 酷狗 / 网易云 / 汽水 的**自建 + 收藏歌单**及其曲目 | `/api/{qq,kugou,qishui,netease}/library/index`（`server.js:8370 / 8587 / 8072 / 8900`）、`/api/{qq,kugou,qishui}/library/playlist/tracks`、网易云走 `/api/playlist/tracks` |
| 2 | 当前队列近邻 | `playQueue.slice(currentIdx+1)` | 已有 |
| 3 | 本地历史正反馈 | 行为模型里 `plays ≥ 2` / `completionRate` 高的曲目 | `mineradio-listen-stats-v1`、P0 事件表 |
| 4 | 本地音乐库（可选） | 用户导入文件 | `local-music-library.json` |
| — | ~~Apple Music 候选~~ | **明确不做** | — |
| — | ~~Spotify 候选~~ | 暂不做（换源链路复杂，先不引入） | — |

池 1 的价值**不在"发现新歌"，而在"用户已经亲自选过"**——推荐质量天然高于全网乱搜。
四个源互相补充的意义同样不是发现，而是**某源缺歌 / 不可播时，从另外三个源找可播版本**。

> QQ 侧已经能区分**自建 vs 收藏**，并识别出「我喜欢」：`isQQFavoritePlaylist`（`server.js:1430`）、`QQ_LIKED_PLAYLIST_ID`（`:1397`）、`created.concat(collected)`（`:3303`）。四个源的 index 返回结构统一（`playlists` / `songs` / `albums` / `counts`），可直接汇总。

**不要另造"统一歌曲指纹"——已经有了，而且是实战验证过的。**

`server.js:1495-1612` 的 `neteaseSourceMatch*` 就是现成的跨源指纹（目前服务于换源链路）：

| 关卡 | 规则 | 证据 |
|---|---|---|
| 曲名 | NFKC + 去括号内容 + 去标点后**完全相等** | `server.js:1495-1499, 1573` |
| **版本令牌** | live / cover / remix / remaster / 重录 / 伴奏 / acoustic / 加速 … **必须完全一致** | `:1512-1530, 1574-1576` |
| 艺人 | id 或归一化名字有交集 | `:1577-1584` |
| 时长 | 差 ≤ `max(1800ms, 1.2%)` | `:1585-1589` |
| 指纹 | 码率 + 体积 + 时长 + 采样率匹配；否则要求艺人集合相等且差 ≤600ms（官方匹配放宽到 1800ms） | `:1590-1592` |

评分：指纹 ×120 + 艺人有 id 70 / 仅名字 42 + 艺人集合 18 + 官方匹配 240 + 时长贴近 ≤45 + 可播 22 + 热度 ≤20（`:1594-1602`）。
**版本令牌这一关最关键**：它是"录音室版 ≠ 现场版 ≠ 伴奏版"的唯一防线，直接决定跨源归并会不会把歌搞混。

> ⚠️ **修正本文档早先的说法**：我先前写的"归并键优先级：`isrc` 最可靠"**对这四个源不成立**——ISRC 只有 Apple 曲目带（`apple-music-api.js:132`），QQ / 酷狗 / 网易云 / 汽水都不提供。国内源的跨源归并就是上面这套指纹。

**职责分层**

| 层 | 负责 | 状态 |
|---|---|---|
| 服务端 | 抓四个源歌单 + 用上面的指纹归并去重 → 候选池 | ✅ `GET /api/smart-shuffle/candidates` |
| 渲染端 | 评分 / 冷却 / 抽样 / 插入（纯函数，输入即候选数组） | ✅ `02c-shuffle-score.js` |

> **服务端绝不打分**：接口只返回"有哪些候选"，连权重都不读。已用单测钉死（见 TEST 8：接口源码里出现 `scoreCandidate` / `affinity` 等词直接判失败）。

**池预筛**：试听片段（`trial`）、`fee` 受限、时长异常（<60s 或 >15min）剔除；需换源的标 `needsSourceSwitch` 降权（`source` 惩罚项已实现）。

**⚠️ 一个必须说清的能力边界**

当前 `planSmartShuffleOrder()` **保证输出是输入的重排**（安全阀会校验多重集相等）⇒ 它只能做**个人歌单智能乱序**（不新增歌、只改顺序），**不能**把队列之外的歌插进来。

| 形态 | 能力 | 状态 |
|---|---|---|
| `A → C → B → D`（重排） | 个人歌单智能乱序 | ✅ **已实现**（就是你说的"先不做推荐新歌"那一步） |
| `A → C → [X] → F`（跨源插入） | 从池里新增歌曲 | ✅ `planSmartShuffleInsertions(queue, pool, ctx)`，**只跑在 shadow** |

不能靠改现有函数实现插入——多重集相等校验会直接拒绝任何新增。两步分开做，正好对应"先乱序、后插歌"。

### 5.3 推荐评分

纯函数 `scoreSong(candidate, ctx) -> {score, breakdown}`，权重集中放一个 JSON（便于调参 + 记录用）：

```
score =  +0.35 * affinity          // log1p(plays) 归一
         +0.20 * completionRate    // 平滑后
         +0.15 * artistAffinity
         +0.10 * recencyFit        // 冷却曲线，越久越高，饱和
         +0.10 * tempoFit          // 与上一首 BPM 距离（music-tempo 本地分析）
         +0.05 * novelty           // 未播过 / 新艺人 / 新专辑
         -0.30 * earlySkipRate
         -0.25 * repeatPenalty     // 冷却窗内 → 直接 -Infinity（硬屏蔽）
         -0.15 * sourcePenalty     // 需换源 / 低码率 / 试听
```

- **冷启动**：无行为数据时 `affinity/completionRate/skipRate` 都取先验常数 ⇒ 退化成一个"带去重和可播性过滤的随机"，比现在好一点但不会更差。
- **必须记录 breakdown**：每次插入把 score 分解写进事件的 `scoreBreakdown`，否则 P3 调参只能瞎猜。
- **tempoFit 的可行性**：本地已有 `music-tempo` 分析与缓存（`03-beat/00-tempo-worker-cache-prefetch.js:92-120`），但缓存**只覆盖本地文件且上限 12 条**，流媒体曲目需按需分析 ⇒ 建议 P2 后期再接入，权重可先置 0。

### 5.4 插入比例

- **N = 每 N 首插 1 首**，默认 `N = 3`；UI 暴露 2/3/4/5/6（"更多新歌 ←→ 更少新歌"），关闭即纯队列顺序。
- **不允许连续插入**：两首候选之间至少隔 2 首用户曲目。
- **队列剩余 < 2 首时不插**，避免扰动用户显式排列的队尾。
- **自适应降级**：本会话内用户连续主动跳过 2 首插入曲 ⇒ 自动降到 `N = 6`；再跳 1 首 ⇒ 本会话停插。
- **插入位置**：只在队列尾部 hydrate / 前进取下一首的时机做（`14-player-controls.js:650-652`、`13-playback-start-audio.js:940`），**不改写用户已排好的前段队列**。

### 5.5 Fewer Repeats

硬约束（在重排时对整个队列生效）：

| 规则 | 默认值 |
|---|---|
| 同曲冷却 | 24h 内不重复（可配 0 / 6h / 24h / 7d）；强制重复时 score × 0.3 |
| 同艺人相邻间隔 | ≥ 3 首 |
| 同艺人窗口 | 最近 20 首内 ≤ 2 次 |
| 同专辑 | 不出现相邻 |

**关键实现约束（容易踩坑）**：现在的 shuffle 是**一次性 Fisher-Yates 重排**，然后把选中曲提到 index 0，之后**顺序推进**（`14-player-controls.js:606-638, 664-665`）。如果只在"重排那一刻"检查冷却，队列后段照样会撞车。
⇒ 更稳的做法：把 `nextTrack` 的"取下一首"改成**从剩余未播集合里做一次带冷却的加权抽样**，而不是依赖一次性重排。这同时也天然支持 5.4 的按比例插入。

### 5.6 落地方式（不重构推荐系统）

| 改动 | 文件 | 规模 |
|---|---|---|
| 新增埋点/事件模块 | 新建 `05-playback/02b-play-events.js` | 新文件 |
| 新增评分模块（纯函数） | 新建 `05-playback/02c-shuffle-score.js` | 新文件，可单测 |
| 接入点 1：`finalizeListenSession` 带出 `endReason/userInitiated/maxProgress` | `05-playback/02-listen-stats.js` | 小改 |
| 接入点 2：shuffle 从"一次性随机重排"改为"带冷却的加权抽样" | `05-playback/14-player-controls.js:615-638, 664-665` | 替换 2 个函数体 |
| 接入点 3：队列尾按比例插候选 | `14-player-controls.js:650-652` / `13-playback-start-audio.js:940` | 小改 |
| provider 层 | **不动** | 0 |

### 5.7 P1 依赖核查：今天已经具备什么

"等两周"等的是**数据成熟**，不是**代码成熟**。逐条核对 P1（Fewer Repeats）的真实依赖：

| P1 需要 | 今天是否已有 | 证据 |
|---|---|---|
| 跨会话**同曲**冷却 | ✅ **已有** | `listenStatsState.songs{}` **没有容量上限**（只有 `history` 被截到 180，见 `02-listen-stats.js:146-148`），每首的 `lastPlayedAt` 长期保留（写点 `:270-271`） |
| 队列内**同艺人 / 同专辑**相邻间隔 | ✅ **已有** | 队列顺序推进 `currentIdx = (currentIdx+1) % playQueue.length`（`14-player-controls.js:664-665`）⇒ "最近 N 首"= `playQueue[0..currentIdx]` 已播前缀，**零新增持久化** |
| 当前剩余集合（可插入位） | ✅ **已有** | `playQueue.slice(currentIdx+1)` |
| 完整播放 / 完成度 | ✅ **已有（弱）** | `songs[key].completed` / `.plays` |
| 精确顺序窗口（跨队列、跨会话的全局最近 N 首） | ⚠️ **需要 P0** | `history` 按 key 去重，只能表达"最近听过的**不同**歌曲"，不能表达"最近 20 次播放" |

**两个必须知道的局限（诚实记录）**：
1. `lastPlayedAt` 只在**有效收听**时更新（`02-listen-stats.js:232-233`）⇒ 被短跳过的歌时间戳不刷新，冷却判断会偏旧。对冷却而言基本无害，但不能当精确播放时间。
2. 队列已播前缀是**队列维度**的：用户换一个歌单后窗口就重置。跨队列的艺人级窗口要等 P0 事件流。

**结论**：P1 可以**立即开工**，只用今天已有的 `songs[].lastPlayedAt` + `playQueue` 已播前缀即可落地，不需要等 P0。

### 5.8 分期（修订版：并行）

```
Day 0        P0 黑匣子上线 ──────────────┐
             P1 Fewer Repeats 开工 ──┐  │
Day 0–2      P2 评分/排序/冷却/插入 框架 + 固定数据单测 ←──┘
             （代码全部写完，权重先放"先验/占位"值）
Day 3–14     MineRadio 正常用，P0 不改用户体验，数据自然生长
两周后       数据够了 → 打开真实权重（只改一个 JSON，不改代码）
```

| 阶段 | 内容 | 是否阻塞 | 验收 |
|---|---|---|---|
| **Day 0** | 事件表 + 短跳过/方向/失败/seek 埋点 + `playMode` 持久化（**不改用户体验**） | — | 事件表开始积累 |
| **Day 0** | **P1 Fewer Repeats**：冷却抽样替换纯随机（`14-player-controls.js:606-638`） | 不阻塞，依赖见 §5.7 | 24h 重复率下降 |
| **Day 0–2** | **P2 框架**：`scoreSong()` 纯函数 + 候选排序 + 冷却 + 按比例插入，**全部用固定 fixture 跑单测** | 不阻塞 | §5.9 的链路单测全绿 |
| **Day 3–14** | 正常使用，只积累数据；每天可看：播放 / 完整 / 短跳 / 手动下一首 / 错误 | — | 漏斗数字成形 |
| **两周后** | 打开**真实权重**：用 `earlySkipRate`/`completionRate`/`avgListenRatio`/artist affinity/recency 校准 §5.3 的系数 | 阻塞的是**权重**，不是代码 | 权重有真实数据支撑 |

> **真正的门禁只有一条**：在真实权重打开之前，不要让"评分排序"接管用户能感知的播放顺序——P2 框架可以先只跑在单测和影子日志里（记录"如果按评分会插哪首"，但不真的插）。
> 这样 Day 0–14 期间用户体验零变化，而代码已经全部写好并验证过了。

### 5.9 固定数据单测（Day 0–2 必须先跑通）

在真实数据到来之前，用 fixture 钉住整条链路：**评分 → 候选排序 → 冷却 → 插入 → 队列**。

```js
// tests/smart-shuffle-scoring.test.js（示意）
const FIXTURES = [
  { key: 'A', plays: 30, completionRate: 0.91, earlySkipRate: 0.02, lastPlayedAt: daysAgo(9) },
  { key: 'B', plays:  8, completionRate: 0.67, earlySkipRate: 0.30, lastPlayedAt: daysAgo(2) },
  { key: 'C', plays:  1, completionRate: 1.00, earlySkipRate: 0.00, lastPlayedAt: 0 },   // 刚播过
];
```

| 断言 | 目的 |
|---|---|
| `score(A) > score(B)` | 偏好强度生效 |
| `C` 落在冷却窗内 → `score(C) === -Infinity` | 冷却硬屏蔽生效（**不是**降权，是排除） |
| 同艺人候选被排到 ≥3 首之后 | 艺人间隔规则生效 |
| 每 3 首恰好插 1 首、且不连续插 | 插入比例生效 |
| `insertedBy === 'smart-shuffle'` 且 `scoreBreakdown` 非空 | provenance 可回放 |
| 候选池为空 / 全部被冷却 → 退回原队列顺序 | **降级安全**（最重要的一条） |

> 这套单测的价值：**权重对不对**要等数据，但**链路通不通**今天就能确定。

### 5.10 明确不要做的事

1. **不要假设 Apple Music 有推荐 API**（审计：0 命中），更**不要把 Apple Music 当作候选源**（§5.2）。AM 的角色只有"播放 provider + 现在在放什么"，不产生候选。
2. **不要建设云端用户画像 / 账号级行为**：没有任何服务端行为存储，且所有收听数据都在本机 localStorage。
3. **不要依赖 Apple 红心**：既读不到也写不了。
4. **不要把 SMTC 当播放流水**：无曲目 ID、无队列、同曲重播不触发 track-reset。
5. **不要把 `mineradio-listen-stats-v1.history` 当播放流水**：它按 key 去重且 ≤180 条，是"最近听过什么"，不是"听了多少次"。
6. **不要把 P0 当成 P1 的前置阻塞**：P1 的依赖今天已有（§5.7）。
7. **不要在真实权重打开前让评分接管用户可感知的播放顺序**——框架先行、影子日志先行（§5.8 门禁）。

---

### 5.11 Day 0 落地状态（已实现，未启用）

Day 0 的两件事都已落地，**默认不改变任何用户体验**：

| 交付物 | 文件 | 状态 |
|---|---|---|
| P0 黑匣子（append-only 事件表） | `public/js/modules/05-playback/02b-play-events.js`（新增） | ✅ IndexedDB `mineradio-play-events`，无 IDB 时退回内存；**短跳过不再丢** |
| 评分 / 冷却 / 抽样 / 插入（纯函数） | `public/js/modules/05-playback/02c-shuffle-score.js`（新增） | ✅ 三函数严格分离：`scoreCandidate` / `selectCandidates` / `weightedSample` |
| 固定数据单测（A/B/C fixture） | `tests/smart-shuffle-scoring.test.js`（新增） | ✅ **23/23 通过** |
| 埋点接线 | `02-listen-stats.js`、`13-playback-start-audio.js`、`14-player-controls.js`、`18-cuefield-automix-integration.js`、`04-progress-seek.js`、`11-provider-fallback.js`、`index-loader.js` | ✅ 共 +63 行，全部是钩子，未改播放决策 |

**关键实现细节**

- **短跳过补上**：事件写入放在 `finalizeListenSession` 的 `effective` 门槛**之前**（`02-listen-stats.js`），所以 <45s 且 <50% 的会话现在会进事件表；旧统计逻辑一字未改，不会回归。
- **endReason 来源**：`ended` 来自 `audio.onended`；`next` / `prev` 来自 UI 按钮已有的 `userInitiated` 参数；其余为 `auto-advance` / `track-switch`。
- **模式开关**：`localStorage['mineradio-smart-shuffle-v1'] = { mode: 'off'|'shadow'|'on', weights: {...} }`，**默认 `off`**。
- **影子模式**：`mode='shadow'` 时每次切歌推演一次（4s 节流、候选上限 40），日志 `[SmartShuffle][shadow] {...}` 并写入 `shuffle-shadow` 事件，**绝不修改 `playQueue` / `currentIdx`**。
- **安全阀（4 层，全部有单测）**：候选不足 → 不接管；剩余全被冷却 → 原序补齐不丢歌；顺序不完整 → 原样返回；一次真实抽取都没发生 → 老实报 `applied:false`。

**A 阶段补充（候选池 + 插入，已实现）**

| 交付物 | 位置 | 状态 |
|---|---|---|
| `GET /api/smart-shuffle/candidates` | `server.js`（候选池段落 + 路由） | ✅ 四源汇聚、复用指纹归并、每源独立容错、空池降级 |
| 跨源归并（复用 `neteaseSourceMatch*`） | `smartShuffleMatchShape` / `smartShuffleMergeCandidates` | ✅ 归一化曲名分块 + 块内指纹判定 |
| 候选池拉取 + 缓存（60s） | `02c-shuffle-score.js#smartShuffleFetchPool` | ✅ 接口失败 → 空池 → 安全阀 |
| 插入规划器 | `02c-shuffle-score.js#planSmartShuffleInsertions` | ✅ 追加不替换、绝不连续插、4 层安全阀 |
| 影子推演（带池） | `02c-shuffle-score.js#smartShuffleShadowProbe` | ✅ 异步 fire-and-forget，**实测不修改 `playQueue`/`currentIdx`** |
| 候选池单测 | `tests/smart-shuffle-candidates.test.js` | ✅ **10/10** |

**版本令牌防线已被单测钉死**：`晴天` vs `晴天 (Live)` / `(伴奏)` / `(Remix)` / `(Acoustic)` / `(重制版)` **必须分成两首**（candidates TEST 2/3）。这是跨源归并最容易出的灾难，现在有回归保护。

**真实账号实测（2026-10-06，六源全部登录）**

用独立进程（`PORT=3999 node server.js` + 真实 userData cookie）直连 `/api/smart-shuffle/candidates`：

| 源 | 登录 | 歌单 | 曲目 | 可用 |
|---|---|---|---|---|
| netease | ✅ | (诊断未暴露) | 543 | 533 |
| qq | ✅ | 3 | 237 | 237 |
| kugou | ✅ | 4 | 497 | 497 |
| qishui | ✅ | 5 | 179 | 179 |

| 指标 | 实测 |
|---|---|
| `raw`（四源并集） | **1446** |
| `merged`（归并后候选） | **1429** |
| `crossSource`（真被判定为跨源同曲） | **14（≈1%）** |
| 冷启动首次调用 | **11.2 s** |
| 命中缓存（换任意 limit 也是） | **9 ms** |

**两个必须记住的实测结论**

1. **跨源归并率只有 ~1%，这符合预期，且不影响候选池。**
   库适配器给出的曲目**不带码率/体积指纹**（`h/m/l/sq/hr` 那些），所以 `neteaseSourceMatchFingerprintCount` 恒为 0，判定被迫走最严的兜底：艺人集合完全相等 **且** 时长差 ≤600ms。多数"同名不同源"的曲目其实互为不同母带/版本，差几秒就被挡掉——**这正是版本令牌想要的结果**。
   ⇒ 候选池的价值是"四源并集去重后的 1429 首"（够用），而不是"跨源补歌"。**若将来要提升跨源命中率，正确做法是给适配器补上媒体指纹字段，而不是放宽时长阈值**（放宽会立刻引入 Live/伴奏误配）。

2. **冷启动 11 秒是真实的性能特征。**
   首次调用要遍历四个源的全部歌单并逐页取全（netease 一个源就要 54 次分页请求）。
   聚合缓存 TTL 定为 **10 分钟**（个人歌单变化很慢，60s 太激进会周期性压满主进程）。
   ⇒ 影子里它是 fire-and-forget，**不会阻塞切歌**；但应用启动后第一次推演要等 11s 才有池。建议后续在启动完成后**预热一次**（后台调一次接口）。

3. **⚠️ 顺带发现一个既有 bug（不是本次引入）：四个源的"短 TTL 缓存"其实是每次请求重建的。**
   `neteaseLibrarySongsCache` / `kugouLibraryCache` / `qishuiLibraryCache` / `qqLibraryCache` 都用 `const` 声明在 **HTTP 请求回调作用域内**（`server.js` 约 7993/8108/8136/8463 行，缩进 2 空格）。回调每次请求重新执行一遍，所以 **Map 每次都是新的**——注释里写的"5 分钟 TTL 缓存"跨请求完全不起作用，只在同一个请求内被调用两次时有效。
   **实测证据**：修复前用 `limit=3` 打第二次（距第一次 1 秒）耗时 **7.1 s**，与冷启动 11.2 s 同量级——说明 5 分钟源级缓存确实没生效。
   ⇒ 影响的不只是 Smart Shuffle：**资料库页每次刷新都在重新遍历全部歌单**。修法是把这 4 个 Map 提到模块作用域。**未擅自改动**（属于既有行为，需你确认）。

**B 阶段补充：从 SMTC 反推 Apple Music 播放会话（已实现）**

**要解决的问题**：`playQueueAt` 只覆盖**内部播放**。用 Apple Music 听歌走的是 UIA 点击 + SMTC，`playQueueAt` 永远不被调用 —— 行为黑匣子一条都记不到，**affinity / completionRate / earlySkipRate 会永远停在先验值，两周后无权重可校准**。

| 交付物 | 位置 | 状态 |
|---|---|---|
| SMTC 会话推导（独立轮询，**不碰时间轴稳定器**） | `public/js/modules/12-smtc/07-smtc-listen-session.js`（新增） | ✅ 1s 轮询只读 `smtcStore` |
| 方向信号 | `03-smtc-ui.js#smtcControlCommand` | ✅ 仅 MineRadio 界面按的上一首/下一首带方向 |
| 外部统计隔离 | `02b-play-events.js#playEventsSignatureStats` | ✅ 外部事件按**跨源签名**单独聚合，四源统计不被污染 |
| 评分归因 | `02c-shuffle-score.js#shuffleCandidateMeta` | ✅ 四源无统计时按签名回退查找 |
| 测试 | `tests/smtc-listen-session.test.js` | ✅ **9/9** |

**五个设计要点**

1. **没有真实曲目 ID**：SMTC 只给 title/artist/album/durationMs，所以 key 是合成的 `smtc:标题|艺人`，另附 `sig` 供与候选池保守匹配。
2. **签名不剥括号**，所以 `同名歌` 与 `同名歌 (Live)` 不会互相归因（TEST 9 钉死）。
3. **方向只在 MineRadio 界面按按钮时可知**；Apple Music 自己的界面 / 键盘媒体键引起的切歌标记 `unknownDirection`，不假装知道。
4. **抗抖动下限 500ms**：SMTC 桥在切歌瞬间会闪出几乎不前进的样本；真实短跳过（≥1s）仍会成案。
5. **内部播放优先**：内部播放器在放时外部会话立即让位（`internal-takeover`），避免同一次收听记两遍。

**统计隔离的实际语义**：外部收听进 `playEventsSignatureStats`（键 = 跨源签名），四源收听进 `playEventsSongStats`（键 = `queueItemKey`）。评分层查候选时先查四源、查不到再按签名回退 —— 所以 **Apple Music 听过的歌会抬高候选池里同一首歌的 affinity，但两者的原始计数不会混在一起**。
**B 补充二：无队列模式 + 源限制闸门**

**问题**：`smartShuffleShadowProbe` 原本要求 `playQueue` 剩余 ≥2 首。纯用 Apple Music 听歌时 MineRadio 队列是空的 → 探针静默返回 → **一条决策数据都攒不到**（而决策数据正是校准权重最需要的东西）。

| 改动 | 说明 |
|---|---|
| **无队列模式（pool-only）** | 队列不足时，以「当前正在听什么」（内部队列优先，否则 SMTC）为上下文，从候选池推演"下一首会插哪首"，产出同样的 `scoreBreakdown` 决策行 |
| **触发源补全** | `07-smtc-listen-session.js` 在外部会话开始时调用探针 —— 外部播放时 `playQueueAt` 永不被调用，必须由 SMTC 侧触发 |
| **源限制闸门** | `smartShuffleApplyGuard()` —— **唯一的接管判定点**，只允许 `netease/qq/kugou/qishui`；空队列 / 无来源信息 / 混合队列一律不接管 |
| 测试 | `tests/smtc-listen-session.test.js` **13/13** |

**"采集"与"接管"必须分清**（本次唯一的红线设计）：

| | 采集（影子） | 接管（`mode='on'`） |
|---|---|---|
| Apple Music / Spotify / 本地 | ✅ 照常记录 | ❌ 闸门拒绝 |
| 国内四源 | ✅ 记录 | ✅ 允许 |

> 我们只要数据，哪来的不重要；但最终开关只服务国内四源 —— 所以 `mode='on'` 接线时**必须先过 `smartShuffleApplyGuard()`**。已写成唯一判定点并用单测钉死（TEST 10 / 13）。
**B 补充三：首条真实日志的体检（2026-10-06，Apple Music 外部播放）**

首条 `shuffle-shadow` 落库后逐字段核对，抓出 3 个真 bug：

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | **`statsSource` 全是 `none`** —— AM 收听一条都归因不到候选池 | Apple Music 的 SMTC `artist` 是 `"<艺人> — <专辑>"`（`apple-music-control.js:321` 早有记录，实测 `Charlie Puth — Voicenotes`）。签名带着专辑名 → 永远匹配不上 | 在 `07-smtc` 与 `02c` 两处都拆掉专辑后缀 |
| 2 | `poolSize: 800`（服务端有 1429） | `smartShuffleFetchPool()` 没传 `limit`，吃了服务端默认 800，**静默截断且有偏** | 显式 `?limit=3000`；扫描上限 1200→3000 |
| 3 | 可能推荐**正在听的那首** | 当前曲目用 `smtc:` key 空间，候选用 `queueItemKey`，两者永不相等，靠 `recentKeys` 排不掉 | 按跨源签名再筛一遍，并上报 `droppedNowPlaying` |

顺带改进：`probability` 原来非抽中一律为 0，现在 top 候选都带**真实 softmax 概率** + `picked` 标记，调参时才看得出差距。

**同一份日志也证实这些是对的**：

| 字段 | 值 | 判定 |
|---|---|---|
| `planMode` | `pool-only` | ✅ 无队列模式生效 |
| `applyGuard` | `{allowed:false, reason:'no-queue'}` | ✅ AM 队列不接管（预期） |
| `completion` | `0.5` | ✅ 贝叶斯先验（plays=0） |
| `recency` | `1` | ✅ 从未播放 |
| `earlySkip` | `null` | ✅ 未知就是未知，不拿假数据凑 |
| `final` | 全部 ≈0.2986 | ✅ 只有先验时的预期值 |

> 结论：**框架正确，只是还没有信号**。这正是需要挂两周的原因。
**B 补充四：第二条真实日志的体检（修掉 3 处）**

`nowPlaying.key` 已变成 `Done For Me (feat. Kehlani)|Charlie Puth`（专辑后缀拆净）✓，
`excluded` 里正确排掉了 Charlie Puth 的另一首 `Like That (Demo)`（同艺人相邻规则）✓。
但同时暴露 3 个问题：

| # | 问题 | 修复 |
|---|---|---|
| 1 | **实际抽中的那首根本不在日志里** —— 它可能排在短名单第 15 位，而报告只取 top-5 | `smartShufflePoolTopRows()` 强制把 picked 那条补进报告（最多 6 行） |
| 2 | `excluded` 塞了完整对象（candidate + meta.song 各一份），**单条日志 15 kB**，DevTools 无法阅读 | `smartShuffleExclusionRow()` 只留 `{key, name, artist, reason, score}` |
| 3 | **概率近乎均匀**：top1=0.0021、top2=0.0015，top-5 合计仅 0.008 —— 1034 个候选占 99.2% | 先按分数取 **top-K（默认 30）** 短名单，再在短名单内加权抽样 |

问题 3 的算术：`temperature=0.25` 时分数差 0.081 只值 `exp(0.081/0.25)≈1.38` 倍偏好，
在 1400 个候选里等于均匀随机，`picked` 字段就失去意义 —— 而它正是两周后评估「选得准不准」的唯一依据。
短名单把首选概率从 ~1/1429 提到 ~1/30（约 50 倍），使该字段可用。

> 注意：**短名单不等于「分数会变得集中」**。无数据时分数本来就几乎相同，短名单内仍接近均匀（实测 top-5 ≈ 1/6）——
> 那是「只有先验」的正常形态。有真实数据后分数方差变大，集中度会自然上升。
**B 补充五：艺人改名 —— 宽松归因签名（已实现）**

**更正一处定性**：`Abel Tesfaye` **不是** Apple 的「元数据不一致」，而是 **The Weeknd 已正式改用本名**；
Apple Music 用的是新名，国内四源还在用旧名。

这比「偶发特例」严重得多：**艺人名根本不能当跨源主键** —— 任何改名的艺人都会永久失配。实测：

| | 曲名 | 艺人 | 时长 |
|---|---|---|---|
| Apple (SMTC) | `StarBoy (feat. Daft Punk)` | `Abel Tesfaye` | 230s |
| 四源候选池 | `Starboy (Clean)` | `The Weeknd / Daft Punk` | 231s |

严格签名实测（必然不等）：`abel tesfaye\|starboy(feat.daftpunk)\|230` vs `the weeknd\|starboy(clean)\|230`。
⇒ 这类歌的 AM 收听一条都归因不到，B 方案等于白做。

**修复：双签名**

| 签名 | 组成 | 用途 |
|---|---|---|
| 严格 `shuffleSongSignature` | 艺人 + 曲名 + 时长(秒) | 冷却 / 排除 / 去重（**规则不变**） |
| 宽松 `shuffleLooseSignature` | **不含艺人**；曲名去括号 + 时长 5 秒桶 | **只用于 AM↔池的归因** |

- 采集侧登记 **±1 相邻桶**：两源时长差 1 秒也可能落在桶边界两侧（实测 231s vs 230s 同桶；232s vs 234s 会一桶之隔）。
- 命中标记 `statsSource: 'smtc-external-loose'`，两周后可据此判断它值不值得留。
- **已知代价（承认）**：同一首歌的 Live/Remix/伴奏会被算作同一首 → 只影响 affinity 统计，**不影响播放顺序，也不会让冷却变松**（冷却仍用严格签名）。

顺带修掉一个隐藏依赖：`02c` 原先直接调用 `02b` 里的 `shuffleMsAnySafe`，
在合并 bundle 里能跑但单独加载会 ReferenceError —— 已改为 `02c` 自持 `shuffleDurationMs`。
**尚未做（刻意留到权重校准之后）**：`mode='on'` 尚未接到 `reorderQueueForShufflePlaybackOrder` —— 现在 `on` 只比 `shadow` 多写一个标记，不影响播放顺序。这是 Day 14 打开真实权重时才动的唯一一处。

**回归**：`node --test tests/*.test.js` → **377 通过**；唯一失败是 `update-external-only.test.js:29` 的版本断言（期望 `2.0.0-beta.1`，仓库是 `2.1.0`），**预先存在且与本次改动无关**（未触碰 `package.json` 与该测试）。

## 附：关键文件索引

| 关注点 | 文件 |
|---|---|
| SMTC 契约（字段/事件/控制） | `desktop/smtc-bridge.ps1` |
| SMTC 渲染端 store + 时间轴稳定器 | `public/js/modules/12-smtc/00-smtc-store.js` |
| Apple Music 控制链（iTunes 搜索 + UIA + SMTC 校验） | `desktop/apple-music-control.js` |
| Apple Web 只读客户端 | `desktop/apple-music-web-api.js` |
| Apple 读 handler | `desktop/apple-music-web-reads-api.js` |
| Apple 资料库索引缓存 | `desktop/apple-music-library-cache.js` |
| Apple 凭证 store | `desktop/apple-music-lyrics-credential.js` |
| Developer 轴退休报告 | `experiment/apple-music-windows-control/REPORT-DEVELOPER-API-RETIREMENT-AUDIT.md` |
| 本地收听统计（**唯一真行为数据**） | `public/js/modules/05-playback/02-listen-stats.js` |
| 队列定义 / 快照 | `00-state/00-core-stores.js`、`05-playback/09-queue-snapshot-autoplay.js` |
| next/prev / 播放模式 / 现有 shuffle | `05-playback/14-player-controls.js` |
| 播放启动 / ended / 队列推进 | `05-playback/13-playback-start-audio.js` |
| 进度/seek | `06-lyrics/04-progress-seek.js` |
| 服务端路由与能力表 | `server.js`（`/api/platform/capabilities`:4822、`/api/listen/report`:4867、`/api/apple/*`:5741+） |
| 本地音频分析（BPM/节拍） | `public/js/modules/03-beat/00-tempo-worker-cache-prefetch.js`、`01-audio-beat-analysis.js` |
