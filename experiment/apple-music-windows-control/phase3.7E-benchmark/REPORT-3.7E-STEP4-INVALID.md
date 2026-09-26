# Phase 3.7E-④ — Baseline 运行结果：**正确性 20/20，但时间指标无效（harness 缺陷）**

**结论先写**：20 组全部执行、20/20 `stage=OK`、20/20 `targetPlaying=True`（**正确性有效**）。
**但 T3/T6/occupancy/total 这一组时间指标不可用**，原因是我 harness 的三个缺陷（下节）。
**不得**把这些数字当作 baseline（否则会得到"AM 抢前台 3.5–5.0 秒"的伪结论）。

原始数据：`reports/bench-20260926-084848.jsonl`（20 条，未改动、未重跑）。

---

## 1. 本轮**有效**的结果

| 项 | 结果 |
|---|---|
| 执行组数 | **20/20**（每首一次、`Retries 0`、无重试、无覆盖） |
| `stage` | **20/20 `OK`** |
| `targetPlaying` | **20/20 `True`**（SMTC 标题匹配目标曲目且 `Playing`） |
| 每首耗时（`t10`，仅供参考，见下） | 3.49s – 5.01s |
| 环境 | build 26200、AM 1.1540.23042.0、单显示器、AM 与用户同一桌面 |

→ **fixture（20 首钉住的 URL）与冻结链本身工作正常**：deep link → UIA → 双击 → SMTC 全部走通。

## 2. 本轮**无效**的结果（三个缺陷，含根因）

### 缺陷 A（最严重）：**每轮结束后的前台恢复失败** → 后续轮次的前置条件崩塌
```
每轮都打印：ENV CHANGED: originalForegroundHwnd 328138->196682
```
- `196682` 就是 **Apple Music 的 HWND**（空基线环境快照里 `appleMusicHwnd=196682`）。
- 即：第 1 轮之后，**`SetForegroundWindow(328138)` 没有成功**（Windows 前台锁：后台进程不能随意设前台），
  Apple Music 一直保持前台 → 第 2–20 轮的"运行前 AM 不是前台"这一前置**已不成立**。
- 直接后果：`T3` 变成**负数**（`t3=-1070…-1140ms`）——observer 在 T0 之前就采到"AM 已是前台"，
  因为**它在运行前就是前台**。

### 缺陷 B：**T6 判定退化** → `t6 = t3`
我的 T6 规则是"cursor 连续两拍不变且不同于原始坐标"；由于恢复光标也失败/未生效，
第一次采样就满足条件 → `t6_ms` 与 `t3_ms` 恒等，`activation_to_click_upper_bound` 因此无意义。

### 缺陷 C：`activation_to_click_upper_bound_ms` 字段语法错误
```
run-bench.ps1:182  -else : The term '-else' is not recognized ...
```
我在 `[ordered]@{}` 里写了 `$(if (...) {...} -else {...})`（**`-else` 非法**）→ 该字段未生成。

### 由此产生的连带失真
`foreground_occupancy_ms = T10 − T3`、`total_ms` 全部基于**负的 T3**，
所以它们≈`t10`（3.5–5.0s）**不代表真实前台占用**，只是"从 observer 更早的一次采样算到 T10"的差值。

## 3. 必须修的三处（修完才能重跑 ④；不修就不能给 baseline）

| # | 位置 | 修法 |
|---|---|---|
| A | `run-bench.ps1` 恢复前台那一步 + 每轮前置校验 | ① 若 `SetForegroundWindow` 未成功，**记录并停止**（不允许带着"AM 已前台"继续跑）；② 前置校验改为**硬门**：运行前 `appleMusicIsForeground` 必须为 false，否则该轮记 `INVALID_PRECONDITION` 并**不测**（不是继续跑）；③ 恢复失败的根因需处理（见下） |
| B | T6 判定 | 改为：T6 = **冻结链返回后**从样本里取"cursor 首次到达并稳定在**非原点**的新位置"的最后一拍；并且要求 `T6 >= T3`（否则置 `null`，宁缺勿假） |
| C | `run-bench.ps1:182` | `if (...) { } else { }`（去掉 `-`），并在字段缺失时显式写 `null` |

**关于 A 的根因（需你决策，不在本轮自作主张）**：`SetForegroundWindow` 从后台进程调用常被 Windows 拒绝。
两条可选路线都需要你同意，因为都触及"实验环境"而非冻结链：
1. **每轮之间由你手动把前台切回 Edge**（最干净、零代码语义变化，但要人工介入 20 次）；
2. 改为"**每组之间强制一次手动确认**"的半自动模式：脚本跑一组、暂停、等你切回前台并按回车，再跑下一组。
（不采用：`AttachThreadInput` / `AllowSetForegroundWindow` / `LockSetForegroundWindow` —— 这些是已关闭路线。）

## 4. 下一步（我的建议）

1. 先按第 3 节修 A/B/C（**只改 harness，不碰冻结链/fixture/resolver**）；
2. A 的路线请你在上面两选一（推荐 **1**）；
3. 修完先跑 **1 组**（`-Case B01`）确认：`T3 >= 0`、`T6 > T3`、`occupancy` 非零且合理、`restoreForeground=ok`；
4. 确认后再跑 `-All` 产出真正的 baseline；
5. 仍然**只做 baseline，不解释 500ms**；解释留给 ⑤（`am-uia:245` 500→0 的同 20 首对照）。

## 5. 纪律

20 组已执行完毕、**未重跑、未覆盖**；`-Retries 0`；未改冻结链 / resolver / fixture / SMTC / timeout / observer 间隔；
未碰已关闭路线；未提权。**本轮唯一改动**是 ④ 前的 `bench-common.ps1:51`（`AmVd.Native::GetWindowThreadProcessId`），
与你批准的一致。
