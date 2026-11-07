# Lyricify Fusion 只读时间轴观测器

> 本目录下所有工具**只读**运行。不会修改 Lyricify Fusion 的配置、数据库、缓存、日志或运行状态。

## 为什么需要它

MineRadio 的 Timeline Stabilizer Plus（TSP）需要一个**外部可观测参照**来研究时间轴表现。
本工具把 Lyricify Fusion 已经产生的日志变成结构化观测 + 实时统计，并提供只读对比入口，
用于后续基于证据的 TSP 优化，而不是靠截图与肉眼判断。

## 快速开始

```bash
# 1) 实时观测（默认只跟新增内容；Ctrl+C 正常退出并保存游标）
node tools/lyricify-fusion-timeline-monitor.js

# 2) 单轮采集 + JSON 快照（适合脚本化/CI）
node tools/lyricify-fusion-timeline-monitor.js --once --json

# 3) 显式读取有界历史（默认不读历史）
node tools/lyricify-fusion-timeline-monitor.js --backfill-bytes 65536

# 4) 只读对比（需要既有观测文件 + TSP 观测文件）
node tools/lyricify-fusion-timeline-monitor.js --compare \
  --observations tools/out/lyricify-fusion-observations-YYYY-MM-DD.jsonl \
  --tsp <tsp-observations.jsonl 或 [TSP] 文本导出>

# 5) 优雅停止（除 Ctrl+C 之外的脚本化方式）
New-Item -ItemType File -Force tools/.state/monitor.stop

# 常用参数
#   --interval 400          轮询间隔 ms
#   --stats-every 20000     实时统计刷新间隔 ms
#   --out <file>            观测 JSONL 输出（默认 tools/out/…-<日期>.jsonl，按 32MB 轮转）
#   --state <file>          游标文件（默认 tools/.state/monitor-cursor.json）
#   --lock-file <file>      单实例锁（默认 tools/.state/monitor.lock）；--force 可跳过（不推荐）
#   --files Log.LastFM.txt  只跟踪指定文件
#   --verbose               打印每条新记录（默认只打印统计块）
```

## 采集器内部设计（要点）

| 关注点 | 做法 |
|---|---|
| 只读 | `fs.openSync(path,'r')`；只读 `[offset,size)`；从不写/截断/改名源文件 |
| 半行 / 跨缓冲区 | 只消费到"最后一个换行符"；无换行则一个字节都不消费 → 不丢字节也不重复消费 |
| 起点落在行中间 | 先丢弃这一行残片（`skippedPartialBytes`），避免产生"无时间戳伪记录" |
| UTF-8 多字节 | 按字节切分 + `StringDecoder`，中文歌名跨写入边界不会乱码 |
| 轮转 / 截断 / 改名 | size 变小 → `truncated`；文件身份（birthtime+ino）变化 → `recreated`；都重置游标 |
| 游标 | 记录 offset / 行号 / 文件身份 / 轮转次数 / 最近 2000 条指纹；**每消费一批立即落盘** |
| 重复读取防护 | 跨重启去重指纹 = `文件|时间戳|事件类型|会话|身份|原文#同批序号`（不用会话内行号） |
| 单实例 | `tools/.state/monitor.lock` + PID 存活检查，避免两个采集器重复写同一输出 |
| 停止 | Ctrl+C / SIGTERM / `tools/.state/monitor.stop` 文件 → 保存游标、释放锁、打印最终统计 |
| 有界 | 输出按大小轮转；统计与指纹环缓冲有界；轮询 400–500ms，不占高 CPU |

## 目录

| 路径 | 作用 |
|---|---|
| `lyricify-fusion-timeline-monitor.js` | CLI：定位日志、增量跟踪、解析、统计、输出、对比 |
| `lib/lyricify-log-sources.js` | 只读定位日志目录/文件（Fusion 与旧 Lite 目录名都支持）+ 只读进程探测 |
| `lib/log-tailer.js` | 只读增量读取：半行、UTF-8 跨边界、截断/轮转/改名、游标 |
| `lib/lyricify-log-parser.js` | 单条记录 -> 结构化观测（精度语义显式标注，不猜测不补零） |
| `lib/timeline-stats.js` | 30s / 60s / 5min / 累计 多窗口统计 |
| `lib/tsp-comparator.js` | 与 TSP 观测的只读对比 + 可比性门禁（不足就拒绝，不硬算） |
| `.state/` | 采集游标（本地，不入库） |
| `out/` | 观测 JSONL（本地，按大小轮转，不入库） |

## 安全边界（代码级）

* 日志文件只用 `fs.openSync(path, 'r')` 打开，从不写入/截断/改名/删除 Lyricify 文件。
* **不启动、不停止、不重启 Lyricify Fusion**，不启动 Apple Music，不改任何播放状态。
* **不修改 Lyricify Fusion 的任何设置**（含日志等级）；不重装、不修复、不初始化、不迁移数据。
* 不读 `Settings.json` / token / cookie / 歌词缓存库等与时间轴无关的个人数据。
* 采集输出与游标写入前校验：必须是本仓库目录内的路径，否则拒绝写入。
* 默认只跟新增内容；历史基线必须显式 `--backfill-bytes` 且有界。
* Ctrl+C / SIGTERM 正常退出并保存游标；不安装服务、不写计划任务、不自启。
* 内存有界（统计 ring + dedupe 上限），输出有界（JSONL 大小轮转）。

## 观测数据说明（重要）

Lyricify Fusion 当前版本**不输出播放位置时间轴**。实测：

* 没有 `hh:mm:ss` 形式的播放位置显示值（三个日志共 48,486 行，命中 0）；
* 没有原始 SMTC TimeSpan；
* 唯一的毫秒数值是 LastFM scrobble 事件里的 `playedMs`/`targetMs`，语义是
  **scrobbler 累计播放时长**，不是 SMTC 原始 position（观测里以
  `rawPosition.semantics='scrobbler-accumulated-played-ms'`、`isRawSmtcPosition=false` 明确标注）。

因此本工具**不会**把 Lyricify 侧伪装成第二套逐帧时间轴，也不会把显示值补成
`47.000000` 秒当作原始精度。

详细侦察结论见 `docs/LYRICIFY_FUSION_TIMELINE_RECON.md`，
实测统计、5 个被修掉的缺陷与 Comparator 能力矩阵见 `docs/LYRICIFY_FUSION_TIMELINE_OBSERVATION.md`。

## TSP 侧数据从哪来（当前状态）

TSP 的 `[TSP]` 调试日志：**默认关闭**，并且只输出到渲染进程控制台（不落盘）。
本工具**不会自行开启**它。要获得真实对比数据，需要一次人工授权的动作（任选其一）：

1. 在 MineRadio DevTools 里执行 `smtcTspSetDebug(true)`，用 `smtcTspDump()` 导出 `[TSP]` 文本（会话级，不涉及 Lyricify）；
2. 或后续为 TSP 增加一个"只写本仓库目录"的文件 sink（需要改 MineRadio 代码）。

在没有上述数据之前，`--compare` 会正常给出**结构性**指标，并对绝对偏差类指标明确给出拒绝原因。
