# phase3.7A-navigation — E10 navigation investigation

隔离实验区：只调查 `Someone Like You / Adele`（song id `403037927`）在 Apple Music
Windows 上的深链导航。**不修改冻结播放链路**，也不修改 resolver 与 analyzer。

## 硬约束（本目录遵守）

- `poc/lib/am-play.ps1`、`am-uia.ps1`、`am-smtc.ps1`：**不 dot-source、不修改**
- `phase3-resolve/*`：不修改、不改阈值、不加歌曲特判
- 不做点击/不做 SMTC 控制/不做输入合成 —— 本阶段只回答“页面到底变了没有”
- 无新依赖；PowerShell 5.1 兼容；`.ps1` 全 ASCII（非 ASCII 数据放 JSON）

## 结构

```
phase3.7A-navigation/
  lib/nav-common.ps1       UIA/SMTC/窗口/深链调用 的自包含仪器
  lib/nav-experiment.ps1   实验编排：case 矩阵与判定
  cases/E10.json           目标 URL 变体、invocation 变体、app 状态变体、A/B/C 对照
  reports/                 运行产物（timeline-*.json、matrix.json/.md、E10-navigation-timeline.*）
  run-e10.ps1              入口
  REPORT.md                结论报告
```

## 用法

```powershell
.\run-e10.ps1 `
  -Title "Someone Like You" -Artist "Adele" -SongId "403037927" `
  -Url "https://music.apple.com/cn/song/someone-like-you/403037927"
```

常用开关：

| 开关 | 作用 |
|---|---|
| `-List` | 只列出全部 case，不导航 |
| `-Cases CTRL-A,E10-D1` | 只跑指定 case |
| `-Full` | 每个 case 都采 T+0/250/500/1000/2000/4000/6000/8000/12000 完整时间线 |
| `-NoPrepare` | 不做前置导航（对应 app 状态轴 F2） |

## 判定口径

每个 case 同时记录：窗口标题/是否最小化/是否前台、UIA 根获取耗时、节点数、ListItem 数、
名称签名、目标文本命中、ListTile 模式可用性、SMTC 标题/艺人/状态。判定分档：

`NAVIGATION_OK_VISIBLE` / `NAVIGATION_ALREADY_SUCCEEDED_UIA_STALE` /
`NAVIGATION_TARGET_PAGE_DIFFERENT` / `NAVIGATION_URL_REJECTED` / `NAVIGATION_TIMEOUT` / `UNKNOWN`

## 结论摘要

见 `REPORT.md`：`PHASE_3_7A_STATUS = ROOT_CAUSE_FOUND` —— E10 的 URL 从未导航失败
（11/11 变体成功，含 3.6 用的同一 URL，稳定页面在 T+1000 出现），失败出在冻结链的
“页面是否已切换”判据（UIA 观察层）。修复方案已给出但**未实施**，需批准后才动冻结文件。
