# Alpha=1 Experiment

- 运行：20260927-102259（run-alpha-probe.ps1 -Apply -Alpha 1，Windows PowerShell 5.1，主机 FHJI-ROG）
- 证据：reports/20260927-102259.txt、reports/20260927-102259.jsonl、reports/20260927-102259-summary.json、reports/20260927-102259.restore.json、reports/shots/*
- 冻结链：poc/lib/** 零改动（git diff --quiet 空）；MineRadio 主线零改动。

## Baseline（Alpha=255，未分层）

| 字段 | 值 |
|---|---|
| HWND | 68306（0x10AD2） |
| PID | 14392 |
| WindowClass | WinUIDesktopWin32WindowClass（UIA 与 GetClassNameW 双路一致） |
| Title | Apple Music |
| style / exStyle | 0x15CF0000（实验前被 SW_RESTORE 成最大化）/ 0x00000100 |
| WS_EX_LAYERED | false |
| Alpha | 不可读（未分层，分类 LAYERED_MISSING —— 这是「非分层窗口」的正确分类，不是异常） |
| visible / iconic / hung | true / false（已 SW_RESTORE）/ false |
| rect | -12,-12 2584x1540（最大化） |
| UIA | root OK（Apple Music / WinUIDesktopWin32WindowClass），197 descendants，21 buttons，1 edit，71 listItems |
| UIA 树签名 | 71|主页;新发现;广播;资料库;最近添加;艺人;专辑;歌曲;播放列表;所有播放列表;喜爱歌曲;音乐回忆 2025 |
| UIA 无副作用操作 | SetFocus(搜索/TextBox) OK，HasKeyboardFocus=true；ScrollIntoView(主页) OK |
| Playback / SMTC | Playing；Take Me Back To LA / Abel Tesfaye — Hurry Up Tomorrow，03:41/04:13 |

实验前的窗口状态：iconic=true（最小化），由冻结库 Restore-AmWindow 临时 SW_RESTORE 到可见（reason=minimized，
after{iconic=false, zoomed=true}），exStyle 未变。

## Alpha=1

| 字段 | 值 |
|---|---|
| HWND | 68306（未变；IsWindow=true） |
| 施加调用 | SetWindowLongPtr(GWL_EXSTYLE, exStyle OR WS_EX_LAYERED) → ok（exStyle 0x00000100 → 0x00080100）；SetLayeredWindowAttributes(hwnd, 0, 1, LWA_ALPHA) → ok |
| requestedAlpha | 1 |
| observedAlpha（立即） | 1（可读，flags=0x00000002 = LWA_ALPHA，colorKey=0） |
| Alpha after 1s | 1（HELD，exStyle 仍含 WS_EX_LAYERED） |
| Alpha after 3s | 1（HELD） |
| Alpha after 5s | 1（HELD） |
| Alpha after 10s | 1（HELD） |
| 分类 | 5/5 次采样 = HELD；未出现 RESTORED_TO_255，也未出现 UNREADABLE |
| UIA root | OK（name Apple Music，class 未变，1 次拿到） |
| UIA 控件发现 | 197 descendants / 21 buttons / 1 edit / 71 listItems —— 与 baseline 完全一致 |
| UIA 树签名 | 与 baseline 逐字相同（行动作前后也相同） |
| UIA 操作 | SetFocus(搜索/TextBox) OK + HasKeyboardFocus=true；ScrollIntoView(主页) OK |
| Playback | SMTC status = Playing；position 233s → 234s（1.3s 内前进 1000ms，继续走） |
| SMTC | ok=true，title/artist/duration 全部正常 |
| IsHungAppWindow | false（全程） |
| 前台 | foregroundIsTargetBefore/AfterAction 全程 false（实验没有把 Apple Music 抢到前台） |

### SCREEN_TRUTH vs RENDER_TRUTH（本实验的关键对照组）

| 对比 | 结果 |
|---|---|
| screenVsRenderBaseline | diffPct = 2.65%（meanLuma 184.20 vs 187.15）—— 采集方法可信：两条通路在 baseline 下几乎一致 |
| screenBaselineVsAlpha（SCREEN_TRUTH） | diffPct = 93.40%，meanLuma 184.20 → 37.00：窗口矩形内不再有 Apple Music 的像素，看到的是它后面的桌面 |
| renderBaselineVsAlpha（RENDER_TRUTH） | diffPct = 0.00%（160 px），meanLuma 187.15 → 187.14：PrintWindow 仍然画出完整 UI，渲染没有停、没有黑屏、没有残影 |
| screenVsRenderAlpha | diffPct = 94.97%：屏幕看到的与窗口自己画的东西彻底不同 —— 这正是「视觉隐身但内容仍在渲染」的证据 |

证据图片（reports/shots/）：
- 20260927-102259-alpha1-screen.png —— SCREEN_TRUTH：窗口位置显示的是后面的应用，没有 Apple Music
- 20260927-102259-alpha1-render.png —— RENDER_TRUTH：完整的 Apple Music UI，正在播放条与 SMTC 一致
- baseline / postrestore 各有 -screen / -render 两张对照

### 备注：setStyleError / setAttrError = 203

两个调用都返回成功（setStyleOk=true / setAttrOk=true），203 是我在成功之后读 GetLastWin32Error 得到的陈旧值
（203 = ERROR_ENVVAR_NOT_FOUND，与本次调用无关）。后续运行已改为只在调用失败时读取该值；本轮的原始记录保持原样
（证据不追改）。

## Alpha=0 comparison

未运行（按约定：Alpha=1 无异常后才单独跑对照；等确认后执行 -Apply -Alpha 0）。

## Restoration

| 字段 | 值 |
|---|---|
| Alpha restored | 255（alphaSetTo255=true） |
| Original exStyle restored | 是：0x00080100 → 0x00000100，matchesOriginal=true（WS_EX_LAYERED 已清除） |
| Apple Music rendering recovered | 是：post-restore SCREEN 与 baseline 的 diffPct = 0.21%（meanLuma 184.29 vs 184.20），RENDER diffPct = 0.005% |
| UIA recovered | 是：root OK / 197 nodes / 树签名与 baseline 相同 / 操作照旧成功 |
| 窗口状态回原样 | 是：实验结束后 SW_MINIMIZE → iconic=true, visible=true；只读复检（10:24）确认 layered=false, exStyle=0x00000100, iconic=true |

## Conclusion（对应 9 项验证 + 6 个问题）

逐项验收（reports/20260927-102259-summary.json）：

| 项 | 结果 |
|---|---|
| HWND | PASS |
| UIA root | PASS |
| UIA 查询（197 节点 / 21 按钮 / 71 列表项） | PASS |
| 无副作用操作（SetFocus + ScrollIntoView） | PASS |
| Playback | PASS（position 持续推进） |
| SMTC | PASS |
| Alpha=1 保持 | PASS（10s / 5 次采样全部 1） |
| Screen 隐身 | PASS（screen diff 93.40%，且 screen 与 render 相差 94.97%） |
| 恢复到原状态 | PASS（exStyle 与最小化状态都回到实验前） |
| Git 冻结 | PASS（poc/lib 零改动，主线零改动） |

1. Alpha=1 是否被 Apple Music 强制恢复？没有。10 秒内 5 次采样全部 HELD=1，exStyle 一直保留 WS_EX_LAYERED。
   限制：这 10 秒内没有换页、没有激活、没有缩放窗口；不能据此推断「永远不回 255」。
2. Alpha=1 时 UIA 是否仍然工作？是。root / 节点数 / 树签名与 baseline 一致，SetFocus 与
   ScrollItemPattern.ScrollIntoView 都成功，HasKeyboardFocus=true。
3. Alpha=1 时是否继续播放？是。SMTC Playing，Take Me Back To LA，position 从 221s 连续走到 237s。
4. Alpha=1 时 SMTC 是否继续工作？是。title / artist / status / position / duration 全部正常。
5. 是否触发 WinUI 3 渲染异常？没有观察到。RENDER_TRUTH 内容与亮度几乎不变（0.00% 差异），
   IsHungAppWindow 全程 false，屏幕侧看到的是背景而不是黑块 / 残影；还原后渲染立即恢复（0.21%）。
6. 是否具备继续实验的价值？是。Alpha=1 满足「视觉隐身 + UIA/播放/SMTC 全部可用 + 可逆」，
   可以进入第二阶段（Alpha=0 对照）。

结论强度声明：以上结论成立于「最大化窗口 + 未激活 + 无页面变化 + 10 秒」这一组条件；
更长时间、换页、激活、缩放、多显示器等条件下的 Alpha 持久性尚未测量。


---

# 补充实验：Alpha=1 下的 UIA 交互压力（20260927-102905）

问题：**在 Alpha=1 已经生效的页面上做 UIA 操作（含真正的换页），Apple Music 会不会把 Alpha 强制改回 255？**

运行：`run-alpha-probe.ps1 -Apply -StressUia`（证据：reports/20260927-102905.*）

## 这一组比上一组多覆盖的变量

| 变量 | 上一组（102259） | 本组（102905） |
|---|---|---|
| 窗口是否前台 | 全程 false（没抢前台） | **全程 true**（SW_RESTORE 后 AM 成为前台窗口） |
| UIA 操作 | 仅 baseline/alpha 各一次 SetFocus + ScrollIntoView | **3 轮 × 4 个操作**（SetFocus / ScrollIntoView#0 / ScrollIntoView#8 / 重读树） |
| 页面变化 | 无 | **有**：SelectionItemPattern.Select 切到侧栏首项，UIA 树从 197 → **494** 节点、listItems 71 → 101 |
| 观察时长 | 10s | 10s + 交互期间 16 次采样（含换页后 0/1/3/5s） |

## 结果

| 检查点 | 结果 |
|---|---|
| 施加 | SetWindowLongPtr ok、SetLayeredWindowAttributes ok（本次 setStyleError/setAttrError 均为 0，陈旧值问题已修） |
| 交互期间 Alpha 采样 | **16/16 = HELD，observedAlpha 全为 1**（opTimeline 见 jsonl） |
| 是否出现 1→255 | **没有**（anyForced255=false，firstForcedAt 为空） |
| 换页是否触发恢复 | **没有**：换页后立即 / +1s / +3s / +5s 四次采样全部 HELD |
| 换页后渲染 | PrintWindow meanLuma = **231.05**（照旧在画），IsHungAppWindow=false |
| 换页后 UIA | 树仍可读：494 descendants，操作照旧成功 |
| 播放/SMTC | 全程 Playing（The Moss / Cosmo Sheldrake），position 持续推进 |
| 还原 | exStyle 0x00080100 → 0x00000100（matchesOriginal=true），随后 SW_MINIMIZE → iconic=true |

**结论：UIA 交互（焦点、滚动、以及一次真正的换页导航）不会让 Apple Music 恢复 Alpha=255。**
本组还顺带覆盖了"窗口处于前台"这一变量，同样保持 1。

## 方法与限制（不要过度解读）

1. 侧栏选中项读数为空（原始页面是搜索页，不属于侧栏），所以脚本选了侧栏首项做换页；
   **实验结束时 Apple Music 停在"主页"而不是原来的搜索页**（这是本次唯一的、非窗口样式的残留状态；需要的话点一下搜索即可回去）。
2. 因此 `step9-recovery` 的像素对比是 30.31%（页面内容变了），不能用它判断"渲染是否恢复"；
   渲染恢复的判据改用：`LAYERED_MISSING`（layered 已清除）+ exStyle 回原值 + PrintWindow meanLuma 195.18（正常）+ UIA 494 节点可读。
3. 观察窗口仍然是"换页后 ≤5 秒 + 交互期间"，**没有**测试更长时间（分钟级）、系统主题/DPI 变化、窗口缩放、多显示器等条件下的持久性。

---

# Alpha=0 对照（20260927-102959）

同序列、同观察项，只把 requestedAlpha 换成 0（证据：reports/20260927-102959.*）。

| 检查点 | Alpha=1（102905 / 103048） | Alpha=0（102959） |
|---|---|---|
| 施加 | SetWindowLongPtr ok + SetLayeredWindowAttributes ok | 同（setStyleError/setAttrError = 0） |
| observedAlpha 立即 | 1 | 0 |
| 10s 内 5 次采样 | 5/5 HELD | 5/5 HELD |
| exStyle | 0x00000100 → 0x00080100 并保持 | 同 |
| UIA root / 节点 | OK / 195-197，树签名与 baseline 相同 | OK / 195，树签名与 baseline 相同 |
| UIA 操作 | SetFocus + ScrollIntoView 成功 | 同 |
| Playback / SMTC | Playing，position 前进 | Playing，position 前进（68s → 69s） |
| SCREEN_TRUTH diffPct | 94.94% | 94.94% |
| RENDER_TRUTH diffPct / meanLuma | 0.00% / 195.14 → 195.13 | 0.00% / 195.16 → 195.15 |
| IsHungAppWindow | false | false |
| 还原 | exStyle 回原值 + SW_MINIMIZE | 同 |

结论：**Alpha=0 没有比 Alpha=1 更容易触发异常**，两者在本轮观察范围内表现一致。
Alpha=0 仅作对照，不作为方案（0 = 完全透明，出问题时更不容易被察觉）。

---

# 输入（鼠标）补充实测：Alpha 不等于点击穿透（20260927-103048）

在 baseline / alpha=1 / postrestore 三个阶段，各用 WindowFromPoint 对窗口矩形中心 (1280,758) 做一次**只读**命中测试：

| 阶段 | 命中窗口 | class | 根窗口 | 根窗口 = Apple Music |
|---|---|---|---|---|
| baseline (alpha 255) | 68312 | Microsoft.UI.Content.DesktopChildSiteBridge | 68306 | 是 |
| alpha=1 | 68312 | 同上 | 68306 | 是 |
| postrestore (alpha 255) | 68312 | 同上 | 68306 | 是 |

结论：**Alpha=1 / 0 只是视觉透明，窗口仍然接收鼠标输入**（没有加 WS_EX_TRANSPARENT，命中测试与 alpha=255 完全一致）。
对隐身方案的含义：若不额外处理，桌面上那块区域里的点击仍会被看不见的 Apple Music 吃掉，
任务栏 / Alt-Tab / z-order 里它也依然在。要做到「隐身且不挡操作」需要另加一层（例如 WS_EX_TRANSPARENT 或移出可视区），
那属于下一阶段实验，本阶段没有做。

---

## 后续：Phase B（Alpha=1 + WS_EX_TRANSPARENT 点击穿透）

点击穿透实验已完成并成立，见独立报告 REPORT-B-CLICKTHROUGH.md：
加 WS_EX_TRANSPARENT 后鼠标命中测试跳过 Apple Music（真实点击落到下层窗口），
而 UIA root / 查询 / SetFocus / ScrollIntoView / SelectionItemPattern.Select 全部照常，
播放与 SMTC 继续，Alpha=1 保持；移除该位后拦截立即恢复。
