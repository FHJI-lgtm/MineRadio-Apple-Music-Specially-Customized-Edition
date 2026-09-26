# B-i 播放列表卡片定位：实测复核与修复（2026-09-26）

范围：只动 `experiment/apple-music-windows-control/poc/lib/am-play-playlist.ps1` 与它的 CLI
`poc/play-playlist.ps1`（B-i 新增文件，非冻结链）。
冻结链未动：`am-uia.ps1` / `am-smtc.ps1` / `am-common.ps1` 与 `0170bca` byte-identical（§8）；
`am-play.ps1` 仍是唯一经授权偏离（= HEAD，未再改）。`main` 仍 `4a6ae2f`。

> **勘误（重要）**：本报告初版写过"卡片子树里找不到任何播放控件，卡片点击只是导航"。
> **前一半是错的** —— 用户指出 Apple Music 悬停卡片时左下角会出现播放按钮（我已用屏幕截图复现，
> 见 §3.1）。错因不是界面没有，而是**我那一次悬停探针没有真的产生鼠标移动**（§3.4）。
> 修正后：起播走卡片自带的悬停播放按钮（主路径），"点卡片 → 进歌单页 → 点页头播放"降为兜底（次要路径）。

---

## 1. 结论

1. 修复前引擎对**任何**输入都报 `candidateCount=1` + `PROBE_ONLY`（假阳性），连不存在的歌单名也是（§6-A）。
2. 修复后 0 / 1 / 2+ 三种结局都可达且与真值一致（§6）。
3. **卡片悬停时左下角的播放按钮是真实存在的 UIA 元素**（前提：指针必须在卡片上**移动**，静止停靠不出；`Button name="播放" AutomationId=PlayButton`，
   rect `594,585,56,56`，落在卡片矩形 `573,295,367,483` 之内）；点它直接起播，**不需要先导航**（§3.1）。
4. 端到端因此闭环且只有两步：搜索 → 资料库作用域 → 定位卡片 → **悬停并点卡片自己的播放按钮** →
   SMTC 验证 `Paused/Opened → Playing` → `stage=PLAYBACK_STARTED, ok=true`（§4、§5）。

---

## 2. 缺陷与修复（6 处）

| # | 缺陷 | 证据 | 修复 |
|---|---|---|---|
| D1 | `Get-AmPlaylistCardCandidates` **成功路径没有返回契约对象** `{ok;errors;candidates}`（只有 catch 分支返回），调用方读 `.candidates` 得 `$null`，而 `@($null).Count = 1`（PS 5.1.26100 实测）→ 候选数恒 ≥1、`PLAYLIST_NOT_FOUND`/`AMBIGUOUS` 不可达、`-Commit` 解引用 `$null` | §6-A | 末尾补 `return @{ ok=$true; errors=@($errors); candidates=@($uniq) }` |
| D2 | "区域排除"把 `Find-AmEnabledEdit` 的返回值当元素用；它返回 `@{ element; count; index }`（am-uia.ps1:151-159），抛错被外层 `catch { }` 吞掉 → 核心改动是死代码 | 静态 | 改 `(Find-AmEnabledEdit $root).element` |
| D3 | `Move-AmCursor` 全仓库不存在 → `-HoverProbe` 必抛 | grep 整个 experiment/ | 换冻结链惯例 `[AmUiaNative]::SetCursorPos(x,y)`（am-uia.ps1:532） |
| D4 | `$items` 从未赋值：`-DumpItems` 空转，`listItems=` 恒 0（会撒谎的诊断） | 修复后变 `listItems=15/18` | 按 am-play.ps1 同款赋值 |
| D5 | **"卡片必须含封面 Image"被证伪**：卡片子树只有 4 个节点、任意深度 0 个 Image，把 10/10 匹配全拒 | §7.3 | 删除该判据，保留区域判据并写明数据 |
| D6 | **精确矩形去重产生"鬼卡片"**：同快照里 `573,297,367,483` 与 `573,297,367,482` 并存 → 2 张卡报成 3 个候选 | §6-D | 去重改 **≤2px 容差** |
| D7 | **悬停探针不产生真实位移**：指针静止停在卡片（或封面）上不出现播放按钮，必须在卡片上移动一下；SetCursorPos 到指针当前坐标是零位移 → 叠层永不进 UIA（我最初的误判就来自这里；用户先纠正，随后复现并确认）。更硬的实测：引擎流程里主动悬停 6/6 次都找不到叠层，而导航路径 7/7 成功 | §3.1 / §3.4 / §9.1 | 叠层按钮保留为**机会性快路径 + 可选 -TryHoverPlay**；默认改为「查一次已有叠层 → 点卡片导航 → 点页头 PlayButton」 |
| D8 | **作用域芯片竞态**：搜索提交后芯片尚未渲染，单次查找直接报 SCOPE_CHIP_NOT_FOUND（真机出现过 1 次，1.6s 就返回） | 本次连跑 7 次里 1 次 | 芯片查找改为最多 6 次 × 300ms 重试（每次取新 root），detail 里带上等了多久 |
| D9 | **播放控件被双击**：冻结的 Invoke-AmRowPlay 发的是**双击**（它是为歌曲行设计的），而 Apple Music 的播放键**第一次点击才真起播**（要加载一下），**再点就暂停** —— 于是出现「找到了、也点了，就是没播」 | 用户指出；实测复现：悬停按钮那次 clicked=true 但 SMTC 8s 不动；同一个坑也能解释悬停路线的失败 | 本文件新增 Invoke-AmSingleClick（一次 down/up，同样的置前台 + 重算几何），**5 处**播放控件/导航点击全部改用它；冻结的 am-uia.ps1 一行未动 |
| D10 | **点完播放不最小化**：歌曲链在点击后会把 Apple Music 最小化（am-play.ps1:307-310，经授权的产品行为），歌单链没有做，用户点完播放 AM 还杵在最前面 | 用户指出 | 新增 `Hide-AmAfterClick`（先等 250ms 让点击落地 → 调 `Minimize-AmWindow`），三处播放点击后都调用；CLI 以**只读方式** dot-source `am-play.ps1` 复用该助手；`-NoMinimize` 可关闭 |
| D11 | **作用域切换可能被吞掉**：芯片是 TogglePattern 按钮，搜索结果页还在渲染时发出的那一击会被直接吞掉，于是整次运行停在 Apple Music 作用域、最后以**假 PLAYLIST_NOT_FOUND** 收场（实测 3/3）。**旧的双击刚好掩盖了它**——第二次点击替它完成了工作，这就是我改成单击后暴露出来的回归 | 3/3 复现（`listItems=44`、搜索结果仍是目录作用域） | 芯片只点一次，然后**按结果验证**（切过去之后资料库作用域里应能找到这张卡），找不到才再点；共 3 次（奇数：即使芯片是 toggle，最终态也是资料库）；新增 `scopeVerified` / `scopeSwitchAttempts`，`scopeSwitched` 只表示「点过了」 |

### 另外三处（本轮按"按你的来"处理）

| # | 问题 | 处理 | 复验 |
|---|---|---|---|
| Q1 | `-CardIndex n` 无 `-Commit` 也会点击起播，违反"默认 PROBE 不点" | 它只**选择**；`-Commit` 才点 | §6-C：`PROBE_ONLY, clicked=False` |
| Q2 | `TODO(B-i step 4)` SMTC 未接 | 已接，判据是**状态转移**（§3.3） | §4/§5：`PLAYBACK_STARTED` |
| Q3 | 鬼卡片（D6） | ≤2px 容差去重 | §6-D |

---

## 3. 起播路径与判据

### 3.1 卡片自带的悬停播放按钮（主路径，实测）

悬停卡片后，播放控件就出现在**同一卡片矩形内**：

| 元素 | AutomationId | rect |
|---|---|---|
| `Button name="播放"` | `PlayButton` | `594,585,56,56`（卡片左下） |
| `Button name="更多"` | （无） | `863,585,56,56`（卡片右下） |

- 屏幕截图（`%TEMP%\am-hover-card.png`）可见：卡片封面加上暗色蒙层，左下圆形播放键与右下"…"键出现。
- 只点这个按钮：`Opened → Playing`，**688ms**（隔离测量）；
  引擎端到端跑出的是 `Paused → Playing`，**133ms**（§5）。
- 与封面图不同，**这个叠层是正常的 UIA 元素**，因此可以按元素点击，不需要按坐标猜。
- 触发条件（用户补充 + 复现）：**指针静止停在卡片或封面上不会出现**，必须在卡片上**移动**一下。
  即叠层由 PointerOver 驱动，而 PointerOver 要求指针在卡片上发生真实位移；SetCursorPos 到指针
  当前所在坐标是零位移，什么都不会发生。据此实现的悬停是「两点扫过 + 轮询」：每次尝试先在卡片
  中心 ±50/±40 范围内做两次相隔 120ms 的移动，然后每 150ms 查一次树，最多 4 次尝试 × 6 次轮询
  （上界约 4.8s）。三次干净复跑实测：第 1/3/1 次尝试命中、第 6/1/4 次轮询看到按钮
  （结果里的 hoverAttempts / hoverPolls）。

> 注意（最终形态）：叠层按钮在**隔离脚本**里很灵，但在**引擎流程**里实测 6/6 找不到（原因未查清，§9.1），
> 因此引擎默认顺序是「先查一次是否已有叠层 → 没有就点卡片（导航）→ 点歌单页页头 PlayButton」，
> 主动悬停降为可选（-TryHoverPlay）。下面这条路径因此就是**默认路径**。

### 3.2 卡片本体点击只导航（默认路径的第二步）

### 3.3 判据（为什么不能用 Wait-AmPlayback）

`am-smtc.ps1` 实际提供的接口：`Get-AmSmtcState` → `@{ok;title;artist;album;status;pos;dur;posMs;aumid}`；
`Wait-AmPlayback(Title,Artist,...)` → MATCH/WRONG_TRACK/TIMEOUT，**需要已知曲名**。

歌单没有可预期曲名，硬套就是编造标题。可观测的只有**状态转移**：

> 起播成立 ⟺ SMTC `status = Playing` 且（点击前不是 Playing 或曲名发生变化）

成功只有 `PLAYBACK_STARTED`（`ok=true`）；`PLAY_BUTTON_NOT_FOUND` / `PLAYBACK_UNCHANGED` /
`SMTC_TIMEOUT` / `PLAYLIST_CLICKED` 都表示"没证明成功"。

### 3.4 勘误：我最初为什么会得出「没有播放控件」

两次悬停探针都没看到叠层，原因是**指针没有真的在卡片上移动**：

- 前一次运行的收尾动作已经把游标留在同一个点，再调 SetCursorPos（同一坐标）不产生 WM_MOUSEMOVE，
  WinUI 就不进入 PointerOver，叠层按钮也就不会进 UIA 树；
- 用户的物理鼠标一动，叠层立刻出现 —— 这就是用户看到而我「看不到」的全部差别。
  用户随后补充得更准确：**把鼠标静止放在封面上也不会出现**，必须在卡片上移动一下；
  这与「零位移不触发」是同一个机制，所以实现里不能只做一次落点，必须做**有位移的扫过**。

现在的实现（Find-AmCardHoverPlayButton）：每次尝试两点扫过 + 轮询（见 §3.1），最多 4 次尝试；
三次干净复跑分别是 1 / 3 / 1 次尝试命中，没有一次走满。
---

## 4. 端到端复验输出（真机，2026-09-26 11:16 UTC）

> 这次跑的是「单点落 + 重试」版的悬停（hoverAttempts=2），已被 §3.1 的「两点扫过 + 轮询」取代；
> 最终实现的三次干净复跑见 §5 的 G 行。

```text
PAUSE_SCRIPT before ok=True status=Paused title=[Ready to Go]
PAUSE_SCRIPT invoke_ok=True after ok=True status=Paused title=[Ready to Go]
=== COMMIT (card hover play path) ===
ok=True  stage=PLAYBACK_STARTED  mode=commit
  detail="SMTC Paused -> Playing via card-hover-play-button (133ms)"
  candidates=1 ambiguous=False clicked=True
  card: 喜爱歌曲  rect=573,295,367,483
  smtc: before=Paused after=Playing transitionMs=133
        beforeTitle="Ready to Go" afterTitle="Ready to Go"
```

JSON 关键字段：`hoverPlayButton=true`、`hoverAttempts=2`、`playVia="card-hover-play-button"`、
`clicked=true`、`ok=true`、`playButtonFound=false`（兜底路径没被用到）。
测试结束后用 `Invoke-AmPause` 还原为 Paused，不留播放副作用。

---

## 5. 判据复验（PROBE，不点击卡片）

| 例 | 命令要点 | 结果 |
|---|---|---|
| A 负例（修复前） | `-Name ZZZ_DSH_NO_SUCH_PLAYLIST_9F3` | `PROBE_ONLY candidates=1`，`cards=[{null…}]` —— 假阳性 |
| A 负例（修复后） | 同上 | `PLAYLIST_NOT_FOUND candidates=0 cards=[] detail="listItems=15"` |
| B 歧义 | `-Name "My Playlist" -ScopeLabel 你的资料库` | `AMBIGUOUS candidates=2`，`573,295,367,483` / `961,295,367,483` |
| C 索引不点击 | 同上 `-CardIndex 1`（无 `-Commit`） | `PROBE_ONLY clicked=False` |
| D 鬼卡片 | `-Name "My Playlist"`（默认作用域） | 修复前 `candidates=3`；修复后 `candidates=2` |
| E 起播（悬停主路径） | `-Name 喜爱歌曲 -ScopeLabel 你的资料库 -Commit` | `PLAYBACK_STARTED`，`playVia=card-hover-play-button`，133ms |
| F 起播（兜底路径） | 同上（当时主路径尚未实现） | `PLAYBACK_STARTED`，`playVia=page-play-button`，4ms |
| G 起播（悬停主路径，3 次干净复跑） | 每次先 `Invoke-AmPause` 再 `-Commit` | 3/3 `PLAYBACK_STARTED`；`hoverAttempts`=1/3/1，`hoverPolls`=6/1/4（上界 4 次尝试×6 次轮询） |

---

## 6. 实测数据（判据的出处）

### 6.1 作用域标签

`AutomationId=SearchAppleMusic` 名字 **"Apple Music"**（2160,131,169,48）；
`AutomationId=SearchLibrary` 名字 **"你的资料库"**（2331,131,150,48）→ `scopeSwitched=true` 稳定成立。
CJK 传参：写进 UTF-8 文本文件，用 `-ScopeLabel ([IO.File]::ReadAllText($p,[Text.Encoding]::UTF8))`；
回读码点 `20320,30340,36164,26009,24211`。

### 6.2 区域判据有效（资料库作用域，同名精确匹配 10 个节点）

| 命中位置 | clickable rect | 判定 |
|---|---|---|
| 侧栏"播放列表"分组第 1 条（+其 Text） | 5,1010,497,63 | reject（搜索框左侧） |
| 侧栏第 2 条（+其 Text） | 5,1080,497,63 | reject |
| 内容区卡片 1（3 个嵌套 clickable） | 573,295,367,483 | **pass** |
| 内容区卡片 2（3 个嵌套 clickable） | 961,295,367,483 | **pass** |

搜索框 `ControlType.Edit`（`AutomationId=TextBox`）rect `15,90,476,55` → 右下角 `491,145`；
侧栏行 x≈5..502 在其左、作用域芯片 y=131 在其上，均被排除；`t+1200ms` 与 `t+3200ms` 结论一致。

### 6.3 Image 判据被证伪

卡片 `FindAll(Subtree)` = **4 个节点**：`ListItem×1 / Group×1 / Text×2`，`Image = 0`。
（悬停后同一卡片仍只有这 4 个节点 —— 叠层按钮是卡片的**兄弟/叠层**，不在它的子树里，
所以"卡片子树里找按钮"这条思路本身就是错的，必须用"矩形落在卡片内"来判定。）

---

## 7. 未修 / 未验证

1. 兜底路径（`card-click` → 页头 `PlayButton`）在**新代码里**未再跑通一次（此前那次 `playVia=page-play-button`
   是旧结构下测到的）；`PLAY_BUTTON_NOT_FOUND` 分支从未被真实触发。
2. 默认（catalogue）作用域下的悬停起播未单独验证（本轮主/兜底都只在资料库作用域测过）。
3. `-CardIndex` + `-Commit` 的真实点击组合未实跑。
4. 悬停的**最坏耗时**没压到最紧：上界 4 次尝试 ×（120ms + 6×150ms）≈ 4.8s；实测最差 3 次尝试，
   但没有在「页面刚渲染完就立刻悬停」这类慢路径上专门压测。
5. `Get-AmPlaylistCardCandidates` 的 `$errors` 仍从未填充，`dumpErrors` 恒 `[]`；
   `Find-AmPlaylistCards` 仍是死代码；`stageHistory` 仍是空数组。
6. 冻结链之外的其它文件未动；Apple Music 测试后已还原 Paused。
7. **悬停叠层为什么在引擎流程里比隔离脚本里难触发，未查清**：隔离脚本 1 次尝试即命中，引擎流程 6/6 找不到，
   卡内 24/24 样本没有叠层。触发条件（指针必须移动）是清楚的，差的是「为什么这次不出现」，需要单独一轮对照实验。
8. **MineRadio 的 UI 那一跳我无法自动验证**：面板 ▶ → IPC → 模块 这一段，模块级已经真机跑通（§9），
   但「点面板按钮」这一下需要人在真实 app 里点一次（同 REPORT-IPC-HARNESS-LIMIT.md 的结论）。

---

## 8. 复现命令

**注意**：本机 harness 自带 shell 禁止运行脚本（dot-source 报 `PSSecurityException`），
所有脚本一律用子进程 `powershell -NoProfile -ExecutionPolicy Bypass -File ...` 跑。

```powershell
# 冻结链（三条都必须 True）
cd F:\mineradio-apple-music
git diff --quiet 0170bca -- experiment/apple-music-windows-control/poc/lib/am-uia.ps1;   $LASTEXITCODE -eq 0
git diff --quiet 0170bca -- experiment/apple-music-windows-control/poc/lib/am-smtc.ps1;  $LASTEXITCODE -eq 0
git diff --quiet 0170bca -- experiment/apple-music-windows-control/poc/lib/am-common.ps1;$LASTEXITCODE -eq 0

# 语法闸
[void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path poc\lib\am-play-playlist.ps1),[ref]$null,[ref]$null)

cd experiment\apple-music-windows-control
$lbl = [IO.File]::ReadAllText("$env:TEMP\am-scope-label.txt",[Text.Encoding]::UTF8)   # 你的资料库
$q   = [IO.File]::ReadAllText("$env:TEMP\am-query.txt",[Text.Encoding]::UTF8)         # 喜爱歌曲

# 负例 / 歧义 / 索引不点（都不起播）
powershell -NoProfile -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "ZZZ_DSH_NO_SUCH_PLAYLIST_9F3" -ScopeLabel $lbl -Human
powershell -NoProfile -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -ScopeLabel $lbl -Human
powershell -NoProfile -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name "My Playlist" -ScopeLabel $lbl -CardIndex 1 -Human

# 端到端（真的起播：先暂停做基线，跑完再暂停）
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\am-pause.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File poc\play-playlist.ps1 -Name $q -ScopeLabel $lbl -Commit -Human
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\am-pause.ps1"
```

---

## 9. 接 MineRadio：模块 / IPC / 面板（本次新增）

链路与歌曲面完全平行，既有 provider 链一行未动：

```text
public 歌单面板 Apple 卡片的 ▶
  -> window.mineradio.amc.playPlaylist({ name, scopeLabel })
  -> ipcMain 'amc:play-playlist'
  -> desktop/apple-music-control.js playPlaylist()
  -> spawn poc/play-playlist.ps1 -Name <name> -ScopeLabel <label> -Commit
  -> Apple Music Windows（UIA 链）-> SMTC 判定 -> 逐字段返回
```

| 文件 | 改动 |
|---|---|
| desktop/apple-music-control.js | 新增 DEFAULT_PLAYLIST_SCRIPT + playPlaylist() 并加入 exports；runChain / playTrack **一行未动** |
| desktop/main.js | 新增 ipcMain.handle('amc:play-playlist')，与 amc:play 同样是「只搬运、不裁决」的处理器 |
| desktop/preload.js | 新增 playPlaylist: (payload) => invoke('amc:play-playlist', payload) |
| public/js/modules/06-lyrics/02-playlist-detail.js | Apple 歌单卡片加 ▶ 按钮 + 作用域限定的点击分支 + playApplePlaylistInAppleMusic()；虚拟卡（资料库 / 喜爱歌曲虚拟卡）不出按钮 |

**契约**（与 CONTROL-PLANE I1 一致）：歌单没有可预期曲目，所以这一面**不承诺**曲目级 identity 校验；
返回里 verification='smtc-transition'，verified 的含义是「SMTC 进入了 Playing」。只有链的 PLAYBACK_STARTED
算 verified=true；PLAYLIST_NOT_FOUND / AMBIGUOUS / PLAY_BUTTON_NOT_FOUND / PLAYBACK_UNCHANGED /
SMTC_TIMEOUT 一律 false 并带 stage。同名多个 → AMBIGUOUS，绝不猜；调用方可传 cardIndex 指定第几个
（面板目前只把这种情况显示成 `!`）。

**实测（真机，2026-09-26）**

- 模块级（正是 IPC 处理器调用的一条路径）：playPlaylist({name:'喜爱歌曲', scopeLabel:'你的资料库'})
  → ok=true verified=true stage=PLAYBACK_STARTED playVia=page-play-button，SMTC Paused -> Playing 144ms，总耗时 **7.9s**；
- CLI 3/3：总耗时约 **8.0 / 8.0 / 8.1s**，全部 PLAYBACK_STARTED；
- 仓库测试：tests/apple-music-playback-context.test.js **10/10**、tests/platform-account-sync-guard.test.js OK；
  被改的 4 个文件 node --check 全 0；
- 每次跑完都用 Invoke-AmPause 把 Apple Music 还原为 Paused。

### 9.1 悬停按钮：实现保留，默认不走（实测不可靠）

- 机会性快路径：点卡片前先查一次树，若卡片内**已经**有 AutomationId=PlayButton（例如用户自己的鼠标正停在
  卡片上）就直接点它 —— 零额外耗时，playVia=card-hover-play-button；
- 主动悬停保留为可选（CLI -TryHoverPlay / payload tryHoverPlay）：一次真机跑里它花掉 14.2s 仍没找到叠层，
  随后退回导航路径成功；
- 因此默认顺序 = 机会性检查 → 点卡片（导航）→ 点歌单页页头 PlayButton（playVia=page-play-button）。

### 9.2 在真实 app 里怎么点这一下

1. 重新加载窗口（Ctrl+R）让新的 02-playlist-detail.js 生效；
2. 打开歌单面板 → 找到带 **AM** 标记的歌单（例如「喜爱歌曲」）→ 点卡片右侧的 **▶**，
   或者展开歌单详情后点里面的 **播放歌单**（两者现在是同一个动作：让 Apple Music 播放整张歌单）；
3. 预期：Apple Music 自动搜索该名字、切到「你的资料库」作用域、打开歌单并开始播放；按钮变成 ✓；
   名字在资料库里不唯一 → 按钮显示 `!`（同名多个，不猜）；找不到 → `×`；
4. console 里会打印 [amc] playPlaylist result，含 stage / playVia / SMTC before-after。

---

## 10. 深链路线（-Url）：实测可行（2026-09-26）

**机制**：链接 → 应用打开页面 → 点页面自己的播放按钮 → SMTC 判定。用的是冻结链里已验证的导航方式
Invoke-AmNavigateUrl（AppleMusic.exe /url "<url>"，失败退回 shell-open），**不是** Win+R 那套 shell 打开；
Win+R 的 musics:// 形式也试过：应用接受、窗口前置，但决定性差异不在 scheme，而在店面（见坑 1）。

**实测（歌链接，us 店面）**

```text
play-playlist.ps1 -Name "How Do I Make You Love Me" -Url "https://music.apple.com/us/song/how-do-i-make-you-love-me/1603171530" -Commit
-> ok=True stage=PLAYBACK_STARTED navigatedBy="AppleMusic.exe /url" playVia="url-page-play-button"
   playButtonFound=true playButtonClicked=true   SMTC Paused -> Playing (4ms)
```

**两个必须记住的坑（都是本次实测）**

1. **店面不匹配的链接会被忽略**：同一个歌的 /cn/... 链接被应用接受（Start-Process 无错）但**页面纹丝不动**；
   /us/... 链接才真正打开页面（页面文本变成 Dawn FM / Abel Tesfaye / 无损，并出现播放按钮）。
   这正是 poc/README.md 早先记过的「URL 按店面分配」。引擎不会假装成功：页面没变就找不到播放按钮，
   报 PLAY_BUTTON_NOT_FOUND。
2. **播放按钮的 AutomationId 分页面**：**歌单页**页头是 PlayButton；**深链打开的专辑/歌曲页**是
   PlayButtonElement（中文名都是「播放」）。因此 Find-AmPlaylistPagePlayButton 增加了可选参数
   -AllowAlternateId，只有深链路线接受第二个 id —— 已验收的名称路线行为不变。

**接线**：-Url 已打通 CLI（-Url）、模块（payload.url）与面板（歌单对象有 url / attributes.url 时自动带上）。
与名称路线的差别：**不搜索、不切作用域、不歧义**，更快也更确定；没有链接时仍走名称路线。
**未验证**：还没有用**真实歌单链接**跑过一次（需要一个与账号店面匹配的歌单链接）。

---

### 10.1 真实歌单链接（用户提供，2026-09-26）：实测跑通

链接：https://music.apple.com/cn/playlist/my-playlist/pl.u-vxy697juWRBP21v

```text
CLI   play-playlist.ps1 -Name "My Playlist" -Url <上面的链接> -Commit
  -> ok=True stage=PLAYBACK_STARTED navigatedBy="AppleMusic.exe /url" playVia="url-page-play-button"
     playButtonFound=true playButtonClicked=true   SMTC Paused -> Playing   总耗时 2.7s
模块  amc.playPlaylist({ name:'My Playlist', url:<链接> })   （就是 IPC 处理器调的路径）
  -> ok=true verified=true stage=PLAYBACK_STARTED playVia=url-page-play-button   总耗时 2.75s
```

对比：同一个歌单走**名称路线**要约 8s，且要搜索、切作用域、可能歧义。链接路线不搜索、不切作用域、不歧义。

### 10.2 与歌链接不同的两个点（都是实测）

1. **pl.u- 资料库歌单链接不分店面**：同一个链接的 /cn/ 与 /us/ 两个版本**都打开了歌单页**
   （页面文本 = My Playlist / FHJI / 周四更新）。而前面的**目录歌曲**链接 /cn/ 被忽略、/us/ 才打开 ——
   所以店面坑只对目录（catalog）链接成立，资料库歌单链接不受影响。
2. **同一个歌单页，按钮 id 取决于“怎么到达”**：
   - 从搜索结果点卡片进入 → 页头按钮是 PlayButton（208x56，y≈684）；
   - 用链接打开 → 页头按钮是 PlayButtonElement（150x56，y≈600），且没有 PlayButton。
   深链路线的 -AllowAlternateId 同时接受两者，因此两条路都点得到。

### 10.3 MineRadio 不需要手工粘贴链接

歌单映射器早就在搬运链接了：apple-music-api.js:892 →
appleUrl: normalizeText(attributes.url)（还有 applePlayParamsId）。本次把面板补上：

- 卡片 ▶ 读卡片的 data-playlist-url（新加的属性，值来自 pl.appleUrl）；
- 详情页「播放歌单」读 pl.appleUrl（其次 pl.url / pl.attributes.url）。

因此**有链接就用链接路线**（2.7s、无歧义），**没有链接才退回名称路线**（约 8s）。

---

### 10.4 单击，不要双击（用户纠正 + 实测）

用户指出：**Apple Music 的播放键第一次点击才真起播（要加载一下），点完播放再点就变成暂停**。
而冻结库里给歌曲行用的 Invoke-AmRowPlay 发的是**双击**（两次 down/up），落在播放控件上就是
「播放 → 暂停」—— 这正是先前那次「悬停按钮找到了、clicked=true、SMTC 却 8s 不动」的合理解释。

处理：本文件新增 `Invoke-AmSingleClick`（**恰好一次** down/up，保留置前台 + 点击前重算几何），
并把 5 处点击全部改成它：作用域芯片、卡片本体（导航）、卡片悬停播放键、歌单页页头 PlayButton（名称路线与
链接路线各一处）。冻结的 am-uia.ps1 未改，歌曲行仍然用它的双击。

改完后的三条路线实测（每次都先压到 Paused）：

| 路线 | 结果 | 耗时 |
|---|---|---|
| 1 链接路线（你给的歌单链接） | PLAYBACK_STARTED via url-page-play-button | 4.5s |
| 2 名称路线（搜索 + 资料库作用域） | PLAYBACK_STARTED via page-play-button | 7.8s |
| 3 名称路线 + -TryHoverPlay | PLAYBACK_STARTED via page-play-button（主动悬停仍未找到叠层，退回成功） | 14.0s |

第 2 条同时证明：**单击仍然能完成导航与作用域切换**（它们原来也是双击）。
未解项不变：主动悬停在引擎流程里为什么找不到叠层，仍未查清（单击修复不能解释「根本没找到」）。

---

### 10.5 点击后自动最小化（用户纠正 + 实测）

歌曲链的既有产品行为是「点击落地后把 Apple Music 最小化」（`am-play.ps1:307-310`：先 `Start-Sleep 250`，
再 `Minimize-AmWindow`，然后才做 SMTC 判定）。歌单链原样照抄这条时序：

- 歌单链 CLI **只读** dot-source `lib/am-play.ps1`（不修改它），复用它的 `Minimize-AmWindow`；
- 三处播放点击（卡片悬停键 / 歌单页页头按钮的两条路线）后都调用 `Hide-AmAfterClick`；
- 若调用方没有加载 am-play.ps1，助手返回 false，引擎本身照常可用（只是不最小化）；
- `-NoMinimize`（模块侧 `payload.noMinimize`）可保留前台。

实测（真机，每次都先压到 Paused）：

| 例 | 结果 | 点后 IsIconic(AM) |
|---|---|---|
| A 链接路线 | PLAYBACK_STARTED via url-page-play-button（过渡 2965ms，正是「要加载一下」） | **True** |
| B 名称路线 | PLAYBACK_STARTED via page-play-button（5ms） | **True** |
| C 链接路线 + -NoMinimize | PLAYBACK_STARTED | **False**（开关有效） |

---

### 10.6 作用域切换：改为按结果验证（单击改动暴露的回归）

把点击从双击改成单击之后，名称路线连续 3 次以 `PLAYLIST_NOT_FOUND / listItems=44` 失败。现场取证：

- `SearchPageStatus` = 「正在显示“喜爱歌曲”的结果」→ 搜索确实执行了；
- 内容区文本 = The River / 绵绵 / 陈奕迅 … → **仍停在 Apple Music（目录）作用域**；
- 两个芯片的 UIA 能力是 **TogglePattern**，没有 SelectionItem；
- 直接探测：在页面稳定后单击芯片一次 → 候选数从 0 变 1（切换成功）。

结论：那一击**本身是对的**，但在「搜索刚提交、页面还在渲染」时会被吞掉；旧的**双击**刚好掩盖了这个竞态
（第二次点击替它干了活），单点之后回归就暴露了。

改法：作用域这一步**点一次 → 按结果验证 → 没切过去才再点**，共 3 次（奇数，即使芯片按 toggle 解释，
最终态也是资料库作用域）；`scopeSwitched` 只表示「点过了」，真实结果由 `scopeVerified` /
`scopeSwitchAttempts` 记录。改完实测：**3/3 名称路线 `scopeVerified=true`（第 1 次尝试）→
`PLAYBACK_STARTED` → 已最小化**。

---

## 11. 原件备份与本次产物

- **WIP 原件备份**（第一次修改前，未提交内容的唯一副本）：
  `C:\Users\limin\AppData\Local\Temp\am-play-playlist.WIP-20260926-184809.ps1`
  SHA256 `98737F71F05B08DBC9D6F6286ED335225D7B209EEF7E90F6610B5497A2F9F935`
- 当前哈希（本轮最后一次修改后）：
  - experiment\apple-music-windows-control\poc\lib\am-play-playlist.ps1 SHA256 B5FF03B699B662F6B4BC7DCDBDBED39BB0792657DDCE57CFA69D6490A8789F55
  - experiment\apple-music-windows-control\poc\play-playlist.ps1 SHA256 F34BB77B1616CD68E7DCBA95309B63A458532ED317578EEA73A077278A99B1B6
  - desktop\apple-music-control.js SHA256 437A11410A027E6EC377AE58A15250311ADC90AEC1C37438B50D9F28C92422AA
  - desktop\main.js SHA256 23CF43113313CBF9DA621AC20B936F969D40E743F94287A28126DE71457B425B
  - desktop\preload.js SHA256 77712CF4CBD7DC7BC7A2FAA13BB38A10B33DC0F9808C45E54C3DEFED872B642F
  - public\js\modules\06-lyrics\02-playlist-detail.js SHA256 D736EE1A2F409AE8B470ED8708A6EC83DB2C6C4995458EF53D5854514924E3B9
  - tests\apple-music-playback-context.test.js SHA256 F3EE59E150C571C14F8443538DE81262B06F916A4F44DCC4C49D674F95248656
- 注意：`git checkout -- <file>` 只能回到 HEAD（106609a），**回不到 WIP**；要回退请用上面的备份文件。
- 测量用的临时脚本/数据（%TEMP%，未入库）：`am-scope-dump.ps1/.json`、`am-pls-diag.ps1/.json`、
  `am-card-subtree.ps1/.json`、`am-post-click.ps1/.json`、`am-page-play.ps1/.json`、`am-hover-overlay.ps1/.json`、
  `am-hover-shot.ps1/.json/.png`（悬停叠层截图）、`am-card-hover-play.ps1/.json`、`am-hover-retry.ps1/.json`、
  `am-pause.ps1`、`am-scope-label.txt`、`am-query.txt`。