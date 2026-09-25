# poc/ — playSong(title, artist?) 实验能力

把第一阶段的 UIA 精准播放 PoC 封装成可复用、可测量的能力。**不接主线、不改 main 业务代码、无新增依赖。**

完整结果与结论见 `../findings/poc/PHASE2-REPORT.md`。

## 快速使用

```powershell
# 播一首歌（推荐：调用方给出歌曲页 URL）
powershell -ExecutionPolicy Bypass -File poc\play-song.ps1 -Title "Shape of You" -Artist "Ed Sheeran" `
  -Url "https://music.apple.com/us/album/shape-of-you/1193701079?i=1193701392" -PauseFirst -Retries 1 -Human

# 冻结/验证测试歌曲（每首实播一次并回填真实 SMTC 串）
powershell -ExecutionPolicy Bypass -File poc\discover-songs.ps1

# 60 次核心可靠性统计（3 首 × 20 次）+ 生成 md/csv/jsonl
powershell -ExecutionPolicy Bypass -File poc\stability-test.ps1 -Runs 20 -Retries 1

# 环境/边界场景（与上面的统计分开）
powershell -ExecutionPolicy Bypass -File poc\scenario-test.ps1
```

`play-song.ps1` 输出一行 JSON；`-Human` 同时打印可读摘要。

## 两种定位模式

| 模式 | 触发条件 | 动作 |
|---|---|---|
| `deeplink`（主用，实测 95%） | 给了 `-Url` | 打开 URL（导航**不算**成功）→ 页面上出现标题匹配的曲目行 → realize（必要时滚动/可视性校验）→ 行左侧安全区合成双击 → SMTC 校验 |
| `search`（回退，实测 0%） | 没给 `-Url` | 搜索框输入标题 + Enter → 候选打分（title 主、artist 辅）→ 激活最佳结果导航 → 页面上双击曲目行 → SMTC 校验 |

搜索视图**不能直接起播**：卡片点击是导航、歌曲行常常未渲染、侧栏会覆盖结果左列。详见报告第 10 节。

## 阶段码

| 阶段码 | 含义 |
|---|---|
| `APP_NOT_RUNNING` | 进程不存在且启动/等窗口失败（30s） |
| `AM_UI_NOT_FOUND` | 拿不到 UIA 根元素 |
| `SEARCH_FAILED` | 搜索框打不开/无法输入（仅 search 模式） |
| `RESULT_NOT_FOUND` | 页面/结果里没有标题匹配的行（或行始终拿不到几何） |
| `REALIZE_FAILED` | 行元素的 BoundingRectangle 始终为空（未渲染/窗口无几何） |
| `BOUNDS_INVALID` | rect 异常（过小/越出虚拟屏） |
| `OUT_OF_VIEW` | rect 有效但滚动后仍在窗口可视区之外（覆盖率<0.7 或点击点不在客户区） |
| `CLICK_FAILED` | 合成输入失败 |
| `SMTC_TIMEOUT` | 点击后**一直没进入 Playing**（点击没生效） |
| `SMTC_WRONG_TRACK` | 进入 Playing 但曲目不对（点了别的版本/别的内容） |
| `PRECONDITION_PAUSE_FAILED` | 用了 `-PauseFirst` 但会话始终停在 Playing |

成功判定**只看 SMTC**：`PlaybackStatus=Playing` 且标题匹配（给了 artist 时 artist 也要匹配，artist 会对 `歌手 — 专辑` 形式做包含匹配，CJK 允许繁简字符重叠）。

## 实测结果摘要（2026-09-25）

- 60 次（A/C 深链 + B 搜索）：**38/60 = 63.3%**；只看深链模式 **38/40 = 95%**
- 成功端到端：mean 2598ms / **median 1811ms** / p95 9493ms / max 9923ms；SMTC 确认段 median **142ms**
- 自动启动：可用（拉起 725ms）
- **需要前台**：跳过置前台时点击无效（S10 实测 13.5s 超时）
- 最大风险：搜索视图不可用于播放 + URL 按店面分配（跨店面链接会被忽略或指向别曲）

## 安全边界

官方 UI Automation + 官方 SMTC + user32 合成输入。不做逆向、不注入、不读写进程内存；不处理 Apple ID 口令/Cookie/media-user-token；不触碰 DRM。URL 解析只在实验期使用公开的 iTunes Search API（无需凭据），结果冻结进 `songs.json`，**运行时不需要网络**。
