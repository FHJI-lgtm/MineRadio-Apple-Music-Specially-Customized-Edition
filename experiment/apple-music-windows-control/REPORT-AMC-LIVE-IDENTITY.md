# REPORT — Apple Music 实时身份接入 MineRadio（2026-09-26）

范围：只改 MineRadio 渲染层与 Apple 只读 handler；`experiment/apple-music-windows-control/poc/lib` **未触碰**。

## 1. 三个真实故障（都已复现、都已修）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 底栏/详情仍是 MineRadio 自己那首 | `publishAmcPlaybackContext` 里引用的 `amcContextContradicted` 只在 `amcPlayRow` 内部声明过 → 每次发布抛 `ReferenceError` → 上下文从未建立、画笔从未执行 |
| 2 | AM 在别处开始播放/切歌时，界面完全不跟随 | `currentPlaybackContext` 是**点击时刻的快照**，无法回答「现在在放什么」 |
| 3 | Apple 专辑页永远空态 | SMTC 不带 album id；专辑轴也没有把 catalog 身份带给渲染层 |

## 2. 实测证据

- 故障 1：vm 内执行原函数得到 `ReferenceError: amcContextContradicted is not defined`；补上作用域后 `setCurrentPlaybackContext` 与画笔都执行。
- 故障 2：`smtc-bridge.ps1:186` 直接透传 `$props.Artist`，Apple Music 给的是 `Artist — Album`（U+2014），因此实时身份必须自己拆这一刀（只认**带空格的**破折号，`Jay-Z` 不拆）。
- 故障 3（公开 iTunes 面实测，2026-09-26）：

  | 专辑 | catalog id | 轨数 / 日期 / 店面 | 曲目表 |
  |---|---|---|---|
  | After Hours | 1499385848 | 14 / 2020-02-19 / USA | 完全一致 |
  | After Hours | 1499378108 | 14 / 2020-02-19 / USA | 完全一致 |
  | My Dear Melancholy, | 1363308558 | 6 / 2018-03-30 / USA | 完全一致 |
  | My Dear Melancholy, | 1363309866 | 6 / 2018-03-30 / USA | 完全一致 |

  ⇒ 同一发行版在 catalog 里有**多个 id**。第一版规则「存活 id 必须恰好一个」因此把所有热门专辑判成歧义 —— 规则本身错了，不是查不到。

## 3. 改动

- `public/js/modules/05-playback/07-search.js`：`amcContextContradictedOf(res)` + 显式第三参数；画笔改为不带守卫的 `applyControlTrackInfo(currentPlaybackContext)`。
- `public/js/modules/02-visual/15-ripples-cover-depth.js`：画笔拆成 `applyControlTrackInfo(song)`；F1 守卫块**逐字保留**；外部会话拥有底栏时抑制队列重绘。
- `public/js/modules/12-smtc/03-smtc-ui.js`：单一判据 `smtcExternalOwnsUi()`（SMTC active 且内部 deck 静音）+ 底栏实时镜像（身份不变不重画）。
- `public/js/modules/12-smtc/00-smtc-store.js`：状态推送时驱动镜像；会话结束把底栏交还队列。
- `public/js/modules/05-playback/06-track-detail-lyrics-actions.js`：`externalLiveSong()` + `currentCoverSong() = 上下文 → 实时会话 → 队列`（`currentQueueSong()` 一字未改）；`songSourceLabel` 认识 apple；评论小节对 apple 不渲染；专辑 id 解析（严格匹配 + 别名对 + 重复条目判定 + 缓存）；专辑行点击接 UIA；Apple 行/专辑不再渲染只属于 MineRadio 的控件（收藏到歌单 / 下一首播放 / 收藏专辑 / 无缝衔接）。
- `desktop/apple-music-web-reads-api.js`：专辑轴为每首曲目带上**显式 `catalogId`**（有 `playParams.catalogId` 用它，否则用 catalog 对象自身的 id —— 这条轴是 catalog-only，不做任何 id 形式推断）。

## 4. 测试

`tests/apple-music-playback-context.test.js`：21 条**运行时**断言（不是源码字符串），覆盖：发布路径真的执行并到达画笔、底栏实时镜像与让位、统一访问器三态、专辑 id 严格/别名/重复条目/缓存、专辑 handler 注入 `catalogId`、专辑行点击分流（Apple→UIA，其余→内部）、Apple 行不再渲染内部控件。

## 5. 刻意保留的边界（不是遗漏）

- 实时身份**不带** `durationMs/positionMs`：底栏拖动仍驱动 MineRadio 自己的 `<audio>`，带上会承诺一个拖不动的进度。等 Step 4（底栏控制接 SMTC toggle）再解决。
- **published context**（从 MineRadio 点过的 AM 结果）仍按 E-A step 6A/6b **不**调专辑端点 —— 是否放开是产品决定，未擅自改。
- 专辑匹配的取舍：**完全相同的重复条目**（轨数/日期/店面一致）接受并取最小 id；**有任何差异**（不同发行版）一律拒绝，宁空态不糊。