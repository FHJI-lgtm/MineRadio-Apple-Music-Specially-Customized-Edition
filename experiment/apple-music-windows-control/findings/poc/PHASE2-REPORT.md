# 第二阶段：Apple Music 精准播放能力（playSong）硬化实验报告

- 分支：`experiment/apple-music-windows-control`（含 `main` 的歌词源修复合并提交 `5ca4427`）
- 环境：Windows 10.0.26200 x64；Apple Music（Store 版）`AppleInc.AppleMusicWin 1.1540.23042.0`
- 单显示器 1280x720 DIP（150% 缩放 → 1920x1080 物理）；Apple Music 窗口最大化 2584x1540 物理
- 结论日期：2026-09-25

---

## 1. 修改/新增了哪些文件

全部位于 `experiment/apple-music-windows-control/`，**未改动 main 业务代码**：

```
poc/
├── lib/
│   ├── am-common.ps1    计时 / UTF-8 输出 / 文本规范化 / title+artist 匹配（含 CJK 容错）
│   ├── am-smtc.ps1      SMTC 读取、暂停、等待 Playing、MATCH/WRONG_TRACK/TIMEOUT 判定
│   ├── am-uia.ps1       UIA：进程/窗口、搜索框、候选行打分、realize/可视性/滚动、安全点双击、截图
│   ├── am-play.ps1      playSong 引擎（两种定位模式 + 阶段码 + 分阶段耗时）
│   └── am-resolve.ps1   （仅实验用）用公开 iTunes Search API 把 title+artist 解析成歌曲页 URL
├── songs.json           冻结的 3 首测试歌曲（含 URL、期望 SMTC 串、备注）
├── play-song.ps1        CLI：Play-AmSong 包装
├── discover-songs.ps1   冻结/验证测试歌曲（每首实播一次并回填真实 SMTC 串）
├── stability-test.ps1   3 首 × 20 次 = 60 次核心可靠性统计
├── scenario-test.ps1    环境/边界场景（与 60 次统计**分离**）
└── README.md            用法、阶段码表、结果说明
findings/poc/            各次运行的 jsonl / csv / md 原始结果（含失败截图）
```

执行顺序：`discover-songs.ps1`（冻结验证）→ `stability-test.ps1`（60 次）→ `scenario-test.ps1`（边界）。

## 2. 是否新增依赖

**没有新增任何 npm/包依赖。** 全部为 Windows PowerShell 5.1 + 官方 UIA（UIAutomationClient）+ 官方 SMTC（Windows.Media.Control）+ user32 输入合成。

唯一的"外部服务"是**仅在冻结测试歌曲时**使用的公开、有文档的 iTunes Search API（HTTPS，无需凭据、无私有接口），解析结果写进 `songs.json`，**运行时（60 次测试与 playSong 本身）不联网**。MineRadio 自身已持有歌曲的 Apple Music URL/ID，不需要这一步。

## 3. playSong 当前调用方式

```powershell
# CLI（输出一行 JSON）
powershell -ExecutionPolicy Bypass -File poc\play-song.ps1 -Title "Shape of You" -Artist "Ed Sheeran" `
  -Url "https://music.apple.com/us/album/shape-of-you/1193701079?i=1193701392" -PauseFirst -Retries 1 -Human

# 引擎（进程内，供 runner 复用）
Invoke-AmPlaySong -Title <t> -Artist <a> [-SongId <id>] [-Url <songURL>] [-TimeoutMs 6000] [-Retries 2] `
  [-SearchWaitMs 6000] [-PageWaitMs 12000] [-PauseFirst] [-NoLaunch] [-NoForeground] [-ShotPath <png>]
```

两种定位模式（结果里以 `mode` 字段区分）：

| 模式 | 何时使用 | 步骤 | 实测可靠性 |
|---|---|---|---|
| `deeplink`（**推荐/主用**） | 调用方给出歌曲页 URL（MineRadio 本来就有） | 打开 URL（**仅导航，不算成功**）→ 轮询到页面上出现标题匹配的曲目行 → realize（必要时滚动/校验可视性）→ 在行左侧安全区合成双击 → SMTC 校验 | A 95% / C 95% |
| `search`（回退） | 没有 URL 时 | 搜索框输入标题 + Enter 提交 → 候选行按 title/artist 打分 → 激活最佳结果导航到歌曲页 → 在页面上双击曲目行 → SMTC 校验 | B 0%（20/20 失败） |

返回结构（节选）：`{ok, stage, mode, attempts, ambiguous, pickedByPosition, matchedRow, triedCandidates,
window:{restored,before,after}, baseline:{status,title,hasSession}, smtc:{title,artist,status,pos,sawPlayingWrong,...},
t:{ensureAppMs,uiRootMs,searchMs,settleMs,realizeMs,clickMs,smtcMs,e2eMs}, stageHistory, ts}`

## 4-6. 60 次测试结果（3 首 × 20 次，每首之间先暂停并等待稳定再计时）

原始数据：`findings/poc/stability-20260925-184133.{jsonl,csv,md}`

| 歌曲 | 次数 | 成功 | 成功率 | mean e2e | median | p95 | max | mean SMTC 段 | 多候选 | 靠列表顺序决定 |
|---|---|---|---|---|---|---|---|---|---|---|
| A `How Do I Make You Love Me?` / Abel Tesfaye（深链 cn） | 20 | 19 | **95%** | 2614 ms | 1896 ms | 9493 ms | 9493 ms | 170 ms | 0 | 0 |
| B `晴天` / 周杰倫（搜索路径） | 20 | 0 | **0%** | — | — | — | — | — | 4 | 15 |
| C `Shape of You` / Ed Sheeran（深链 us） | 20 | 19 | **95%** | 2582 ms | 1726 ms | 9923 ms | 9923 ms | 249 ms | 0 | 0 |
| **合计** | **60** | **38** | **63.3%** | 2598 ms | **1811 ms** | 9493 ms | 9923 ms | **209 ms** | 4 | 15 |

- 成功率只看 SMTC：`PlaybackStatus=Playing` 且标题匹配（给了 artist 时也要匹配）。
- **只看深链模式：38/40 = 95%**；搜索模式 0/20。
- 端到端 = 单次尝试开始（暂停+稳定之后）→ SMTC 确认；SMTC 确认段本身 median **142 ms**。
- 每次尝试前都 `TryPause` 并等到会话不再 Playing 才计时，因此**不存在"上一轮还在播"被算成成功**的假阳性。

## 7. 失败案例与失败阶段

| 阶段 | 次数 | 涉及歌曲 | 含义 |
|---|---|---|---|
| `SMTC_TIMEOUT` | 14 | B(12), C(1) | 点击后一直没进入 Playing（点击未生效/页面未真正播放） |
| `SMTC_WRONG_TRACK` | 7 | B(4), A(1) | 进入 Playing 但曲目不对（点了别的版本/别的内容） |
| `APP_NOT_RUNNING` | 1 | B | 尝试期间 Apple Music 进程不可用（含启动等待 30s 超时） |
| `RESULT_NOT_FOUND` | 0（60 次中） | — | 发生在冻结验证阶段（B 用 tw 链接时页面未出现匹配行） |

观察到的两个现象（原始 jsonl 可复核）：

1. **B 全部失败且失败形态在变**：`SMTC_TIMEOUT` 与 `SMTC_WRONG_TRACK` 交替，说明搜索路径既可能"点了没反应"，也可能"点了别的版本"。B 的 20 次里有 15 次只能靠列表顺序挑候选（`pickedByPosition=true`），这正是你要求保留的稳定性指标。
2. **第 19-20 轮出现小簇异常**：C 一次 `SMTC_TIMEOUT`、A 一次 `SMTC_WRONG_TRACK`、B 一次 `APP_NOT_RUNNING`（启动等待超时）。同批次里出现进程不可用，最可能是运行期间 Apple Music 自身重启/被干扰；A/C 的其余 38 次都是稳定成功。建议后续专门做一次"长时间连续运行"观察这一簇。

## 8. Apple Music 未启动时能否自动启动

**能。** `Ensure-AmRunning` 在进程不存在时用执行别名 `%LOCALAPPDATA%\Microsoft\WindowsApps\AppleMusic.exe` 启动，然后轮询主窗口句柄（上限 30s）。60 次运行中 `app had to be launched: 2` 次，均成功进入后续流程；场景 S2 专门验证"杀掉进程 → playSong 自行拉起并播放"。

## 9. 是否要求 Apple Music 位于前台

**要求窗口可见且不在最小化状态，并且点击前必须能置前台。** 实测结论：

- **最小化 = 必然失败**：最小化时 UIA 根的 `BoundingRectangle` 为空，所有行的 rect 也为空 → `REALIZE_FAILED`。引擎因此在用 UIA 之前先 `SW_RESTORE`（仅当 `IsIconic`）+ 置前台（`window.restored` 字段记录；60 次里有 4 次需要恢复）。
- **`SW_RESTORE` 有副作用（已修）**：对**已最大化**的窗口调用 `SW_RESTORE` 会把它还原成普通大小，导致点击前一刻几何变化、点击落到别处（实测把"点击歌曲行"变成了"点了侧栏的新发现"）。现在只在 `IsIconic` 时才 restore。
- **被遮挡/非前台**：见第 9 节场景 S9/S10 的实测（`scenarios-*.md`），结论写在那里。

## 10. 当前 UIA 方案最大的稳定性风险

按影响排序：

1. **搜索视图不可用于播放（最大风险）**：搜索结果里点"卡片"是**导航**而不是播放；真正的"歌曲行"经常处于未渲染状态（`BoundingRectangle` 为空）；侧栏展开时会覆盖结果左列（UIA 仍报 rect，但点下去命中的是侧栏）；再加上滚动/DPI/页面切换，几何随时漂移。实测过 5 种交互（hover 找播放按钮 / Invoke / Select+Enter / 单击 / 快速双击）都无法从搜索视图直接起播。这就是 B 组 0/20 的原因。
2. **依赖歌曲页 URL，而 URL 是按店面分配的**：把 API 返回的 `/us/` 手动改写成 `/cn/` 会指向**另一首曲子**（实测点出了翻唱版 `Fame on Fire`，被 SMTC 校验拦下）。店面不匹配时链接会被 App **直接忽略**（tw 链接实测无效）。→ 调用方必须提供"与已登录店面一致"的 URL/ID（MineRadio 持有的就是这类 id）。
3. **行名依赖本地化与列表结构**：专辑页行名形如 `音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟`。匹配只依赖标题/歌手子串（不依赖"音轨 N"前缀）✓，但整棵自动化树（`Search_Button` / `TextBox` / ListItem 名称）都是应用私有实现，Store 自动更新后可能失效。
4. **点击需要真实的前台窗口 + 屏幕坐标**：合成双击坐标来自 UIA 物理像素，若窗口在点击前改变几何就会错位 → 已加"点击前重读 rect 重算安全点"（`clickRecomputed` 字段）。
5. **同名多版本**：即使标题精确匹配，也可能有 feat./Remix/Live 多个候选（A 的搜索视图出现 10 个），只能靠 artist 或列表顺序收敛；`ambiguous` / `pickedByPosition` 已作为一等指标进入每次结果。

## 11. 是否已具备进入下一阶段"登录实验"的条件

**建议：可以进入，但先接受一个前提条件。** 依据：

- 深链模式已被证明稳定可用：**95% 成功（38/40）**，median **1.81s**、p95 9.5s、SMTC 确认段 median **142ms**，且成功判定完全由 SMTC 把关（能挡住"打开了 App 但没播放"和"播了别的歌"两类假成功）。
- 该模式对 MineRadio 的接口要求很低：**给出歌曲的 Apple Music URL/ID**（MineRadio 作为 Apple Music 客户端本来就持有），无需登录、无需凭据、无需私有接口。
- 因此播放链路已可作为"下一阶段登录实验"的稳定基座：登录实验只需要在拿到凭据后，把"官方歌词/账号态"接进来，播放动作继续走 `deeplink` 模式。

进入下一阶段前建议先做（都属于小幅加固，不是重构）：

1. 在 playSong 的入参里**把 URL/ID 变成显式必需项**（或明确"无 URL 时自动降级为 search 并如实返回低置信"），避免调用方误用搜索路径。
2. 把第 9 节场景里"被遮挡/非前台"的实测边界写进接口契约（调用方需要保证窗口可前台化，或接受一次前台夺取）。
3. 补一个"连续 200 次"的长稳测试，专门观察第 7 节提到的第 19-20 轮异常簇。

## 场景测试实测（与 60 次统计分离）

原始数据：`findings/poc/scenarios-20260925-185032.md/.jsonl`

| 场景 | 结果 | 说明 |
|---|---|---|
| S1 应用已打开 | ✅ OK 2675ms | 基线 |
| S2 应用未运行 | ✅ OK 4817ms（`launch=True`，拉起耗时 **725ms**） | playSong 自行启动 Apple Music 并播放成功 |
| S3 A→B→C 连续切换 | A ✅ 1197ms / B ❌ SMTC_TIMEOUT / C ✅ 1543ms | 切换本身无额外问题；B 的失败与搜索结果视图有关 |
| S4 同一首歌重复 3 次 | ✅ 3/3（1163 / 1173 / 1579 ms） | 每次先暂停再计时 → **无假阳性** |
| S5 同名多版本（搜索路径） | 4 个候选，`ambiguous=True`，stage=SMTC_TIMEOUT | 候选识别与歧义标记正确，但搜索视图仍点不动 |
| S6 不存在的歌曲 | ❌ `REALIZE_FAILED`（**不是** `RESULT_NOT_FOUND`） | 见下方"已知缺陷" |
| S7 窗口最大化 | ✅ OK 5103ms | |
| S8 窗口普通大小 | ✅ OK 8910ms | 从最大化切回普通会触发重排，明显更慢 |
| S9 窗口被其它窗口覆盖（保留置前台） | ✅ OK 1191ms | 流程先置前台，因此仍能播 |
| S10 同样场景但**禁用置前台** | ❌ `SMTC_TIMEOUT`（13.5s） | **实测证明：点击前必须把 Apple Music 置前台，否则合成点击不会触发播放** |

### 关于第 9 问的最终结论（是否需要前台）

**需要。** 依据 S9 vs S10 的对照：保留置前台 → 成功；跳过置前台（另一个窗口占据前台）→ 13.5s 后 `SMTC_TIMEOUT`，SMTC 仍停留在上一首的 Paused 状态。另外最小化状态下 UIA 完全没有几何（必须 `SW_RESTORE`）。本方案不做"后台点击/虚拟显示器"这类补偿，只在契约里要求"窗口可前台化"。

### 两个已知缺陷（本轮如实记录，未修）

1. **`RESULT_NOT_FOUND` 很难触发**：搜索视图会把查询词本身回显成一个列表项（形如 `how do i make you love me?`），它与标题"完全相等"，因此对**不存在的歌曲**也会先匹配上这个回显项，流程一路走到 realize 才失败（S6 得到 `REALIZE_FAILED`）。结果是**安全失败（不会误报成功）**，但阶段码不理想。修法：要求候选具备真实几何/排除"查询回显"，或引入"无结果"状态判定。
2. **遮挡场景构造不可靠**：本机 `notepad` 是 Store 应用，启动后 `MainWindowHandle` 立即为 0，`SetWindowPos` 未能真正盖住 Apple Music（脚本报参数转换错误）。不过 Notepad 仍抢到了前台，因此 S10 依然有效测出了"前台要求"；"窗口被覆盖但仍在最前"的情形未单独构造。

## 附：证据文件

| 文件 | 内容 |
|---|---|
| `findings/poc/stability-20260925-184133.md/.jsonl/.csv` | 60 次结果（本次） |
| `findings/poc/discover-20260925-184013.*` | 冻结验证（A/C 成功、B 失败） |
| `findings/poc/scenarios-*.md/.jsonl` | 场景测试（含 S2 自动启动、S7/S8 窗口态、S9/S10 遮挡与前台） |
| `findings/poc/fail-*.png` | 每次失败的窗口截图 |
| `findings/poc/diag*-*.png` | 排查搜索视图/卡片交互时留下的对照截图 |
| `poc/*.ps1`, `poc/lib/*.ps1` | 可重跑的实现与工具 |
