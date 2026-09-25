# Phase 3.7C — 虚拟桌面隔离 PoC：Case A 实测结果

# RESULT: **FAIL**

**失败点**：A-uia 要求把 Apple Music 窗口置前并点击，而这个动作**把用户的当前虚拟桌面从 Desktop 1 切到了 Desktop 2**。
即：虚拟桌面**不能**隔离 A-uia；反过来，A-uia 的前台需求**强制触发桌面切换**。

证据：`reports/vd-poc-20260925-214932.{txt,json}`（唯一一次 Case A 尝试，未重跑）。

---

## 1. 你要求的 13 项汇总

| # | 项 | 实测 |
|---|---|---|
| 1 | 当前（活动）桌面代理 ID | BEFORE `7a8a789c-3926-4cb9-807f-dc11278c2841` → AFTER **不同**（见 #9） |
| 2 | Apple Music 所在桌面 ID | `d0eaca32-4916-4f4a-8a59-06207d6a2f9d`（前后**未变**） |
| 3 | UIA 是否找到窗口 | BEFORE **False** → AFTER **True**（`Apple Music` / `WinUIDesktopWin32WindowClass` / `ControlType.Window` / Enabled / Offscreen=False / bounds `-12,-12,2572,1528`） |
| 4 | UIA 是否找到目标歌曲 | **是**：`matchedRow=音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟` |
| 5 | 是否执行 Invoke/Select | 非 Invoke/Select 路线（Phase 2 安全双击），`clickRecomputed=False` |
| 6 | 是否发生鼠标输入 | **是**：`mouseMoved=True`，cursor `1339,1053 → 819,928` |
| 7 | 是否发生键盘输入 | **否**：`physicalKeyboardInput=False` |
| 8 | 操作前后 foreground | BEFORE `Edge（为 Apple Music 定制…）` → AFTER **`Apple Music`**（`foregroundChanged=True`，`foregroundChangedByApplication=False`） |
| 9 | 操作前后活动桌面 | **变化**（`desktopProxyStable=False`）→ 用户当前桌面被切到 Apple Music 所在桌面 |
| 10 | SMTC before | `Romeo (feat. Frances Alina)` / `Paused` |
| 11 | SMTC after | `How Do I Make You Love Me?` / `Abel Tesfaye — Dawn FM` / **`Playing`** |
| 12 | 是否成功播放目标歌曲 | **是**（目标曲目确实开始播放） |
| 13 | 是否打扰用户当前桌面 | **是**（桌面被切换 + 光标移动 + 焦点被夺：`focusChanged=True`，焦点落到 `音轨 3 …`） |

配套读数：`stage=OK`、`navMethod=AppleMusic.exe /url`、`navigated=True`、`contentMatchMs=2364`。

## 2. 机制（本轮最有价值的发现）

```
BEFORE: Apple Music 在 Desktop 2（appleMusicDesktopId=d0eaca32…）
        用户前台=Edge（activeDesktopIdProxy=7a8a789c…）
        uiaWindowFound = False        ← UIA 看不见"非当前桌面"上的窗口

  ① AppleMusic.exe /url <song url>     ← 与桌面无关，成功（navigated=True, contentMatchMs=2364）

  ② A-uia 需要 UIA 定位 + 真实点击 → 它先把 Apple Music 窗口置前
        foregroundChanged: Edge → Apple Music
        ⇒ Windows 把**活动桌面切到 Desktop 2**（窗口置前的前提就是它所在桌面变为活动桌面）

  ③ 切换后 uiaWindowFound 变 True，点击落地 → 目标曲目 Playing

AFTER:  appleMusicDesktopId 仍为 d0eaca32…（窗口没被搬走）
        但用户的活动桌面 = Desktop 2 → desktopProxyStable=False → FAIL
```

**两条独立结论**（正是你要求分开验证的两件事）：

1. **UIA 可见性**：窗口在**非当前**虚拟桌面时，**UIA 取不到**（`uiaWindowFound=False`）；一旦该桌面变为活动桌面就立刻可见。
   → UIA 观察与"窗口是否在当前桌面"**强相关**。
2. **输入/前台注入**：`SetForegroundWindow` + 光标点击**能够**作用于 Desktop 2 的窗口——但代价是**把该桌面变成活动桌面**，
   即**不满足隔离**。虚拟桌面**没有独立鼠标**，也不能阻止前台切换。

因此：**"Desktop 1 全程不切换"这一条不成立** → FAIL。

## 3. 失败点归类（不要在下一轮引入新方案前的判断）

| 候选原因 | 是否成立 | 依据 |
|---|---|---|
| UIA 找不到窗口 | 部分：**开始时确实找不到**，但这是**结果**而非根因 | BEFORE `uiaWindowFound=False` |
| Invoke/Select 无效 | 不适用（本轮不是 Invoke/Select 路线） | `clickRecomputed=False`、`matchedRow` 正常 |
| SendInput/点击未作用于 Desktop 2 | **否**：点击生效了 | 目标曲目 `Playing` |
| 窗口不在活动桌面而被拒绝处理输入 | **否**：没有被拒 | 同上 |
| **前台置前导致桌面切换** | ✅ **根因** | `foregroundChanged=True` 且 `desktopProxyStable=False` |
| Apple Music 自身切换桌面 | 否 | `foregroundChangedByApplication=False`（是本进程主动置前） |

## 4. 当前状态与用户侧影响（如实告知）

- **目标曲目已开始播放**：`How Do I Make You Love Me? — Dawn FM`，`Playing`；
- **你的当前桌面现在应该在 Desktop 2**（因为 Apple Music 被置前）——需要你手动切回 Desktop 1（`Win+Ctrl+←`）；
  **我不会替你切换桌面**（本实验禁止移动/切换桌面状态）；
- Apple Music 窗口仍在 Desktop 2（`appleMusicDesktopId` 前后未变）。

## 5. 结论（本阶段）

> **在 Windows 11 上，虚拟桌面不能隔离 A-uia 的选曲/点击操作。**
> 具体机制：A-uia 的点击路径必须先置前 Apple Music，而窗口置前必然把**该窗口所在桌面变为活动桌面**；
> 于是用户当前桌面被切换。UIA 本身也**无法观察非当前桌面**上的窗口。

补充：URL 深链（`AppleMusic.exe /url`）本身与桌面无关，可正常送达（`navigated=True`）；**问题只出在"需要 UIA+点击"的那一段**。

## 6. 下一步可选方向（**未实施，等你决定**；本轮不引入新方案）

1. **若坚持不用输入注入**：回到已封档的结论——`A-api` 仍是唯一理想的替换后端，而 3.8 已证明它当前不可用
   （`OS_PACKAGE_COM_REGISTRATION_PATH_UNRESOLVED → PRACTICALLY CLOSED`）；
2. **若接受"会切桌面"**：那虚拟桌面路线没有收益，应直接使用现有 A-uia（在用户当前桌面工作），并如实告知用户会被打扰；
3. **若想减小侵扰**：可研究的只剩"缩短/隐藏置前与光标移动"（属产品体验优化，**不改变"会切桌面"这一事实**）；
4. 不建议：再造新机制绕过前台（同一机制必然重复触发同样的桌面切换）。

## 7. 纪律

本轮只跑了**一次** `-ObserveOnly`（准入检查，5/5 通过）与**一次** `-Case A`，无循环压测；
未创建/删除/移动/切换虚拟桌面；未调用 `MoveWindowToDesktop`；未增加任何输入方式；
未改 A-uia / resolver / 播放逻辑；未提权；未改注册表或系统文件；
未碰 `vtable[3+]` / Packaged COM / ProxyStub / MusicKit。
