# MineRadio（Apple Music Edition）

> Windows 沉浸式音乐播放器：Apple Music（SMTC）实时同步、原生音频可视化、FFT 频谱分析、粒子视觉舞台、专辑封面与多源双语歌词。

> **本仓库是基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的二次开发（fork）版本**，在原 MineRadio 基础上新增 Apple Music（Windows SMTC）接入、原生音频可视化、专辑封面、播放控制与多源歌词等能力。原项目的版权归原作者/原项目所有者所有，详见下文「[项目来源与二次开发声明](#项目来源与二次开发声明)」。

MineRadio 是一款 Windows 桌面沉浸式音乐播放器。本分支聚焦 **Apple Music for Windows** 的外部接入：MineRadio 只做「媒体状态监听（SMTC）+ 歌词匹配 + 视觉呈现」，音频与播放完全由 Apple Music 自己负责——不需要任何第三方音频直链，也不触碰 DRM。

---

## 目录

- [项目来源与二次开发声明](#项目来源与二次开发声明)
- [主要改动](#主要改动)
- [Apple Music Windows 接入原理](#apple-music-windows-接入原理)
- [SMTC Bridge](#smtc-bridge)
- [Native Audio Capture](#native-audio-capture)
- [FFT 音频分析](#fft-音频分析)
- [Visualizer / 粒子视觉](#visualizer--粒子视觉)
- [专辑封面](#专辑封面)
- [播放控制](#播放控制)
- [多源歌词（QQ → 酷狗 → 网易云）](#多源歌词qq--酷狗--网易云)
- [双语歌词](#双语歌词)
- [核心特性](#核心特性)
- [Windows 环境要求](#windows-环境要求)
- [Electron / Node.js 要求](#electron--nodejs-要求)
- [安装与运行](#安装与运行)
- [构建方法](#构建方法)
- [已知限制](#已知限制)
- [用户数据与隐私](#用户数据与隐私)
- [第三方音乐平台说明](#第三方音乐平台说明)
- [致谢](#致谢)
- [License](#license)

---

## 项目来源与二次开发声明

- 本项目（MineRadio Apple Music Edition）是**基于原 MineRadio 项目（[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)）的二次开发版本**，不是从零独立开发。
- 原 MineRadio 项目及其原始代码的版权归原作者（XxHuberrr）所有；本项目保留原项目全部版权声明、许可证文本与 NOTICE。
- 本项目在原项目基础上进行了功能扩展与修改，包括但不限于：Apple Music（Windows SMTC）外部播放状态接入、原生 WASAPI 音频可视化、FFT 频谱分析、专辑封面获取、SMTC 播放控制、多源歌词（QQ 音乐 / 酷狗音乐 / 网易云音乐）、双语歌词翻译与歌词源优先级设置等。
- **本项目与 Apple Inc. 没有官方关联，也不是 Apple 官方软件。** Apple Music、Apple 等相关商标及服务名称归其各自权利人所有。
- 原项目许可证（GPL-3.0）继续适用于原始代码部分；本仓库整体按仓库内 [LICENSE](./LICENSE)（GPL-3.0）授权，详见「[License](#license)」。

## 主要改动

本项目在保留原 MineRadio 全部既有功能（搜索播放、歌词舞台、粒子视觉、3D 歌单架、桌面模式、多平台登录等）的基础上，实际新增并验证的功能：

- **Apple Music（Windows SMTC）外部接入**：监听系统媒体会话，实时同步歌名 / 歌手 / 专辑 / 播放状态 / 进度（`desktop/smtc-bridge.ps1`，PowerShell 5.1 + WinRT）
- **SMTC 播放控制**：上一首 / 播放 / 暂停 / 下一首（官方 `TryXXXAsync`，与 Apple Music 解耦）
- **专辑封面**：SMTC 优先，iTunes Search API 兜底 + 会话内缓存 + 快速切歌防串台
- **原生音频可视化**：WASAPI Process Loopback 采集 `AMPLibraryAgent.exe` 音频（`desktop/native/MineRadioAudioCapture.cpp`，源码随仓库提供）
- **FFT 频谱分析**：64 频段频谱 + bass / mid / treble，驱动粒子与视觉
- **多源歌词**：QQ 音乐 → 酷狗音乐 → 网易云音乐，严格优先级 fallback，可拖动排序 / 启用禁用 / 持久化
- **双语歌词**：原文 + 中文翻译双行显示；主源无翻译时自动从网易云 `tlyric` 补齐
- **歌词竞态防护**：切歌时旧歌曲的晚到歌词/封面不会覆盖新歌曲


## Apple Music Windows 接入原理

Apple Music for Windows 通过系统级的 **Windows SMTC（System Media Transport Controls）** 广播当前播放状态（歌名/歌手/专辑/进度/播放状态）。MineRadio 不做播放，只监听 SMTC：

```
Apple Music（播放/暂停/切歌）
        ↓ Windows SMTC
MineRadio SMTC Bridge（PowerShell + WinRT）
        ↓ stdout JSON
主进程（状态解析 / 封面 / 播放控制 IPC）
        ↓ IPC
渲染层（歌词匹配 / 视觉 / 粒子 / 封面 / 控制按钮）
```

MineRadio 与 Apple Music 完全解耦：关闭 Apple Music 只影响 SMTC 状态，MineRadio 自身播放器照常工作。

## SMTC Bridge

`desktop/smtc-bridge.ps1` 使用 Windows PowerShell 5.1 + WinRT `GlobalSystemMediaTransportControlsSessionManager`，通过事件驱动读取当前 active media session：

- `MediaPropertiesChanged` → 歌名 / 歌手 / 专辑
- `PlaybackInfoChanged` → 播放 / 暂停状态
- `TimelinePropertiesChanged` → 播放进度

Bridge 以 **stdout JSON-lines** 与主进程通信（`{"type":"state",...}`），并接受 **stdin JSON 控制命令**（`{"command":"play|pause|toggle|next|previous"}`）调用官方 `TryXXXAsync()` 方法。

## Native Audio Capture

音频可视化不依赖浏览器音频 API：主进程启动原生辅助进程 `MineRadioAudioCapture.exe`（`desktop/native/MineRadioAudioCapture.cpp`，源码随仓库提供），通过 **WASAPI Process Loopback** 采集目标进程（`AMPLibraryAgent.exe`——Apple Music 实际渲染音频的进程）的音频数据：

```
AMPLibraryAgent.exe（音频渲染）
        ↓ WASAPI Process Loopback（真实默认渲染端点 + IAgileObject）
MineRadioAudioCapture.exe（原生 C++，静态链接）
        ↓ stdout JSONL（rms / bass / mid / treble / 64 频段 spectrum，~20Hz）
主进程 → IPC → 渲染层 AudioAdapter
        ↓
粒子 / 视觉着色器
```

辅助进程与音频采集逻辑与 MineRadio 主程序完全隔离：任何采集失败只会让视觉回到非响应状态，不影响 SMTC / 歌词 / 封面 / 控制。

## FFT 音频分析

`MineRadioAudioCapture.exe` 内部对采集到的 PCM 做 **FFT**，映射为 64 个对数频段，聚合出 `bass / mid / treble` 与频谱，经音频 IPC 进入渲染层，驱动粒子强度、beat 检测与视觉能量场。渲染层有严格的数值卫生（无 NaN/Infinity）与静默降级。

## Visualizer / 粒子视觉

- 粒子舞台与歌词舞台共用 WebGL 渲染管线
- 封面纹理（来自当前播放歌曲）驱动粒子颜色、浮色与背景渐变
- 音频指标驱动粒子运动、burst 与节奏镜头系统
- 分辨率可调（256/384/512 纹理），内置 AI 深度封面增强（可选）

## 专辑封面

- SMTC 可提供的封面优先（PS 5.1 下不可用时自动降级）
- 兜底走 **iTunes Search API**（公开接口，按 `artist + title` 搜索取 `artworkUrl100` → 提升到 300×300）
- 会话内内存缓存（identity 键 `aumid|title|artist|album`，LRU 上限 100）+ 发送去重 + 请求 in-flight 去重 + 旧请求 identity 校验（快速切歌不串台）
- 封面同时驱动右上角 UI 胶囊与 Visualizer 背景粒子纹理（同一 `applyCoverCanvas` 入口）

## 播放控制

右上角提供 `上一首 / 播放暂停 / 下一首` 按钮，通过 SMTC 官方 `TrySkipPreviousAsync / TryPlayAsync / TryPauseAsync / TrySkipNextAsync` 控制 Apple Music：

- 按钮状态只由 SMTC 事件回推（`isPlaying`），点击后不本地改状态
- 无 active session 或内部播放器播放时按钮禁用
- 主进程侧命令队列防抖（快速连续点击不堆积、不阻塞）

## 多源歌词（QQ → 酷狗 → 网易云）

默认优先级：

1. **QQ 音乐**
2. **酷狗音乐**
3. **网易云音乐**

- 严格按用户设置顺序 fallback：网络错误 / API 错误 / 无结果 / 歌词为空 / 解析失败 / 匹配度过低 → 自动下一源
- 每个源：`enabled / name / id / priority / search() / getLyrics()`，复用现有解析器（LRC/YRC/逐字）
- 标题/艺术家规范化：去 `Remix / Live / Radio Edit` 等版本后缀、处理 `feat./ft./with`、大小写、全角/半角、异常 Unicode；候选按匹配度评分，不盲取第一条
- 异步竞态：`generationId` 校验，切歌时旧歌曲的晚到结果不会覆盖新歌曲
- 右上角「词源」按钮可打开优先级设置面板：拖动排序、启用/禁用、恢复默认（localStorage 持久化）
- 歌词来源显示在状态胶囊：`歌词已同步 · 歌词来源：QQ 音乐`

## 双语歌词

- 原文 + 中文翻译双行显示（翻译行数可少于原文、无翻译自动降级为仅原文）
- 主源（QQ/酷狗）无翻译时，自动从网易云 `tlyric` 补齐（时序 + 顺序双策略配对）
- 渲染模式可调：`译文 / 当前 / 双行 / 多行 / 关闭`
- 逐字（YRC/词级）卡拉OK保留

## 核心特性

- Apple Music（SMTC）实时同步：歌名/歌手/进度/播放状态
- SMTC 播放控制（上一首/播放暂停/下一首）
- 原生 WASAPI 进程回环音频采集 + FFT 频谱（bass/mid/treble）
- 粒子视觉舞台、歌词舞台、3D 歌单架、节奏镜头
- 专辑封面（SMTC → iTunes Search 兜底 + 缓存）驱动视觉
- 多源歌词（QQ/酷狗/网易云）+ 双语翻译 + 歌词源优先级
- 完整桌面模式、本地 MP4 / Wallpaper Engine 视觉
- 网易云 / QQ / 酷狗 / 汽水 / Spotify 登录与音源补充接入

## Windows 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（x64） |
| PowerShell | Windows PowerShell 5.1（系统自带，无需安装） |
| Apple Music | Apple Music for Windows（[Microsoft Store](https://apps.microsoft.com/detail/9pfhdd2n4n4p)） |
| 音频 | WASAPI 默认渲染端点可用 |

> 音频采集需要目标系统存在可用的渲染端点；Apple Music 需处于播放状态（Session 激活）后采集才会启动。

## Electron / Node.js 要求

| 项 | 版本 |
| --- | --- |
| Electron | 42.4.x |
| Node.js | 18+（开发构建用） |
| electron-builder | 26.x |

无需 `npm install` 也可以直接运行已打包版本；源码构建需要 Node.js 18+ 与 npm。

## 安装与运行

### 预打包版本

下载 `Mineradio-2.1.0-Setup.exe`（NSIS 安装包）或 `Mineradio 2.1.0.exe`（portable），运行即可。安装包会创建桌面快捷方式。

### 源码运行

```bash
npm install
npm start
```

### 使用

1. 打开 Apple Music for Windows 并播放一首歌
2. MineRadio 自动检测 SMTC 会话：状态胶囊显示歌名/歌手/进度/歌词来源
3. 歌词/封面/粒子视觉随歌曲自动同步
4. 右上角控制按钮可暂停/播放/切歌

## 构建方法

### Electron 应用

```bash
npm run build:win        # NSIS 安装包
npm run dist             # NSIS + portable
npm run dist:portable    # portable
```

产物位于 `dist/`。

### 原生音频采集辅助进程

`MineRadioAudioCapture.exe` 由仓库内源码 `desktop/native/MineRadioAudioCapture.cpp` 构建（`#define INITGUID` + `-lole32 -luuid`，静态链接）。仓库**不提交二进制**，运行预打包版本已内置；从源码构建时：

```bash
cd desktop/native
build.bat
```

`build.bat` 自动定位编译器（环境变量 `W64DEVKIT_GXX` → 常见 w64devkit 安装位置 → `PATH` 中的 `g++`，或 MSVC `cl`）。诊断工具源码（`AudioProbe / SessionProbe / RenderProbe / PathProbe / SinePlayer / LoopbackSelfTest`）同样随仓库提供。

### Apple Music 开发者凭据（可选）（未经过验证，谨慎使用）

搜索页签与登录面板需要 MusicKit 开发者凭据（可选用环境变量或配置文件注入，详见上文 SMTC 接入说明）：

| 环境变量 | 含义 |
| --- | --- |
| `APPLE_MUSIC_TEAM_ID` | Team ID |
| `APPLE_MUSIC_KEY_ID` | MusicKit Key ID |
| `APPLE_MUSIC_PRIVATE_KEY` | P8 私钥内容（或指向 .p8 文件路径） |
| `APPLE_MUSIC_STOREFRONT` | 地区代码，默认 `us` |
| `APPLE_MUSIC_TOKEN_FILE` | music user token 保存路径 |
| `APPLE_MUSIC_CONFIG_FILE` | 凭据保存路径 |

配置文件模板见 [`.apple-music-credentials.example.json`](./.apple-music-credentials.example.json)。**SMTC 歌词同步不依赖任何 Apple 开发者凭据。**

## 已知限制

- **不提供 Apple Music 音频直链/下载**：Apple Music 官方 API 不向第三方提供无 DRM 完整音频；音频播放由 Apple Music 自身负责，MineRadio 只做视觉/歌词/封面
- **专辑封面**：PS 5.1 无法直接读取 SMTC Thumbnail 流，封面走 iTunes Search 兜底（公开接口），个别冷门歌曲可能搜不到封面
- **音频采集**：依赖系统默认渲染端点与 Apple Music 会话激活；采集失败时视觉自动降级为无响应状态
- **歌词**：QQ/酷狗对部分歌曲（尤其英文歌）不返回翻译，此时自动从网易云补齐或降级为仅原文
- 未签名安装包可能触发 SmartScreen 提示（小众 Electron 软件常见），请从官方 Release 下载并确认文件名

## 用户数据与隐私

登录 Cookie、搜索历史、自定义封面、自定义歌词、节奏分析缓存、Apple Music 凭据与 music user token **只保存在本机用户数据目录**（例如 `.apple-music-credentials.json` / `.apple-music-token.json`），不会上传，也不会提交到仓库。music user token 属于敏感凭据，请勿分享。

更多说明见 [PRIVACY.md](./PRIVACY.md)。

## 第三方音乐平台说明

MineRadio 不是网易云音乐、QQ 音乐、酷狗音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。

## 致谢

原 MineRadio 由 XxHuberrr 主要设计与打造。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢。同时感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。

本二次开发版本的 Apple Music（SMTC）接入、原生音频可视化、多源歌词等功能由本仓库维护者完成；对原项目作者及所有社区贡献者表示感谢。

## License

Copyright (C) 2026 XxHuberrr.

本项目采用 **GPL-3.0** 授权。详见 [LICENSE](./LICENSE)。

MR Logo、Mineradio 名称、界面视觉设计与原创视觉表达归作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。
