# Lyricify Fusion 时间轴观测与 Comparator —— 实测报告

> 阶段：只读采集 → 实时解析 → 统计分析 → 与 MineRadio TSP Plus 对比
> 结论先行：**Lyricify Fusion 当前版本不输出播放位置时间轴**；本报告给出能观测到的全部事实，
> 以及一个可以持续运行、无需截图、不干扰 Lyricify Fusion 的观测工具。
> 全程未对 Lyricify Fusion 的配置 / 缓存 / 数据库 / 安装文件 / 运行状态做任何修改。

配套文档：[只读侦察报告](LYRICIFY_FUSION_TIMELINE_RECON.md) · [工具说明](../tools/README.md)

---

## 1. 观测对象

| 项目 | 实测值 |
|---|---|
| 进程 | \`Lyricify Lite\`（PID 35648，MSIX 包 \`63265WXRIW.193470E81A0DE_8ybqz4qm5hwha\`） |
| 可执行文件 | \`C:\Program Files\WindowsApps\...\Lyricify Lite\Lyricify Lite.exe\` |
| 日志目录 | \`%APPDATA%\Lyricify\Lyricify Lite\Logs\`（产品已更名 Lyricify Fusion；磁盘上仍是旧目录名，采集器对两个名字都支持） |
| 日志文件 | \`Log.txt\`、\`Log.Lyrics.txt\`、\`Log.LastFM.txt\`（**只有这三个**，无第二套日志，无轮转副本） |
| 编码 / 行尾 | UTF-8 **无 BOM** / CRLF / 始终以换行结尾 |
| 时间戳 | ISO-8601，**7 位小数（100ns）**，本地时区，例：\`2026-10-06T17:08:10.4789636+08:00\` |

## 2. 是否实时追加

| 观测 | 结果 |
|---|---|
| 90 秒窗口字节增量 | \`Log.Lyrics.txt\` +138 B、\`Log.LastFM.txt\` +196 B、\`Log.txt\` +0 B |
| 触发方式 | **只在事件发生时写一行**（切歌 / scrobble 阈值 / 生命周期 / 异常），稳定播放期间完全静默 |
| 轮转 | 无（\`Log.txt\` 自 2026-03-01 持续追加至今仍是一个文件） |

因此不存在"每秒一个采样点"的时间轴日志：**日志节奏 = 事件节奏**。

## 3. 精度普查（对 48,486 行逐行扫描）

| 检索项 | Log.txt | Log.Lyrics.txt | Log.LastFM.txt |
|---|---|---|---|
| \`hh:mm:ss\` / \`mm:ss\` 播放位置**显示值** | 0 | 0 | 0 |
| 原始 SMTC TimeSpan / \`Position=\` 数值 | 0 | 0 | 0 |
| \`playedMs=\` / \`targetMs=\` 毫秒数值 | 0 | 0 | **99 / 99** |
| Pause/Resume/Playing/Stopped/Seek/currentTime | 0 | 0 | 0 |

* \`Log.txt\` 里 5,659 处 "Position" 全部来自异常堆栈的方法名 \`PlaybackInfo.SetPosition(...)\`；
  5,661 条 \`[<AUMID>] Error in OnAnyTimelinePropertyChanged Invoke\`（5,654 条集中在 2026-05-03），
  异常类型实测有 \`System.InvalidOperationException: Collection was modified\`（在 SetPosition 内）、
  \`TaskCanceledException\`（Dispatcher）、\`NullReferenceException\`。
* \`Log.Lyrics.txt\` 里 12 处 "Position" 是歌名《positions》(Ariana Grande)。
* 唯一毫秒数值：\`[Event] Scrobble trigger: session=…, title=…, artist=…, playedMs=<n>, targetMs=<n>\`，
  **语义是 scrobbler 累计播放时长，不是 SMTC 原始 position**（观测里显式标注
  \`semantics='scrobbler-accumulated-played-ms'\`、\`isRawSmtcPosition=false\`）。

## 4. 采集器怎么工作（只读）

\`\`\`
node tools/lyricify-fusion-timeline-monitor.js            # 前台实时观测（默认只跟新增）
node tools/lyricify-fusion-timeline-monitor.js --once --json
node tools/lyricify-fusion-timeline-monitor.js --backfill-bytes 6000   # 显式有界历史
node tools/lyricify-fusion-timeline-monitor.js --compare --tsp <file>  # 只读对比
\`\`\`

* **只读打开**：\`fs.openSync(path,'r')\`；只读 \`[offset,size)\`；从不写/截断/改名 Lyricify 文件。
* **增量算法**：读到的块只消费到"最后一个换行符"为止；没有换行就一个字节都不消费
  → 半行不会被当成记录，也不会被重复消费。
* **起点落在行中间**（崩溃/回退）：先丢掉这一行的残片再开始，绝不让半行变成"无时间戳记录"。
* **游标**：\`tools/.state/monitor-cursor.json\`（仓库内），记录每源 offset / 行号 / 文件身份 / 轮转次数
  / 最近 2000 条记录指纹；**每消费一批立即落盘**，把崩溃后重复消费限制在一轮之内。
* **跨重启去重**：指纹 = \`文件|时间戳|事件类型|会话|身份|原文前缀#同批序号\`（**不使用会话内行号**，
  因为行号跨重启会变）。命中的记录计入 \`Duplicates skipped\`，不再重复计入统计。
* **轮转检测**：size 变小 → \`truncated\`；文件身份（birthtime+ino）变化 → \`recreated\`；两种情况都重置游标。
* **单实例锁**：\`tools/.state/monitor.lock\`（PID 存活检查），避免两个采集器重复写同一输出。
* **停止**：Ctrl+C / SIGTERM / 创建 \`tools/.state/monitor.stop\` → 保存游标 + 释放锁 + 打印最终统计。
* **有界**：输出 JSONL 按大小轮转（默认 32MB）；统计与指纹环形缓冲有界；不占高 CPU（400–500ms 轮询）。

## 5. 实测统计结果（真实数据，非示例）

### 5.1 实时窗口（live，5 分钟窗口）

\`\`\`
[run]  records=6   record-interval(med/p95)=407ms/42.99s
       position samples=0（该版本不输出播放位置）  repeated/forward/backward = n/a
       duplicate events=0   duplicate timestamps=0   track changes=2（scrobble-reset）
       log lag(med/p95)=1.09s/81.68s   collector lag(mean)=0ms   precision-unknown=100.0%
       pause/resume: 不可观测（日志不记录播放状态）
\`\`\`

* \`log lag\` = 采集时刻 − 日志时间戳。稳态中位数 **1.09s**（轮询间隔 400ms）；
  p95 81.68s 的那几条是**采集器停机期间 Lyricify 自己写的日志**，恢复跟踪后才被读到 —— 属于"恢复间隙"，不是日志延迟。
* \`collector lag\`（读到 → 处理）实测 0ms。
* \`precision-unknown = 100%\`：所有记录都不带播放位置，如实标注。

### 5.2 显式有界历史回读（\`--backfill-bytes 6000\`，每个文件 6000 字节）

| 指标 | 值 |
|---|---|
| 记录数 | **113**（跨 2026-10-01 → 2026-10-06） |
| 事件类型 | \`track-search\` 43、\`scrobble-reset\` 32、\`app-start\` 13、\`app-loaded\` 13、\`other\` 6、\`app-exit\` 5、\`unclassified\` 1 |
| 带 position 的记录 | **0** |
| 精度未知占比 | **100%** |

> 说明：\`Log.txt\` 只在生命周期/异常时写，6000 字节覆盖约 5 天；因此这份数据适合看**事件词汇与身份变化**，
> 不适合看采集延迟（历史行的 lag 无意义）。

### 5.3 事件形态（每一次切歌的稳定三连）

真实抓到的切歌瞬间（同一秒内，跨两个文件）：

| 相对时间 | 文件 | 事件 | 采集 lag |
|---|---|---|---|
| +0.000s | Log.Lyrics.txt | \`track-search\`（[Search Track] 标题行） | 780ms |
| +0.002s | Log.LastFM.txt | \`scrobble-reset\`（reason=Track + 完整身份） | 1187ms |
| +0.602s | Log.Lyrics.txt | \`track-search\`（带来源的命中行） | 990ms |

→ 同一事件的**重复日志**（两个文件各一条）实测间隔约 2ms，被正确统计为 \`duplicate timestamps\`，
而不同事件之间的间隔中位数是 407ms、p95 是 42.99s（切歌间隔）。

## 6. 实测中暴露并修掉的 5 个真实缺陷

| # | 现象（实测） | 根因 | 修复 |
|---|---|---|---|
| 1 | \`EBUSY: resource busy or locked\`，一条观测写不出去 | 输出文件被外部读取者持锁，\`appendFileSync\` 立刻失败 | 有界重试 + \`write failures\` 计数，瞬时占用不再丢数据 |
| 2 | 强杀采集器后重启，同一段日志被重复计入 | 游标只在统计周期落盘；去重集合是进程内内存 | 每批消费后立即落盘游标 + 指纹持久化到游标并跨重启装载 |
| 3 | 重读被识别为"新记录" | 指纹用了**会话内行号**（重启后变化） | 指纹改为内容稳定型（时间戳/类型/身份/原文 + 同批序号） |
| 4 | 出现 \`unclassified\` 伪记录（\`set scrobble state…\` 少了开头两字母） | 游标落在行中间时，残片被当成一条记录 | 起点不在行首时先丢残片（\`skippedPartialBytes\` 报告），并新增回归测试 |
| 5 | 两个采集器同时写同一输出 | 无实例保护 | \`tools/.state/monitor.lock\` 单实例锁 + \`--force\` 显式覆盖 |

**重复抑制实测证据**（游标故意回退 400 字节后重启）：

\`\`\`
New records:        0
Duplicates skipped: 5   (跨重启 / 重复读取防护)
[TSP 无关] 优雅停止：锁已释放，游标已保存
\`\`\`

## 7. Comparator：能可靠比较什么

**输入**：Lyricify 观测 JSONL（本工具产出）+ TSP 观测（\`[TSP]\` 文本导出 或 含 \`t/stableMs\` 的 JSONL）。

| 指标 | 可否比较 | 说明 |
|---|---|---|
| 绝对 position 偏差 | ❌ | Lyricify 侧**根本没有** position 观测（0 条）；即使有，也只有 playedMs（语义不同）或秒级显示值（±1000ms 量化） |
| 变化率趋势 d(position)/dt | ❌ | 同上：样本数 0 < 3 |
| 重复率 / 事件节奏 / 事件类型分布 | ✅ | 结构指标不需共同时间基准 |
| 事件时序（切歌 vs TSP 轨道变化） | ✅（需同窗口数据） | 本次两侧数据来自不同时间窗，对齐结果为 \`n/a\`，**未强行给出数字** |
| TSP stable 单调性 / anchor 重建次数 / 采样间隔 | ✅ | 只依赖 TSP 侧 |

实测输出（真实命令）：

\`\`\`
[Lyricify Fusion ↔ MineRadio TSP Comparator] (read-only)
TSP observations:      20 records / 20 samples (time basis: full)
Lyricify observations: 113
lyricify position      0 samples, semantics=[]
  [NOT comparable] absolutePositionDeviation :: Lyricify 侧没有 position 观测（实测该版本日志不输出播放位置）
  [NOT comparable] rateTrend :: Lyricify 侧 position 样本不足（0 < 3）
  [comparable]    structural
  [comparable]    eventTiming
  TSP stable monotonic: true (order violations=0, anchor-reset actions=0)
  TSP stable interval (med/p95): 4.99s / 5.25s
\`\`\`

> TSP 侧数据说明：这 20 条是**离线重放**——把真机抓到的 20 个真实 SMTC 样本（整秒 position、~5s 间隔）
> 喂进本仓库真实的 \`08-timeline-stabilizer-plus.js\` 代码得到的 TSP 输出。
> 它是"真实输入的算法输出"，**不是**运行中 MineRadio 的实时采集，报告中已如实标注。

## 8. 安全声明

* 采集器只以 \`'r'\` 模式打开 Lyricify 的 \`Log*.txt\`；源码层过滤 \`^Log.*\.txt$\`，绝不会碰
  \`Settings.json\`、\`Cache\Text\Tokens\`、\`LyricsCatalog.db\`、\`HotKey.json\`、\`StoreInfo.ini\`。
* 会话前后对比：\`Settings.json\` 最后写入时间停在 **15:03:20**（早于本次会话）、
  token 文件最后写入 **2026-09-26**、Logs 目录始终只有原来那 3 个文件且 CreationTime 未变。
  期间只有 \`Log.Lyrics.txt\`/\`Log.LastFM.txt\`/\`LyricsCatalog.db\` 被 **Lyricify 自己**更新，
  时间戳与它自己的切歌事件一一对应。
* 未启动/未停止/未重启 Lyricify Fusion，未附加调试器，未修改任何播放状态，未安装服务或计划任务。
* 采集输出与游标全部落在本仓库（\`tools/out\`、\`tools/.state\`），写入前有"必须在本仓库内"的路径校验。

## 9. 需要人工授权的后续操作

1. **让 TSP 产生落盘观测流**（唯一能解锁"绝对偏差/时间对齐"对比的动作）：
   * 方案 A（最轻）：在 MineRadio DevTools 里执行 \`smtcTspSetDebug(true)\`，用 \`smtcTspDump()\` 导出
     \`[TSP]\` 文本，交给 \`--compare --tsp <file>\`。**不涉及 Lyricify**，仅是会话级开关。
   * 方案 B（长期）：为 TSP 增加"只写本仓库目录"的文件 sink，实现 TSP 侧实时采集。
   * 两种方式本次**都未执行**，等待授权。
2. **让 Lyricify Fusion 输出更细的时间轴日志**：需要修改它自己的日志等级/调试开关 →
   违反只读约束，**不建议，也不会执行**。
3. 若未来 Lyricify Fusion 版本开始在日志里输出秒级或毫秒级 position，
   本工具已就绪：秒级会被标注为 \`precision='second'\`（禁止当原始精度），
   只有真正的毫秒级 position 才会解锁绝对偏差对比。
