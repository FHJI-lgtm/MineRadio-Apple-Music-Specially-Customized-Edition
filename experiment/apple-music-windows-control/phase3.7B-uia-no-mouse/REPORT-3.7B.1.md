# Phase 3.7B.1 — Instrumentation Repair + Remaining UIA Contract Probe

**PHASE_3_7B.1 = INSTRUMENTATION_FIXED（剩余 pattern 的最终结论待用修好的 JSONL 重跑一轮）**

3.7B 的总结论不变：**UIA 行级 activation contract 不可用**（`UIA_ACTIVATION_UNAVAILABLE`）。
冻结播放库 / resolver / analyzer 依旧零改动；未开始非 UIA 路线。

---

## 1. 第一优先级：JSON instrumentation 修复（已完成并验证）

修复过程中连续踩到 **两个 PowerShell 5.1 陷阱**，都不是"写法好看不好看"的问题，而是**证据会丢**：

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | `reports/activation-.json` 只有 689 字节、15 条明细全是空对象 | 行对象用 `[ordered]@{}` + 内联 `$(if ...)`；且缺 `Get-AmStamp/Get-AmIsoNow`（3.7B 不加载 am-common） | 行对象改为显式字段结构；runner 自带 `Get-AmNmStamp/Get-AmNmIso` |
| 2 | `[pscustomobject][ordered]@{...}` → `Argument types do not match`；改用 `[pscustomobject]@{...}` 仍报错；**异常还会中断脚本，导致连 `.md` 都没写出** | 该异常实际来自 `ConvertTo-Json -Depth 12` 处理**深层嵌套 OrderedDictionary** | **放弃 ConvertTo-Json**，改为手写 JSONL（严格按你给的字段集），一次一行，保证落盘 |

**验证结果**（`reports/activation-20260925-203337.jsonl`，1714 字节，1 条记录）：

```
attempt=1 E10/N1/row-analysis result=ROW_ANALYSIS_ONLY realized=True geomAfter=True
titleRows=4 main=ordinal 1 invoke(sup=False,ok=False) select(sup=False,ok=False)
smtcAfter=[Shape of You/Paused] mouse=False fg=False keys=False ts=2026-09-25T20:33:46
```

每条记录现在都完整包含你要求的字段：
`case, scenario, attempt, strategy, target{found,title,url,titleRowsMatched,mainRowGuess,patternsAvailable},
realized, geometry{before,afterRealize,afterScroll,geometryAfter},
invoke{attempted,supported,succeeded,error}, select{...}, smtcBefore, smtcAfter{title,artist,status,playing},
cursorBefore, cursorAfter, foregroundBefore, foregroundAfter, mouseMoved, foregroundChanged,
foregroundChangedByApplication, keyboardInjected, result, timestamp, extra{...}`

## 2. 第三项：E10 realize 后确实能拿到 geometry —— ✅ 确认

`geometry.geometryAfter = True`（多轮复现，含控制组）。即 3.7A 遗留的 `TARGET_ROW_NOT_FOUND`
**不是"永远拿不到几何"**，而是"未 realize 前该行 offscreen/无边界，realize 后才有"。
realization 这条链是通的：**页面 ✅ → 目标元素发现 ✅ → 虚拟化实现 ✅ → 几何 ✅ → UIA 行级动作 ❌**。

## 3. "4 个标题命中行里哪一个是主行" —— 已解剖，结论是"名字无法区分"

- 实测命中行数**不稳定**：同一页面在不同轮次里出现 `titleRows = 4` 与 `titleRows = 1`；
  4 个命中行都是同名 `ControlType.ListItem` / `ListViewItem` / XAML。
- `mainRowGuess` 两轮都落到 **ordinal 1**，但推导依据只是"它有几何 / 有内部动作子元素"，
  **不是** 名字或 AutomationId（这些行 AutomationId 为空、Name 相同）。
- 结论：**"文本命中 ≠ 播放行"成立，且用名称/序号无法可靠识别主行**；
  当前唯一可靠的判别是 **realize 后是否 materialize 出几何**（这也解释了为什么冻结链当时找不到行）。

## 4. 第二优先级：剩余 UIA contract（数据部分完成，标签有缺陷需重跑）

9 轮探测（E10 N1 × item-container/expand-collapse/toggle/probe-chain，E10 N2/N4 × probe-chain，
A/B/C × N1 × probe-chain）控制台结果：

| 结果 | 次数 | 含义 |
|---|---|---|
| `ACTION_NO_EFFECT` | 6 | Invoke 与 Select **都无异常、都返回成功，但 SMTC 不变、无播放** |
| `PATTERN_NOT_SUPPORTED` | 3 | ⚠ 见下 |

**必须指出的缺陷**：这 3 次的标签**不可信**。`item-container` / `expand-collapse` / `toggle`
三个策略本来就不调用 invoke/select，而我的判定逻辑在两者都未尝试时落到了
`PATTERN_NOT_SUPPORTED` —— 这是**标签逻辑的假象**，不是"pattern 不支持"的证据。
它们真正的探测结果（`extra.itemContainer`、`extra.patternProbe`）写在了那一轮的记录里，
而那一轮的 JSON 恰好因第 1 节的序列化缺陷丢失。**修好的 JSONL 只跑了 row-analysis 一条**（为快速验证写盘），
所以：**ItemContainer(10019) / ExpandCollapse(10005) / Toggle(10015) 的最终支持状态仍然未定**，
必须用修好的 writer 重跑一轮 9-job 矩阵才能下结论。我不会在证据缺失的情况下替它们下结论。

已确定的部分：
- Invoke（10000）与 SelectionItem（10010）**存在且可调用**，但 **不产生播放** → `Pattern availability ≠ semantic activation`，
  这是本次逆向最关键的结论（15 + 6 次实验一致）。
- LegacyIAccessible（10018）在本机 **类型缺失、id 也不可解析** → 未测（记录为 `typeUnavailable`）。
- ItemContainer/ExpandCollapse/Toggle：**待重跑确认**。

## 5. 审计（N1–N4 场景证据）

修好的记录结构已经能承载你要求的"后续非 UIA 路线的清白证明"：每个 run 都存
`cursorBefore/cursorAfter`、`foregroundBefore/foregroundAfter`、`mouseMoved`、
`foregroundChanged`、`foregroundChangedByApplication`、`keyboardInjected`、`focusBefore/After`、
以及 `setupLog`（场景准备动作单独记录，位于审计窗口之外）。

已观察到的审计结果（console + 1 条完整记录）：**`mouseMoved=False`、`foregroundChanged=False`、
`foregroundChangedByApplication=False`、`keyboardInjected=False`**，静态 MouseGuard 扫描 3.7B 全部 `.ps1`
（`SetCursorPos/mouse_event/SendInput/SendKeys/Cursor.Position/MoveTo(/BringWindowToTop`）→ `ok=True, hits=[]`。

## 6. 下一步（严格按你的边界）

1. 用修好的 writer 重跑 `.\run-activation-test.ps1`（9 job：E10 N1×4 策略 + N2/N4 probe-chain + A/B/C 控制组），
   并顺带修正标签逻辑：非 invoke/select 策略的结果必须由 `extra.itemContainer` / `extra.patternProbe` 判定，
   不能因为"没调用 invoke/select"就落到 `PATTERN_NOT_SUPPORTED`；
2. 拿到 ItemContainer / ExpandCollapse / Toggle 的确切支持状态 + 内部操作元素（Button/Hyperlink/Custom/
   SplitButton/ToggleButton）的 materialization diff；
3. 若全部为 ❌ / 不存在 → 才有底气宣布 **UIA playback activation contract = unavailable**，
   再讨论是否进入 COM / 未公开 IPC / 私有 API（**本阶段未涉及**）。

## 7. 附注：一个尚未修的次要问题

runner 里的 `Invoke-AmNmPause`（SMTC 暂停以建立基线）**没有定义**（上一版被删掉了函数体却保留了调用），
因此每轮运行会打印一次 command-not-found；由于路径上 SMTC 本来就处于 `Paused`，基线仍然有效，
但这是一个应当补回的 helper（实现即 `TryPauseAsync` + `Await-AmNavWinRt`）。
