# Phase 3.7B.3 — 剩余 contract 补齐 + 最终 gate

产物：`reports/contract2-20260925-204303.jsonl`（**扁平 JSONL**：`kind=job` 9 条 + `kind=candidate` 9 条，9.5 KB，无嵌套、无 ConvertTo-Json）。
冻结播放库 / resolver / analyzer 零改动。**未开始** COM / IPC / 私有 API。

## 1. 本轮三处修复的结果

| 修复 | 结果 |
|---|---|
| ① ItemContainer 改为对**活的 List 元素**探测 | ✅ 探针成功执行（不再有 `OrderedDictionary ... TryGetCurrentPattern`）；`probeTarget=live-List`、`patternExists=true` |
| ② 普查与 invoke 用**同一批元素**（同一次 Realize 后枚举） | ✅ 矛盾消失：`candidateCount=1` 且 `invokedCount=1`、`invokeOkCount=1` 一致 |
| ③ JSONL 彻底扁平化 | ✅ 每行独立 `key=value`，机器可解析（`kind=job` / `kind=candidate`） |

## 2. 逐项结果（本轮干净数据）

| # | 项 | 数据 | 判定 |
|---|---|---|---|
| 1 | **ItemContainer(10019)** | 活 List 元素上 `patternExists=true`、动作已调用无异常，但 `FindItemByProperty(NameProperty, title)` → **no-match** | ❌ **name 级 item 查找拿不到行句柄**（不是"pattern 不存在"；是"支持该 pattern 却查不到目标项"） |
| 2 | **ExpandCollapse(10005)** | 活 ListItem 上 `patternExists=false`、`detail=pattern-not-supported-on-live-ListItem` | ✅ 有效阴性 |
| 3 | **Toggle(10015)** | 同上 | ✅ 有效阴性 |
| 4 | **LegacyIAccessible(10018)** | `detail=pattern-id-not-resolvable` | ⏳ 本机不可测（保持） |
| 5 | **内部控件materialize + invoke** | 行内 `candidateCount=1`；该候选 `invokeExists=true`、`invokeAttempted=true`、`invokeSucceeded=true`；`newControlsMaterialized=0`、`treeChanged=false`；**SMTC 9/9 未变** | ✅ **干净阴性：行内唯一的可 invoke 控件调用成功但无播放效果** |
| 6 | Invoke / Select（前两轮） | 可调用、无异常、SMTC 不变 | ❌ 已降级（可调用 ≠ 能播放） |
| 7 | Realize → geometry | `geometryAfter=true` **9/9**（E10 与控制组一致） | ✅ |

## 3. 审计（本轮）

| 审计 | 结果 |
|---|---|
| `pauseRan` | **9/9 true** |
| `keyboardInjected` | **9/9 false**；静态 MouseGuard `mouseGuardOk=true`（本目录 5 个 `.ps1`，`hits=[]`） |
| `mouseMoved` | **7/9 false**；第 1、2 轮 `true` —— 实验代码**不含任何鼠标 API**，且其余 7 轮无移动，故归因为**外部/物理鼠标移动**，非本实验所致（如实记录，不掩盖） |
| `foregroundChanged` | **8/9 false**；E10/N4 一次 `true`，但 `foregroundChangedByApplication=false`（Apple Music 未抢前台） |
| `smtcChanged` / `smtcExpected` | **9/9 false / 9/9 false** |

## 4. 最终 gate

| 门槛 | 状态 |
|---|---|
| ItemContainer(10019) | ❌ 支持 pattern 但查不到目标项，无法构成激活路径 |
| ExpandCollapse(10005) | ❌ 行不支持 |
| Toggle(10015) | ❌ 行不支持 |
| LegacyIAccessible(10018) | 本机不可测 |
| 内部控件 | ✅ 已确认：唯一候选可 invoke 成功，但**无激活效果** |
| Invoke / Select | ❌ 无播放效果 |
| Realize | ✅ 有几何 |
| Mouse / Keyboard / Foreground | ✅ 未动 / 未注入 / 未被 Apple Music 抢占（1 次前台变化非 Apple Music 引起） |
| SMTC | ✅ 全程未改变 |

# UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE

**准确含义**（按你给的定义）：在当前 Apple Music Windows 的 UIA 自动化树与当前可用 UIA Pattern 下，
**没有发现一种能够在不注入鼠标/键盘输入、不依赖前台焦点的前提下可靠触发播放的激活契约**。

这不等同于"UIA 不支持播放"：真实情况是 —— 页面导航、目标元素发现、虚拟化实现、几何全部可用；
`Invoke` / `SelectionItem` / 行内候选控件都**可以被调用且不报错**，但**都不改变 SMTC**；
`ItemContainer` 虽然受支持却拿不到目标项；`ExpandCollapse` / `Toggle` / `LegacyIAccessible` 不可用。

## 5. 下一层（不在此处开始）

按你的边界，下一站才是 **COM / IPC / 私有 API / 进程间通信**。届时前面的审计继续作为硬性验收条件：
非 UIA 路线也必须证明 `mouseMoved=false`、`keyboardInjected=false`、`foregroundChangedByApplication=false`。

本轮遗留（诚实列出，均不影响上面的 gate 结论）：
1. ItemContainer 只用了 `NameProperty` 查找，未试 `AutomationIdProperty` / `ControlTypeProperty` 组合 → 若要更彻底，可补这一组再确认一次；
2. LegacyIAccessible 在本机 .NET 不可解析（需要 UIA COM interop 或 `LookupById` 可用环境）→ 未测；
3. 第 1、2 轮的光标移动来自实验之外，无法归因。
