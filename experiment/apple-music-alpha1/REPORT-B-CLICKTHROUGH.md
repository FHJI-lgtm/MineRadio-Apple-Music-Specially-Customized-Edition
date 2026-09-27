# Phase B —— Alpha=1 + WS_EX_TRANSPARENT 点击穿透实验

- 最终有效运行：20260927-103613（前两次是仪器 bug，见文末「仪器 bug 记录」，原始记录保留）
- 证据：reports/20260927-103613-clickthrough.{txt,jsonl}、-clickthrough-summary.json、20260927-103613.restore.json
- 冻结链 poc/lib 零改动；MineRadio 主线零改动；实验结束 Apple Music 已回到最小化（iconic=true）。

## 方法（为什么不能只看 exStyle 位）

按你的要求，用**真实输入 + 真实命中测试**判定，而不是看样式位：

1. 在 Apple Music 窗口矩形内、且**可见屏幕范围内**，用 UIA 元素边界扫描出一个「空白点」——
   该点不落在任何 Button / ListItem / Edit / Hyperlink / TabItem / ComboBox / CheckBox / MenuItem / TreeItem 的矩形内，
   因此点在那里不可能改变 Apple Music 的状态（本次点：100,1408；扫描 61 点，剔除 60 点）。
2. 在该点放一个 140x90 的**自有接收窗**（WinForms），并用 SetWindowPos 把它插到**紧贴 Apple Music 下方**的 z 序
   （不激活），这样唯一能挡住它的窗口就是 Apple Music 本身。
3. 在每个阶段做三件事：WindowFromPoint 命中测试 + 一次**真实合成点击**（SetCursorPos + mouse_event，并回报光标实际落点）
   + 点击前后对比 Apple Music 的 UIA 树签名（证明点击没有改变 Apple Music 状态）。
4. 接收窗的消息循环在点击后用 DoEvents 泵动，否则 WM_LBUTTONDOWN 只是排队、处理器不运行（会造成假阴性）。

## 结果（三轮点击 + 命中测试）

| 阶段 | exStyle | WindowFromPoint 命中 | 真实点击被谁收到 | Apple Music 树签名 |
|---|---|---|---|---|
| A 对照：alpha=1，未加 TRANSPARENT | 0x00080100 | Apple Music（Microsoft.UI.Content.DesktopChildSiteBridge，根 68306） | **Apple Music**（接收窗 0 次） | 未变 |
| B：alpha=1 + WS_EX_TRANSPARENT | **0x00080120** | **自有接收窗**（WindowsForms10.Window…，根 3214754） | **接收窗 1 次** | 未变 |
| C：移除 TRANSPARENT | 0x00080100 | Apple Music（根 68306） | **Apple Music**（接收窗仍是 1 次） | 未变 |

光标实际落点在三轮里都是 100,1408（未被屏幕边界钳制），所以 A/B/C 是同一条件下的对照。

## B 验收矩阵（你要的那张表）

| 项目 | Alpha=1 | Alpha=1 + WS_EX_TRANSPARENT |
|---|---|---|
| UIA root | 在 | **在**（name=Apple Music，class=WinUIDesktopWin32WindowClass，1 次拿到） |
| UIA 查询 | 正常 | **正常**：493 descendants / 19 buttons / 1 edit / 101 listItems，树签名与 baseline 逐字相同 |
| UIA 操作 | 正常 | **正常**：SetFocus(搜索|TextBox) ok + HasKeyboardFocus=true；ScrollItemPattern.ScrollIntoView ok |
| SelectionItemPattern | 正常 | **正常**：SelectionItemPattern.Select ok（侧栏导航成功，节点数 493 → 403） |
| Playback | Playing | **Playing**：Lose It / Oh Wonder，position 160s → 191s 持续推进 |
| SMTC | 正常 | **正常**：title/artist/status/position/duration 全部可读 |
| Alpha 保持 | 1（HELD） | **1（HELD）**：exStyle 0x00080120，flags=0x2(LWA_ALPHA)，可读 |
| WindowFromPoint 命中 AM | 是 | **否**（命中下层接收窗） |
| 底层窗口收到点击 | — | **是**（接收窗记录到 1 次 MouseDown） |
| 撤销后恢复拦截 | 是 | **是**（移除 TRANSPARENT 后 AM 重新吃掉点击） |
| 渲染 | 正常 | **正常**：PrintWindow meanLuma 230.6、IsHungAppWindow=false |
| 恢复窗口 | 回原状 | **回原状**：exStyle→0x00000100、再 SW_MINIMIZE → iconic=true；还原后 UIA 正常 |

## 结论

1. **鼠标消息穿透 ≠ UIA 控制失效 —— 这两个可以同时成立。**
   加了 WS_EX_TRANSPARENT 之后：鼠标命中测试跳过 Apple Music（真实点击落到下层窗口），
   而 UIA root / 查询 / SetFocus / ScrollIntoView / SelectionItemPattern.Select 全部照常工作，
   Apple Music 继续播放、SMTC 正常、Alpha=1 保持。
2. **因果性成立**：同一坐标、同一时刻条件，加位前 AM 吃掉点击，加位后穿透，去掉位后又吃掉。
3. 这就是「视觉不可见 + 不挡鼠标 + UIA 仍可操作 + 仍在播放」四件事第一次同时成立。

## 必须说清的限制（不要把这一轮当成产品结论）

1. **只验证了一个点**（100,1408，窗口左下的空白区）。要宣称「整窗穿透」需要做整面网格扫描（例如每 80px 一点）。
2. **只验证了左键按下/抬起**。滚轮（WM_MOUSEWHEEL 走同一命中测试，理论上同样穿透）、右键、拖拽、触控板手势都没有测。
3. **键盘/焦点不受影响**：WS_EX_TRANSPARENT 只管鼠标命中测试与绘制顺序，不改变焦点、键盘、任务栏、Alt-Tab、z 序；
   本次 SetFocus 仍然成功就是证据。要「完全不被感知」还需要另想（隐藏窗口/移出屏幕等）。
4. **持久性未测**：本轮只观察了几十秒；长时间 soak、切页后、缩放/DPI/多显示器变化后的行为都没测（按你的安排 A/C 先不做）。
5. 该样式是**整个窗口**的属性，加了之后窗口上任何位置都不再接收鼠标 —— 对「隐身」是目标，
   但如果将来想让窗口局部可点，就得换方案（子窗口/区域）。

## 仪器 bug 记录（为什么前两次不算数）

1. 第一次（103455）：空白点落在 1488 —— 超出屏幕高度（虚拟屏 0,0 2560x1600，最大化矩形延伸到 -12,-12 2584x1540），
   SetCursorPos 把光标钳到屏幕内，点击根本没落到接收窗上；同时接收窗消息循环没泵动。
   → 已修：扫描范围收窄到「窗口矩形 ∩ 屏幕 − 60px 边距」，光标实际落点写进记录；接收窗命中改用容器方法调用记录，并在点击后泵 DoEvents。
2. 记录里 renderOk 曾是 1.9MB 的布尔数组：PowerShell 的 `$bytes -ne $null` 会逐元素比较；已改为 `$null -ne $bytes`。
3. belowAppleMusic.win32Error=203 与之前一样是「调用成功之后读 GetLastWin32Error」的陈旧值（该调用返回 true）。
