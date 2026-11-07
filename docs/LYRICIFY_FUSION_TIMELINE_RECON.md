# Lyricify Fusion 时间轴观测 · 只读侦察报告

> 阶段：第一阶段（只读侦察）。**本阶段未对 Lyricify Fusion 做任何写入、配置修改、进程操作。**
> 产品新名称统一使用 **Lyricify Fusion**；下文中出现的 "Lyricify Lite" 一律是磁盘上/进程里实际存在的旧名称，属于观测事实，不做改名。

## 1. 运行中的进程

| 项目 | 观测值 |
|---|---|
| 进程名 | `Lyricify Lite`（PID 35648，观测时刻） |
| 可执行文件 | `C:\Program Files\WindowsApps\63265WXRIW.193470E81A0DE_1.3.1.0_x64__8ybqz4qm5hwha\Lyricify Lite\Lyricify Lite.exe` |
| 安装形态 | MSIX 包（PackageFamilyName `63265WXRIW.193470E81A0DE_8ybqz4qm5hwha`） |
| 启动时间 | 2026-10-06 08:05:35 |
| 命令行 | 仅可执行文件路径，无可用于控制的外部参数 |

结论：**正在运行**，且运行期间未做任何干预（未重启、未结束、未附加调试器）。

## 2. 日志位置（唯一权威来源）

```
%APPDATA%\Lyricify\Lyricify Lite\Logs\
  Log.txt          5,097,767 B   最后写入 2026-10-06 15:45:37
  Log.Lyrics.txt   1,620,516 B   最后写入 2026-10-06 16:57:49（观测窗口内仍在增长）
  Log.LastFM.txt     646,338 B   最后写入 2026-10-06 16:57:49（观测窗口内仍在增长）
```

- MSIX 包目录 `...\Packages\63265WXRIW...\{RoamingState,LocalCache}` 是指向上述真实路径的重定向入口，深度 ≤3 扫描没有发现第二套日志。
- MSIX 包目录下不存在其他 `.log/.txt/.jsonl` 文件。
- 同级的 `...\Lyricify\Lyricify for Spotify\Logs\` 属于**另一个应用**，不在本次观测范围。
- `LyricsCatalog.db`（歌词缓存库）**未被读取**，属于用户数据，不在观测范围。

## 3. 是否实时追加

| 观测 | 结果 |
|---|---|
| 90 秒窗口内字节增量 | `Log.Lyrics.txt` +138 B、`Log.LastFM.txt` +196 B、`Log.txt` +0 B |
| 新增行数 | 两个文件各 1 行（一次切歌） |
| 轮转情况 | 无 .1/.old/.bak；`Log.txt` 自 2026-03-01 持续追加至今，无大小轮转 |
| 编码 / 行尾 | UTF-8 **无 BOM**，CRLF，文件始终以换行符结尾 |
| 时间戳格式 | ISO-8601 带 7 位小数（100ns 精度）+ 本地时区，例如 `2026-10-06T17:01:51.0317442+08:00` |

**追加规律（关键）**：Lyricify Fusion 只在**事件发生时**写日志，稳定播放期间**没有任何周期性写入**。因此不存在"每秒一个采样点"的时间轴日志。

## 4. 三个日志各自的职责与精度

| 文件 | 实际内容 | 与时间轴的关系 |
|---|---|---|
| `Log.txt` | 应用事件（App starting/exiting、Finished App loading）+ 异常。含 **5,661 条** `[<AUMID>] Error in OnAnyTimelinePropertyChanged Invoke`（其中 5,654 条集中在 2026-05-03 一天）与 14 条 `Error when getting PlaybackInfo` | 能看到它自己的 SMTC 时间轴回调**报错**，但**没有任何 position/duration/播放状态数值** |
| `Log.Lyrics.txt` | `[Search Track]` 歌词检索记录（标题/艺人/专辑/匹配等级/来源 ID），11,798 行 | 只有歌曲身份与检索时序 |
| `Log.LastFM.txt` | scrobble 状态机：`Reset scrobble state: reason=Track/Session, key=<AUMID>|metadata|<title>|<artist>|<album>`（3,356 条）、`Scrobble trigger: ... playedMs=<n>, targetMs=<n>`（99 条）、`Scrobble failed`（99 条） | 唯一带毫秒数值的位置数据：**playedMs / targetMs**，且只在跨过 scrobble 阈值时打印一次 |

### 4.1 精度普查（对全部 48,486 行逐行扫描）

| 检索项 | Log.txt | Log.Lyrics.txt | Log.LastFM.txt |
|---|---|---|---|
| 形如 `hh:mm:ss` / `mm:ss` 的**播放位置显示值** | 0 | 0 | 0 |
| 原始 TimeSpan / `Position=` 数值 | 0 | 0 | 0 |
| `playedMs=` / `targetMs=` 毫秒数值 | 0 | 0 | 99 / 99 |
| "Pause/Resume/Playing/Stopped/Seek/currentTime" 关键字 | 0 | 0 | 0 |

`Log.txt` 里 5,659 处 "Position" 全部来自异常堆栈里的方法名 `PlaybackInfo.SetPosition(...)`；
`Log.Lyrics.txt` 里 12 处 "Position" 是歌名《positions》(Ariana Grande)。

**结论：当前安装的 Lyricify Fusion 版本不输出播放位置时间轴。** 既没有秒级显示值，也没有原始 SMTC TimeSpan。
它可被只读观测到的"时间轴相关事实"只有三类：

1. 时间轴回调异常事件（带 100ns 时间戳 + 异常类型）；
2. 轨道/会话切换事件（带 100ns 时间戳 + 歌曲身份）；
3. scrobble 阈值事件携带的 `playedMs`（毫秒，但语义是**scrobbler 累计播放时长**，不是 SMTC 原始 position）。

## 5. 与任务文档假设的差异（必须先说明）

任务文档提到"如果日志只打印 `00:00:47`，应记录为秒级显示值"。实测**连这种显示值都不存在**。
因此本工具的能力边界必须诚实声明：

- ✅ 可以做：只读增量采集、事件级时间轴、身份切换时序、异常事件时序、`playedMs` 精度标注、实时统计、与 TSP 事件对齐。
- ❌ 不能做：把 Lyricify 侧当成"另一条逐帧 position 时间轴"与 TSP 逐点求绝对偏差——**没有那种数据**。

## 6. 安全边界（本工具的实现约束）

允许：只读打开上述 3 个文件、读元数据、读进程信息、在 MineRadio 项目目录写采集器/状态/输出/报告。

禁止（已在代码中落实）：写/删/改名 Lyricify 文件；改设置或日志等级；启动/停止/重启 Lyricify；注入/挂调试器；写 Lyricify 目录下的任何文件；采集 tokens/cookies/账号数据（`Settings.json`、`Cache\Text\Tokens`、`LyricsCatalog.db` 一律不读）；为了好解析而截断/清空日志。

## 7. 需要人工授权的后续操作

1. **让 Lyricify Fusion 输出更细的时间轴日志**：需要改它自己的日志等级/调试开关 → 违反只读约束，**未执行，也不建议执行**。
2. **让 MineRadio TSP 落盘观测流**：TSP 的 `[TSP]` 调试日志默认关闭，且只输出到渲染进程 Console（不落盘）。
   打开它需要一次显式动作（DevTools 里执行 `smtcTspSetDebug(true)`，或后续授权新增文件 sink）。
   本次**未开启**，Comparator 只提供"读取既有观测文件"的只读入口，等授权。
