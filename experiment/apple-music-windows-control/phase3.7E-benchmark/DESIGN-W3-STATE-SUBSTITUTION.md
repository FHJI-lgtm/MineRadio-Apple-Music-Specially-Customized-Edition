# W3 State-Substitution 设计（只读文档，未改代码、未跑实验）

**定位**：W3 是**状态替换实验**，不是"删 350 ms"实验。
把"固定等待 350 ms"替换为"等待一个可观测状态成立"，并让状态未成立时的行为从"照常点击"变成"安全失败"。

**状态**：本文档只做设计。**不改 `poc/lib`（frozen chain）任何一行，不跑任何实验。**
**前置依据**：`CONTROL-PLANE.md` §7（固定等待吸收原则 / 一次一个等待）、`AUDIT-5WAITS-5Q.md`（五问审计，W3 = `am-uia.ps1:517`）。

---

## 1. 现状与语义假设

```powershell
# am-uia.ps1, Invoke-AmRowPlay (行 511-541)
if (-not $NoForeground) {
  Invoke-AmForeground $Hwnd          # IsIconic ? ShowWindow(SW_RESTORE) ; SetForegroundWindow
  Start-Sleep -Milliseconds 350      # ← W3
}
if ($Element) { ... 重读 BoundingRectangle、重算安全点击点 ... }   # 行 522-531
[void][AmUiaNative]::SetCursorPos($usedX, $usedY)
Start-Sleep -Milliseconds 200        # ← W4
mouse_event(down); mouse_event(up); Start-Sleep -Milliseconds 130; mouse_event(down); mouse_event(up)   # ← W5
```

W3 的隐含语义假设是：**调用 `SetForegroundWindow` 之后，经过 350 ms，前台状态与布局都已稳定，可以安全读取几何并点击。**

这条假设里其实混了两件事，本设计的第一个贡献就是把它们分开：

| 假设 | 内容 | 是否可直接观测 |
|---|---|---|
| **S1 前台** | 目标窗口已经是前台窗口 | **可**：`GetForegroundWindow() == $Hwnd`（只读 user32 查询） |
| **S2 布局** | 目标行的 `BoundingRectangle` 已稳定，点击点计算后不会再移动 | 不直接可观测；现有代码的替代品是"重读并与前台前读数比较" |

### 1.1 现有数据对 S2 的只读预判（不改代码、不新跑实验）

benchmark 行里已存在 `clickRecomputed`：它正是"前台调用**之后**重读几何，与前台调用**之前**的读数不一致"。
读取 ④/⑤/⑥ 三份原始 JSONL（只读）：

| 运行 | `clickRecomputed=true` | 曲目 | 这些曲目的 stage |
|---|---|---|---|
| ④ `bench-20260926-090320` | **4/20** | B03, B08, B14, B16 | 全部 `OK` |
| ⑤ `bench-20260926-090905` | **6/20** | B01, B03, B06, B15, B16, B20 | 全部 `OK` |
| ⑥ `bench-20260926-092741` | **7/20** | B01, B03, B06, B08, B11, B14, B16 | 全部 `OK` |

读法（严格）：**约 1/3 的运行中，前台调用之后的几何与之前不同**；B03 与 B16 三次运行全部 recomputed。
同时注意现有实现**并不等待布局稳定，而是重读并重算**（`recomputed=True` 的曲目照样 `OK`）。

结论（两条都必须写进解读）：

1. S1 与 S2 **不是同一个状态**，350 ms 可能在替 S2 兜底而不只是替 S1。
2. 现有数据**不能**回答"350 ms 结束时 S2 是否已稳定"——`clickRecomputed` 只说"相对于前台前的读数变过"，不说"已经不动了"。
   本设计不假装它回答了这个问题。

---

## 2. 候选替换

```
deadline = T0 + 350ms                     # T0 = Invoke-AmForeground 返回的瞬间
loop:
    if GetForegroundWindow() == $Hwnd:    # S1 成立
        return SUCCESS
    if now >= deadline:
        return FOREGROUND_TIMEOUT         # 见 §3
    poll interval P
```

**唯一核心成功条件**：`GetForegroundWindow() == $Hwnd`。
不加入"看起来稳定"的条件（rect 两次相同、截图对比、UIA 状态等）——否则实验变量膨胀，违反 §7.2"一次一个假设"。
S2 若被证明才是关键，那是**下一次**实验的条件，不是本次的附加条件（见 §7 判定矩阵）。

**轮询实现约束**：
- 只用 user32 `GetForegroundWindow`，**不使用任何 UIA pattern 调用**（该链路已记录 UIA pattern 会 re-empty 矩形，属于有副作用的读）。
- `P` 是实验参数，必须与结论同时声明；`w3WaitMs` 的分辨率 = `P` + 调用开销。
  设计默认 **P = 10 ms**（实验要高分辨率）；若将来作为生产替换，应改用更粗的 `P`（25–50 ms）并重新声明分辨率。
- 本机**未测量** `GetForegroundWindow` 的单次调用开销；设计上它是只读 user32 查询、不注入输入、不触发 UIA，
  其开销由 `w3PollCount` 可见，不得用猜测值填进报告。
- 轮询期间不得有任何 `SetCursorPos` / `mouse_event` / `SendInput` / `SendKeys`（§4.5）。

---

## 3. timeout 不等于"继续"

这是本设计的安全核心，两个分支必须互斥：

```
GetForegroundWindow() == AppleMusic
        ↓
   读取几何 → 移动光标 → 点击        ✅ 原行为

deadline 到，前台仍不是 AppleMusic
        ↓
   不读取目标行
   不移动鼠标
   不滚轮
   不点击 / 不双击
   返回 W3_FOREGROUND_TIMEOUT        ✅ 安全失败
```

而不是：

```
350ms 到 → 不管前台是谁 → 继续点击    💀 盲点输入
```

后者正是 W2 审计里指出、并因此让 W3 暂缓的风险：benchmark 期间前台是操作者的 msedge，
盲点双击可能把输入注入到无关应用。

**超时值保持原值**：`deadline = T0 + 350 ms`。
因此本次改动是"**350 ms 固定等待 → 最多 350 ms 的状态等待**"，不是把上限延长、也不是缩短上限。
换句话说：本次实验**不允许**通过加长等待来换取"更容易满足"，那会同时污染延迟结论与安全结论。

---

## 4. 需要额外定义的东西

### 4.1 成功条件
`GetForegroundWindow() == $Hwnd`，且 `$Hwnd` 必须是**本次点击所用的那个窗口句柄**（`Invoke-AmRowPlay` 收到的 `$Hwnd`）。
不得改用"进程名匹配"或"标题匹配"。

### 4.2 timeout
严格 `350 ms`（与现状同值）。声明：`P` = 轮询间隔，`w3WaitMs` 分辨率 = `P` + 开销。

### 4.3 timeout 行为
返回 `W3_FOREGROUND_TIMEOUT`；不读目标行、不动鼠标、不点击。
**新失败码**，因此必须同时更新失败分类（否则 harness 会把它当 unexplained）：
- `run-bench.ps1` 的失败集合/聚合必须把它计入 failures；
- `poc/analyze-e2e.ps1` 的已知失败码清单必须收录它，且**不得**计入"explained false negative"；
- timeout 路径没有产生输入，benchmark 的 restore 步骤应记录为 ok（无东西需要恢复），**不得**因此报 restore failure。

### 4.4 观测指标（新增，落在现有 `a.*` 组，与 `a.clickMs` 同构）
| 字段 | 含义 |
|---|---|
| `w3WaitMs` | T0 → S1 成立的实测毫秒数（含最后一轮轮询的等待） |
| `w3PollCount` | 轮询次数（用于暴露 `P` 的开销与抖动） |
| `w3Satisfied` | S1 在 deadline 内成立 = true |
| `w3Timeout` | 到达 deadline 仍未成立 = true（此时 §4.3 生效） |

这些字段的意义：**直接回答"350 ms 里到底有多少时间真的在等 Apple Music 成为前台"**，
而不是再拿 350 ms 本身当收益估计（§7.1 的核心禁令）。

### 4.5 最重要的安全不变量
> **W3 未满足时，代码不得执行任何输入注入**：不移动鼠标、不滚轮、不点击、不双击。

该不变量必须**被测试**，而不是被声称——见 §6.2 负路径测试。

---

## 5. 设计前置问题（实现前必须有答案，否则实验会测到假超时）

| # | 问题 | 设计意图 |
|---|---|---|
| Q1 | `$Hwnd` 是 `Find-AmWindow` 得到的主窗口。Apple Music（WinUI 3）可能拥有多个顶层窗口（迷你播放器、对话框、浮层），前台句柄可能是其中另一个 | 需要决定比较口径：直接相等，还是 `GetAncestor(GetForegroundWindow(), GA_ROOT) == GetAncestor($Hwnd, GA_ROOT)`。**先做只读探测**（记录前台句柄与 `$Hwnd` 的关系，不改变行为），再定口径，避免把"合法的前台"误判为 timeout |
| Q2 | `SetForegroundWindow` **可能被 Windows 前台锁拒绝** | 若发生，本次实验会产出真实 `W3_FOREGROUND_TIMEOUT`。这正是"350 ms 是同步关键"的证据，**不得**被当成 bug 抹掉；但必须先排除 Q1/Q3 造成的假超时 |
| Q3 | 过渡期间 `GetForegroundWindow()` 可能返回 `0` 或属于 shell/上一个窗口 | 视为"未满足"，继续轮询；不得把 `0` 当作满足 |
| Q4 | 轮询期间 Apple Music 若再次被别的窗口抢前台 | 状态等待应继续等到 deadline；**不得**在 deadline 之后"补一次"继续执行 |
| Q5 | `-NoForeground` 分支完全不受影响 | 本次改动只落在 `if (-not $NoForeground)` 块内 |

---

## 6. 变更范围与验证

### 6.1 两个编辑域（必须分开记录，且 harness 改动必须是时序中性的）
| 域 | 文件 | 改动 | 约束 |
|---|---|---|---|
| A. frozen chain | `poc/lib/am-uia.ps1`（仅 `Invoke-AmRowPlay` 内 W3） | 350 ms 固定等待 → 状态等待 + 失败码 + 返回新字段 | **只此一处**；`W5`、`W4`、几何重读逻辑、点击序列一字不动 |
| B. benchmark harness | `phase3.7E-benchmark/run-bench.ps1`（及必要时的 lib） | 把 `w3*` 写入行 | **不得**在测量窗口内增加 sleep、UIA 调用或任何额外等待；只允许从 `AttemptResult` 读标量 |

**等价包络（等价性声明）——本次与 ⑤/⑥ 的性质差异**：⑤/⑥ 是"一个数字变化"，本次是"控制流变化"。因此必须显式声明：
- 保持不变：几何读取与点击点计算、光标移动、双击序列与间隔（W4/W5）、SMTC 校验、Resolve 层；
- 发生变化：① S1 成立即恢复执行（可能早于 350 ms）；② S1 未成立则安全失败（新失败码）。

### 6.2 负路径测试（验证 §4.5，复用 3.7B 既有审计，不新增实验设施）
用一个测试开关强制 `w3Timeout=true`（例如令条件恒假），然后断言在**不注入任何输入**的前提下返回失败：
- `cursorBefore == cursorAfter`（`Get-AmNmCursor`）；
- 由 3.7B `New-AmNmAudit / Compare-AmNmAudit` 得到 `mouseMoved=false`、`keyboardInjected=false`；
- 目标曲目 SMTC 状态不变（没有播放发生）；
- 静态扫描确认 timeout 分支内不存在 `SetCursorPos` / `mouse_event` / `SendInput` / `SendKeys` / `Cursor.Position`。

### 6.3 分阶段门（逐步放行，先安全后测量）
| 门 | 内容 | 通过标准 |
|---|---|---|
| G0 | 静态审查 | 改动只落在 W3；timeout 分支零输入注入（人工逐行 + 静态扫描） |
| G1 | Q1/Q2 只读探测 | 确定前台句柄口径；无"合法前台被误判"的路径 |
| G2 | 负路径测试（§6.2） | 强制 timeout 时审计三连成立、无输入注入、无播放发生 |
| G3 | 干跑（3 首，先不开点击） | `w3Timeout=0`，`w3WaitMs` 有分布；不出现假超时 |
| G4 | 正式实验（20 首，同夹具/同序/`Retries 0`） | 见 §7 判定矩阵 |

---

## 7. 观测与判定矩阵（含 §7.4 可分辨性声明）

**主终点**：`w3WaitMs` 的分布（S1 实际需要多久成立）。这是本次实验真正能高精度回答的问题，
且不需要靠 A/B 差值——它是对状态本身的直接测量。

**次终点**：`a.clickMs` / `t6` / occupancy 的 ④↔⑦ 配对差值。
**但这些不得作为主判据**：`CONTROL-PLANE.md` §7.4 已用 W2 证明本协议在 n=20、每首一次条件下
分辨不了几百毫秒量级的系统性效应（逐曲方差 ±500…±2000 ms）。因此 occupancy 只能作为参考，
差值为"不可分辨"时**必须写成不可分辨**，不得写成"无收益"。

| 观测结果 | 判定 | 处置 |
|---|---|---|
| `w3Timeout` = 0，`w3WaitMs` p90 ≤ ~120 ms | 350 ms 里**大部分是可回收的等待** | 有理由继续讨论替换（但仍需 §7.4 允许的手段去证明 latency 收益；不得引用 350 ms 本身当收益） |
| `w3WaitMs` 经常 ≥ ~250 ms | 350 ms **不是纯浪费**，它接近真实过渡时间 | 不缩短；记录"同步关键"归类 |
| `w3Timeout` > 0 且 Q1/Q2/Q3 已排除（真被拒） | 350 ms 是**同步关键** | 回退；按 §7.1 归类为 synchronization-critical |
| `w3Timeout` > 0 但由 Q1（HWND 口径）造成 | **实验无效** | 修条件定义后重跑，不得据此判定 wait 性质 |
| 失败集合变化 / 出现新失败码（除 timeout 本身） | correctness 或时序受影响 | 回退并记录原因 |
| `w3Satisfied=true` 但出现 `SMTC_WRONG_TRACK` 或点击偏移 | 350 ms 可能在替 **S2（布局）**兜底 | 回退本次替换；S2 作为**独立的下一次**实验（几何稳定条件），不并入本次 |

---

## 8. 非目标（明确写出，避免范围漂移）

- 不在本次实验里缩短 350 ms 上限（保持 350 ms）；
- 不把 W4（200 ms）/ W5（130 ms）并入；
- 不引入 S2（几何稳定）作为附加条件；
- 不用本次实验声称"节省了 X ms 用户可观测延迟"；
- 不在未通过 G0–G3 的情况下让代码接触真实点击。

---

## 9. 索引

| 项 | 文件 |
|---|---|
| 本文档 | `phase3.7E-benchmark/DESIGN-W3-STATE-SUBSTITUTION.md` |
| 五问审计（W3 条目） | `phase3.7E-benchmark/AUDIT-5WAITS-5Q.md` |
| 判据（§7 / §7.4） | `CONTROL-PLANE.md` |
| 只读取数所用数据 | `.../reports/bench-20260926-090320.jsonl`（④）、`...-090905.jsonl`（⑤）、`...-092741.jsonl`（⑥） |
| 目标代码位置 | `poc/lib/am-uia.ps1:511-541`（W3 = 行 517） |
| 负路径测试可复用审计 | `phase3.7B-uia-no-mouse/lib/instrumentation.ps1`（`New-AmNmAudit / Compare-AmNmAudit`） |

---

## 10. G1 只读探测结果（2026-09-26）与本设计的修订

结果报告：`phase3.7E-benchmark/REPORT-G1-W3-FOREGROUND-OBJECT.md`。
两轮观测 = 12 s 校验 + 300 s + 300 s；实测采样 gap median 15–16 / mean 16 / max 50–60 ms（`P=10 ms` 仅属探测协议）。

**§5 的 Q1 —— 观测范围内已有答案**

- Apple Music 有 **6 个顶层窗口**，且**每一个的 root 都等于自身**（彼此无父子关系）；`196682` 是"首个 visible 且有 title"的那一个，
  也正是 benchmark 一直报的 `hwnd=196682`。
- 22 次 AM 前台 episode（两轮共 4006 个 AM 前台样本）**全部**是 `foregroundHwnd == 196682`；
  `amProcessButNotDirectSamples = 0`、`rootEqualOnlySamples = 0`。
- 因此：**直接相等（`foregroundHwnd == targetHwnd`）是观测到的正确 S1 定义，不采用 `GA_ROOT` 归一化。**
  `GA_ROOT` 只有在"前台是 196682 的子窗口"时才会与直接比较不同，这类样本一个都没有出现。
- **仍未闭合的部分**：22 次全部由操作者产生（Alt+Tab / 任务栏 / 鼠标）。链路自己的
  `ShowWindow(SW_RESTORE) + SetForegroundWindow` **程序化过渡未被观测**（G1 被明确禁止激活）。
  要闭合它需要**单独授权**，因为它本身是一次激活。

**§5 的 Q3 —— 已从"防御性假设"变为实证**

前台**确实会经过 `hwnd=0`**：两轮共 5 个 null 样本，其中一次（15 ms）**紧接着就是 AM 成为前台**。
所以"`HWND == 0` ⇒ S1 NOT SATISFIED、不得当 wildcard、不得 fallback 到 root"是有数据支撑的规则。

**第二轮新增事实，直接修订 §4.4 与 §5**

- 在 2875 个"前台 = 196682"的样本里，有 **3 个样本同时 `IsIconic(196682) == true`**（都在本轮最早三次
  "恢复被最小化窗口"的激活上）→ **S1 不蕴含"已恢复、已布局"**。
- 修订 §4.4：新增指标 **`w3TargetIconicAtSatisfied`**（S1 成立瞬间目标的 `IsIconic` 状态）。**只记录，不改变条件。**
- 修订 §7：**`S1 AND NOT IsIconic($Hwnd)` 列为"已声明的候选条件"**，仅当 W3 实验出现失败、或出现可归因于
  "过早恢复"的点错行时才启用；**不得静默并入 S1**——那会变成"一次实验、两个假设"，违反 §7.2。
- run 1 的原始文件**没有** `targetIconic` 字段（该字段在第二轮之前才加入），因此 run 1 **不报告**该字段的任何计数。

**字段可靠性（随结论引用）**：`activeDesktop` 在 100 ms 刷新节奏下不可靠——run 1 `unavailable` 5.7% 且全零 GUID 6.6%，
run 2 `unavailable` 4.8%。`unavailable` 与全零 GUID 一律视为"无可用值"，**任何结论都不得把它们当作桌面身份**。

**2026-09-26 追加：Q1 已闭合（G1b 程序化过渡观测）**

经单独授权，执行了**一次**程序化过渡（`ShowWindow(SW_RESTORE)` + `SetForegroundWindow($Hwnd)`，
与链路 `Invoke-AmForeground` 同序；探针内禁止鼠标/键盘/滚轮/UIA/`SetCursorPos`/`SendInput`，修正版静态扫描全 0）：

- 调用前 `IsIconic(196682) = true`；`ShowWindow(...,9)` 返回 true；**`SetForegroundWindow` 返回 true**（调用本身 1 ms）
- **S1 在调用后的第一个采样点即成立**（t0+2 ms）；采样粒度 ~16 ms ⇒ 只能说"第一个采样点"，
  **不得表述为"程序化过渡耗时 2 ms"**（单次观测、单样本、无分布）
- 该瞬间 `targetIconic = false`；全程 `hwnd = 0` 样本 0；观测窗结束时前台仍是 196682
- ⇒ **Q1 闭合**：`S1 := GetForegroundWindow() == $Hwnd` 正式采用，**不采用 `GA_ROOT`**。
  累计证据 23 次激活（22 人手 + 1 程序化）、4509 个 AM 前台样本，`CASE_B = 0`
- `w3TargetIconicAtSatisfied` 保留为**指标**；`S1 AND NOT IsIconic($Hwnd)` **仍未采用**（避免一次实验两个假设）
- `SetForegroundWindow` 本次返回 true **不等于**它总会成功（Q2 作为一般性风险仍然开放；本次未触发）
- **W3 本体修改仍未授权**：G2（强制 `FOREGROUND_TIMEOUT` → 验证零输入注入）→ G3（3 首干跑）→ G4（20 首）顺序不变
- 披露：该次运行打印的探针内扫描块是**坏的**（3 个来自头部注释的假阳性、2 个数组拼接造成的假阴性），
  已在运行后修正并另存修正版扫描证据（`reports/w3prog-prog-20260926-095949-staticscan.txt`）；
  **探针未重跑**（只授权一次过渡），详见 `REPORT-G1b-PROGRAMMATIC-TRANSITION.md`
