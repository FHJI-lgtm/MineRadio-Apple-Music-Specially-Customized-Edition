# Phase B+ —— 整窗命中扫描 + 多输入类型（Alpha=1 + WS_EX_TRANSPARENT）

- 有效运行：20260927-104049（第一次 20260927-1040xx 无效，见文末「无效运行记录」）
- 证据：reports/20260927-104049-sweep.txt / .jsonl / -sweep-summary.json
- 冻结链 poc/lib 零改动；MineRadio 主线零改动；结束 Apple Music 已回到最小化。

## PASS 判定（按你我约定的三条）

| 判据 | 本轮结果 |
|---|---|
| 1. 所有扫描点 WindowFromPoint 根窗口 != Apple Music | **90 / 90 通过**（stillAppleMusic = 0） |
| 2. 至少一种真实鼠标事件被下层窗口收到 | **通过**：9 个点各发左键+右键，9/9 被下层接收窗收到；滚轮 3/3 收到 |
| 3. UIA root / 查询 / 操作仍正常 | **通过**：root ok、496 节点 / 101 listItems、SetFocus + ScrollIntoView + SelectionItemPattern.Select 全部成功 |
| 附：Alpha 保持 | 1（exStyle 0x00080120，flags=0x2，可读） |
| 附：播放 / SMTC | Playing（for him. / Troye Sivan），SMTC 正常，IsHungAppWindow=false |
| 附：移除样式后恢复拦截 | 通过（9/9 点重新命中 AM，点击不再到达下层） |
| 附：完全还原 | 通过（exStyle→0x00000100、SW_MINIMIZE→iconic=true、还原后 UIA 197 节点正常） |

**B_PLUS_PASS = true**

## 扫描点构成（共 90 点）

| 类别 | 数量 | 说明 |
|---|---|---|
| 网格点（Grid=240px） | 77 | 覆盖窗口可见区域（60,60 到 2500,1528） |
| 四角 | 4 | corner-tl / tr / bl / br |
| 四边中点 | 4 | edge-top / bottom / left / right |
| 中央 | 1 | center |
| 搜索区 | 1 | 搜索框（Edit）中心 |
| 导航区 | 1 | 侧栏 ListItem 中心 |
| 列表区 | 1 | 内容区 ListItem 中心 |
| 空白区 | 1 | 不落在任何可交互元素内的点 |

其中 **74 / 90 个点本身就位于可交互元素（Button / ListItem / Edit 等）的矩形内** ——
也就是说这些点如果窗口不穿透，落下去就是真实操作，不是打在空白边距上。

## 每个点命中的是谁

| 命中窗口 | 点数 |
|---|---|
| 自有接收窗（即「穿透到 Apple Music 下层」） | **84** |
| Lyricify Lite 顶层覆盖窗（HwndWrapper[Lyricify Lite…]） | 4 |
| 任务栏（MSTaskSwWClass） | 1 |
| Chrome 窗口（Chrome_RenderWidgetHostHWND） | 1 |
| **Apple Music 根窗口** | **0** |

后 6 个点被别的**顶层窗口**盖住（歌词悬浮窗 / 任务栏 / Chrome），仍然满足「不是 Apple Music」；
这些点无法归因给接收窗，所以真实点击测试只在前 84 个点里挑。

## 真实输入测试（不是只看命中测试）

9 个点（优先选接收窗胜出的点，均匀覆盖窗口上缘与左侧）各发一次真实左键 + 一次真实右键：

| 点 | 左键被接收窗收到 | 右键被接收窗收到 | 光标实际落点 |
|---|---|---|---|
| 60,60 | 是（down+up 计入 2） | 是 | 60,60 |
| 300,60 | 是 | 是 | 300,60 |
| 540,60 | 是 | 是 | 540,60 |
| 780,60 | 是 | 是 | 780,60 |
| 1740,60 | 是 | 是 | 1740,60 |
| 1980,60 | 是 | 是 | 1980,60 |
| 2220,60 | 是 | 是 | 2220,60 |
| 2460,60 | 是 | 是 | 2460,60 |
| 60,300 | 是 | 是 | 60,300 |

滚轮：3 个点各发一次 +120，3/3 被接收窗收到（系统设置 MouseWheelRouting=2，「悬停时滚动非活动窗口」为开）。

## 对照组（移除样式，同一批点）

移除 WS_EX_TRANSPARENT（exStyle 0x00080120 → 0x00080100）后，同样这 9 个点：

- WindowFromPoint **9/9 重新命中 Apple Music**（Microsoft.UI.Content.DesktopChildSiteBridge / InputNonClientPointerSource）
- 同点再发一次真实左键：接收窗增量 **0**（Apple Music 重新吃掉点击）

→ 穿透与「不穿透」是同一个坐标、同一时刻条件下由该样式位决定，因果性成立。

## UIA 在穿透状态下（复核）

| 项目 | 值 |
|---|---|
| UIA root | ok（Apple Music / WinUIDesktopWin32WindowClass） |
| 节点 / 按钮 / 编辑框 / 列表项 | 496 / 19 / 1 / 101 |
| 树签名 | 101|主页;新发现;广播;资料库;最近添加;艺人;专辑;歌曲;播放列表;所有播放列表;喜爱歌曲;音乐回忆 2025 |
| SetFocus(搜索) | ok，HasKeyboardFocus=true |
| ScrollItemPattern.ScrollIntoView | ok（主页） |
| SelectionItemPattern.Select | ok（侧栏导航成功） |

## 无效运行记录（诚实交代）

第一次 B+ 运行（20260927-1040xx）**没有调用 Add-Alpha1Transparent** —— 我在写 sweep 脚本时漏了一步，
而记录里的 sample 字段自己写着 transparent=false、exStyle=0x00080100，
所以那次「86/90 点仍命中 Apple Music、穿透为假」的结果与「样式位根本没加」完全自洽，是脚本遗漏而不是新现象。
修正后（补上该步 + 真实输入点改为只挑接收窗胜出的点）才有上面的有效结果。原始记录保留在 reports 里。

## 仍然不能宣称的东西

1. 只测了**单显示器、当前 DPI、无缩放**、观察窗口几十秒；soak / DPI / 多显示器 / resize 按安排留到下一阶段。
2. 被顶层窗口（歌词悬浮窗/任务栏）覆盖的点，「不是 AM」成立，但点击落到那些窗口上——这与 Apple Music 无关。
3. 左键计数含 down+up 两次事件（接收窗同时记录 MouseUp），所以显示为 2；这是计数口径，不是双击。
4. 滚轮可达性依赖系统 MouseWheelRouting=2；若用户关闭「悬停滚动非活动窗口」，滚轮会走焦点窗口，届时穿透不再覆盖滚轮。
5. 键盘/焦点、任务栏存在感、Alt-Tab、z 序都不受该样式影响（本阶段未改变这一结论）。
