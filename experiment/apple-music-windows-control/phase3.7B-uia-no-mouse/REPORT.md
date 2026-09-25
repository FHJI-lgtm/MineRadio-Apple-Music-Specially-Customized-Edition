# Phase 3.7B — UIA No-Mouse Activation 报告

**PHASE_3_7B = UIA_ACTIVATION_UNAVAILABLE**

- 实验区完全独立：`phase3.7B-uia-no-mouse/`，只复用我自己的 3.7A 仪器，**从不加载 frozen 播放库**
  （`poc/lib/am-play|am-uia|am-smtc|am-common` 一次都没被 dot-source，也未修改）。
- 未修改：Resolver / version semantics / candidate scoring / storefront ladder / SMTC verification /
  analyzer / matching threshold。未加任何歌曲特判。未开始 3.7B 之外的 COM 逆向或私有 IPC。

---

## 1. Apple Music UIA Pattern Inventory（可靠，`reports/E10-pattern-inventory.json`）

E10 页面（`Someone Like You`，已按 3.7A 修复正确导航）：**244 个节点、44 个 ListItem**。

| 项 | 值 |
|---|---|
| 携带目标标题的 ListItem | **4 个** |
| 携带目标标题的其他元素（文本） | 7 个 |
| 标题命中候选按钮（Button/Hyperlink/Image） | **0 个** |
| 第一命中 ListItem：ControlType / ClassName / FrameworkId | `ControlType.ListItem` / `ListViewItem` / **XAML** |
| IsEnabled / **IsOffscreen** | True / **True** |
| BoundingRectangle | **空**（无几何） |
| NativeWindowHandle | 0（非独立窗口） |
| 父节点 | `ControlType.List` / `ListView` |
| **可用 Pattern** | **InvokePattern、SelectionItemPattern、ScrollItemPattern、VirtualizedItemPattern** |
| LegacyIAccessiblePattern | **本机 .NET 无该类型**（`System.Windows.Automation.LegacyIAccessiblePattern` 解析失败；已改用 `AutomationPattern.LookupById(10018)`，返回不可解析）→ 记录为 `typeUnavailable`，**未测** |
| 未探测 | `ItemContainerPattern`(10019)、`SynchronizedInputPattern`(10021)、`ExpandCollapse/Toggle/Value`（已尝试，未出现在首批命中元素上） |

**区分**（按要求）：这里只回答 “pattern exists / supportsAction”。
`pattern exists` = 4 个；`supportsAction` = 4 个（Invoke/Select/ScrollIntoView/Realize）；
**action succeeded / caused playback 见第 3 节——没有一次导致播放**。

## 2. E10 realization 结果

- 目标行在**未 realize 前 offscreen=True 且 bounds 为空**——这正是冻结链在 3.7A 报
  `TARGET_ROW_NOT_FOUND` 的直接原因：不是页面不对，而是**该行未实现/不可见**。
- 执行 `VirtualizedItemPattern.Realize()` → `ScrollItemPattern.ScrollIntoView()`（无鼠标、无前台、无键盘）
  后，控制组（A/B/C）**realized=True（取得几何）**；E10 的逐条记录因下节缺陷丢失，不能断言其 after-geometry。
- 目录模式（ScrollIntoView/Realize）本身**可用**，即 realization 层不是"完全不可用"，而是"是否稳定取得几何"需要重跑确认。

## 3. InvokePattern / SelectionItemPattern 结果（尝试 15 次）

- 目标行**支持** `InvokePattern` 与 `SelectionItemPattern`（第 1 节）。
- 15 次无鼠标尝试（E10 的 N1/N2/N4 × invoke/select/realize+invoke，加 A/B/C × N1 × invoke）中：
  **SMTC 始终为 `Shape of You / Paused`——没有任何一次进入 `Playing`**。
  因此结论是：**`Invoke()` 与 `Select()` 都没有引起播放**（不是"播错歌"，是"没反应"）。
- 可观测的 5 条记录里：`realized=True`、`mouseMoved=False`、`foregroundChanged=False`、
  `foregroundChangedByApplication=False`；其中 1 条出现 `fgChanged=True / fgByApp=False`
  （场景准备阶段启动对照应用所致，非 Apple Music 抢前台）。

**⚠ 必须如实说明的缺陷**：`reports/activation-.json`（应为 `activation-<stamp>.json`）里的
**15 条 per-run 明细被序列化成了空对象**（文件仅 689 字节，`activation-.md` 表格为空行）。
根因是实验库缺少 `Get-AmStamp` / `Get-AmIsoNow`（3.7B 未 dot-source am-common），叠加我的行对象
序列化写法在 PS 5.1 下的问题。**后果**：N1–N4 的逐场景归因不完整，本节结论仅基于控制台记录的
事实（无播放、无鼠标移动、无前台被抢）。这不是阴性结果被掩盖，而是**证据本身不完整**。

## 4. VirtualizedItem / ScrollItem / LegacyIAccessible

| Pattern | 存在 | 动作 | 结果 |
|---|---|---|---|
| VirtualizedItemPattern | 是 | `Realize()` | 控制组取得几何（realized=True）；E10 after-geometry 未记录 |
| ScrollItemPattern | 是 | `ScrollIntoView()` | 同上，无异常 |
| InvokePattern | 是 | `Invoke()` | 无异常、**无播放** |
| SelectionItemPattern | 是 | `Select()` | 无异常、**无播放** |
| LegacyIAccessiblePattern | 本机类型缺失 | `DoDefaultAction/Select` | **未测**（`LookupById(10018)` 不可解析） |

## 5. N1–N4 场景

场景定义与准备都已实现并记录（`Set-AmNmScenario`：可启动对照应用、可最小化/还原 Apple Music，
均标记为 setup 且在审计窗口之外）。**逐场景结果因第 3 节的数据丢失缺陷不完整**，因此不做逐场景断言。
可确认的共性：所有可见记录中 Apple Music **没有被抢到前台**，鼠标**没有移动**。

## 6. 审计

| 审计 | 手段 | 结果 |
|---|---|---|
| mouse movement | 静态：扫描 3.7B 全部 .ps1 中的禁用 API 令牌（`SetCursorPos`/`mouse_event`/`SendInput`/`SendKeys`/`Cursor.Position`/`MoveTo(`/`BringWindowToTop`）→ `ok=True, scanned=4, hits=[]`；运行时：每次动作前后采样 `GetCursorPos` | **未发现任何鼠标 API；可见记录 cursorBefore==cursorAfter** |
| foreground | `GetForegroundWindow` + 进程名，动作前后对比 | 可见记录 `foregroundChanged=False`；Apple Music 未抢前台（`fgByApp=False`） |
| focus | `AutomationElement.FocusedElement` 前后对比 | 已记录（逐条数据丢失，见第 3 节） |
| SMTC | WinRT `GlobalSystemMediaTransportControlsSessionManager`（只读） | 15/15 次未进入 Playing |
| 键盘 | 未调用任何键盘 API（静态扫描覆盖 `SendKeys`/`SendInput`） | physicalKeyboardInput=false |

注：3.7A 的仪器（`nav-common.ps1`）里存在 `SetForegroundWindow` helper，但 **3.7B 从未调用它**；
B 阶段自身代码不含任何前台夺取调用。

## 7. Control group

A/B/C 与 E10 走同一套代码路径（无特判）：A/B/C 在 N1 下 `realized=True`、`mouseMoved=False`、
`foregroundChanged=False`，但 `Invoke()` 同样**未导致播放**。即：**当前 UIA 行级 Invoke 对这首歌
App 版本不构成可用的 activation contract**，与 E10 是否"特殊"无关。

## 8. 是否存在可用的 No-Mouse Activation

**未找到。** 严格按验收条件（SMTC correct + mouseMoved=false + foregroundChanged=false + 无物理键盘）
**没有任何一次通过**：

- realization（前置条件）**部分可用**；
- 行级 `Invoke` / `Select` 有 pattern、调用无异常，但**不产生播放**；
- 结论层：**失败在 "activation" 层，而不是 URL/导航层（3.7A 已修）或 realization 层**。

## 9. 下一步建议（3.7B 之外，按规则不在此处开始）

1. **先修实验缺陷并重跑**（必须）：补 `Get-AmStamp`/`Get-AmIsoNow`，把行对象改为显式
   `[pscustomobject]` 逐字段赋值，产出完整的 N1–N4 × strategy 归因表；
2. 在完整数据上确认 **E10 realize 后是否取得几何**（控制组已能），以区分
   `UIA_REALIZATION_UNAVAILABLE` 与 `ACTION_NO_EFFECT`；
3. 探测**尚未测的 contract**：`ItemContainerPattern`(10019) 从 List 取行、
   `ExpandCollapse/Toggle`（行内播放按钮可能在选中后才 materialize）、
   以及**行内子元素的 Invoke**（4 个标题命中行里究竟哪一行是"主行"——需要按 AutomationId/位置判定）；
4. 若上述仍无效果，才考虑非 UIA 路径（COM / 未公开 IPC / 私有 API）——**本阶段明确未涉及**。

## 10. 证据文件

- `reports/E10-pattern-inventory.json`（201 KB，完整清单：4 个行命中、7 个文本命中、0 个按钮、父节点 List/ListView、LegacyIAccessible 类型缺失）
- `reports/activation-.json` / `activation-.md`（**已损坏，仅作缺陷证据保留**，不用于结论）
- 脚本：`run-pattern-probe.ps1`、`run-activation-test.ps1`、`lib/{instrumentation,patterns,activation}.ps1`
