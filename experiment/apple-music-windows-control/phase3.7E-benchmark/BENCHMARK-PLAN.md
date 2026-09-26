# Phase 3.7E — Foreground Occupancy Benchmark：方案与可观测性边界

## 0. 本轮先说清楚：**benchmark 尚未执行**

我**没有**跑这 20 组。原因不是时间，而是**测量能力**：你要求的 T3/T5/T6/T7/T10 里，
至少 4 个时间戳**无法在不修改冻结链的前提下从外部观测**（见第 3 节）。
若照现状"跑一遍"，产出的数字会把"未测量"混进"已测量"，这正是你明确禁止的。

因此本轮交付三件**确定可靠**的东西：
1. **歌单核对结果**（你给的清单里 **5 首违反你自己的规则**，已替换）；
2. **可执行的测量方案**（外部插桩 + 精度声明）；
3. **可观测性边界**（哪些时间戳可得、哪些必须改冻结链才行）。
以及：**你提出的"约 1 秒前台占用"这个前提，在本项目现有证据里并不存在**（见第 6 节 Q1）。

---

## 1. 歌单核对（`cases/songs-20.json`）

按你的规则第 2 条（不得使用历史已测曲目），你给的 20 首里以下 **5 首必须替换**：

| 你给的曲目 | 冲突来源 | |
|---|---|---|
| Ed Sheeran — Shape of You | Phase 2 对照曲 **C**、22 首审计 **E02**、单元 **U03/U04/U15**、版本矩阵 **M08/M17** | ❌ 替换 |
| The Weeknd — Blinding Lights | 22 首审计 **E04**、单元 **U12**、版本矩阵 **M10** | ❌ 替换 |
| Billie Eilish — bad guy | 22 首审计 **E06**、单元 **U13** | ❌ 替换 |
| Coldplay — Viva La Vida | 22 首审计 **E13**、版本矩阵 **M09/M20** | ❌ 替换 |
| （The Weeknd 重复占位） | 同上（Blinding Lights 已用） | ❌ 替换 |

**替换为**（均**未**出现在任何历史测试记录中）：`Anti-Hero / Taylor Swift`、`Flowers / Miley Cyrus`、
`Kill Bill / SZA`、`A Sky Full of Stars / Coldplay`（第 5 首由重复占位腾出，见 JSON）。

保留 16 首 + 替换 4 首 = **20 组**，覆盖 2003–2025、长度 short/medium、专辑各异，
并刻意包含一首带括号标题的（`we can't be friends (wait for your love)`）作为 resolver 压力样本。
**注意**：这 20 首**尚未做 CN storefront 可解析性验证**——正式跑之前必须先用 resolver
`-NoLookup` 之外的正常路径各解析一次，解析失败者按你的规则**记录跳过原因并换歌**，不得静默替换。

## 2. 测量方案（不修改冻结链）

**核心约束**：`Invoke-AmPlaySong`（Phase 2 / 3.7A 冻结）**一行不改**。因此插桩必须在**外部**：

```
t0  = 单调时钟起点
① 起一个 50ms 采样线程/循环（Stopwatch 单调时钟），每拍记录：
     - AppleMusic 顶层窗口是否存在（EnumWindows）        -> 提供 T2
     - GetForegroundWindow() 是否 == AppleMusic HWND     -> 提供 T3（首次为真的拍）
     - UIA 是否能取到窗口 + 目标行是否存在               -> 提供 T4
     - GetCursorPos()                                    -> 提供 T5/T6 近似
     - SMTC title/artist/status                          -> 提供 T8/T9
     - 每拍都带上采样序号与真实耗时（避免把轮询开销算进链路）
② 调用冻结入口一次（未改）
③ 冻结入口返回后，立即：
     - SetForegroundWindow(原始前台 HWND)                -> T10
     - SetCursorPos(原始鼠标坐标)                        -> T11
④ 停表，写 JSONL（每首一行）+ 汇总
```

**精度声明（必须写进结果）**：所有 T 值精度 = 50ms 轮询粒度 + 采样自身耗时；
因此 **p50/median 可信，单次极小值不可信**（min 只能作为"至少这么快"的下界）。
运行前先测一次"空轮询"基线，把采样开销从报告里单列出来。

## 3. 可观测性边界（关键诚实点）

| 时间戳 | 含义 | 外部可观测？ |
|---|---|---|
| T0/T1 | 测试开始 / deep link 发出 | ✅ 可 |
| **T2** | AM 窗口/HWND 确认 | ✅ 可（EnumWindows 轮询） |
| **T3** | AM 成为 foreground | ✅ 可（每拍比较 foreground HWND）——**最关键的那个** |
| **T4** | UIA 找到目标歌曲 | ✅ 可（外部跑一遍与冻结链同源的 `Select-AmCandidateWithGeometry`，只读） |
| **T5** | 鼠标开始移动 | ⚠ 近似（首次发现 cursor 变化那一拍，误差 ≤1 拍） |
| **T6** | 鼠标到达目标 | ⚠ 近似（cursor 首次稳定在目标点） |
| **T7** | 双击/点击完成 | ❌ **不可外部观测**。冻结链内部才有该时刻 → 标记 `NOT_OBSERVABLE_WITHOUT_MODIFYING_A_UIA`，用 T6 作上界近似 |
| **T8/T9** | SMTC 看到目标 / 确认 Playing | ✅ 可（每拍读 SMTC；T9 = 首次 status=Playing 且标题/艺人匹配） |
| **T10** | 恢复原始前台 HWND | ✅ 可（本实验自己执行恢复并打点） |
| **T11** | 鼠标恢复完成 | ✅ 可 |

→ 所以 `activation_to_click = T7 - T3` **无法严格给出**；报告必须写成
`activation_to_click_upper_bound = T6 - T3`（并注明 T7 不可得），**不得**把它当作 T7 的数字上报。

## 4. 允许的"优化"（本轮只列证据，不改冻结链）

你要求"不要用没有依据的固定 sleep"。已确认冻结链中**存在**的等待点（原始值，未改）：

| 位置 | 原值 | 依据 | 可否缩短 |
|---|---|---|---|
| 导航等待 `PageWaitMs` | **12000ms 上限**（轮询，非固定 sleep；命中即退出） | 3.7A 实测稳定页面 T+1000ms 出现 | 上限本身不影响成功用例（已提前退出），只需确认最慢用例 |
| 导航轮询间隔 | 300ms | 未知（无依据） | **候选**：可试 100ms，但需重跑成功率的证据 |
| `PauseFirst` 后 settles | 有固定等待 | 确保基线非 Playing | 需实测 |
| `-Retries` | 默认 2 | 无依据 | 只影响失败路径，不影响成功耗时 |
| 冻结链的 `Start-Sleep` 其他点 | 多处小值 | 未逐条审计 | **下一步单独做静态审计**（只读） |

**结论**：在**不改冻结链**的前提下，本轮**不能**给出"哪个固定等待可以安全删除"的确定答案——
需要先做一次**只读的等待点清单**（把 `poc/lib/*.ps1` 里所有 sleep/超时点列出来 + 各自依据），
再用本 benchmark 的数据判断哪些从未被触碰（例如成功用例的全部耗时分布都远小于该上限）。

## 5. 环境记录模板（跑之前先填）

`appleMusicRunning / applemusicLoggedIn / mineRadioForeground / originalForegroundHwnd+Process /
cursorX,Y / activeDesktopIdProxy / appleMusicHwnd / monitorCount / windowsBuild / appleMusicVersion`
—— 20 组期间不得改变（尤其不得切换桌面/窗口/显示器）。

## 6. 三个问题的当前诚实回答

**Q1：Foreground Occupancy 最低实际能达到多少？**
**现在无法回答**。更准确地说：**"当前约 1 秒"这个前提在本项目证据里不存在**——
3.7C Case A 与 3.7D Case A 都**没有**做"恢复原始前台"，因此**从未测量过 foreground occupancy**；
`foreground occupancy = T10 - T3` 是本轮**新引入**的量，必须先跑出 T3/T10 才有数字。
可用的**旁证**（不是 occupancy）：冻结链 SMTC 段 p50 **144ms**（22 首 E2E，`e2e-22-…-metrics.json`）；
点击后 SMTC 确认通常 < 500ms；导航稳定页 T+1000ms。→ 合理预期 occupancy 落在**数百毫秒到 1 秒量级**，
但这是**预期，不是测量**，报告中不得写成结论。

**Q2：前台占用主要消耗在哪里？**
同样**要先测**。按已测数据，最可能的顺序是：`AM 置前 → UIA ready（含导航 contentMatch ~1–3s 的前置段，
但那一段发生在置前之前）→ 鼠标移动+双击 → SMTC 更新（~150ms 级）→ 恢复前台`。
其中"恢复前台"目前**没有被实现**（这正是本实验要新增的最后一步），其耗时未知（`SetForegroundWindow` 在
Windows 上有前台锁与时间片限制，通常 10–100ms，但**未测**）。

**Q3：有没有明确的固定等待可以安全删除/缩短？**
**需要先做只读等待点审计**（第 4 节）。在拿到该清单与本 benchmark 数据之前，我不提出任何"缩短"建议——
按你的要求，只提证据，不在本轮大改代码。

## 7. 下一步（一次只做一件事）

1. **只读等待点审计**：把 `poc/lib/am-common|am-smtc|am-uia|am-play.ps1` 中所有 sleep / 超时点、
   原值、轮询结构、退出条件逐条列出（不改一行代码）；
2. **可解析性预检**：用正常 resolver 路径对 20 首逐一预解析，记录跳过原因，锁定最终 20 首；
3. **实现外部插桩 runner**（第 2 节方案）+ 空轮询基线；
4. **正式跑 20 组**（每首一次，失败记录不覆盖），产出你要求的表格与统计
   （mean / **median** / P90 / min / max，并单列 `activation_to_click` 的 upper-bound 说明）。

## 8. 纪律

本轮**未运行任何 benchmark**；未修改 resolver / A-uia / 播放逻辑 / SMTC 逻辑；
未碰 COM / Virtual Desktop / Z-order / 后台 UIA 等已关闭路线；未增加控制策略；
未改注册表或系统文件；未提权；无循环压测。
产物：`phase3.7E-benchmark/cases/songs-20.json`（歌单 + 历史冲突说明）、本文件（方案与边界）。
