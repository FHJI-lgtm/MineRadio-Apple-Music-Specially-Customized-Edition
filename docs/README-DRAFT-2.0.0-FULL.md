# MineRadio · Apple Music 特别定制版

> 让音乐不止于播放，也成为桌面的一部分。

MineRadio Apple Music 特别定制版是基于 MineRadio 持续开发的定制版本，围绕 **Windows 桌面音乐体验、Apple Music 资料库浏览、实时歌词与沉浸式粒子视觉** 进行扩展。

我们希望将音乐播放、歌曲信息、歌词和动态视觉整合到一个连贯的桌面体验中，让听歌不再只是一个后台播放过程。

> **本仓库是基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的二次开发（fork）版本**，在原 MineRadio 基础上新增 Apple Music（Windows）资料库浏览与播放控制、原生音频可视化、专辑封面、多源歌词等能力。原项目版权归原作者/原项目所有者所有，详见下文「[项目来源与二次开发声明](#项目来源与二次开发声明)」。

---

## ✨ 项目特色

### 🎵 Apple Music 资料库

* 浏览音乐资料库中的**专辑、艺人与歌单**，查看专辑作品与艺人详情。
* 展示艺人头像、流派及可获取的简介信息，把音乐资料与现有播放交互连接起来。
* 歌单详情支持 **播放歌单** 与 **随机播放**（直接驱动 Apple Music 自己的播放按钮）。

### 🎤 实时歌词

* 获取并显示与当前播放歌曲匹配的歌词，支持多个歌词数据源的匹配与回退。
* 为歌词舞台与音乐视觉提供歌曲及时间信息。

### 🌌 沉浸式视觉舞台

* 基于专辑封面与音频数据呈现动态粒子视觉，延续 MineRadio 原有的视觉舞台设计与交互体验。

### 🖥️ Windows 桌面集成

* 通过 Windows **SMTC** 获取系统媒体会话信息，结合系统媒体控制与现有桌面交互实现播放状态展示及控制。
* **Apple Music 隐身模式**：被控制的 Apple Music 窗口视觉隐藏（Alpha=1 + 鼠标穿透），不再占据桌面。

---

## 目录

- [✨ 项目特色](#-项目特色)
- [项目来源与二次开发声明](#项目来源与二次开发声明)
- [主要改动](#主要改动)
- [Apple Music 接入原理](#apple-music-接入原理)
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
- [📌 项目状态](#-项目状态)
- [⚠️ 说明](#️-说明)
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
- **多源歌词**：QQ 音乐 → 酷狗音乐 → 网易云音乐，严格优先级 fallback，可拖动排序 / 持久化
- **双语歌词**：原文 + 中文翻译双行显示；主源无翻译时自动从网易云 `tlyric` 补齐
- **歌词竞态防护**：切歌时旧歌曲的晚到歌词/封面不会覆盖新歌曲
### v2.0.0 新增
- **Apple Music 资料库**：歌单 / 艺人 / 专辑 / 喜爱歌曲浏览，歌单详情支持播放与**随机播放**。
- **Apple Music 播放控制**：单曲 / 专辑 / 歌单 / 随机播放，SMTC 真实状态校验，播放后自动最小化。
- **Apple Music 隐身模式**：Alpha=1 + 鼠标穿透 + 看门狗 + 播放门控，默认开启。
- 音源凭证改为 **Apple Music Web `media-user-token`**；开发者账号轴（Team ID / Key ID / P8）已整体退休。

---

## Apple Music 接入原理

> 本版已改写：早期仓库文档写的是「MineRadio 不做播放，只监听 SMTC」，那已不再准确 —— 现在的 MineRadio 既能**看到**，也能**控制**。

### 1) 状态监听：Windows SMTC（只读）

Apple Music for Windows 通过系统级 **SMTC** 广播当前播放状态（歌名 / 歌手 / 专辑 / 进度 / 播放状态）。

```text
Apple Music（播放/暂停/切歌）
        |  Windows SMTC（System Media Transport Controls）
        v
desktop/smtc-bridge.ps1（PowerShell 5.1 + WinRT）
        |  stdout JSON
        v
主进程（状态解析 / 封面 / 播放控制 IPC）
        |  IPC
        v
渲染层（歌词匹配 / 视觉 / 粒子 / 封面 / 控制按钮）
```

* SMTC 提供曲名、艺人、专辑、进度与播放状态 —— **这是「现在在放什么」的唯一事实来源**。
* 播放 / 暂停 / 上一首 / 下一首通过 SMTC 会话控制发送。

### 2) 播放控制：UIA 驱动 + SMTC 校验

```text
用户点「播放歌单 / 随机播放 / 播放专辑」
        |  IPC（播放期间临时摘掉隐身透明位）
        v
PowerShell 链条（experiment/apple-music-windows-control/poc/**）
        |  ① 搜索歌单/专辑 → ② 选中正确范围与卡片 → ③ 进入目标页面
        |  ④ 定位目标行/按钮（UIA AutomationId + 名称 + 几何校验）
        |  ⑤ 语义点击一次（Invoke）或受控双击（歌单行）
        |  ⑥ 立即把窗口交还桌面（自动最小化）
        v
SMTC 再次读取 → 只有「真的切歌了」才算成功（verified）
```

* **不谎报**：只有 SMTC 确认播放身份后才算成功；失败时返回明确阶段（如 `SMTC_WRONG_TRACK`、`NO_JSON`）。
* **随机播放**：驱动 Apple Music 歌单页自己的「随机播放」按钮，并用随机开关的状态 + SMTC 双重确认。
* **自动最小化**：所有播放路径（单曲 / 专辑 / 歌单 / 随机播放）播放后都会把 Apple Music 交还桌面。

### 3) 资料库数据：Apple Music Web 接口（`media-user-token`）

资料库页面（歌单 / 艺人 / 专辑 / 喜爱歌曲）由主进程提供的本地只读接口驱动，例如：

```text
/api/apple/user/playlists        歌单列表
/api/apple/playlist/tracks       歌单曲目（分页取全）
/api/apple/library/albums        专辑列表
/api/apple/library/album/tracks  专辑曲目
/api/apple/library/artists       艺人列表
/api/apple/library/artist/detail 艺人详情（头像 / 流派 / 简介）
```

* 数据通过 **Apple Music Web 接口**取得：请求使用 **Bearer + `media-user-token`**（网页登录凭证）；
  凭证由 `desktop/apple-music-lyrics-credential.js` 管理，**只保存在本机**。
* **开发者账号轴（Team ID / Key ID / P8 → ES256 JWT → `/v1/me/*`）已整体退休** —— 现在不需要 Apple 开发者密钥，
  只需要你自己的 Apple Music 账号在网页侧的登录凭证。
* `/api/apple/logout` 只做清理（删除历史遗留的 `.apple-music-token.json`，只删不读）。
* 设置里的「Apple Music 账户设置」= **登录 / 凭证入口** + 连接状态 + 隐身模式开关。

### 4) 隐身模式（默认开启，可关闭）

* 窗口属性 `Alpha=1` + `WS_EX_LAYERED` + `WS_EX_TRANSPARENT`：视觉隐藏与鼠标穿透，同时保留 UIA 控制能力。
* **看门狗**：每秒校验窗口属性，丢失即修复（alpha / 透明位 / 分层位 / 多属性丢失 / 窗口换新）；失败按 1s→30s 退避，超限安全停机并恢复窗口。
* **播放门控**：控制播放期间临时摘掉透明位（播放链依赖真实点击操作 Apple Music），结束（含失败）必定戴回。
* 用户手动唤起 / 操作 Apple Music 时自动退出隐身；MineRadio 退出时自动恢复窗口。

### 5) 音频响应视觉

* 通过原生音频捕获（`desktop/smtc-audio-capture.ps1` + `native/MineRadioAudioCapture.exe`）取回系统播放音频，用于 FFT 频谱与粒子响应。
* 音频只用于视觉呈现，不落盘、不转发。

---

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

辅助进程与音频采集逻辑与 MineRadio-Apple-Music-Specially-Customized-Edition 主程序完全隔离：任何采集失败只会让视觉回到非响应状态，不影响 SMTC / 歌词 / 封面 / 控制。


## FFT 音频分析


`MineRadioAudioCapture.exe` 内部对采集到的 PCM 做 **FFT**，映射为 64 个对数频段，聚合出 `bass / mid / treble` 与频谱，经音频 IPC 进入渲染层，驱动粒子强度、beat 检测与视觉能量场。渲染层有严格的数值卫生（无 NaN/Infinity）与静默降级。


## Visualizer / 粒子视觉


- 粒子舞台与歌词舞台共用 WebGL 渲染管线
- 封面纹理（来自当前播放歌曲）驱动粒子颜色、浮色与背景渐变
- 音频指标驱动粒子运动、burst 与节奏镜头系统


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
除 SMTC 会话控制外，本版新增 **UIA 驱动的播放控制**：单曲 / 专辑 / 歌单 / 歌单随机播放，
由 PowerShell 链条在 Apple Music 内搜索并定位目标，执行一次语义点击，再用 SMTC 校验最终播放身份（详见[接入原理](#apple-music-接入原理)）。

---

## 多源歌词（QQ → 酷狗 → 网易云）


默认优先级：

1. **QQ 音乐**
2. **酷狗音乐**
3. **网易云音乐**

- 严格按用户设置顺序 fallback：网络错误 / API 错误 / 无结果 / 歌词为空 / 解析失败 / 匹配度过低 → 自动下一源
- 每个源：`enabled / name / id / priority / search() / getLyrics()`，复用现有解析器（LRC/YRC/逐字）
- 标题/艺术家规范化：去 `Remix / Live / Radio Edit` 等版本后缀、处理 `feat./ft./with`、大小写、全角/半角、异常 Unicode；候选按匹配度评分，不盲取第一条
- 异步竞态：`generationId` 校验，切歌时旧歌曲的晚到结果不会覆盖新歌曲
- 右上角「词源」按钮可打开优先级设置面板：拖动排序、恢复默认（localStorage 持久化）
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

下载 `MineRadio-Apple-Music-Specially-Customized-Edition-1.1-Setup.exe`（NSIS 安装包）或 `MineRadio-Apple-Music-Specially-Customized-Edition 1.1.exe`（portable），运行即可。安装包会创建桌面快捷方式。

### 源码运行

```bash
npm install
npm start
```

### 使用

1. 打开 Apple Music for Windows 并播放一首歌
2. MineRadio-Apple-Music-Specially-Customized-Edition 自动检测 SMTC 会话：状态胶囊显示歌名/歌手/进度/歌词来源
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
- 歌词同步
由于 Apple Music for Windows 的播放进度和媒体状态通过 Windows SMTC
（System Media Transport Controls）提供，在切歌、拖动进度条或播放状态快速变化
时，SMTC 可能出现短暂的时间轴延迟、跳变或事件乱序。
因此，MineRadio-Apple-Music-Specially-Customized-Edition 的歌词显示在极少数情况下可能出现短暂的歌词跳行、回跳或同步
延迟。该问题属于 Apple Music / Windows SMTC 播放状态同步链路的已知限制，
MineRadio-Apple-Music-Specially-Customized-Edition 无法完全控制其上游数据质量。
如果出现短暂不同步，通常会在 SMTC 状态恢复后自动重新同步。
* 播放控制目前仅支持 **Apple Music for Windows** 作为音源；其它音乐源（QQ / 酷狗 / 网易云等）接入**排期 2.1.0**。
* 播放控制依赖 UIA 与 SMTC，Apple Music 客户端界面更新可能导致个别入口需要适配。

---

## 📌 项目状态

项目仍在持续开发中。资料库浏览、艺人详情、歌词与视觉舞台等功能会继续迭代，部分功能的兼容性和数据覆盖率可能因歌曲、系统环境及外部服务而异。

**当前版本：v2.0.0**（播放控制 + 资料库 + 隐身模式）。后续将继续完善资料库体验与**多音乐源整合（排期 2.1.0）**。
---

## ⚠️ 说明

* 本项目为 MineRadio 的社区定制版本，不代表 Apple 或其他音乐平台的官方产品。
* Apple Music 相关功能依赖相应的客户端环境、账号状态及可用服务。
* 第三方服务的可用性、数据覆盖率与接口行为可能发生变化。
* 请遵守相关平台的用户协议、版权规则及适用法律。
* 项目的实际功能、许可证与第三方依赖说明以仓库中的对应文件为准。
---

## 用户数据与隐私

* Apple Music 登录凭证（`media-user-token`）**只保存在本机**，仅用于访问资料库与歌词；**不上传、不外传**。
* MineRadio 内部**不内置任何 Apple 密钥**；退出登录时会清除本地凭证（`/api/apple/logout`）。
* 音频捕获仅用于实时视觉，不落盘、不转发。
* 发布产物中不包含任何账号 / 令牌数据。

---

## 第三方音乐平台说明


MineRadio-Apple-Music-Specially-Customized-Edition 不是网易云音乐、QQ 音乐、酷狗音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。


## 致谢


原 MineRadio 由 XxHuberrr 主要设计与打造。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢

本二次开发版本的 Apple Music（SMTC）接入、原生音频可视化、多源歌词等功能由本仓库维护者完成；对原项目作者及所有社区贡献者表示感谢。


## License


Copyright (C) 2026 XxHuberrr.

本项目采用 **GPL-3.0** 授权。详见 [LICENSE](./LICENSE)。

MR Logo、Mineradio 名称、界面视觉设计与原创视觉表达归原作者所有；第三方依赖和第三方服务分别遵循其各自授权与服务条款。

