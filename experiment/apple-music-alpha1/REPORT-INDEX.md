# Apple Music Alpha=1 隐身实验 —— 证据索引

**状态：EXPERIMENT CLOSED（实验封板）**  ·  **Tag：`checkpoint/apple-music-alpha1-soak-pass`**

## 证据链

```
Alpha=1                PASS   (请求值/实测值 1，10s 内 5/5 HELD)
  -> UIA Stress        PASS   (16/16 HELD，含换页与前台)
  -> Alpha=0 Control   PASS   (对照，同样 5/5 HELD)
  -> Click-through     PASS   (真实点击被下层窗口收到，UIA 不受影响)
  -> B+ Full-window    PASS   (90 点整窗扫描 0 点命中 Apple Music)
  -> 30-minute Soak    PASS   (180 采样，verdict = NO_VIOLATION)
  -> EXPERIMENT CLOSED
```

| 阶段 | 报告 | 原始记录 |
|---|---|---|
| Alpha=1 基础 + UIA stress + Alpha=0 对照 | [REPORT-ALPHA1.md](REPORT-ALPHA1.md) | reports/20260927-102259.*（Alpha=1）、20260927-102905.*（UIA stress）、20260927-102959.*（Alpha=0）、20260927-103048.*（输入命中） |
| Click-through（单点真实点击对照） | [REPORT-B-CLICKTHROUGH.md](REPORT-B-CLICKTHROUGH.md) | reports/20260927-103613-clickthrough.* |
| B+ 整窗扫描 + 多输入类型 | [REPORT-B-PLUS-SWEEP.md](REPORT-B-PLUS-SWEEP.md) | reports/20260927-104049-sweep.* |
| 30 分钟 Soak | [REPORT-SOAK.md](REPORT-SOAK.md) | reports/20260927-105155-soak.{jsonl,txt}、20260927-105155-soak-summary.json、20260927-105155.restore.json |
| 只读基线 | — | recon/baseline-202609270218.{json,txt} |

## 一句话结论

Windows 原生窗口属性即可让 Apple Music 主窗口**视觉不可见（Alpha=1）、鼠标命中穿透（WS_EX_TRANSPARENT）、
而 UIA 与播放链完好**：30 分钟内 180 次采样 alpha 恒为 1、两个样式位全程在位、UIA root 180/180 可用、
1593 次固定点命中测试 0 次命中 Apple Music、9 次换页 + 4 次窗口缩放移动扰动全部保持、SMTC 状态恒为 Playing。

## Verified（本实验有直接数据）

- Alpha=1 persistence（180 采样恒为 1，无回弹、无不可读）
- WS_EX_LAYERED persistence（0 次丢失）
- WS_EX_TRANSPARENT persistence（0 次丢失）
- full-window mouse hit-test pass（90 点整窗扫描 0 命中；soak 内 1593 次命中 0 次命中 AM）
- left / right / wheel input pass（B+ 真实合成输入：9/9 点左键、9/9 点右键、3/3 点滚轮被下层窗口收到）
- UIA root / query / interaction（SetFocus、ScrollItemPattern.ScrollIntoView、SelectionItemPattern.Select）
- UIA page navigation（9 次换页扰动）
- playback / SMTC continuity（provider 全程在线，状态恒为 Playing，连续 10 首）
- window move / resize（2584x1540 ↔ 200,150 1914x900，各 4 帧）
- restore procedure（配方 + 严格还原 + 终检；另有一次真实中断事故用 `-RestoreOnly` 成功恢复）
- 30-minute soak（NO_VIOLATION，判据见 REPORT-SOAK.md）

## Not verified（没有数据，不要当成通过）

- dynamic DPI switching（本轮 DPI 恒为 168，未扰动）
- multi-monitor hot-plug（本轮虚拟屏恒为 0,0 2560x1600，本机无第二块屏）
- keyboard / focus isolation（**已观察到窗口可持有前台**，未做键盘归属实验）
- Alt-Tab
- taskbar
- long-term z-order behavior
- \>30 min / sleep-wake persistence

## Out of scope（明确不属于本实验）

- MineRadio mainline（`desktop/apple-music-control.js`、play-song/play-playlist 播放链、SMTC store）
- SMTC timeline / lyrics / currentPlaybackContext / playQueue
- Apple Music binary / 安装目录 / 注册表修改
- injection / hook / DLL
- watchdog
- product integration（产品化封装另开 `experiment/apple-music-alpha1-product/`）

## 最重要的限制（产品化设计必读）

**WS_EX_TRANSPARENT 实现的是鼠标命中穿透，不等于键盘焦点隔离。**

30 分钟 soak 的 180 次采样中，有 **121 次 `GetForegroundWindow()` 仍然是 Apple Music**（窗口完全不可见、鼠标穿透，
但依然可以持有前台；多发生在 SW_MAXIMIZE 之后）。也就是说：

- 鼠标：不会打到这个幽灵窗口（已验证）
- 键盘：仍可能进入 Apple Music（未验证 / 需专门设计）
- 任务栏、Alt-Tab、z-order 中它依然存在（未验证）

因此不要把它描述成「完全不被感知」；准确说法是「视觉不可见 + 鼠标穿透 + 可 UIA 控制 + 仍在播放」。

## 复现（脚本与命令）

| 用途 | 命令 |
|---|---|
| 只读观察（安全默认） | `run-alpha-probe.ps1 -ObserveOnly` |
| Alpha=1 / Alpha=0 | `run-alpha-probe.ps1 -Apply -Alpha 1` \| `-Alpha 0` |
| UIA 交互压力 | `run-alpha-probe.ps1 -Apply -StressUia` |
| 单点点击穿透对照 | `run-click-through.ps1` |
| 整窗扫描 + 多输入 | `run-clickthrough-sweep.ps1 -Grid 240 -InputPoints 9` |
| 长跑 Soak | `run-stealth-soak.ps1 -Minutes 30 -IntervalSec 10 -NavEverySec 180 -ResizeCount 4`（**必须后台启动**，`run_code` 自身 timeout 要覆盖内层时长） |
| 事故恢复 | `run-alpha-probe.ps1 -RestoreOnly -From reports/<stamp>.restore.json` |
| 语法自检 | `tools/parse-check.ps1` |
| 只读窗口探针 | `tools/probe-window-state.ps1` |

纪律：任何施加型脚本都先写 `reports/<stamp>.restore.json` 配方，`finally` 内 alpha→255、清 LAYERED/TRANSPARENT、
恢复原始 exStyle、按实验前状态 SW_MINIMIZE；`experiment/apple-music-windows-control/poc/lib/**` 冻结链始终零改动。

## 后续（不在本 checkpoint 内）

产品化从本 checkpoint 新开 `experiment/apple-music-alpha1-product/`：
第一版只解决「开/关隐身 + 保存原状态 + 可靠恢复」，之后再单独讨论键盘焦点、Alt-Tab、任务栏、z-order；
**先不做 watchdog**（避免把实验变量与产品机制混在一起）。
