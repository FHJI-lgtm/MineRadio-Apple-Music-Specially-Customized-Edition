# Phase 3.7E-③ — 测量能力与空轮询基线（已实测）

**状态：测量能力就绪；本阶段唯一未跑的是 ④ 的 20 组 baseline（需要你确认后开跑）。**
产物：`run-bench.ps1`、`lib/bench-common.ps1`、`reports/empty-baseline-20260926-084630.txt`。

---

## 1. 空轮询基线（真实测量，非估计）

```
build=26200    appleMusicVersion=1.1540.23042.0    monitors=1
activeDesktopIdProxy = appleMusicDesktopId = 7a8a789c-3926-4cb9-807f-dc11278c2841
appleMusicIsOnCurrentDesktop = True
originalForegroundHwnd = 328138    originalCursor = 2420,662

samples = 255    gapMean = 82ms    gapMedian = 80ms    gapMax = 121ms
```

**测得分辨率声明（写进此后所有报告）**：

> **poll 请求 50ms → 实测采样间隔 median 80ms / mean 82ms / max 121ms。**
> 因此 T 值有效粒度 ≈ **80ms（最坏 121ms）**：
> **median/P90 有意义；单次 min 只能理解为观测下界；T5/T6 仅近似；T7 不可得、绝不伪造。**

这条比"50ms observer"精确得多——**requested poll ≠ 有效分辨率**，采样本身（含 SMTC 读取）约 30ms 开销。
20 组 baseline 里的 `activation_*` 必须按这个粒度解读，任何"精确到毫秒"的表述都不成立。

## 2. harness 结构（与冻结链的关系）

```
run-bench.ps1
├─ -Observer        独立进程采样器（每拍：AM 窗口/前台/cursor/SMTC），写 .samples
├─ -EmptyBaseline   只跑采样器 N 秒 → 上文分辨率（已执行）
├─ -Case <id>       单首一次
└─ -All             20 首各一次（④）
```

- 冻结链：**只调用** `Invoke-AmPlaySong`（URL 由钉住的 fixture 提供），**零修改**；
- 内部计时：直接**读返回值** `t.*`/`a.*`、`contentMatchMs`、`navigated`（高精度、进程内）；
- 外部计时：`T3`（AM 首次成为 foreground）、`T6`（cursor 稳定在目标点的近似）、`T8/T9`（SMTC 首次命中目标+Playing）、`T10`、`T11`；
- **T7 不产出**；报告里只有 `activation_to_click_upper_bound_ms = T6 - T3`（字段名即带 `upper_bound`）；
- 每轮结束按阶段许可**恢复原前台窗口与光标**（`SetForegroundWindow` / `SetCursorPos` 仅用于恢复，
  且记为 `restoreForeground` / `restoreCursor` 结果）；
- 每轮先做**环境漂移检查**（foreground/cursor/desktop/AM desktop/monitor），任何漂移记为 `envMismatch`；
- 每首一次，失败**只记录、不覆盖、不重试**（`Retries 0`）。

## 3. 已知 harness 缺陷（1 处，开跑 ④ 前修）

- `bench-common.ps1:51` `GetWindowThreadProcessId` 调用在 `AmNav.Native` 上不存在 → 于是
  `originalForegroundProcess` / `foregroundProcess` 为空（**`originalForegroundHwnd` 正常 = 328138**，恢复不受影响）。
- 影响面：仅"前台进程名"这一项字段缺失（你字段清单里有它），**不影响 Foreground Occupancy 计算**。
- 处理：开跑 ④ 前**只改这一处**（换成存在该 P/Invoke 的类型，或本 lib 自带声明），其余不动。

## 4. ④ 运行方式（确认后执行）

```powershell
.\phase3.7E-benchmark\run-bench.ps1 -All
```

跑前环境要求（与 3.7D 同）：**AM 在 Desktop 1、非最小化、非前台**（前台建议 Edge）；
20 组期间不得改桌面/窗口/显示器。产出：
`reports/bench-<stamp>.jsonl`（每首一行，含 `t3_ms / t6_ms / t_smtc_ms / t10_ms /
foreground_occupancy_ms / activation_to_click_upper_bound_ms / total_ms / internal.* / actions.* /
stage / stageDetail / matchedRow / clickRecomputed / restoreForeground / restoreCursor / envMismatch / targetPlaying`）。

## 5. 报告口径（已锁定，不再改 harness）

- 主指标：**Foreground Occupancy = T10 − T3**，给 **median / P90 / min / max**（并声明 min 为下界）；
- 分解：`AM → UIA ready`、`UIA → interaction upper bound (T6−T3)`、`interaction → SMTC`、`SMTC → 恢复前台`；
- `Total = T10 − deep link 发出`；
- 单列 `navigateMs` / `contentMatchMs` / `a.clickMs` 等内部值与 500ms 固定 sleep 的关系；
- 失败必须带 `failureStage`（UIA / Realize / Click / SMTC），**不得**在 ⑤ 之前用它解释"500ms 是否承担同步"。

## 6. 纪律

本轮**未跑播放**（空基线不含任何 deep link / 点击）；未改 resolver / A-uia / 播放 / SMTC；
未改 fixture（20 首已钉死）；未碰已关闭路线；未提权；无循环压测。
