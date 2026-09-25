# Phase 3.7B.2 — 严格因果隔离轮（9 job）

产物：`reports/contract-20260925-203655.jsonl`（27 KB，9 条）+ `contract-20260925-203655-summary.md`（可解析表格）。
冻结播放库 / resolver / analyzer 零改动；未开始 COM/IPC。

## 0. 本轮修复

| 项 | 状态 |
|---|---|
| `Invoke-AmNmPause`（3.7B.1 缺失的 runner 自身 bug） | ✅ **已实现**（`TryPauseAsync` + `Await-AmNavWinRt`），本轮 9/9 `pauseRan=true` |
| JSONL 逐条落盘 | ⚠ 已落盘（9 条、27 KB、8 字段齐全），但**嵌套片段用单引号**导致严格 `ConvertFrom-Json` 失败 → 已用正则提取为 `*-summary.md`（表格可解析）；根因与修法见第 4 节 |
| 局部子树三次快照（action 前 / Realize 后 / action 后）+ diff | ✅ 已实现并执行 |

## 1. 本轮结论（逐项，含无效项，不掩盖）

| # | pattern | 结果 | 判定 |
|---|---|---|---|
| 1 | **ItemContainer(10019)** | `exists=false`，**但 actionError 暴露我的代码 bug**：`[System.Collections.Specialized.OrderedDictionary] does not contain a method named 'TryGetCurrentPattern'` | ❌ **无效运行，仍未测**。我把 `Get-AmNmAnchorChain` 返回的**信息对象**当成了活的 List 元素传给探针 |
| 2 | **ExpandCollapse(10005)** | 目标行上 `patternId 可解析`、`TryGetCurrentPattern=false`、无异常 | ✅ **有效阴性：目标行不支持 ExpandCollapse** |
| 3 | **Toggle(10015)** | 同上 | ✅ **有效阴性：目标行不支持 Toggle** |
| 4 | **LegacyIAccessible(10018)** | `pattern-id-not-resolvable-on-this-machine`（本机 .NET 无该类型的 wrapper，id 也取不到） | ⏳ 本机不可测（非"Apple Music 不支持"的结论，只是本机不可用） |
| 5–9 | **内部控件 Invoke**（E10 N1/N2/N4 + CTRL-A/CTRL-C） | `innerInvoke=true`（行内找到带 InvokePattern 的元素且 `Invoke()` 返回成功），**SMTC 始终不变** → `INTERNAL_INVOKE_NO_EFFECT` | ⚠ 假设"ListItem.Realize → 内部播放控件 → 该控件 Invoke"**在这一轮没有成立**；但同一轮的 internal-control 普查报告 `candidateCount=0`，与"找到并 invoke 成功"**自相矛盾**（见第 3 节），所以还不能算铁证 |

## 2. 审计（N1–N4 证据，全部 9 条）

| 审计 | 结果 |
|---|---|
| `pauseRan` | **9/9 true**（基线前置条件确实执行了） |
| `mouseMoved` / `cursorBefore→cursorAfter` | **9/9 false**（未移动鼠标） |
| `keyboardInjected` | **9/9 false**（静态 MouseGuard：本目录 4 个 `.ps1`，`hits=[]`） |
| `foregroundChanged` | **8/9 false**；E10/N4 出现 1 次 `true`，但 `foregroundChangedByApplication=false`（不是 Apple Music 抢前台，落在场景准备/导航时序上，如实记录） |
| `geometryAfter`（Realize 后取到几何） | **9/9 true**（E10 与控制组一致） |
| `treeChanged` / `newControlsMaterialized` | **9/9 false / 0**：Realize 与动作都**没有**在行子树里 materialize 出新的动作控件 |

## 3. 必须修掉的两处（否则结论不成立）

1. **item-container 探针传参错误**：`Get-AmNmAnchorChain` 只返回 UIA 元素的*信息副本*，不含活元素。
   修法：锚链改为同时保留活元素（或在 `Find-AmNmTargetElements` 的结果里沿 `TreeWalker` 找到活的 `ControlType.List`），
   再对它做 `FindItemByProperty`。
2. **内部控件普查与"找到并 invoke"矛盾**：`Get-AmNmSubtree` 的 pattern 探测（`TryGetCurrentPattern`）对
   行内 Button 应能标记 `10000`，普查却报 `candidateCount=0`。必须先让普查与实invoke用的元素来自同一次枚举
   （同一批活元素），否则 `INTERNAL_INVOKE_NO_EFFECT` 只能算**待复现**。
3. **JSONL 嵌套片段引号**：`($x | ConvertTo-Json -Compress) -replace '"',"'"` 产生的是**非法 JSON**。
   修法：片段里的 `"` 必须转义为 `\"`（或干脆不放嵌套数组，改为只存扁平键值）。

## 4. 当前阶段状态（与你的清单对齐）

| 项 | 状态 |
|---|---|
| Instrumentation / JSONL / MouseGuard / Foreground audit / Keyboard audit | ✅ |
| `Invoke-AmNmPause` | ✅ 已修 |
| InvokePattern / SelectionItemPattern | ❌ 已降级：可调用但**无效果**（21+6 次一致） |
| **ItemContainer** | ⏳ **无效运行，未测**（探针传参 bug） |
| **ExpandCollapse** | ✅ 已排：目标行不支持 |
| **Toggle** | ✅ 已排：目标行不支持 |
| **内部 materialized 控件** | ⏳ 待复现（普查与 invoke 结果矛盾） |
| **LegacyIAccessible** | ⏳ 本机不可测 |

因此**现在还不能写** `UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`：
ItemContainer 与内部控件两项尚未取得干净数据。按你的边界，这两项排完之前不碰 COM/IPC。

## 5. 下一轮（明确的最小动作）

1. 修第 3 节的 1 与 2（锚链保留活元素；普查与 invoke 用同一批活元素；JSONL 片段转义）；
2. 重跑同样的 9 job，重点看：`ItemContainer.FindItemByProperty` 是否命中、命中元素的 ClassName/AutomationId、
   以及内部控件普查与 invoke 是否一致；
3. 只有出现"ItemContainer ❌ + ExpandCollapse ❌ + Toggle ❌ + 内部控件不存在/无效 + Legacy 不可用"的**干净**数据，
   才宣布 `UIA_PLAYBACK_ACTIVATION_CONTRACT = UNAVAILABLE`。
