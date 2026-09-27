# MineRadio 集成测试 —— Round 2：WS_EX_TRANSPARENT 门控

日期：2026-09-27 11:36–11:37 CST · 分支 experiment/apple-music-windows-control
脚本：integration/round2-gating.ps1（配合 integration/amc-chain-driver.js）

一句话结论：**门控成立**。Alpha 全程保持 1，只在执行冻结 AMC 播放链的那几秒摘掉 WS_EX_TRANSPARENT；verified=true、SMTC 真实切歌、播完透明位自动戴回、点击穿透恢复。异常注入也证明 finally 守护有效。

## 实测矩阵（数值就是采样读数）

| 状态 | Alpha | TRANSPARENT | exStyle | 9 点命中 AM | 与预期 |
|---|---|---|---|---|---|
| idle | 1 | ON | 0x00080120 | 0/9 | 通过：隐身 + 穿透 |
| play-open（摘掉透明位） | 1 | OFF | 0x00080100 | 7/9 | 通过：点击重新回到 Apple Music |
| play-closed（自动戴回） | 1 | ON | 0x00080120 | 0 点（N/A，见下） | 通过：位已恢复 |
| restored | 1 | ON | 0x00080120 | 0 点（N/A） | 通过：隐身 + 穿透恢复 |
| fail-injection open | 1 | OFF | 0x00080100 | 0 点（N/A） | 门开 |
| fail-injection closed | 1 | ON | 0x00080120 | 0 点（N/A） | 通过：异常后仍戴回 |

alpha 在这 6 个隐身阶段状态里取值集合 = {1}：门控只动透明位，从不动 Alpha。

## 播放链结果（冻结链，未改一行）

| 相 | 结果 |
|---|---|
| 搜索 | search = 4 |
| 播放 | ok=true / chainOk=true / verified=true / stage=OK；url = …/us/song/blinding-lights/1513133940 |
| 实际曲目 | Blinding Lights — Teddy Swims（artistLayer = exact） |
| 独立 SMTC 复核 | Blinding Lights / Playing（真的切了，不是看起来切了） |
| 探针点击副作用 | 点击前后 UIA 树签名一致（amStateUnchanged = true） |

## 关键守护：任何异常都必须把透明位戴回去

门控实现是 try { 摘位 → 跑冻结链 } finally { 戴位 }。为了验证 finally 真的有效，做了故意失败注入：把链脚本指向不存在的路径（no-such-chain.ps1）。结果：

- 链失败：play.ok = false / stage = NO_JSON（PowerShell 报 -File 路径不存在）
- **reopened = true**：exStyle 从 0x00080100 回到 0x00080120，Alpha 仍是 1
- 失败之后点击穿透仍然有效（接收窗再次收到点击）

也就是说：不会因为一次 AMC 超时/失败而留下「Alpha=1 但不穿透」的幽灵 AM。

## 点击穿透证据（真实合成点击，不是只看命中测试）

在 Apple Music 矩形内的空白点放一个自有接收窗（按 z 序紧贴 AM 下方）：

- idle（透明 ON）：接收窗 MouseDown 增量 2（down+up）⇒ 点击穿过 AM
- play-open（透明 OFF）：9 点里 7 点重新命中 AM ⇒ 点击回到 AM（这正是冻结链需要的）
- restored（透明重新 ON）：接收窗再次收到 2 ⇒ 穿透恢复

## 验收清单（你列的 10 项）

| # | 项目 | 结果 |
|---|---|---|
| 1 | 搜索仍正常 | 通过（search = 4） |
| 2 | 播歌真正切换 | 通过（SMTC Blinding Lights） |
| 3 | verified = true | 通过 |
| 4 | SMTC 目标歌正确 | 通过（Blinding Lights — Teddy Swims） |
| 5 | Alpha 全程保持 1 | 通过（6/6 阶段采样 = 1） |
| 6 | 播放后 TRANSPARENT 必须重现 | 通过（reopened = true；异常后同样重现） |
| 7 | WindowFromPoint 再次不命中 AM | 通过（idle 0/9；restored 接收窗收到点击） |
| 8 | 下层窗口重新可以收到点击 | 通过（接收窗 MouseDown 增量 2） |
| 9 | AM 最后恢复原始状态 | 通过（matchesOriginal = true、alpha→255、iconic = true） |
| 10 | poc/lib 零修改 | 通过（git status / git diff 对该路径为空） |

## 两条必须写清的限制（不要把 N/A 读成 PASS）

1. 冻结链播完会自己最小化 AM（poc/lib/am-play.ps1:310 → Minimize-AmWindow，是链条自身文档化的行为，不是隐身层造成的）。所以 play-closed / restored / 失败注入那几个状态的窗口 rect 已退化，相对采样点数为 0 ⇒ 那些点的命中测试**不适用（N/A）**，我没有算成穿透通过；有效的穿透证据来自 idle（播放前）与 restored 两次真实点击被接收窗收到。
2. 我 checklist 第一版 alphaHeldEverywhere = false 是检查逻辑的 bug：它把 restore 之后的 finalState（此时 LAYERED 已清、alpha 读不到 = -1，属于正确结果）也算进了「必须等于 1」。修正后只看隐身阶段状态：6/6 全是 1。脚本已改（新增 statesWithNoPoints 计数，显式区分 N/A）。

## 应用侧旁证（本轮重启的 MineRadio，未改一行代码）

- 日志 integration/mineradio-20260927-113624.log：62 条 [AUDIO] native/bridge metrics + IPC sent，28 条 SMTC IPC sent (T4)，标题里出现 Blinding Lights
- 0 次 CAPTURE_START_FAILED、0 次 NON_FINITE_METRICS ⇒ 外部音频捕获在门控播放期间照常

## 对产品化的含义

门控可以在 MineRadio 侧这样落地（Round 2 已实测可行的最小机制）：

    idle          alpha=1 + TRANSPARENT      隐身穿透
    playRequest   摘掉 TRANSPARENT           Alpha 不动
                  跑现有冻结 AMC 播放链      真实点击可达 AM
                  SMTC verified 判定
    finally       无论成功/失败/超时，戴回 TRANSPARENT
    回到 idle     alpha=1 + TRANSPARENT      隐身穿透

下一步（未做，等你定）：把这同一个门控扩到 暂停 / 下一首 / 上一首。走 SMTC bridge stdin 的控制不涉及点击穿透，理论上不需要摘位；但如果走 AMC 点击路径就需要同样门控。键盘焦点隔离仍未验证。
