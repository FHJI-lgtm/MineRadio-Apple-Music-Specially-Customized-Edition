# phase3.7B-uia-no-mouse — UIA no-mouse activation experiment

隔离实验区：研究 Apple Music Windows 是否存在**不移动鼠标、不抢前台、不发送键盘输入**的
UIA activation contract。

## 硬约束（本目录遵守）

- **从不加载** frozen 播放库（`poc/lib/am-play|am-uia|am-smtc|am-common` 均未 dot-source）
- **从不修改** `poc/lib/am-play.ps1`、`phase3-resolve/*`、`poc/analyze-e2e.ps1`
- 禁用任何鼠标/键盘物理输入 API；`Test-AmNmScriptHygiene` 会在开跑前静态扫描本目录全部 `.ps1`，
  命中 `SetCursorPos` / `mouse_event` / `SendInput` / `SendKeys` / `Cursor.Position` / `MoveTo(` /
  `BringWindowToTop` 任意一个即 **FAIL 退出**
- 场景准备（启动对照应用、最小化或还原 Apple Music）会记录在 `setup` 字段，且在审计窗口**之外**；
  激活阶段不做任何前台夺取

## 结构

```
phase3.7B-uia-no-mouse/
  lib/instrumentation.ps1   鼠标/前台/焦点审计 + 静态 MouseGuard + 本实验自带的文本匹配
  lib/patterns.ps1          UIA pattern 清单（按 pattern id 解析，避免本机缺失类型）+ 目标元素定位
  lib/activation.ps1        场景准备、Realize/ScrollIntoView 序列、单动作（可归因）调用
  cases/E10.json            E10 目标 + N1–N4 场景 + 策略列表
  cases/controls.json       A/B/C 对照组
  run-pattern-probe.ps1     阶段 1：只做清单，不激活
  run-activation-test.ps1   阶段 2–4：带审计的激活尝试
  reports/                  产物
  REPORT.md                 结论
```

## 用法

```powershell
.\run-pattern-probe.ps1
.\run-activation-test.ps1                 # 有界默认矩阵
.\run-activation-test.ps1 -Full           # 全部场景 x 全部策略
.\run-activation-test.ps1 -Only E10-N1-invoke
```

## 判定口径（与验收条件一致）

`NO_MOUSE_ACTIVATION_PASS` 要求同时满足：SMTC 标题与艺人正确 + `status=Playing` +
`mouseMoved=False` + `foregroundChanged=False` + 无物理键盘输入。
其他分档：`ACTIVATION_FOREGROUND_STEAL`（SMTC 正确但 Apple Music 抢了前台，不算成功）、
`UNATTRIBUTED_SUCCESS`、`ACTION_NO_EFFECT`、`PATTERN_NOT_SUPPORTED`、`NO_TARGET_ELEMENT`、
`UIA_REALIZATION_UNAVAILABLE`。

## 已知缺陷（必须修后才能重跑）

本目录的 `run-activation-test.ps1` 调用 `Get-AmStamp` / `Get-AmIsoNow`，而 3.7B 不加载 am-common，
因此**时间戳与输出文件名失效**；同时行对象用 `[ordered]` + 内联 `$(if ...)` 组合在 PS 5.1 下落成空对象，
导致 `reports/activation-.json` 的 15 条明细为空。**该文件的数字不可用于结论**，
结论以 `REPORT.md` 与 `reports/E10-pattern-inventory.json` 为准。修复方式见 REPORT.md 第 9 节。
