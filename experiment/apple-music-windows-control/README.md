# experiment/apple-music-windows-control

**一次性侦察实验（已结束）**：研究 Windows 版 Apple Music 客户端是否存在可供本地应用调用的
「精准点歌 / 播放指定歌曲」接口。

- 分支：`experiment/apple-music-windows-control`
- 结论与完整报告：**[`findings/REPORT.md`](findings/REPORT.md)**
- 一句话结论：**未发现可可靠调用的官方精准点歌接口**；唯一可落地路径是 UI Automation 驱动其自身窗口，
  已 PoC 成功（Song ID `1603171530` 实际播放，端到端实测 2641 ms）。

## 目录结构

```
recon/      14 个只读侦察脚本（01 基础 → 14 结束状态），可重复运行
findings/   原始证据文本、AppxManifest 导出、PoC 截图、REPORT.md
```

`recon/*.ps1` 全部为 **ASCII-only**（Windows PowerShell 5.1 会把无 BOM 的 UTF-8 `.ps1` 当 ANSI 解析），
并且只做只读探测 + 合成输入，不改动系统设置。

## 如何重跑

```powershell
# 全部只读，逐个执行；每个脚本把结果写入 findings/
powershell -ExecutionPolicy Bypass -File .\recon\01-install-and-protocols.ps1
...
powershell -ExecutionPolicy Bypass -File .\recon\13-latency-and-search.ps1

# 结束状态检查（读取 SMTC 会话、确认无 WebView2 子进程）
powershell -ExecutionPolicy Bypass -File .\recon\14-final-state.ps1
```

注意：`09`–`13` 会真实操作 Apple Music（前台化、深链导航、UIA 点击），属于「对用户自己的应用做 UI 自动化」，
不会修改任何应用文件或系统设置。运行前请确保已登录 Apple Music 且歌曲在媒体库中可达。

## 隔离与安全边界

- **不改动 MineRadio 主线**：实验期间未修改 `main` 上任何文件（`desktop/`、`public/`、歌词/播放核心均未触碰）；
  `desktop/smtc-bridge.ps1` 仅被读取，用作 WinRT `Await` 调用方式的参考。
- 未新增 npm 依赖。
- 未进行逆向、注入、内存读取或二进制 patch；未接触 Apple ID 口令 / cookie / 会话令牌；未触碰 DRM（FairPlay）与音频解密。
- 未写入注册表、未安装服务、未更改协议或播放器默认项。

## 完全移除

```powershell
git checkout main
git branch -D experiment/apple-music-windows-control   # 若不需要保留
Remove-Item -Recurse -Force .\experiment\apple-music-windows-control
```

无系统级残留；实验启动的 Apple Music 实例可自行关闭。
