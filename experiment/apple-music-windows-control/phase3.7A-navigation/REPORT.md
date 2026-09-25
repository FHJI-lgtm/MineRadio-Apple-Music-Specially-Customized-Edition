# Phase 3.7A — Navigation Investigation 报告

**PHASE_3_7A_STATUS = ROOT_CAUSE_FOUND**

冻结链路零改动：`poc/lib/am-play.ps1`、`am-uia.ps1`、`am-smtc.ps1` 与 `phase3-resolve/*` 均未修改（本阶段所有代码在 `phase3.7A-navigation/`，不 dot-source 冻结库）。

---

## 1. E10 root cause

**分类：`NAVIGATION_ALREADY_SUCCEEDED_UIA_STALE`**

结论：`403037927` 的 URL **从未导航失败**。失败发生在 **UIA 观察层**——Phase 3.6 播放链在“判断页面有没有变”这一步得出“未变化”，于是在查找目标行之前就抛出了 `URL_NAVIGATION_FAILED`。

证据（全部可复现，见 `reports/matrix.json`、`reports/timeline-*.json`）：

| 证据 | 内容 |
|---|---|
| 同一个 URL 本次成功 | `E10-D1` = Phase 3.6 失败时用的**同一个 URL** → `NAVIGATION_OK_VISIBLE`，`pageChanged=True`，listItems **31 → 44**，页面文本同时出现 `Someone Like You` 与 `Adele` |
| 导航耗时 | 稳定页面（44 项 + 两个目标串）在 **T+1000 ms** 观测到；T+500 时页面处于过渡态（15 项）。即 < 1 秒完成导航 |
| 与冻结报告的对照 | 冻结报告写的是 `page unchanged within 12000ms (nav=AppleMusic.exe /url) listItems=44`——**44 项正是 E10 页面的形态**；即冻结链看到的就是 E10 页面，却判为“未变化” |
| 实验开始前的 app 状态 | 3.7A 第一次取快照（尚未发送任何 URL）时，窗口（当时 `iconic=True`）的树里**已经**有 `Someone Like You` + `Adele`，signature 正是 `162F19096C670B04`，即 E10 页面 |
| 窗口标题无用 | 所有页面（31/44/59/71 项）的窗口标题都恒为 `Apple Music` —— 任何“靠窗口标题判断页面”的实现都必然失效 |
| 导航幂等 | `E10-F2`（已在目标页）→ `pageChanged=False` 且目标文本可见，属正确行为 |

**未证明的部分（不编造）**：冻结检测器内部为何把两个不同页面判成同一个。最可能的结构性原因是“按树的形状/条目数做签名，而两个歌曲页形状相同”（E10 的前一个用例 E09 是另一位 Adele 歌曲页，同样 ~44 项）。本阶段**没有**读取或修改冻结代码，因此这只是待验证假设，不是结论。要证实只需比较同一冻结函数在两个 44 项 Adele 页面上的取值。

## 2. Control group 对比（同一仪器、同一流程）

| case | 歌曲 | verdict | pageChanged | listItems | firstChangeMs |
|---|---|---|---|---|---|
| CTRL-A | How Do I Make You Love Me? | NAVIGATION_OK_VISIBLE | True | 44 → 31 | 500 |
| CTRL-B | 晴天 | NAVIGATION_OK_VISIBLE | True | 31 → 59 | 0 |
| CTRL-C | Shape of You | NAVIGATION_OK_VISIBLE | True | 59 → 31 | 0 |
| E10-D1 | Someone Like You | **NAVIGATION_OK_VISIBLE** | True | 31 → 44 | 0 |

E10 与已验证成功的 A/B/C **没有行为差异**：调用方式、等待策略、UIA 根、目标定位、超时、日志全部相同（`nav-experiment.ps1` 一套代码走完所有 case）。

## 3. URL / storefront 实验结果（D 轴）

| test | URL | storefront | invocation | verdict | 终点 signature |
|---|---|---|---|---|---|
| E10-D1 | `/cn/song/someone-like-you/403037927` | cn | `/url` | OK_VISIBLE | `162F19096C670B04` |
| E10-D2 | `/cn/song/test/403037927`（**假 slug**） | cn | `/url` | OK_VISIBLE | `162F19096C670B04` |
| E10-D3 | `/us/song/someone-like-you/403037927` | us | `/url` | OK_VISIBLE | `162F19096C670B04` |
| E10-D4 | `/tw/song/someone-like-you/403037927` | tw | `/url` | OK_VISIBLE | `162F19096C670B04` |
| E10-D5 | `/cn/song/403037927`（无 slug） | cn | `/url` | OK_VISIBLE | `162F19096C670B04` |
| E10-D6 | `/cn/album/someone-like-you/403037872?i=403037927` | cn | `/url` | OK_VISIBLE | `162F19096C670B04` |

**结论**：Apple Music Windows **依赖 song id**，不依赖 slug；cn/us/tw 三种 storefront 与三种 URL 形式都落到**同一个页面（signature 完全相同）**。因此 E10 **不存在** storefront sensitivity，也不存在 slug 依赖——`NAVIGATION_STOREFRONT_ISSUE` / `NAVIGATION_URL_REJECTED` 均被排除。

## 4. UIA tree 观察结果

- 目标页：**44 个 ListItem**，全部 44 个可枚举；`ScrollItemPattern = 20/20`、`SelectionItemPattern = 20/20`、`InvokePattern = 5/20`、`VirtualizedItemPattern = 5/20`（对前 20 个 ListItem 采样）
- 页面识别可行：**文本命中**（`Someone Like You` + `Adele`）与**名称签名**都能区分页面；窗口标题不能
- 过渡态：导航后 ~0.5 s 内页面处于过渡态（15 项、无目标文本），1 s 时已稳定 —— 检测窗口若只在一个固定时刻取样会误判
- 该 UIA 观察本身不涉及点击/播放，`E10-F2` 证明“已在目标页”时不会误报为失败

## 5. invocation 差异（E 轴）

| 方式 | 命令 | 结果 |
|---|---|---|
| `AppleMusic.exe /url "<URL>"` | `Start-Process -ArgumentList @('/url',$Url)` | started=True，退出码 **0**，导航成功 |
| ShellExecute | `Start-Process "<URL>"` | started=True，**同样成功**，终点 signature 相同 |

两种方式都能触发导航，位置/时序无可观测差异；启动器进程均为“交接后立即退出（exitCode=0）”，与单实例行为一致。

## 6. 是否存在 Apple Music 状态依赖（F 轴）

| 状态 | case | 结果 |
|---|---|---|
| 先播着另一首歌（控制曲 C 页面）再发 E10 URL | E10-D1…D6、E1 | 全部成功 |
| 先在 Adele 艺人页附近（71 项）再发 E10 URL | E10-F1 | 成功（71 → 44） |
| 不做任何准备（app 停在任意状态） | E10-F2 | 目标已在页面上 → `pageChanged=False`，仍判为正确 |
| **窗口处于最小化时发送 URL** | 追加实验 | **成功**：`ShowWindow(SW_MINIMIZE)` 后立即调用 URL，2 s 内 app 自行恢复窗口并切到 E10 页面（44 项 + 两个目标串） |

→ 未发现任何“Apple Music 当前 UI 状态吞掉导航”的证据；最小化也不能阻止导航。

## 7. 最小修复方案（**未实施**，按 K 条规则先报告）

修复点不在 URL 层，而在冻结 `poc/lib/am-play.ps1` 的**深链导航判据**。建议（待批准，不自行修改）：

1. 把“页面是否已切换”的判据从**结构性签名**改为**内容判据**：在等待循环里直接检测目标标题/艺人文本（本阶段已证明该文本可稳定读到，44 项页面 1 s 内出现），或同时使用“标题+艺人命中”与“签名变化”两个条件取或；
2. 取样时机：至少区分“过渡态”（本例 T+500 时 15 项、无目标文本）与“稳定态”（T+1000 后），避免在过渡态下结论；
3. 不缩短超时、不改 SMTC 判定、不改匹配标准；修复后必须重跑 **E10 + A/B/C** 与 Phase 2 冻结回归 15/15。

（另有一条与本次结论无关的观察：窗口标题恒为 `Apple Music`，任何基于标题的页面判断都不可靠。）

## 8. 修复前后耗时

| 项 | before（Phase 3.6 冻结链） | after（3.7A 实测导航层） |
|---|---|---|
| E10 导航结果 | `URL_NAVIGATION_FAILED`，`page unchanged within 12000ms` | 稳定页面在 **T+1000 ms** 出现，过渡态 T+500 |
| E10 端到端 | 35502 ms（超时 + 重试），E2E 失败 | 导航层 < 1 s（未接播放，本阶段不主张 E2E 数字） |
| 对照曲 | A/B/C 各 ~4.4–6.7 s（含播放） | 导航 < 1 s，行为一致 |

## 9. A/B/C regression

- 本阶段 A/B/C 与 E10 使用**同一套实验代码**：4/4 `NAVIGATION_OK_VISIBLE`
- 冻结播放链路未被调用也未被修改：`git diff` 对 `poc/lib/` 为空（提交时校验）
- Resolver 未改：`phase3-resolve/lib/resolve35.ps1`、`version36.ps1` 无改动；旧 20 例回归数字不受影响
- Analyzer 未改：`poc/analyze-e2e.ps1` 指标定义保持 Phase 3.6 状态

## 10. 是否建议进入 Phase 3.7B

**建议：先批准并实施第 7 节的最小修复，再进入 3.7B。**

理由：E10 的根因已经落到具体一层（冻结链的页面切换判据），修复是局部且可验证的；而 3.7B（No-Mouse Activation）要在同一个判据之上工作，如果页面切换判据仍会把成功当失败，3.7B 的结论也会不可信。若你希望并行，3.7B 可以在实验目录内独立开展，但不得依赖冻结链的页面判据。

---

## 附：证据文件

- `reports/matrix.json` / `matrix.md` —— 12 个 case 的完整矩阵（含调用参数、退出码、签名、条目数、首变时刻）
- `reports/E10-navigation-timeline.json` / `.txt` —— E10-D1 的 T+0/250/500/1000/2000/4000/6000/8000/12000 时间线
- `reports/timeline-<case>.json` —— 每个 case 的完整快照（pre / invocation / 逐点 UIA+SMTC / 窗口状态）
- `reports/run-log.txt` —— 整轮运行的原始日志
