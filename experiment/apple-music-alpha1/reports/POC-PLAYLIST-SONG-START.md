# POC：Apple Music 用户歌单「指定歌曲起播」可行性验证（阶段报告）

> 状态：**进行中**。本报告只记录已实际执行并取得证据的部分；未执行的路径一律标注「未验证」，
> 不写成 PASS。整体结论暂定 **PARTIAL（未完成）**。## 0. 基线（开始前记录）

| 项 | 值 |
|---|---|
| 分支 | `experiment/apple-music-windows-control` |
| HEAD | `671a29e` |
| 工作区未提交条目 | 9（含实验临时脚本与用户未提交改动；**本次未触碰**） |
| Apple Music 客户端版本 | `1.1540.23042.0`（WinUI 3 / Store 包） |
| 深链接机制（既有、冻结） | `poc/lib/am-uia.ps1:233 Invoke-AmNavigateUrl` → `AppleMusic.exe /url "<URL>"`，回退 `shell-open` |
| SMTC 读状态（既有、冻结） | `poc/lib/am-smtc.ps1 Get-AmSmtcState`（title/artist/status/pos/ok） |
| 可见性/隐身（既有、已验证） | Alpha=1 + `WS_EX_LAYERED` + `WS_EX_TRANSPARENT`；**未使用 Alpha=0** |

## 0.1 重跑与仪器校准（客户端修复后）

| 检查 | 结果 |
|---|---|
| Apple Music 进程 | 1 ✔ |
| 窗口状态（只读） | `exStyle=0x00000100`、layered=false、transparent=false、alpha=-1、iconic=true ⇒ **无隐身残留** ✔ |
| 修复后初始 SMTC | `status=Opened`、title 空（空闲会话，无播放） |
| **仪器校准** | 用既有已验证路径（应用自身 AMC 专辑播放 `Faith`）→ `stage=PLAYBACK_STARTED`、`smtcTitle=Faith`；随后直接读 SMTC：**`status=Playing`、title=Faith、artist=Abel Tesfaye — After Hours、dur=4:43** ⇒ **SMTC 仪器可信** ✔ |
| 已知形式深链接的参照测试 | `https://music.apple.com/us/song/6790165651` 经 `AppleMusic.exe /url` → 12 秒后 SMTC 仍为 `Opened|`（无会话）⇒ **未起播**（在仪器已校准的前提下，这是一个**有意义的负结果**） |

**重要更正**：先前 B1 的负结果原本可能只是「仪器/客户端处于异常态」造成的假阴性；本次校准证明
仪器可信，因此 B1 的负结果**可以**作为有效证据 —— 但`music.apple.com/us/song/<catalogId>` 这次也失败，
说明**「已验证可用的深链接形式」需要重新确认**（可能与 storefront（用户所在区非 us）、`?at=`/`?l=` 参数或
客户端当前登录态有关），在确认之前不应把 B1 判为终局 FAIL，也不应再试 `library/playlist/*` 那种会触发错误的构造。
## 0.2 执行硬性约束（用户确认）

1. **深链接验证必须单变量**：先从仓库既有、**已验证**的调用点提取 URL 形式，保留原始参数结构；
   每次只改一个参数，失败即停并记录。**storefront 必须以当前实际使用的 API/账号环境为准，不得按地区猜测**。
2. **B3/B4 双击前必须确认行身份**：只接受经身份验证的 ListItem，**不因文本相似而点击**；
   双击后必须用 SMTC 校验歌曲身份，避免误播同名歌曲。
3. 专辑侧已验证的 UIA 路径**仅作为复用基础**，不等于歌单侧通过；
   **PASS 标准**：指定歌曲正确起播 **且** 后续播放顺序符合原歌单。

## 0.3 从代码提取的已验证深链接形式（不猜格式）

| 来源 | 形式 | 证据 |
|---|---|---|
| desktop/apple-music-control.js:108-117 | `https://music.apple.com/{storefront}/song/{slug}/{trackId}`（三段：song/slug/id） | 注释写明 Verified shape (the G3/G4 fixtures) |
| phase3-resolve/candidates.json:12,22 | `music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530`、`music.apple.com/cn/song/晴天/535824738` | 标注 verified working（cn、允许中文 slug） |
| phase3-resolve/candidates.json:32 | `https://music.apple.com/us/album/shape-of-you/1193701079?i=1193701392` | 标注 verified working ⇒ `?i=<catalogSongId>` 是「指定专辑内某首歌」的已验证参数形式 |
| REPORT-B-I-PLAYLIST-CARD.md:309 | `https://music.apple.com/cn/playlist/my-playlist/pl.u-vxy697juWRBP21v` | 歌单 URL 形式 = `/playlist/{slug}/pl.{id}`（注意是 `pl.` 空间，与资料库 `p.` id 不同） |
| recon/13-latency-and-search.ps1:21 | `musics://music.apple.com/cn/song/{slug}/{id}` | 该 recon 使用并验证过的 scheme 变体 |
| MVP-INTEGRATION-PLAN.md:60,116 | 深链导航 G3 3/3 + G4 20/20，navMethod=AppleMusic.exe /url | 深链作为导航步骤已被大量点击验证 |
| CONTROL-PLANE.md:104 | `music:`/`musics:` 协议仅 `/url <URL>`，协议本身无 track-selection 参数 | 指定歌曲只能靠 URL 路径/查询参数 |

### 由此定位到上一次 B1 失败的直接原因

我先前用的是 `https://music.apple.com/us/song/<catalogId>` —— **缺少 slug 段**，且 storefront 按 us 猜测；
而仓库已验证形式是 `/{storefront}/song/{slug}/{id}`。**违反单变量原则**（同时改了 storefront 与路径结构），
因此那次负结果不能证明「Apple Music 不支持指定歌曲」，只能说明我构造的 URL 不合法。

### 单变量测试矩阵（每行只改一个变量，失败即停）

| # | 基线 | 唯一变量 | 预期 |
|---|---|---|---|
| T0 | `/{apiStorefront}/song/{slug}/{id}`（完全照抄已验证形式） | 无（重建基线） | 起播该曲目，验证仪器与形式都正常 |
| T1 | 同 T0 | storefront 改为 API/账号实际值（而非 us 猜测） | 确认 storefront 的正确来源 |
| T2 | 同 T0 | 去掉 slug（`/song/{id}`） | 若失败即证明 slug 段必需 |
| T3 | 同 T0 | scheme 改为 `musics://` | 与 `AppleMusic.exe /url` 是否等价 |
| T4 | `/{sf}/album/{slug}/{albumId}?i={catalogSongId}`（candidates.json 已验证形式） | 无（重建基线） | 起播专辑内指定歌曲 |
| T5 | T4 的歌单类比 `/{sf}/playlist/{slug}/pl.{id}?i={catalogSongId}` | 需先确认该歌单是否有 `pl.` 空间 id | 若成立即 B1 成立（歌单内指定歌曲起播） |

**前置待确认**：`/api/apple/user/playlists` 返回对象是否有 `pl.` 空间 id（当前只有 `id: p.…` 与 `applePlayParamsId: p.…`，`appleUrl` 为空）。
若不存在，T5 无法构造，需另找歌单内指定歌曲的参数形式，或转入 B3/B4。

### storefront 的正确来源

`canonicalUrl` 使用 `result.storefront`；`apple-music-web-api.js` 的 `getCatalog` 默认 us，
但 web player bearer 缓存里带 `storefront` 字段 —— 测试应以该实际值为准
（`tests/apple-music-web-lyrics.test.js:410` 出现 `catalog/cn/...`，账号环境可能就是 cn）。
## 0.4 T1：storefront 来源确认（只读，未执行 T2/T3，未触发任何播放）

### 结论先说

`result.storefront` **不是账号事实，而是调用方请求参数**；仓库当前 3 处调用点全部硬编码 `country: 'us'`，
而 T0 基线与本机既有已验证记录使用的 storefront 是 **`cn`** ⇒ **二者不一致，属于真实差异，已按约定停止后续测试**。

### 来源与原始值

| 来源 | 原始值 | 证据 |
|---|---|---|
| `result.storefront`（代码路径） | = 调用方传入的 `requestedCountry` | `desktop/apple-music-control.js:85-99`：`storefront: requestedCountry \|\| ''` |
| 渲染层实际传入值 | `'us'`（硬编码，3 处） | `05-playback/19-amc-app-search-panel.js:176`、`05-playback/07-search.js:1273`、`:1620`、`06-track-detail-lyrics-actions.js:243` |
| iTunes 结果的真实 `country` | 另一独立字段（未被 `canonicalUrl` 使用） | 同文件 `country: r.country \|\| ''` |
| web player bearer 缓存 `storefront` | **非持久化（内存缓存）**，磁盘无对应文件 | userData 内仅 `.apple-music-lyrics-credential.json` / `apple-music-stealth.json` / `apple-playlist-counts.json` |
| 账号侧 storefront 旁证 | 既有已验证日志与 fixture 均为 `cn` | `zorder-poc-...txt:2`、`phase3-resolve/candidates.json:12,22`、`reports/...` |
| T0 使用的 storefront | `cn` | T0 URL：`https://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530` |

### 与 T0 的对照

- T0（`cn`）**通过**：导航 `AppleMusic.exe /url` + 冻结链行点击 ⇒ SMTC 报出 `Playing / How Do I Make You Love Me? / Abel Tesfaye — Dawn FM`。
- 若走应用当前的搜索→播放路径（`country: 'us'`），`canonicalUrl()` 会生成 `https://music.apple.com/us/song/{slug}/{id}`，
  与 T0 基线**storefront 不一致**。
- 按 T1 约定：**先报告差异，不修改 URL、不执行后续测试**。

### 本轮明确未做的事

- 未执行 T2（去 slug）、未执行 T3（`musics://` scheme）
- 未点击任何 UI、未触发任何播放（仅代码阅读 + 磁盘文件只读 + 既有日志比对）
- 未改动任何 URL 或代码
## 0.5 T2 / T3 / T4 实测记录（cn 固定，仅在 POC 脚本内；未改主线代码）

执行器：`experiment/apple-music-alpha1/integration/poc-run-case.ps1`（独立 POC 脚本，
内部调用既有冻结链 `poc/play-song.ps1 -Title -Artist -Url`，即 `AppleMusic.exe /url` 导航 + 行点击 + SMTC 判定）。
原始记录：`experiment/apple-music-alpha1/integration/poc-t2t3t4-records.json`。

### T2 去掉 slug

| 项 | 值 |
|---|---|
| URL | `https://music.apple.com/cn/song/1603171530`（仅去掉 slug，其余同 T0） |
| 导航 | `navMethod=AppleMusic.exe /url` |
| 链侧 | `ok=true`、`stage=OK`、`matchedRow=音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟` |
| SMTC before | `Paused` ｜ **`How Do I Make You Love Me?`** |
| SMTC after | `Playing` ｜ `How Do I Make You Love Me?` ｜ Abel Tesfaye — Dawn FM |
| 结论 | **未定论（基线不干净）** —— 测试前 SMTC 已经是**目标曲目**（T0 遗留，处于暂停），
| | 因此「after=Playing 且是同一首」**无法区分**是 URL 生效，还是链点到了页面上已在的同一行。 |
| | 按任务书要求（不得以导航成功/标题匹配单独判定起播），**不判 PASS**。 |

### T3 scheme 改 musics://

| 项 | 值 |
|---|---|
| URL | `musics://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530`（路径与 T0 完全相同） |
| 导航 | `navMethod=AppleMusic.exe /url` |
| 链侧 | `ok=true`、`stage=OK`、同一 matchedRow |
| SMTC before | `Playing` ｜ `How Do I Make You Love Me?` |
| SMTC after | `Playing` ｜ `How Do I Make You Love Me?` |
| 结论 | **未定论（基线不干净）** —— 测试前目标曲目已在播放，无法证明 `musics://` 是否被接受； |
| | 与 `/url` 的**等价性不能**由此判定。 |

### T4 复测专辑 `?i=` 形式（复用既有 fixture）

| 项 | 值 |
|---|---|
| URL | `music.apple.com/us/album/shape-of-you/1193701079?i=1193701392`（取自 `phase3-resolve/candidates.json` 的 note，**原文无 scheme**） |
| 导航 | `navMethod=AppleMusic.exe /url` |
| 链侧 | `ok=false`、**`stage=URL_NAVIGATION_FAILED`**、耗时 40.4 s |
| SMTC before | `Playing` ｜ `How Do I Make You Love Me?` |
| SMTC after | `Playing` ｜ `How Do I Make You Love Me?`（未变化） |
| 异常 | **本项 URL 由我提取时漏掉了 `https://` 前缀**（fixture 的 note 文本本身不带 scheme） |
| 结论 | **未定论（URL 构造错误，属提取缺陷）** —— 不能据此判断 `?i=` 形式是否有效； |
| | 需以**带 scheme** 的形式重测（与 T0 一样，从实际使用过的日志取原文）。 |

### 本轮暴露的两个执行缺陷（已定位，尚未修）

1. **基线不干净**：三个用例连续执行，未在每项开始前重置到「与目标曲目不同」的已知基线 ⇒ T2/T3 的判定被污染。
   修正做法：每项开始前先建立**不等于目标曲目**的基线（例如用应用自身路径播另一首并暂停），并把基线身份写入记录；
   若基线恰为目标曲目，直接标 **未定论**，不得判 PASS。
2. **fixture 文本不含 scheme**：从 `candidates.json` 的 note 提取会丢 `https://`；应从**实际调用日志**（如 zorder 报告）取原文，或显式补 scheme 并标注来源。

### 本轮明确未做的事

- 未执行 T5（尚无真实、可核验的 `pl.` 空间歌单实体 ID）
- 未修改 `canonicalUrl()`、未改渲染层 `country:'us'`、未改任何主线播放代码
- 未把 `cn` 描述为已确认的账号 storefront（`cn` 仅是本次 POC 的固定测试条件）
## 0.6 执行器修复 + T2 重跑（本轮）

### 执行器修改摘要（`experiment/apple-music-alpha1/integration/poc-run-case.ps1`，独立 POC 脚本）

| 阶段 | 内容 | 失败处理 |
|---|---|---|
| 1 前置状态 | 读 SMTC 现状（`preState`）并记录时间戳 | — |
| 2 建立基线 | 用既有已验证控制路径播放一首**与目标不同**的基线歌（本轮用 fixture 的 `https://music.apple.com/cn/song/晴天/535824738`） | 基线链失败即进入第 3 步判定 |
| 3 基线判定 | 要求 `SMTC.title == 基线标题` 且 `!= 目标标题` 且非空；同时记录 title/artist/album/status/ts | **不满足即 abort**：`BASELINE_NOT_CONFIRMED_OR_EQUALS_TARGET`，标记 INCONCLUSIVE，**不执行目标 URL** |
| 4 暂停基线 | 发一次受控暂停键并记录结果（不假设暂停会清会话） | 记录 `pauseResult` |
| 5 目标 URL | 仅基线确认后才调用冻结链 `poc/play-song.ps1 -Title -Artist -Url` | — |
| 6 分阶段记录 | 导航 `navMethod/stage/stageDetail`；UIA `candidateCount/ambiguous/matchedRow/attempts`；点击（注明冻结链未单独暴露点击字段，`stage=OK` 才隐含点击已执行）；起播 `SMTC status/title/artist` | 不合并成一个 ok |
| 7 判定 | `URL_NAVIGATION_FAILED` → FAIL（仅当前条件）；SMTC 标题==目标 → PASS；否则 INCONCLUSIVE | 不放宽条件 |

**未修改**：冻结链 `poc/play-song.ps1` / `poc/lib/**`、MineRadio 正式播放主线、`canonicalUrl()`、渲染层 `country:'us'`。

### 本轮 T2 实际结果 —— **INCONCLUSIVE（目标 URL 未执行）**

| 项 | 值 |
|---|---|
| 目标 URL（未执行） | `https://music.apple.com/cn/song/1603171530`（唯一变量：省略 slug） |
| 基线尝试 | `https://music.apple.com/cn/song/晴天/535824738`，`navMethod=AppleMusic.exe /url`，链侧 **`stage=URL_NAVIGATION_FAILED`** |
| 基线 SMTC | `Paused` ｜ `How Do I Make You Love Me?`（= 目标曲目）⇒ 基线**未能建立** |
| preState | `Paused` ｜ `How Do I Make You Love Me?` |
| abort 原因 | `BASELINE_NOT_CONFIRMED_OR_EQUALS_TARGET` |
| navigation / uiaMatch / click / smtcAfter | **全部为空**（证明目标 URL 确实没有被执行） |
| 判定 | **INCONCLUSIVE** —— 按约定不得继续、不得判 PASS |

原始记录：`experiment/apple-music-alpha1/integration/poc-t2-record.json`
测试命令：
```
powershell -NoProfile -ExecutionPolicy Bypass -File experiment\apple-music-alpha1\integration\poc-run-case.ps1 \
  -Id T2 -TargetUrlFile <t2-target-url.txt> -TargetTitleFile <t2-target-title.txt> \
  -TargetArtistFile <t2-target-artist.txt> -BaselineUrlFile <t2-baseline-url.txt> -BaselineTitleFile <t2-baseline-title.txt>
```

### 由此得到的两个事实（仅限当前条件，不外推）

1. 执行器的**干净基线闸门有效**：基线不成立时确实中止，目标 URL 未被触碰（字段为空可核）✔
2. 本轮用作基线的 URL（含中文 slug `晴天`）在当前环境下 `URL_NAVIGATION_FAILED`；
   这与 T0（ASCII slug）通过并不矛盾 —— 但**不能**据此断言中文 slug 一概不可用（仅当前条件失败）。

### 下一轮建立基线的两个候选（择一，不混用）

- **B-a（推荐）**：用应用自身已验证路径（`amc.playAlbum` → 指定专辑内一首**非目标**歌曲）建立基线，
  该路径不依赖 URL 形式（已多次实测 `PLAYBACK_STARTED` + SMTC 标题），可绕开 URL 变量污染；
- **B-b**：改用另一条**ASCII slug** 且已在使用日志中出现过的歌曲 URL 作为基线（需先确认其形式与 T0 同类）。

### 本轮未做

- 未重跑 T3、T4；未执行 T5；未尝试任何额外 URL 变体；未为得到 PASS 放宽判定
- 未把 `cn` 描述为已确认的账号 storefront（仅为固定测试条件）
## 0.7 B-a 基线（URL 无关）+ T2 重跑 —— **PASS（仅当前条件）**

### 前置：本轮新增的 POC 脚本（均在实验目录内，未改主线）

| 文件 | 作用 |
|---|---|
| `integration/poc-baseline-via-app.js` | 经 CDP 调用应用自身已验证路径 `amc.playAlbum({name,track,scopeLabel,sectionLabel})` 建立基线（**不依赖 URL**） |
| `integration/poc-t2-phase2.ps1` | 读 SMTC 确认基线 → 受控暂停（记录前后）→ 仅基线确认后才执行目标 URL（冻结链）→ 分阶段记录 |
| `integration/poc-t2-via-app-baseline.json` | 本轮原始记录 |

### 分阶段证据（原始记录 `poc-t2-via-app-baseline.json`）

| 阶段 | 观测值 | 说明 |
|---|---|---|
| 基线播放（应用自身路径） | `stage=PLAYBACK_STARTED`、`smtcTitle=Faith`、`matchedName=Faith`、`picked=After Hours` | 基线曲目与目标**不同** |
| 基线 SMTC | `Playing` ｜ `Faith` ｜ Abel Tesfaye — After Hours ｜ ts `18:41:34` ｜ `confirmed=true` | 身份非空、等于预期、且≠目标 |
| 受控暂停 | before `Playing｜Faith` → after `Paused｜Faith` ｜ `identityPreserved=true` ｜ ts `18:41:36` | 暂停后身份未消失，页面/队列状态未做假设 |
| 目标 URL 导航 | `navMethod=AppleMusic.exe /url`、**`stage=OK`**、`chainOk=true`、`elapsedMs=4912` | **未出现 `URL_NAVIGATION_FAILED`**；URL = `https://music.apple.com/cn/song/1603171530`（唯一变量：省略 slug） |
| UIA 匹配 | `candidateCount=1`、`ambiguous=false`、`matchedRow=音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟`、`attempts=1` | 页面内容匹配后才可能列出该行 |
| 点击 | **`evidence=INFERRED`**（冻结链未单独暴露点击字段；`stage=OK` 隐含页面等待成功后的行点击已执行） | **不作为独立观测** |
| 最终 SMTC | `Playing` ｜ `How Do I Make You Love Me?` ｜ Abel Tesfaye — Dawn FM ｜ ts `18:41:44` | 目标曲目确实在播放 |

### 判定：**PASS（仅当前条件）**，理由与边界

成立的证据链：基线是**另一首歌**且经 SMTC 确认（排除“目标原本就在播”的污染）→ 目标 URL 交给冻结链后
**导航阶段 OK（非 URL_NAVIGATION_FAILED）**且页面内容匹配成功 → UIA 恰好匹配到**目标歌曲行（1 个候选）** →
最终 SMTC 身份 = 目标曲目。⇒ 在本轮条件下，**去掉 slug 的 URL 仍能导航到目标歌曲页面**，随后既有 UIA 行点击链路完成起播。

必须写明的限制：
- **点击是推断**，不是独立观测（冻结链无点击字段）；因此本项证明的是
  「导航成功 + 行匹配 + SMTC 起播」，而不是「点击本身被独立观测到」。
- 结论**仅限**该 URL（`/cn/song/1603171530`）与**当前环境**；不外推到其它歌曲、其它 storefront 或其它 URL 形式。
- `cn` 仍只是本轮 POC 的固定测试条件，**不代表账号商店地区已获确认**。

### 本轮未做

- 未运行 T3/T4/T5；未修改 `canonicalUrl()`、渲染层 `country:'us'`、任何正式播放代码或冻结链；
- 未覆盖既有 T2(#1)/T3/T4 的 INCONCLUSIVE 记录，未做追溯改判。
## 0.8 T3：`musics://` scheme（唯一变量）

测试命令：
```
powershell -NoProfile -ExecutionPolicy Bypass -File experiment\apple-music-alpha1\integration\poc-t2-phase2.ps1 \
  -TargetUrlFile t3-target-url.txt -BaselineTitleFile t2-baseline-app-title.txt \
  -TargetTitleFile t2-target-title.txt -TargetArtistFile t2-target-artist.txt
```
目标 URL：`musics://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530`（仅 scheme 变化）
基线：应用自身路径 `amc.playAlbum`（URL 无关），基线曲目 `Faith`
原始日志：`experiment/apple-music-alpha1/integration/poc-t3-record.json`

| 阶段 | 观测值 |
|---|---|
| 基线 SMTC | {"album":"","ts":"2026-10-02T18:43:21","artist":"Abel Tesfaye — After Hours","confirmed":true,"expected":"Faith","status":"Playing","title":"Faith"} |
| 受控暂停 | {"ts":"2026-10-02T18:43:23","before":"Playing|Faith","identityPreserved":true,"after":"Paused|Faith"} |
| 导航 | {"stage":"OK","elapsedMs":4736,"stageDetail":"","navMethod":"AppleMusic.exe /url","chainOk":true} |
| UIA 匹配 | {"attempts":1,"matchedRow":"音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟","ambiguous":false,"candidateCount":1} |
| 点击 | {"evidence":"INFERRED","note":"frozen chain exposes no click field; stage=OK implies the row click executed after a successful page wait"} |
| 最终 SMTC | {"artist":"Abel Tesfaye — Dawn FM","status":"Playing","album":"","title":"How Do I Make You Love Me?","ts":"2026-10-02T18:43:31"} |
| **判定** | **PASS** |

判定理由与限制：
- 判定规则与 T2 相同：导航 `URL_NAVIGATION_FAILED` → FAIL（仅本轮条件）；导航成功 + UIA 唯一匹配目标行 + 最终 SMTC 身份=目标 → PASS（仅当前条件）；否则 INCONCLUSIVE。
- 点击仍为 **INFERRED**（冻结链不暴露点击字段），不得据此声称 scheme 本身直接触发起播。
- 结论仅限该 `musics://` URL 与当前环境，不外推到所有 `musics://` 链接。

### 本轮未做

- 未运行 T4/T5；未修改正式播放主线、`canonicalUrl()`、渲染层 `country:'us'`、冻结链或 `poc/lib/**`；未推断账号 storefront
- 未覆盖 T0–T2 及此前 INCONCLUSIVE 记录
## 0.9 T4：专辑 URL 的 `?i=` 单曲选择形式

### URL 与目标身份核验（执行前完成）

| 项 | 值 | 来源（文件:行号） |
|---|---|---|
| 完整 URL（含 scheme，verbatim） | `https://music.apple.com/us/album/shape-of-you/1193701079?i=1193701392` | `phase3.7A-navigation/cases/E10.json:30`、`phase3.7A-navigation/reports/run-log.txt:9`、`phase3-resolve/known-songs.json:26`、`poc/songs.json:30`、`phase3.7B-uia-no-mouse/cases/controls.json:6` |
| 目标歌曲身份 | title `Shape of You`、artist `Ed Sheeran`、songId `1193701392`、storefront `us`（同一记录内给出，非由 slug 推断） | `phase3.7A-navigation/cases/E10.json:30`、`poc/songs.json:27-30` |
| 专辑佐证 | `÷ (Deluxe)`（albumId 1193700767 为 `÷` 非 Deluxe，二者不同） | `phase3-resolve/PHASE36-REPORT.md:91`、`phase3-resolve/candidates.json:29` |

测试命令：
```
powershell -NoProfile -ExecutionPolicy Bypass -File experiment\apple-music-alpha1\integration\poc-t2-phase2.ps1 \
  -TargetUrlFile t4-target-url.txt -BaselineTitleFile t2-baseline-app-title.txt \
  -TargetTitleFile t4-target-title.txt -TargetArtistFile t4-target-artist.txt
```
原始日志：`experiment/apple-music-alpha1/integration/poc-t4-record.json`

| 阶段 | 观测值 |
|---|---|
| 基线 SMTC | {"album":"","ts":"2026-10-02T18:45:06","artist":"Abel Tesfaye — After Hours","confirmed":true,"expected":"Faith","status":"Playing","title":"Faith"} |
| 受控暂停 | {"ts":"2026-10-02T18:45:08","before":"Playing|Faith","identityPreserved":true,"after":"Paused|Faith"} |
| 导航 | {"stage":"OK","elapsedMs":4897,"stageDetail":"","navMethod":"AppleMusic.exe /url","chainOk":true} |
| UIA 匹配 | {"attempts":1,"matchedRow":"音轨 4 Shape of You 3 分钟，54 秒钟","ambiguous":false,"candidateCount":1} |
| 点击 | {"evidence":"INFERRED","note":"frozen chain exposes no click field; stage=OK implies the row click executed after a successful page wait"} |
| 最终 SMTC | {"artist":"Ed Sheeran — ÷ (Deluxe)","status":"Playing","album":"","title":"Shape of You","ts":"2026-10-02T18:45:16"} |
| **判定** | **PASS** |

判定理由与限制：
- 规则同 T2/T3：导航 `URL_NAVIGATION_FAILED` → FAIL（仅本轮条件）；导航成功 + UIA 唯一匹配目标行 + 最终 SMTC 身份=目标 → PASS（仅当前条件）；否则 INCONCLUSIVE。
- 本项只证明「该专辑 URL 在本环境中导航并最终播到该曲目」；**不声称 `?i=` 参数被正确解释**，
  也不声称 URL 自身直接触发起播（点击仍为 INFERRED）。
- 结论仅限该 URL 与当前环境；`us` 是该 fixture 自带的 storefront，非账号 storefront 推断。

### 本轮未做

- 未运行 T5；未修改正式播放主线、`canonicalUrl()`、渲染层 `country:'us'`、冻结链或 `poc/lib/**`；
- 未覆盖 T0–T3 与既有 INCONCLUSIVE 记录，未追溯改判。
## 0.10 T5 前置调查：是否存在可核验的 `pl.` 空间歌单实体 ID（只读，未执行 T5）

### 结论先说

**存在一个真实、可核验的 `pl.` 实体 ID**（用户提供、且**实测跑通**），但**缺少它与资料库歌单 `p.…` 的映射证据**，
也**缺少「歌单内指定歌曲」的参数证据** ⇒ 按约定 **T5 不能开始**，并已在下面写明缺哪一段。

### 证据清单（file:line / 原始值 / 判定）

| 候选 | 来源（文件:行号） | 原始 URL 或 ID | 是否对应真实用户歌单 | 是否为 `pl.` 实体的独立证据 | 目标歌曲身份可确认？ |
|---|---|---|---|---|---|
| `pl.u-vxy697juWRBP21v` | `experiment/apple-music-windows-control/REPORT-B-I-PLAYLIST-CARD.md:307-315` | `https://music.apple.com/cn/playlist/my-playlist/pl.u-vxy697juWRBP21v`（用户于 2026-09-26 提供） | **未证实**（名字与两个同名资料库歌单都可能对应） | **有**：`play-playlist.ps1 -Name \"My Playlist\" -Url <链接> -Commit` → `ok=True stage=PLAYBACK_STARTED navigatedBy=AppleMusic.exe /url playVia=url-page-play-button`，SMTC `Paused -> Playing`，2.7s（:311-315） | **否**（该次是整单播放：`playVia=url-page-play-button`，未做指定歌曲） |
| 资料库歌单 ID | `…/REPORT-B-I-PLAYLIST-CARD.md:336-337`；本轮 App 实测 | `p.MoGJ98ktvP9kMed`、`p.YJXV7dvIerGlQ2X`（两个「My Playlist」） | 是（Experiment A 已用，295 首） | 否（`p.` 是**资料库**空间，不等于 `pl.`） | 是（A 章已建立 295 首顺序与 library/catalog id） |
| `appleUrl`（歌单对象字段） | 本轮 `/api/apple/user/playlists` 原始返回 | `appleUrl: \"\"`（空）、`applePlayParamsId: p.…` | 是 | 否（为空，**不可**据空值推导 URL） | — |
| 映射机制（代码内已声明的硬约束） | `desktop/apple-music-web-api.js:156-189` | 注释：`library ID != catalog ID`；`catalogId` **只从 `attributes.playParams.catalogId` 原样复制，绝不推断**，缺失即为空 | — | 这是**唯一被代码认可的**库↔目录身份桥 | — |

### 缺口（缺哪一段映射证据）

1. **p. ↔ pl. 映射缺失**：现有证据里 `pl.u-vxy697juWRBP21v` 与 `p.MoGJ98ktvP9kMed` / `p.YJXV7dvIerGlQ2X` 之间**没有任何一条记录**表明它们是同一个歌单；
   名字都叫 My Playlist，**不能**用来做映射（同名歧义）。
2. **歌单内指定歌曲的参数缺失**：§10.1 那次成功是**整单播放**（`url-page-play-button`），没有任何「指定第 N 首 / 指定歌曲」的参数被验证过；
   `?i=` 只在**专辑**形式上被本轮 T4 验证（PASS，仅当前条件），**不能**平移为歌单结论。
3. **映射的合法来源尚未取数**：`handleAppleUserPlaylistsWeb`（`server.js:5311`）当前返回的对象里 `appleUrl` 为空；
   是否携带 `attributes.playParams.catalogId` **未采集**（按代码硬约束，缺失时不得推断）。

### 下一步可行路径（择一，均只读或另行批准后才动手）

- **P-1（推荐，只读）**：读一次 `/api/apple/user/playlists` 的**原始**对象，确认是否存在 `attributes.playParams.catalogId` 或 `url` 字段 ——
  有则得到**合法**的 p.→pl. 映射；没有则记录「映射不可得」，不再尝试构造。
- **P-2（需要你确认）**：由你确认 `https://music.apple.com/cn/playlist/my-playlist/pl.u-vxy697juWRBP21v` 到底对应哪一个资料库歌单（本机有两个同名 My Playlist）。
- **P-3（仅在你批准 T5 本体后）**：在获得映射后，验证歌单 URL 是否支持指定歌曲参数，并**单独**验证歌单上下文与下一首顺序。

### 本轮未做（按指令）

- 未执行 T5 播放测试；未构造任何 `pl.` ID；未把 `p.…` 改写成 `pl.…`；未修改正式播放主线、`canonicalUrl()`、渲染层、冻结链或任何用户歌单；未覆盖既有记录。
## 0.11 P-1：只读核查歌单映射字段 —— **映射不可得（当前只读条件下）**

### 检查时间与原始响应

| 项 | 值 |
|---|---|
| 检查时间 | 2026-10-02（本轮） |
| 调用路径 | `GET http://127.0.0.1:3000/api/apple/user/playlists?limit=50&offset=0` |
| 原始响应文件 | `experiment/apple-music-alpha1/integration/poc-p1-user-playlists-raw.json`（HTTP 200，2284 字节，未加工保存） |
| 响应顶层字段 | provider, loggedIn, userId, playlists, total, offset, limit, nextOffset, hasMore, partial, source, error, message |
| 歌单对象**实际出现过的全部字段** | provider \| source \| id \| virtual \| name \| cover \| creator \| trackCount \| playCount \| subscribed \| shelfPane \| public \| appleUrl \| applePlayParamsId |

### 两个同名条目的逐字段记录（**注意：其中一个实际叫 My Playlist2**）

| name | id | appleUrl | applePlayParamsId | catalogId | url | attributes |
|---|---|---|---|---|---|---|
| `My Playlist2` | `p.MoGJ98ktvP9kMed` | `\"\"`（空） | `p.MoGJ98ktvP9kMed` | 不存在 | 不存在 | 不存在 |
| `My Playlist` | `p.YJXV7dvIerGlQ2X` | `\"\"`（空） | `p.YJXV7dvIerGlQ2X` | 不存在 | 不存在 | 不存在 |

全量统计：`catalogId` 出现 0 次、`url` 0 次、`attributes` 0 次、`appleUrl` 非空 0 次（5 个歌单全部如此）。

### 与代码认可的身份映射规则对照

| 证据 | 内容 |
|---|---|
| `desktop/apple-music-web-api.js:158-160`（硬约束注释） | `library ID != catalog ID`；`catalogId` **只从 `attributes.playParams.catalogId` 原样复制，绝不推断**，缺失即 undefined |
| `desktop/apple-music-web-api.js:170-193`（`mapLibraryAlbum`） | **专辑**路径确实实现了该桥：`catalogId: playParams.catalogId`，并保留 `playParams`；`appleUrl` 硬编码为空串 |
| `desktop/apple-music-web-reads-api.js:76-100`（`handleAppleUserPlaylistsWeb`） | **歌单**路径：`GET /v1/me/library/playlists` → 逐项 `mapAppleLibraryPlaylist(item)`；**映射结果里没有任何 `attributes` / `catalogId` / `url` 透传** |

⇒ 按代码认可规则，p.→pl. 的合法桥（`attributes.playParams.catalogId` 或 `attributes.url`）**在歌单路径上未被实现、也未被采集**。

### 判定

- **未发现明确映射证据 ⇒ 映射不可得**，本轮调查在此停止（不猜测、不构造）。
- **未决（不升级为映射）**：上游 `/v1/me/library/playlists` 的**原始 payload** 是否携带 `attributes.url` / `playParams.catalogId` —— 
  本轮**无法只读获取**（bearer 仅存在于主进程内存，路由只返回映射后的对象；抓上游需要改动生产代码，本轮禁止）。
- 顺带更正此前记录：两个条目并非都叫 `My Playlist`，实际一个是 **`My Playlist2`**（同名歧义比先前记录更小，但仍不足以做映射）。

### 下一步可行路径

1. **P-1b（需另行批准）**：以**临时调试钩子**抓一次上游原始 payload，确认是否存在上述字段；
   若存在 → 得到合法映射；若不存在 → 记录为映射不可得（终局）。
2. **P-2（需要你确认）**：`https://music.apple.com/cn/playlist/my-playlist/pl.u-vxy697juWRBP21v` 对应哪个歌单；
   但即便确认，仍缺「歌单内指定歌曲」的参数证据。
3. **P-3（产品向替代路线，需批准）**：不走 `pl.` 深链，改为「打开歌单页 → UIA 只认 ListItem 行 → 落点空白 → 真双击 → SMTC 判定」，
   复用专辑侧已验证机制（该机制在专辑页 PASS，但**歌单页未验证**，且上下文/下一首顺序仍需单独验证）。

### 本轮未做（按指令）

- 未执行 T5；未构造 URL；未测试指定歌曲参数；未修改 `canonicalUrl()`、渲染层、冻结链、用户歌单或既有 POC 记录。
## 0.12 P-3 第一阶段：用户歌单页指定歌曲（本轮）—— **INCONCLUSIVE（含两项正向发现）**

执行器：`experiment/apple-music-alpha1/integration/poc-p3-phase1.ps1`（独立 POC，未改主线/冻结链）
基线：应用自身路径 `amc.playAlbum` → `Faith`（SMTC 确认）
目标：歌单 `My Playlist2`（资料库 `p.MoGJ98ktvP9kMed`，295 首）内**第 3 首** `玄翎衔心`（资料库 `i.EYVbNPphmEbV1oR`）
原始记录：`experiment/apple-music-alpha1/integration/poc-p3-phase1-record.json`

### 分阶段观测（原始值）

| 阶段 | 观测 | 判定 |
|---|---|---|
| 基线 SMTC | `Playing` ｜ `Faith` | 基线成立（≠ 目标） |
| 歌单搜索 | `ok=true`、候选 1、精确同名 1（`My Playlist2`） | 唯一、无歧义 |
| **卡片点击（导航）** | `ok=true`，点 `681,536`（**未重算**，用的是我给的坐标） | — |
| **点击后 SMTC** | 仍 `Playing` ｜ `Faith` | **导航未起播** ⇒ 与专辑侧同款「只开页面、不出声」行为 ✔ |
| **页面身份** | 页面内出现 2 处 `My Playlist2`（标题等） | **确认打开的是目标歌单**（非仅凭同名卡片） |
| UIA 目标行 | `count=1`、`unique=true` | 唯一匹配 ✔ |
| 落点 | `blank-right-of-badge` → 实际 `x=2602, y=1112` | **超出该行范围**（见阻塞点） |
| 点击 | `ok1=true, ok2=true`（两次调用 = 4 次点击），标记 **INFERRED** | 工具链不暴露结果，仅推断 |
| 最终 SMTC | `Playing` ｜ `Faith`（未变化） | **目标未起播** |

### 阻塞点（本轮停止原因）

**落点越界**：本轮的 aim 规则（“短名字子元素视为徽标，取其右边缘 +200”）把**时长文本**（如 `3:38`，长度 ≤4）
误判成徽标 ⇒ 落点被推到 `x=2602`（超出该行右边界，甚至出窗口），点击无效。
这是我上次为「E 徽标」写的启发式在歌单页的**误伤**，不是歌单页本身不可行。

### 本轮的两项正向发现（可复用）

1. **歌单页可以只导航不起播**：点击歌单卡片后 SMTC 不变 ⇒ 与专辑侧一致，可用于「先开页再选行」。
2. **目标行可被唯一匹配**：以 `ListItem` 祖先 + 标题（含艺人）子串匹配，得到 `count=1`。

### 下一轮修法（拟定，待批准）

- aim 规则改为**行内约束**：优先 `标题文本中心`；否则 `row.Left + 0.45 * row.Width`；**并把点夹在 row 矩形内**（留 40px 边距）；
- `badge` 候选排除**纯数字/时长形态**（`^\\d+# POC：Apple Music 用户歌单「指定歌曲起播」可行性验证（阶段报告）

> 状态：**进行中**。本报告只记录已实际执行并取得证据的部分；未执行的路径一律标注「未验证」，
> 不写成 PASS。整体结论暂定 **PARTIAL（未完成）**。

## 0.13 P-3 第一阶段重跑（修复行内点击定位）—— **PASS（仅当前条件）**

执行器：`experiment/apple-music-alpha1/integration/poc-p3-phase1.ps1`（本轮修改；未改主线/冻结链）
原始记录（**新文件，未覆盖旧证据**）：`experiment/apple-music-alpha1/integration/poc-p3-phase1b-record.json`
旧的失败记录仍在：`integration/poc-p3-phase1-record.json`（对应 §0.12）

### 执行器修改摘要

1. aim 规则改为**行内约束**：优先 `标题文本中心`，其中心必须落在目标 `ListItem` 行矩形内；否则用 `row.Left + 0.45 × row.Width` + 行垂直中心；
2. **强制边界检查**：最终点必须在行矩形内且与行边缘保持 ≥40px；行宽不足 80px 或点不满足时**中止**（`INCONCLUSIVE_NO_VALID_AIM`），不放宽、不盲点；
3. 徽标候选过滤：排除 `^\\d+# POC：Apple Music 用户歌单「指定歌曲起播」可行性验证（阶段报告）

> 状态：**进行中**。本报告只记录已实际执行并取得证据的部分；未执行的路径一律标注「未验证」，
> 不写成 PASS。整体结论暂定 **PARTIAL（未完成）**。
## 1. 实验 A：歌单与歌曲身份 —— **PASS**

测试对象（真实用户资料库歌单）：**My Playlist**，Library Playlist ID = `p.MoGJ98ktvP9kMed`，
`/api/apple/playlist/tracks` 报告 `total=295`、`hasMore=true`（分页 100/次）。

**数据全部来自 Library API，未做任何 UIA 列表滚动。**

| 身份 | 示例（歌单第 51 首） | 与其它身份的区别 |
|---|---|---|
| Library Playlist ID | `p.MoGJ98ktvP9kMed` | 歌单身份 |
| Library Song ID (`id`) | `i.vMX19DDugYAzpbX` | 资料库歌曲身份 |
| Catalog Song ID (`catalogId`) | `1786354119` | 目录（商店）歌曲身份 |
| 顺序 | 第 1..295 位，API 按歌单顺序返回 | `trackNumber` 字段另有其值 |
| 客户端 UIA 元素标识 | 未采集（本阶段未执行 UIA 定位） | 未验证 |
| SMTC 会话 | 见实验 B1 记录 | 播放状态事实来源 |

快照文件：`experiment/apple-music-alpha1/integration/poc-playlist-identity.json`（歌单元数据 + 前 100 首完整字段）。
注意：`appleUrl` 字段**为空**，API 不提供可直接使用的深链接 ⇒ 深链接需自行构造。

## 2. 实验 B：寻找无需 UIA 全列表滚动的路径

### B1 深链接 —— **FAIL（就当前构造形式而言）**

目标：第 51 首「晓」（Library Song ID `i.vMX19DDugYAzpbX`，Catalog `1786354119`），远离可视区。

| # | URL | 12 秒后 SMTC | 判定 |
|---|---|---|---|
| 1 | `https://music.apple.com/library/playlist/p.MoGJ98ktvP9kMed?l=i.vMX19DDugYAzpbX` | title=`""`、无会话 | 未起播 |
| 2 | `https://music.apple.com/library/playlist/p.MoGJ98ktvP9kMed?i=1786354119` | title=`""`、无会话 | 未起播 |

### B1 副作用记录（重要，安全相关）

用户报告：**实验期间 Apple Music 出现过「未知错误」状态**（现已由用户手工修复）。
时间上与 B1 的两次 `music.apple.com/library/playlist/...` 导航吻合 ⇒ 该 URL 形式不仅**不起播**，
还可能把客户端置于错误状态。

处置与约定：
- 该系列 URL 形式（`library/playlist/<id>?l=`、`?i=`）在**未确认客户端可接受之前不得再次尝试**；
- 后续 B1 扩展必须先做**只读**确认（观察页面是否有错误提示/是否停留在原页面），并且每次只试一种形式；
- 破坏性检查前先读 SMTC 当前状态并记录，出现错误立即停止该路径（对应任务书第 4 条第 9 点）。

结论：**`library/playlist/<id>?l=`（library song id）与 `?i=`（catalog id）两种构造都未能起播**。
尚未区分「URL 未被客户端接受」与「页面打开但未播放」——需要下一步对客户端页面做一次只读观察，
并尝试其它形式（例如目录歌单 URL `pl.<id>?i=<catalogSongId>`、或客户端私有 scheme）。**当前记为 FAIL/未定论**。

### B2 既有控制入口

| 入口 | 能否指定目标歌曲 | 能否保留歌单上下文 |
|---|---|---|
| `amc.playPlaylist({name, scopeLabel})`（歌单链） | 否（按名字找到歌单卡后从**第 1 首**开始） | 是（歌单自身队列） |
| `amc.playAlbum({name, track, ...})`（本次新做，专辑语义） | 可定位到某一行 | 专辑页上下文，非用户歌单上下文 |
| `amc.playTrack({url,...})`（单曲深链） | 是（目录歌曲） | **否**（脱离歌单上下文，播目录版本） |

⇒ 现有入口中**没有**「指定歌单内某首 + 保留该歌单队列」的接口。

### B3 UIA 直接定位 / B4 ScrollIntoView / B5 分段滚动 —— **未验证**

尚未执行。已有可复用的强相关能力（本次新做并已真机验证）：
`poc/play-album-library.ps1` 已实现「按名字打开页面（**点击卡片只导航、不出声**，已实测）→ 树级只认
`ListItem` 行 → 落点=E 徽标右侧空白 → **真双击** → SMTC 判定」，并修掉了两处坑
（`Invoke-AmRowPlay` 会覆盖调用方坐标；歌曲行需要双击）。这套机制**大概率适用于歌单页**，但属**未验证**。

## 3. 实验 C：歌单播放上下文 —— **未验证**

四个位置（第 1 首 / 可视区内 / 远离可视区 / 接近末尾）与「下一首是否按歌单顺序」均**未执行**。
已具备的工具：`Get-AmSmtcState`（判定当前曲目）、VK_MEDIA_NEXT_TRACK（受控下一首，仅测试时使用）、
`poc-playlist-identity.json`（提供期望的下一首名字，可交叉验证顺序）。

## 4. 稳定性与安全

- 未使用固定屏幕坐标作为主方案（当前阶段的落点由元素矩形推导，非硬编码坐标）
- 未使用全局滚轮；未使用 Alpha=0；未修改稳定主线的播放行为
- 本阶段脚本均有 8–12 秒级等待上限；未引入新的常驻进程
- 未执行破坏性操作前会先读 SMTC 当前状态（B1 的两次导航改变了客户端页面，已记录）

## 5. 推荐（暂定，待 B3/B4 + C 完成后再定稿）

- **主方案候选**：先修/找到可用的深链接形式（B1 扩展）；若不成立，则采用「打开歌单页 → UIA 行定位 →
  双击」路线（复用已修好的 `play-album-library.ps1` 机制），该路线**不使用滚轮**、也**不逐屏滚动**。
- **兜底**：有限步分段滚动（仅在 B3/B4 均失败时启用）。
- **已知限制**：Library API 不提供深链接（`appleUrl` 为空）；播客式条目页内行可能不可枚举（专辑侧已实测）。

## 6. 变更清单

| 文件 | 说明 |
|---|---|
| `experiment/apple-music-alpha1/integration/poc-identity.js` | 实验 A：纯 API 取歌单/歌曲身份（无 UIA） |
| `experiment/apple-music-alpha1/integration/poc-playlist-identity.json` | 歌单元数据 + 前 100 首顺序/ID 快照 |
| `experiment/apple-music-alpha1/integration/poc-deeplink-test.ps1` | 实验 B1：深链接两种构造 + SMTC 判定（含受控下一首检查） |
| 本次未修改任何稳定主线播放代码 | — |

复现：`node experiment/apple-music-alpha1/integration/poc-identity.js`（需应用运行）→
`powershell -File experiment/apple-music-alpha1/integration/poc-deeplink-test.ps1`

## 7. 结论（阶段）

| 项 | 判定 |
|---|---|
| 实验 A 身份建立（无滚动） | **PASS** |
| 实验 B1 深链接指定起播（当前形式） | **FAIL**（两次构造均未起播，且客户端曾进入未知错误状态；该形式暂禁重试） |
| 实验 B2 既有入口 | 已梳理：无「指定歌单内某首 + 保留队列」的入口 |
| 实验 B3/B4/B5 | **未验证** |
| 实验 C 上下文与下一首顺序 | **未验证** |
| 仪器可信度 | **PASS**（SMTC 能报 Playing/标题；已用它交叉验证过一次真实播放） |
| 深链接形式确认 | **未完成**：本区 storefront / 参数组合待重新确认（失败样例已记录） |
| 整体 | **PARTIAL（未完成）— 暂不建议开始正式歌单播放功能设计** |

## 8. 下一步（建议顺序）

1. B1 扩展（**谨慎**）：先用只读观察确认客户端在两种 URL 下的页面反应与是否报错；确认可接受后再试其它形式
   （`pl.<id>?i=` 等），一次只试一种，出现错误立即停止；
2. B3/B4：在歌单页上用既有树级扫描定位目标行（复用 `play-album-library.ps1` 的落点/双击/SMTC 判定）；
3. C：四个位置 × （起播、SMTC 匹配、歌单上下文、下一首顺序、异常）逐项实测；
4. 通过后再评估接入正式播放流程。

---

## 0.14 P-3 第二阶段：队列上下文与下一首 —— **PASS_CONTEXT（仅当前条件）**

（按「只追加」写入，放在文件末尾，避免再触发结构重复。）

要回答的唯一问题：从 `My Playlist2` 第 3 首 `玄翎衔心` 起播后，下一首是否**确实对应该歌单的下一首**，而不是某个意外队列。

### 方法

- 期望顺序来自 Library API（`poc-playlist-identity.json`，歌单 `p.MoGJ98ktvP9kMed`）：
  `#3 玄翎衔心` → `#4 万音之梁` → `#5 踏歌行`（→ `#6 且听风吟`）
- 起播由 P-3 第一阶段执行器完成（歌单页 → 唯一行匹配 → 受控双击；§0.13）
- 记录 A：**自然切歌**（无强制操作）；记录 B：**一次受控 next**（VK_MEDIA_NEXT_TRACK）

### 记录 A：自然切歌（`integration/poc-p3-phase2-record.json`）

| 项 | 值 |
|---|---|
| 起播（§0.13） | #3 `玄翎衔心`，ts `19:03:50` |
| 稍后实测 SMTC | `Playing` ｜ **`万音之梁`** ｜ `鸣潮先约电台, jkinss & JINGYAN — 万声弥新(游戏《鸣潮》原声音乐)` |
| 与 API 对比 | 该曲 = API 的 **#4**（`matchesApiTrack4 = true`） |
| 说明 | 本轮脚本因前置闸门（要求起播时 SMTC 必须仍是 #3）判定 `INCONCLUSIVE_NOT_STARTED_FROM_TARGET`，
| | 但 `steps.before` 已如实记录上述观测 —— 这是**自然过渡**到 #4 的证据 |

### 记录 B：一次受控 next（`integration/poc-p3-phase2b-record.json`）

| 项 | 值 |
|---|---|
| 操作前 | `Playing` ｜ `万音之梁`（=API #4，`matchesApiTrack4=true`） |
| 操作 | 一次 `VK_MEDIA_NEXT_TRACK` |
| 操作后 SMTC | `Playing` ｜ **`踏歌行`** ｜ `鸣潮先约电台 & jkinss — 万声弥新(游戏《鸣潮》原声音乐)`，ts `19:06:30` |
| 与 API 对比 | 该曲 = API 的 **#5**（`equalsApiTrack5 = true`） |
| 判定 | **PASS_CONTEXT** |

### 结论与限制

- 证据链：`#3 玄翎衔心`（起播）→ **自然**到 `#4 万音之梁` → 受控 next 到 `#5 踏歌行`，两者均与 Library API 给出的歌单顺序一致 ⇒
  **本轮条件下，播放仍处于该用户歌单的播放序列，而不是意外队列**。
- 限制：只验证了连续 3 首（#3→#4→#5）；未验证更长跨度、随机播放、歌单末尾与跨歌单行为；
  记录 B 的运行未包含「页面仍显示歌单名」的上下文快照（该检查在第一阶段做过：`playlistIdentity.matches=2`）。
- 结论仅限本轮歌单 `My Playlist2`、该歌单顺序与当前环境。

### 本轮未做（按指令）

- 未测试深链、未改播放器架构、未接入正式主线；未验证/未宣称其它上下文场景。

---

## 0.15 P-3 扩样：第二个歌单（音乐回忆 2025）

样本对比：歌单 1 = `My Playlist2`（295 首，用户自建、中文命名）；歌单 2 = `音乐回忆 2025`（**99 首**，Apple 自动回顾式、英文/拉丁命名）
歌单 2 的 Library ID：`p.2P6Wg5KCVWOK3m2`（身份与顺序来自 Library API，快照 `integration/poc-playlist2-identity.json`）

### 步骤一：指定歌曲起播（与第一阶段同协议）

原始记录：`integration/poc-p3-playlist2-phase1-record.json`

| 项 | 观测 |
|---|---|
| 歌单搜索 | 候选 1、精确同名 1（`音乐回忆 2025`） |
| 导航 | 卡片点击 ok；点击后 SMTC 仍 `Paused｜踏歌行`（`playbackChanged=false`）⇒ 仅导航 |
| 歌单身份 | 页面内 3 处歌单名 |
| 目标行（#3 `The Hills`） | `count=1`、`unique=true` |
| 几何 | 行 `519,1062 2022x98`；标题 `671,1097 89x27`；最终点 `titleCenter 716,1110`（行内、≥40px 边距） |
| 点击 | 1 次调用，**INFERRED**（helper 内部双击） |
| 最终 SMTC | `Playing` ｜ **`The Hills`** ｜ `Abel Tesfaye — Beauty Behind the Madness` ｜ ts `19:08:32` |
| **判定** | **PASS_PHASE1** |

### 步骤二：连续两次曲序核验

原始记录：`integration/poc-p3-playlist2-order-record.json`（操作前观测 + 两次受控 next）

| 步 | 期望序号 | 期望曲目 | 实际 SMTC | 艺人 | 结果 |
|---|---|---|---|---|---|
| 1 | #4 | Starboy (feat. Daft Punk) | Starboy (feat. Daft Punk) | Abel Tesfaye — Starboy | 一致 |
| 2 | #5 | Out of Time | Out of Time | Abel Tesfaye — Dawn FM | 一致 |

操作前观测：{"expected":"The Hills","status":"Playing","match":true,"title":"The Hills"}

| **判定** | **PASS_CONTEXT** |

### 扩样小结（当前条件下的通用性证据）

- 两个歌单（295 首中文自建 / 99 首英文回顾式）在**同一协议**下均得到：导航成功 → 歌单身份确认 → 目标行唯一匹配 → 起播身份与目标一致 → 连续曲序与 API 一致。
- 仍**未证明**：所有歌单、所有播放模式（随机）、歌单末尾与跨歌单边界；生产集成仍暂缓。

---

## 0.16 P-3 扩样：第三个歌单（My Playlist，370 首）—— **PARTIAL（滚动路径未被触发）**

样本：`My Playlist`（Library ID `p.YJXV7dvIerGlQ2X`，**total = 370**，本轮只取首页 100 首做身份来源）
目标：**第 40 首** `There for You`（`Martin Garrix & Troye Sivan`）——刻意选远离首屏的位置
原始记录：`integration/poc-p3-playlist3-scroll-record.json`

### 五项记录（沿用既有判定口径）

| # | 项 | 观测 |
|---|---|---|
| 0 | 操作前基线 | `Playing` ｜ `Out of Time`（上一轮歌单 2 的曲目，≠ 本轮目标） |
| 1 | 歌单导航 | 卡片点击 `ok=true`；点击后 SMTC 仍 `Playing｜Out of Time` ⇒ **仅导航** |
| 2 | 歌单身份 | 页面内 **4** 处 `My Playlist` |
| 3 | 目标行匹配 | **step 0 即 `matches=1`**（扫描时 `scrollPercent = 0`，**未执行任何滚动**） |
| 4 | 点击证据 | `calls=1`、`ok=true`、实际点 `968,1465`，**INFERRED**（helper 内部双击） |
| 5 | 最终 SMTC | `Playing` ｜ **`There for You`** ｜ `Martin Garrix & Troye Sivan — There for You - Single` ｜ ts `19:10:40` |

几何：行 `519,1416 2022x98`；标题 `671,1451 591x26`；最终点 `titleCenter 966,1464`；窗口 `-12,-12 2584x1540`（点在窗口内）；执行前 `rowStillValid=true`
滚动序列：`[{"step":0,"percent":0,"matches":1,"errors":0}]`

### 为什么判 PARTIAL 而不是 PASS

- 起播本身成功：目标身份（标题 + 艺人）与 Library API 的第 40 首一致 ✔
- **但本轮没有验证到滚动/虚拟化路径**：目标行在 `scrollPercent = 0` 时**已在 UIA 树中**（`matches=1`），
  滚动循环一次都没执行 ⇒ 按你的要求必须区分「UIA 找到了目标行」与「滚动后仍能可靠操作目标行」，
  后者**本轮未验证**。
- 因此：本样本记为 **PARTIAL（指定歌曲起播通过；滚动定位未触发、未验证）**。

### 附带观察（有用但不足以结论）

- 目标行矩形 `y=1416`、窗口高 1540 ⇒ 行位于接近窗口底部/视口边缘附近，仍被 UIA 枚举到并成功点击；
  这提示该列表的**实现化范围可能大于可视区**，但不能据此推断更深位置（如 200+）也如此。

### 下一步（滚动路径的真正验证）

1. 取更深目标：用 `offset=100&limit=100` 再取一段，选 **第 150–200 首**作为目标（预期需要真实滚动/分页才可见）；
2. 复用本轮已实现的**有界语义滚动**（`ScrollPattern.LargeIncrement`，最多 12 步、连续两次 percent 不变即停、每步重扫并记录 matches/errors/percent）；
3. 记录滚动前后行重建、重复匹配、旧元素失效（`errors` 计数）等虚拟化现象；
4. 仅在滚动后仍**唯一匹配**时才执行受控双击并做 SMTC 身份校验。

---

## 0.17 P-3 深层目标滚动验证 —— **INCONCLUSIVE（滚动 API 拒绝执行）**

歌单：`My Playlist`（`p.YJXV7dvIerGlQ2X`，370 首）｜原始记录：`integration/poc-p3-deep-scroll-record.json`
候选来源：Library API `offset=100/200/300&limit=100`（`integration/poc-playlist3-deep-candidates.json`，不猜曲目）

### 目标选择（按指令：先确认 0% 时是否已存在）

| 候选序号 | 曲目 | 0% 时匹配数 | 是否采用 |
|---|---|---|---|
| #171 | `You're Somebody Else` / flora cash | **0** | **采用**（确实需要滚动才可能出现） |
| #271 | `In the Studio (feat. Junglebae)` / Trobi | 未测（首个候选已满足条件） | — |
| #370 | `SPIN` / Kroi | 未测 | — |

⇒ 本轮**通过前置条件**：目标在 `scrollPercent = 0` 时**不在** UIA 树中，因此这是一次**真正的滚动测试**（区别于 §0.16）。

### 分项结果（不合并为单一 PASS）

| 项 | 观测 | 判定 |
|---|---|---|
| 歌单导航 | 卡片点击 `ok=true`；SMTC 仍 `Playing｜There for You`（未起播） | ✔ 仅导航 |
| 目标歌单身份 | 页面内 **4** 处 `My Playlist` | ✔ |
| 滚动容器 | `scrollerFound = true`（存在垂直可滚动元素） | ✔ |
| **滚动路径** | step 0：`percent=0`、`matches=0`、`errors=0`、`state=absent`；随后调用 `Scroll(LargeIncrement, NoAmount)` **抛异常**：
| | `Operation is not valid due to the current state of the object.` ⇒ 滚动循环在第 1 步即终止（`stepsRun=1`） | **未验证/失败** |
| 目标行匹配 | 目标在滚动前后均未唯一出现（滚动未生效） | 未达成 |
| 点击 | **未执行**（无行可点；遵守「不盲点、不换坐标重试」） | 未执行 |
| 最终 SMTC | 仍 `Playing｜There for You`（未变化） | 未起播 |

### 检查点状态（点击前 6 项安全闸门）

闸门**未触发**（因为滚动后没有唯一行）：歌单身份 ✔ / 唯一匹配 ✗ / 标题+艺人校验 — / 元素有效性 — / 矩形与窗口有效性 — / 落点约束 —。
按指令：**不做替代坐标尝试、不放宽匹配条件**，记录并停止 ✔

### 本轮结论与限制

- 明确的失败阶段：**滚动调用本身被 UIA 拒绝**（`Scroll` 抛异常），因此**滚动路径仍未获得任何有效证据**；
- 这既不能证明滚动可用，也不能证明不可用 —— 属于**工具链/时机问题**而非被验证的行为；
- 队列顺序本轮未测试（按指令）。

### 下一轮可选修法（择一，仍不改生产/冻结链）

1. 改用**绝对定位**：`ScrollPattern.SetScrollPercent(NoAmount, pct)` 逐档推进；
2. **换容器**：当前选中的是首个垂直可滚动元素，可能不是页面主 ScrollViewer；按 `ControlType.Document/List` 层级与 `VerticalScrollPercent` 可用性重新挑选；
3. **语义滚动替代**：对已实现化的邻近行调用 `ScrollItemPattern.ScrollIntoView`，逐段推进直到目标出现；
4. **键盘翻页**（`PageDown`）仅在聚焦列表后使用，并在报告中明确标注这是输入注入、不属于语义滚动。

### 完整性检查（写入后立即执行）

| 检查 | 结果 |
|---|---|
| 顶级标题重复 | 见下方程序输出（0 重复） |
| 本章节重复 | §0.17 × 1 |
| 历史原始记录存在 | phase1 / phase1b / playlist2-phase1 / playlist2-order / playlist3-scroll / deep-scroll 全部在 |
| 冻结链与正式代码改动 | `poc/lib` + `poc/play-song.ps1` + `desktop` + `server.js` + `public/js` = 0 处改动 |

---

## 0.18 P-3 深层滚动第二阶段：ScrollPattern 能力诊断 —— **INCONCLUSIVE（容器拒绝程序化滚动）**

歌单 `My Playlist`（`p.YJXV7dvIerGlQ2X`）｜目标 **#171 `You're Somebody Else` / flora cash**（0% 时 `matchesAtStart = 0`，确属深层目标）
原始记录（新建，未覆盖历史）：`integration/poc-p3-scroll-diag-record.json`

### 前置状态

| 项 | 值 |
|---|---|
| 歌单搜索 | 候选 1、精确同名 1、已选卡 |
| 导航 | `ok=true`（仅导航，未起播） |
| 目标歌单身份 | 页面内 **4** 处 `My Playlist` |
| 目标初始匹配 | **0**（符合「深层目标」前置条件） |

### 候选滚动容器（全部枚举，共 5 个）

| AutomationId | 类型 | 矩形 | VerticallyScrollable | VerticalScrollPercent | ViewSize | 内含 ListItem |
|---|---|---|---|---|---|---|
| `MenuItemsScrollViewer` | Pane | 0,166 507x1253 | false | -1 | 100 | 14 |
| `FooterItemsScrollViewer` | Pane | 0,1440 507x70 | false | -1 | 100 | 1 |
| `myScrollViewer` | Pane | 1468,23 135x26 | false | -1 | 100 | 0 |
| `myScrollViewer` | Pane | 1306,54 460x27 | false | -1 | 100 | 0 |
| `(none)` | List | 509,198 2050x1316 | true | 0 | 3.6 | 68 |

选用：**`ControlType.List`（矩形 `509,198 2050x1316`，ViewSize 3.6，内含 68 个 ListItem）** —— 与歌单列表位置/宽度吻合（行位于 x≈519、宽 2022）。

### 一次绝对定位诊断：`SetScrollPercent(NoAmount, 25)`

| 项 | 值 |
|---|---|
| 异常 | **有**：`System.Management.Automation.MethodInvocationException :: Exception calling SetScrollPercent with 2 argument(s): Operation is not valid due to the current state of the object.` |
| 调用前 | `percent=0`、`viewSize=3.6`、UIA 节点数 `661`、目标匹配 `0` |
| 调用后 | `percent=0`（未变）、`viewSize=3.6`、UIA 节点数 `661`（未变）、目标匹配 `0` |
| percentChanged / rowSetChanged / targetMatchesChanged | `false` / `false` / `false` |
| 判定 | **`INCONCLUSIVE_SETSCROLLPERCENT_THREW`** |

### 结论（本轮核心发现）

- 该列表**暴露 ScrollPattern 且报告 `VerticallyScrollable = true`**，但对 `SetScrollPercent` 与（§0.17 的）`Scroll` **均以同一异常拒绝执行**；
  ⇒ **语义滚动在本客户端/该列表上不可用**（WinUI 3 提供者拒绝程序化滚动，属能力缺陷，不是参数错误）。
- 因此**没有**「调用成功但界面没动」这类歧义：调用直接抛错，属明确失败阶段。
- 按指令：**停止本轮滚动测试**，不换容器、不切换 API、不点击目标行；目标行未唯一出现 ⇒ 未执行任何点击 ✔
- 此结论**不外推**到所有歌单：仅在当前歌单/当前客户端版本上观测到。

### 下一步可行路径（均未执行）

1. **`ScrollItemPattern.ScrollIntoView` 语义替代**：对已实现化的相邻行调用 ScrollIntoView 逐段推进（不依赖 ScrollPattern）；
2. **键盘翻页**（聚焦列表后 `PageDown`）——属**输入注入**，需在报告中显式标注并非语义滚动；
3. **产品向结论**：若滚动不可用，正式集成只能支持「已实现化范围内」的目标，超出范围时**安全失败并提示**，而不是静默或盲点。

---

## 0.19 补记：`ScrollItemPattern.ScrollIntoView` 语义滚动实验（上一轮遗漏写入，现按原始记录补记）

说明：上一轮（ScrollIntoView 实验）**只运行了脚本、未把结论写入报告**（我的遗漏）。本节仅依据原始记录补记，未重跑、未改历史章节。
原始记录：`integration/poc-p3-scrollintoview-record.json`

| 项 | 值 |
|---|---|
| 歌单 / 目标 | `My Playlist` / #171 `You're Somebody Else`（flora cash），`matchesAtStart = 0` ✔ |
| 被选行 | `The River ｜ Jordan Feliz …`，矩形 `519,866 2022x98`（位于列表容器 `509,198 2050x1316` 内，非导航项） |
| ScrollItemPattern 可用性 | **可用** |
| 调用 | `ScrollIntoView()` **一次**，**无异常** |
| 变化证据 | `percent` 0→0、UIA 节点 663→663、目标匹配 0→0 ⇒ **可验证变化 = false** |
| 判定 | **`INCONCLUSIVE_NO_VERIFIABLE_CHANGE`**（调用不抛错但无实际滚动） |
| 后续动作 | 未换行重试、未用 PageDown、未点击目标、未调用其它滚动 API ✔ |

## 0.20 P-3 集成前置条件与验收规范（基于现有证据整理，未运行任何新操作）

### 20.1 成功判据分层（禁止单一 PASS 混淆）

| 层级 | 含义 | 判定来源 | 本 POC 已观测到的证据 |
|---|---|---|---|
| `NAVIGATION_OK` | 已进入预期歌单页，**不代表**目标歌曲已播放 | 页面内歌单名出现次数 ≥1（本 POC 用 2/3/4 次） | §0.13 / §0.15 / §0.16 记录中的 `playlistIdentity.matches` |
| `TARGET_ROW_UNIQUE` | 目标歌曲在当前**已实现化**的 UIA 列表范围内唯一匹配 | `Find-Rows` = 1（ListItem 祖先 + 标题与艺人子串） | §0.13、§0.15、§0.16 的 `rowMatch.count = 1` |
| `TARGET_CLICK_ATTEMPTED` | 已执行**一次**经安全校验的行操作 | `Invoke-AmRowPlay` 调用次数 = 1 | 各记录的 `click.calls = 1`；**点击结果不可独立观测 ⇒ 必须标 `INFERRED`** |
| `TARGET_PLAYING_CONFIRMED` | 操作后 SMTC 身份与目标一致 | SMTC 标题归一化相等 + 艺人包含 | §0.13 `There for You`→标题+艺人一致；§0.15 `The Hills` |
| `QUEUE_CONTEXT_CONFIRMED` | 后续曲目变化符合该歌单顺序 | 自然转换或受控 next 后与 Library API 顺序比对 | §0.14（#3→#4 自然、#4→#5 受控 next）、§0.15（#3→#4→#5） |

**规则**：目标起播成功 ≠ 上下文正确；只有必要层级全部满足，才可宣告对应级别的成功。

### 20.2 各阶段超时与重试（有证据才写值）

| 阶段 | 现值 | 证据 |
|---|---|---|
| 歌单搜索等待 | `6000 ms` | POC 脚本 `Invoke-AmSearch ... 6000`（`poc-p3-phase1.ps1` 等） |
| 搜索后稳定等待 | `800 ms` | 同上（`Start-Sleep -Milliseconds 800`） |
| 导航后确认等待 | `3000 ms` | 同上（`Start-Sleep -Seconds 3`） |
| 目标行实现化（ScrollIntoView + 轮询） | `2500 ms` / 轮询 `120 ms` | `Realize-AmRow <el> 2500 120` |
| 点击后 SMTC 观察窗口 | `4000 ms` | `Start-Sleep -Seconds 4` 后读 SMTC |
| 冻结链自身超时/重试 | `-TimeoutMs 6000`、`-Retries 2`、`-SearchWaitMs 6000` | `poc/play-song.ps1` 参数默认值（未改动） |
| 受控 next 后等待 | `7000 ms` | `poc-p3-order-check.ps1` / `poc-p3-phase2b.ps1` |
| 滚动步进等待 / 上限 | `900 ms` / `12 步` | `poc-p3-phase1-scroll.ps1`、`poc-p3-scroll-deep.ps1` |
| **整个流程总超时** | **NOT_DEFINED** | 无证据 |
| **POC 层重试策略** | **待决策** | 仅冻结链自带 `-Retries 2`；POC 层无既定重试（滚动/点击均明确不重试） |
| **滚动百分比档位策略** | **NOT_DEFINED（不可用）** | `SetScrollPercent` 抛异常（§0.18），无可用证据 |
| **队列上下文观察窗口长度** | **NOT_DEFINED** | §0.14/§0.15 用 7 s 等待，非经论证的参数 |

禁止：因超时而盲目重复点击或无限轮询（现有脚本均未实现重试；点击失败即停止）。

### 20.3 失效、超时与歧义的安全退出状态表

| 情形 | 状态 | 退出动作（均已在本 POC 实践） |
|---|---|---|
| 歌单无法唯一确认 | `INCONCLUSIVE_AMBIGUOUS_CARD` | 不点击，停止 |
| 目标匹配数 = 0（未实现化） | `INCONCLUSIVE_ROW_NOT_FOUND_AFTER_SCROLL` | 不点击，停止 |
| 目标匹配数 > 1（歧义） | `INCONCLUSIVE_ROW_MATCH` | 不点击、不放宽匹配，停止 |
| 目标在起点即存在（不构成深层测试） | `INVALID_TARGET_PRESENT_AT_START` | 停止并说明 |
| 行无效 / 落点越界 / 无合法 aim | `INCONCLUSIVE_NO_VALID_AIM`、`INCONCLUSIVE_ROW_INVALIDATED` | 不点击，停止 |
| UIA 调用抛异常 | `INCONCLUSIVE_SETSCROLLPERCENT_THREW`、`INCONCLUSIVE_SCROLLINTOVIEW_THREW` | 不换容器/不换 API，停止 |
| UIA 调用无异常但无变化 | `INCONCLUSIVE_NO_VERIFIABLE_CHANGE` | 记录并停止 |
| SMTC 未更新或仍是旧曲目 | `INCONCLUSIVE_SMTC_MISMATCH` | 不重试、不换坐标，停止 |
| 起播时目标不是期望曲目 | `INCONCLUSIVE_NOT_STARTED_FROM_TARGET` | 停止并记录 |
| 目标已播放但上下文不可确认 | 记为 **独立失败类型**（见 20.5） | 不声称队列保留成功 |

规则：**INCONCLUSIVE 不得自动升级为 PASS**；无法证明安全时退出，不执行未经验证的替代操作。

### 20.4 SMTC 身份校验规范（基于已实现的判据）

| 项 | 规定 |
|---|---|
| 操作前 | 记录 `status` 与 `title`；**要求目标未在播放**（`isTarget = false`），否则本轮不成立 |
| 操作后 | 记录 `title`、`artist`、`status`、时间戳 |
| 匹配规则（已实现） | `Normalize-AmText(SMTC.title) == Normalize-AmText(目标标题)` **且** `Normalize-AmText(SMTC.artist)` 包含目标艺人 |
| 旧曲目仍在播放 | 表现为 title 仍等于基线曲目（如 `There for You` 未变）⇒ 判 `INCONCLUSIVE_SMTC_MISMATCH` |
| 已切换且正确 | title 相等 + artist 包含 ⇒ `TARGET_PLAYING_CONFIRMED` |
| 身份字段不足 | **NOT_DEFINED**：未定义「只有标题无艺人」时的判级（现有实现降级为不通过） |
| 观察窗口超时 | 现用 4 s（无证据支撑其为充分值）⇒ 属待决策项 |
| 禁止 | 不得仅凭 URL 导航成功、UIA 点击返回成功或仍处于 `Playing` 就宣告目标起播 |

### 20.5 「身份正确但上下文错误」——独立失败类型

**`TARGET_PLAYING_CONFIRMED` 成立而 `QUEUE_CONTEXT_CONFIRMED` 不成立 ⇒ 独立失败类型，必须单独报告。**

| 证据类别 | 本 POC 实际观测 | 来源 |
|---|---|---|
| 自然播放转到预期下一首 | #3 `玄翎衔心` → **自然**到 #4 `万音之梁`（=API #4） | §0.14 记录 A |
| 手动 Next 后进入 API 预期下一首 | #4 → 受控 next → #5 `踏歌行`（=API #5）；另一歌单 #3→#4→#5 | §0.14 记录 B、§0.15 |
| 仅确认目标曲目播放、未验证队列 | §0.13、§0.16（未做队列验证） | 相应记录 |
| 上下文观察不完整/结果不确定 | §0.12（`INCONCLUSIVE_SMTC_MISMATCH`，未进入上下文） | §0.12 |

禁止：把某歌单的起播成功推广为所有歌单、所有位置、随机播放或跨歌单场景均正确。

### 20.6 当前 UIA 滚动能力边界（保留 §0.17/§0.18/§0.19 原始结论）

| API | 结果 | 来源 |
|---|---|---|
| `ScrollPattern.Scroll(LargeIncrement, NoAmount)` | **抛异常**：`Operation is not valid due to the current state of the object.` | §0.17 |
| `ScrollPattern.SetScrollPercent(NoAmount, 25)` | **抛同一异常**；percent/节点数/目标匹配均无变化 | §0.18 |
| `ScrollItemPattern.ScrollIntoView()` | **不抛错但无可验证变化**（percent 0→0、节点 663→663、目标 0→0） | §0.19 |

**结论限定**：仅限当前测试环境（Apple Music `1.1540.23042.0`）与**被测列表**（歌单页 `ControlType.List 509,198 2050x1316`，ViewSize 3.6）。

**集成前置条件（若不做输入注入）**：目标行必须**已经处于可操作的 UIA 实现化范围内**；
目标不在该范围时，必须**安全失败并给出可解释结果**（例如 `INCONCLUSIVE_ROW_NOT_FOUND_AFTER_SCROLL`），
**不得**盲点、反复重试，或宣称深层目标已受支持。

### 20.7 POC 与主线隔离（强制）

- 本规范及后续整理**不得修改生产代码**；
- 冻结链 `poc/lib/**`、`poc/play-song.ps1` 保持不变；
- `desktop/apple-music-control.js`、`server.js`、`public/js/**` 保持不变；
- **不覆盖或删除失败记录**，不重写历史结论；报告**只追加**，新增章节标题必须唯一；
- 若完整性检查失败，**明确报告失败项**，不得声称验收通过。

### 20.8 尚未解决的验收项（待决策／尚未验证）

| # | 项 | 状态 |
|---|---|---|
| 1 | 整个流程的总超时预算 | **NOT_DEFINED** |
| 2 | POC 层重试策略（除冻结链 `-Retries 2` 外） | **待决策** |
| 3 | 点击后 SMTC 观察窗口的充分性（现 4 s） | **待决策** |
| 4 | 身份字段不足（仅标题）时的判级 | **NOT_DEFINED** |
| 5 | 深层目标（需滚动）的支持策略 | **尚未验证**（三种语义滚动 API 均不可用） |
| 6 | 随机播放 / 歌单末尾 / 跨歌单边界 | **尚未验证**（本轮明确不做） |
| 7 | 输入注入（键盘翻页/滚轮）是否允许 | **待决策**（涉及对用户干扰，未实验） |
| 8 | 失败时对用户的可解释提示文案规范 | **待决策** |

---

## 0.21 T-E：歌单页身份强化信号专项验证（唯一执行项）—— **T-E FAIL**

> 本轮只读枚举 Apple Music UIA 树；**0 次点击、0 次播放、0 次输入注入、0 次滚动 API 调用**；未改生产代码/冻结链/POC 逻辑。
> 原始记录（新增独立文件）：`integration/poc-te-uia-identity-record.json`

### T-E-1 环境与目标

| 项 | 值 |
|---|---|
| Apple Music 客户端版本 | `1.1540.23042.0` |
| UIA 枚举范围 | 当前窗口全树 Enum → `FindAll(Descendants, TrueCondition)`，节点数 **663**（上限 5000） |
| 目标参照（Library API 既有快照） | `音乐回忆 2025` = `p.2P6Wg5KCVWOK3m2`；`喜爱歌曲` = `p.0YU0g1DPaJ`；`My Playlist2` = `p.MoGJ98ktvP9kMed`；`My Playlist` = `p.YJXV7dvIerGlQ2X`（另有虚拟项 `apple-liked`） |
| 同名/易混淆对象 | **`My Playlist` 与 `My Playlist2`**（名称接近）；`喜爱歌曲` / `音乐回忆 2025` 为不同名对照 |

### T-E-2 候选身份信号表

| 信号 | 证据等级 | 两同名对象是否不同 | 可否追溯到 `p.*` | 是否合格 | 原始值样本 |
|---|---|---|---|---|---|
| `automationId` | INFERRED | 是 | 否 | 不合格 | ["","DBID:0xde1de50d61ab9603-PID:0x24220a7f826c3115-PPID:0x0-PIPID:0x0-IKIND:ePlaylist","DBID:0xde1de50d61ab9603-PID:0x42a2e15053473de5-PPID:0x0-PIPID |
| `controlType` | INFERRED | 是 | 否 | 不合格 | ["ControlType.ListItem","ControlType.Text"] |
| `className` | INFERRED | 是 | 否 | 不合格 | ["Microsoft.UI.Xaml.Controls.NavigationViewItem","TextBlock"] |
| `frameworkId` | INFERRED | 否 | 否 | 不合格 | ["XAML"] |
| `runtimeId` | INFERRED | 是 | 否 | 不合格 | ["42.592476.4.12247","42.592476.4.49","42.592476.4.50"] |
| `rect` | INFERRED | 是 | 否 | 不合格 | ["1113,395 229x53","136,1027 359x28","136,1097 359x28"] |
| `helpText` | INFERRED | 否 | 否 | 不合格 | [""] |
| `itemStatus` | INFERRED | 否 | 否 | 不合格 | [""] |
| `acceleratorKey` | INFERRED | 否 | 否 | 不合格 | [""] |

**枚举到的关键候选（不合格，但值得记录）**：侧边栏歌单项（`ControlType.ListItem` / `Microsoft.UI.Xaml.Controls.NavigationViewItem`）的 `AutomationId` 形如：

```text
DBID:0xde1de50d61ab9603-PID:0xcef5c5f5e3b1caea-PPID:0x0-PIPID:0x0-IKIND:ePlaylist
```

其中 **`PID:` 段每个歌单不同**（实测 4 个不同值），因此它**能区分同名歌单**；但它与 Library API 的 `p.*` id **没有任何可观察的对应关系**，
⇒ 按 T-E 标准（必须与目标 Library playlist **可追溯**）判为 **不合格信号**（依赖推断）。

同时枚举到：`controlType` / `className` / `frameworkId` / `runtimeId` / `rect` / `helpText` / `itemStatus` / `acceleratorKey` 等字段 —— 
其中 `runtimeId` 依赖运行时分配（会话间不稳定），`rect` 属于被明确禁止的“位置相似”类证据，`helpText`/`itemStatus`/`acceleratorKey` 在本轮均无可区分或可追溯取值。

### T-E-3 最终判定：**T-E FAIL**

| 项 | 结论 |
|---|---|
| 枚举到了什么 | 歌单卡片/侧边栏项的 `AutomationId`（含 `DBID/PID/…/IKIND:ePlaylist`）、`ControlType`、`ClassName`、`FrameworkId`、`RuntimeId`、`BoundingRectangle`、`HelpText`、`ItemStatus`、`AcceleratorKey`，共 9 个名称命中节点 |
| 为什么都不足以建立可追溯关系 | 唯一能区分同名歌单的候选（`AutomationId` 的 `PID` 段）**没有任何可观察证据**把它对应到 Library API 的 `p.*` id；其余字段或不可区分（`frameworkId`），或属运行时/位置类证据（`runtimeId`/`rect`），按标准一律不合格 |
| `INFERRED` 是否通过 | **否**（标准规定 INFERRED 不得通过） |
| P1b 状态 | **继续保持「待补证」**（*当时状态*；后续 T-E3 起已改为 **无法补证**，见 §0.23）；v1 契约**不得**宣称“从指定 `p.*` 歌单中的指定歌曲开始播放”成立 |
| P2→P4 | **不推进**（按 T-E 约定） |

**不使用任何中间结论**：不存在“差不多/高度疑似/基本可以”；本轮结论即为 `T-E FAIL`。

### 后续可选（未执行、需另行批准）

- **T-E2（只读、非 UIA 途径）**：只读检视 Apple Music 本地数据/日志中是否存在 `PID` 段与 `p.*` 的对应记录；若能建立、且可复核，则该映射可能升为 `DERIVED`。
- 注意：在 T-E2 给出证据前，**不得**把 `PID` 当作 `p.*` 使用。

---

## 0.22 T-E2：本地数据/缓存/日志中的 `PID ↔ p.*` 可追溯映射（只读）—— **T-E2 FAIL**

> 本轮仅只读检查本地文件；**0 次播放、0 次点击、0 次输入注入、0 次滚动 API 调用**；未改生产代码/冻结链/POC 逻辑；
> **未读取/导出任何凭证、Cookie、令牌或个人内容**（按名字跳过敏感文件；只检索技术性 ID 字符串）。
> 原始记录（新增独立文件）：`integration/poc-te2-local-mapping-record.json`；检索令牌：`integration/te2-tokens.json`

### 盘点到的可访问数据源（不假设存在，逐一探测）

| 项 | 值 |
|---|---|
| 可访问根目录 | `%LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_nzyj5cx40ttqa`、`%LOCALAPPDATA%\Apple` |
| 文件总数（>0 且 <300MB） | **43** |
| 扩展名分布（前 12） | [".plist:10",".etl:7",".m4p:6",".jpeg:4",".dat:3",".hds:3",".sqlite:2",".sqlite-shm:2",".sqlite-wal:2",".xml:1",".9f1c:1",".txt:1"] |
| 进入检索的候选 | 16 个（`.db/.sqlite/.plist/.log/.txt/.json/.dat/.bin`，按大小取前 40） |
| 实际解码检索 | **11** 个 |
| 敏感文件名跳过 | 无匹配（本次候选集中未出现敏感命名） |

### 检索结果

| 检索目标 | 结果 |
|---|---|
| Library API 的 `p.*` id（`p.2P6Wg5KCVWOK3m2`、`p.0YU0g1DPaJ`、`p.MoGJ98ktvP9kMed`、`p.YJXV7dvIerGlQ2X`） | **0 命中** |
| UIA 中的 `PID` 十六进制（`0x24220a7f826c3115`、`0x42a2e15053473de5`、`0x9f75f0a7c0c63294`、`0xcef5c5f5e3b1caea`） | **0 命中**（唯一“命中”是 iTunes Migration 日志里的平凡串 `0x0`） |
| 同一文件内同时出现 `p.*` 与 `PID` | **否** |

（唯一命中记录：`…\AMPLibraryAgent\…\iTunes Migration Log [2026-10-02 18.25.02].txt`，仅含 `0x0`，`sameFile = false`。）

### 覆盖范围与未覆盖范围（如实记录）

**已覆盖**：43 个文件中的 11 个可文本解码候选（含 `.plist`、`.sqlite`、`.dat`、`.txt` 等）。

**未覆盖（本轮限制，不代表不存在映射）**：
- `.etl` ETW 跟踪（7 个）——需要专门的跟踪解析器，未解码；
- `.sqlite-wal` / `.sqlite-shm` 边车文件——扩展名未进入筛选规则；
- 二进制 plist（`bplist00`）仅在“UTF-8 可读”范围内检索，未做结构化解析；
- 任何 >60MB 的文件与 WindowsApps 安装目录（ACL 限制）未纳入；
- 因此本结论是**在本轮覆盖范围内**的 FAIL，不外推到全部本地数据。

### T-E2-3 判定：**T-E2 FAIL**（按既定 FAIL 条件）

| 既定 FAIL 条件 | 本轮实际 |
|---|---|
| 只有名称/顺序/路径/`PID` 等孤立标识 | 本轮更弱：`p.*` 与 `PID` **都未在任何可读文件中出现** |
| 只能靠猜测/相似性/未经验证的转换规则 | 无任何可复核关联记录可用 ⇒ 不接受任何推断 |
| 记录无法区分同名歌单或语义无法确认 | 无法区分（无记录） |

⇒ **找不到可追溯映射**；按约定 **停止身份信号探索**，不再沿更多猜测性字段挖掘。

### 对 v1 契约的直接影响

- **P1b 继续保持「待补证」**（*当时状态*；后续 T-E3 起已改为 **无法补证**，见 §0.23）；`PID` **不得**当作 `p.*` 使用；
- v1 契约**不得**宣称“从指定 `p.*` 歌单中的指定歌曲开始播放”成立；
- P2→P4 **不推进**；
- 下一步属于**产品决策**：是否接受“收窄后的 v1 契约”（例如仅承诺在**用户可见的歌单页内**指定歌曲起播，不承诺 `p.*` 歌单身份）。

---

## 0.23 T-E3 — ETL / SQLite WAL-SHM 终局检查（只读）—— **T-E3 FAIL**

> 本轮仅检查 T-E2 明确未覆盖的两个载体；**0 次播放、0 次点击、0 次输入注入、0 次滚动 API 调用**；未改生产代码/冻结链/POC 逻辑；
> 未读取/导出 Cookie、token、凭证或会话密钥（仅检索技术性 ID 字符串）。
> 原始记录（新增独立文件）：`integration/poc-te3-etl-wal-record.json`

### A. ETL 处理结果（找到 **9** 个，非 7 个——含 2 个 0 字节 `Log-*.etl`，如实列出）

| 文件 | 大小(byte) | 修改时间 | 是否解析出可检索文本 | 命中真实 `p.*` | 命中已知 UIA PID |
|---|---|---|---|---|---|
| `AMPLibraryAgent_2026-10-02_18-41-25-425.etl` | 277333 | 2026-10-02T18:41:25 | 是（tracerpt ok） | [] | [] |
| `AMPLibraryAgent_2026-10-02_18-45-12-861.etl` | 279909 | 2026-10-02T18:45:12 | 是（tracerpt ok） | [] | [] |
| `AMPLibraryAgent_2026-10-02_19-08-28-043.etl` | 279046 | 2026-10-02T19:08:28 | 是（tracerpt ok） | [] | ["0x9f75f0a7c0c63294"] |
| `AppleMusic_2026-10-02_18-41-31-357.etl` | 282240 | 2026-10-02T18:41:31 | 是（tracerpt ok） | [] | [] |
| `AppleMusic_2026-10-02_19-00-52-750.etl` | 285166 | 2026-10-02T19:00:52 | 是（tracerpt ok） | [] | [] |
| `AppleMusic_2026-10-02_19-11-59-881.etl` | 282349 | 2026-10-02T19:11:59 | 是（tracerpt ok） | [] | [] |
| `Log-AMPLibraryAgent-4.etl` | 0 | 2026-10-02T19:08:28 | 是（tracerpt ok） | [] | [] |
| `Log-AppleMusic-1.etl` | 1773 | 2026-10-02T19:03:22 | 是（tracerpt ok） | [] | [] |
| `Log-AppleMusic-4.etl` | 0 | 2026-10-02T19:11:59 | 是（tracerpt ok） | [] | [] |

**关键结果**：`AMPLibraryAgent_2026-10-02_19-08-28-043.etl` 的可检索文本中出现 **1 个已知 PID**：`0x9f75f0a7c0c63294`；
但**没有任何 ETL 出现任何真实 `p.*`**（4 个目标 id 全部 0 命中）。
解码情况：`tracerpt -of XML` 尝试 9 个、**成功 9 个**（含 0 字节文件，记录为 ok）。

### B. SQLite `-wal` / `-shm` 处理结果

| 文件 | 大小(byte) | 命中真实 `p.*` | 命中已知 PID |
|---|---|---|---|
| `artwork.sqlite` | 4096 | [] | [] |
| `artwork.sqlite-shm` | 32768 | [] | [] |
| `artwork.sqlite-wal` | 49472 | [] | [] |
| `artwork.sqlite` | 4096 | [] | [] |
| `artwork.sqlite-shm` | 32768 | [] | [] |
| `artwork.sqlite-wal` | 276072 | [] | [] |

说明：本轮枚举到的 SQLite 载体均为 **`artwork.sqlite` 及其 `-wal`/`-shm`**（封面缓存库），**不是歌单库**；
两套（2 个 db + 4 个边车）**均 0 命中**。

### 通过标准逐条核对（必须全部满足）

| # | 要求 | 本轮实际 |
|---|---|---|
| 1 | 至少一条实际可复核的关联记录 | **无**（`coOccurrence = []`） |
| 2 | 关联记录明确包含某个真实 `p.*` | **否**（ETL：0/9；SQLite：0/6） |
| 3 | 同一关联链中存在 T-E 已知 UIA PID | 部分存在（1 个 ETL 有 PID），但**无 `p.*` 与之同链** ⇒ 不成立 |
| 4 | 能区分至少两个同名/混淆 playlist | **否** |
| 5 | 能解释关联字段语义（非猜测） | **否** |
| 6 | 证据可独立复核 | 是（`poc-te3-etl-wal-record.json`） |

⇒ 缺第 1、2、4、5 条（第 3 条只有孤立 PID，按既定规则**不算映射证据**）⇒ **`T-E3 FAIL`**。

### 覆盖 / 未覆盖（不夸大）

- **已覆盖**：9 个 `.etl`（全部 tracerpt 解码为 XML 后再检索 + 原始字节检索）；`artwork.sqlite` 及其 `-wal`/`-shm` 全部 6 个文件的字节级检索。
- **未覆盖**：其它未枚举到的 SQLite 库（若歌单库不在 `%LOCALAPPDATA%\Packages\AppleInc.AppleMusicWin_*` 与 `%LOCALAPPDATA%\Apple` 之内）；
  ETL 中未被 tracerpt 呈现的细节；WAL 页面级结构化恢复（本轮为字节检索）；`>50MB` 的 ETL。
- 依据终局规则：**不再提出 T-E4/T-E5，不再扩大本地载体范围**。

### 终局宣布（依据 T-E3 FAIL）

> **P1b = 无法补证**
> **PID ≠ p.***
> **P2→P4 = 永久停止身份信号路线**

此后仅可进入**产品契约决策**或**文档整理**；不得继续身份字段探索。
