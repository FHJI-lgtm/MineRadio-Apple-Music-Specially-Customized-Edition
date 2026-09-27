# MineRadio 集成测试 —— Round 3：Alpha=1 + TRANSPARENT 下的 UIA 滚动

日期：2026-09-27 11:44–11:45 CST · 脚本 integration/round3-uia-scroll.ps1 · 探针 integration/cdp-lyrics-probe.js

## 唯一要回答的问题

**在 Alpha=1 + WS_EX_TRANSPARENT 的最终隐身穿透状态下，UIA 是否仍能主动滚动 Apple Music，并且不会误滚 MineRadio 歌词舞台？**

## 答案：PASS

UIA 滚动成功 4/4（ScrollPattern），Apple Music 真的滚了（vPercent 0 → 4.47% → 8.94% → 4.47% → 0），
全程 Alpha=1、TRANSPARENT=ON，MineRadio 侧 0 次滚动副作用（探针已用 +20/-20 自校准证明能看见变化）。

## 读数矩阵

| 状态 | Alpha | TRANSPARENT | exStyle | UIA root | scroll target | scroll op | AM UIA 变化 | MineRadio 歌词变化 | 判定 |
|---|---|---|---|---|---|---|---|---|---|
| 进入隐身 | 1 | ON | 0x00080120 | OK | 无可用（4 个 ScrollViewer 全部 vScrollable=false, vPercent=-1） | N/A | N/A | 无变化 | N/A（不是 PASS） |
| UIA 导航到歌曲列表 | 1 | ON | 0x00080120 | OK | 出现 DataGridListView (ControlType.List)，vScrollable=true, vPercent=0 | SelectionItemPattern.Select 成功 | 列表容器出现 | 无变化 | 建立可滚动区域 |
| scroll-1 down | 1 | ON | 0x00080120 | OK | DataGridListView | ok=true | vPercent 0 → 0.0447 | 无变化 | PASS |
| scroll-2 down | 1 | ON | 0x00080120 | OK | DataGridListView | ok=true | 0.0447 → 0.0894 | 无变化 | PASS |
| scroll-3 up | 1 | ON | 0x00080120 | OK | DataGridListView | ok=true | 0.0894 → 0.0447 | 无变化 | PASS |
| scroll-4 up | 1 | ON | 0x00080120 | OK | DataGridListView | ok=true | 0.0447 → 0 | 无变化 | PASS |
| 冻结 Realize-AmRow（ScrollItemPattern.ScrollIntoView） | 1 | ON | 0x00080120 | OK | 被选中的 ListItem | REALIZE_FAILED（rect=null, realize=false, escalated=true, scrollIntoView=false） | 无 | 无变化 | 该调用失败，原因见下（与隐身无关） |
| 失败注入（不存在的 UIA target） | 1 | ON | 0x00080120 | OK | null element | ok=false，错误被捕获 | 无 | 无变化 | PASS（守护生效） |
| 恢复 | -1（未分层） | OFF | 0x00000100 | OK | — | — | — | 无变化 | matchesOriginal=true |

## 单独列（你要求的那几项）

| 项 | 结果 |
|---|---|
| Alpha 是否全程 {1} | 是（进入隐身 + 4 次滚动 + 失败注入，8 次采样全为 1） |
| TRANSPARENT 是否全程 ON | 是（exStyle 恒为 0x00080120，0 次被摘掉） |
| UIA scroll 成功次数 | 4 / 4（ScrollPattern，down/down/up/up 完整来回） |
| MineRadio scroll 副作用次数 | 0（4 个容器 scrollTop/transform 与基线逐字符相同，OP 前后都相同） |
| UIA failure injection | 已做：AutomationElement.FromHandle(0x5EED5EED) 返回 null → 调用抛错被捕获，未中断流程 |
| restore | matchesOriginal=true；alpha→255；WS_EX_LAYERED=false；WS_EX_TRANSPARENT=false；iconic 与测试前一致（true） |
| poc/lib git diff | 空（0 修改） |

## MineRadio 侧怎么测的（没有改它一行代码）

- 用 Chromium 自带的远程调试端口（启动参数 --remote-debugging-port=9222，Electron 既有能力）
  通过 CDP 在渲染进程里读取：所有可滚动容器的 scrollTop/scrollHeight/transform + 页面内 lyric 相关状态，
  每个阶段取一次指纹（前/后逐字符比对）。
- 探针自校准（关键）：先做一次脚本化 scrollTop +20 再还原，探针报告 delta=20 ⇒ 它确实能看见滚动变化。
  所以后面的「0 次副作用」是有效阴性，不是探针瞎了。
- 本轮实际打开的页面只有主窗口 1 个，容器 4 个：
  home-rail.home-insight-rail、#fx-panel、#playlist-panel、#lyric-timing-popover（lyric=true）；全程 scrollTop=0、transform 不变。

## 边界与 N/A（不把 N/A 算 PASS）

1. 初始页面（主页/迷你播放器）**没有任何可滚动区域**：4 个 ScrollPattern 元素全部 vScrollable=false、vPercent=-1。
   我没有把它算成失败，也没有硬凑：改用 UIA 导航（SelectionItemPattern.Select 到侧栏第 8 项「歌曲」）构造出真正的长列表 DataGridListView，再测滚动。
   导航不是播放路径，本轮没有触碰 AMC、没有 Invoke 任何行、没有合成点击。
2. 独立的 desktop-lyrics 歌词窗本轮**没有打开**，因此对那个窗口标记 N/A；
   被验证的是主窗口里与歌词相关的滚动容器（#playlist-panel、#lyric-timing-popover 等）零变化。
3. 冻结 Realize-AmRow（ScrollItemPattern.ScrollIntoView）**尝试了但失败**：REALIZE_FAILED / rect=null / realize=false / setFocus=false。
   失败点是「选中的 ListItem 尚未被虚拟化实体化、没有边界矩形」，与 Alpha/TRANSPARENT 无关（同一时刻 ScrollPattern 正常工作）。
   本轮的 UIA 滚动证据来自 ScrollPattern；ScrollItemPattern.ScrollIntoView 在隐身下的可用性**未验证**。
4. SMTC 标题在运行期间从 Call Out My Name 变成 Try Me —— 这是同一张 EP 的第 1 首到第 2 首，属于**正常队列推进**；
   本轮没有发送任何 transport 命令、没有调用 SMTC bridge、没有点击播放（checklist 里的 transportUntouched=false 就是这个观察，不是失败项）。

## 过程中发现并修掉的一个工具缺陷（诚实记录）

第二次写配方文件时报 Set-Content : Stream was not readable，把该次运行的 reports/<stamp>.restore.json **截断成空文件**。
本次恢复用的是内存里的配方所以没有影响（restore 成功），但如果进程恰好在那之后崩溃，灾备路径就会失效。
已修：Write-Alpha1Recipe 改为 [System.IO.File]::WriteAllText（不经 PowerShell 管道、无 BOM）。

## 收尾状态

- Apple Music：alpha 255、LAYERED=false、TRANSPARENT=false、已最小化（iconic=true，与测试前一致）；页面停留在被导航到的「歌曲」列表（点一下侧栏可回去）。
- MineRadio：仍在运行（带 CDP 端口的 dev 实例）；未修改任何代码。
- poc/lib 冻结链：零修改。
