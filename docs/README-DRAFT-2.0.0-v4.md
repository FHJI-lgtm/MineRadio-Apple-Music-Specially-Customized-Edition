# MineRadio · Apple Music 特别定制版

> 让音乐不止于播放，也成为桌面的一部分。

MineRadio Apple Music 特别定制版是基于 MineRadio 持续开发的定制版本，围绕 **Windows 桌面音乐体验、Apple Music 资料库浏览、实时歌词与沉浸式粒子视觉** 进行扩展。

我们希望将音乐播放、歌曲信息、歌词和动态视觉整合到一个连贯的桌面体验中，让听歌不再只是一个后台播放过程。

> **本仓库是基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的二次开发（fork）版本**，原项目版权归原作者及原项目所有者所有，详见下文声明与 License。

---

## 📸 界面一览

| | |
|---|---|
| <img src="docs/assets/readme/music-library-albums.webp" width="420" alt="音乐资料库"> | <img src="docs/assets/readme/playlist-detail.png" width="420" alt="歌单详情"> |
| **音乐资料库**：专辑 / 艺人 / 歌单浏览 | **歌单详情**：播放歌单 + 随机播放 |
| <img src="docs/assets/readme/album-detail.png" width="420" alt="专辑详情"> | <img src="docs/assets/readme/artist-detail.webp" width="420" alt="艺人详情"> |
| **专辑详情**：曲目列表 + 播放专辑 | **艺人详情**：头像 / 流派 / 简介（简介来源会在界面上标注） |
| <img src="docs/assets/readme/lyrics-stage.png" width="420" alt="歌词舞台"> | |
| **歌词舞台**：双语歌词 + 粒子视觉（叠加在资料库之上） | |

> 截图来自 v2.0.0 实际界面。

---

## 🎮 功能一览

### 🎵 Apple Music 资料库
* 浏览资料库中的**专辑、艺人与歌单**，查看专辑作品与艺人详情（头像 / 流派 / 简介，来源见技术章节）。
* 歌单详情支持 **播放歌单** 与 **随机播放**（直接驱动 Apple Music 自己的播放按钮）。

### ▶️ Apple Music 播放控制（v2.0.0 新增）
* 单曲 / 专辑 / 歌单 / 随机播放；**以 SMTC 真实状态判定是否真的切歌**，播放后自动把 Apple Music 交还桌面。
* **Apple Music 窗口可在受控状态下隐藏**（隐身模式，默认开启）：平时 Apple Music 不显示在桌面上；
  执行播放控制期间窗口状态会被**临时调整**以便完成点击，结束后**恢复隐身**。技术细节见「Apple Music 接入原理」。

### 🎤 实时歌词
* 多源匹配与回退（QQ / 酷狗 / 网易云 + Apple Music Web 私有歌词），支持双语。

### 🌌 沉浸式视觉舞台
* 原生音频捕获 → FFT 频谱 → 粒子 / beat 视觉；专辑封面补齐。

### 🖥️ Windows 桌面集成
* SMTC 媒体会话、桌面模式、3D 歌单架、壁纸引擎兼容等原有能力保持。
## 💾 下载与安装

从 [Releases](https://github.com/FHJI-lgtm/MineRadio-Apple-Music-Specially-Customized-Edition/releases) 下载**当前版本 v2.0.0**：

* `MineRadio-Apple-Music-Specially-Customized-Edition-2.0.0-Setup.exe` —— 安装版（NSIS）
* `MineRadio-Apple-Music-Specially-Customized-Edition-2.0.0.exe` —— 免安装（portable）

* 环境：Windows 10/11；播放控制需已安装并**登录** Apple Music（Windows 版）。
* 未签名安装包可能触发 SmartScreen 提示（小众 Electron 软件常见），请从官方 Release 下载并核对文件名。

## ⚠️ 已知限制

* **播放控制仅支持 Apple Music for Windows** 作为音源；其它音乐源（QQ / 酷狗 / 网易云等）的完整资料库与播放控制**排期 2.1.0（计划功能）**。
* 播放控制依赖 UIA 与 SMTC，Apple Music 客户端界面更新可能导致个别入口需要适配。
* 不提供 Apple Music 音频直链/下载；音频播放由 Apple Music 自身负责，MineRadio 只做视觉 / 歌词 / 封面 / 控制。

## 🧭 音乐源能力现状（避免混淆）

| 能力 | 现状 |
|---|---|
| **完整资料库 + 播放控制** | **仅 Apple Music**（v2.0.0 正式支持） |
| 已有登录 / 辅助接入能力 | QQ 会员状态识别、汽水音乐本地登录态、Spotify 等（沿用上游 MineRadio 能力） |
| **歌词来源** | QQ → 酷狗 → 网易云 + Apple Music Web 私有歌词 |
| **2.1.0 计划** | 其它音乐源的**完整资料库与播放控制**整合（当前未支持） |

## 🚧 项目状态

项目仍在持续开发中。资料库浏览、艺人详情、歌词与视觉舞台等功能会继续迭代；部分功能的兼容性与数据覆盖率可能因歌曲、系统环境及外部服务而异。

**当前版本：v2.0.0**。

---

## 目录

- [🎮 功能一览](#功能一览)
- [💾 下载与安装](#下载与安装)
- [⚠️ 已知限制](#已知限制)
- [🧭 音乐源能力现状（避免混淆）](#音乐源能力现状避免混淆)
- [🚧 项目状态](#项目状态)
- [项目来源与二次开发声明](#项目来源与二次开发声明)
- [Apple Music 接入原理](#apple-music-接入原理)
- [SMTC Bridge](#smtc-bridge)
- [Native Audio Capture](#native-audio-capture)
- [FFT 音频分析](#fft-音频分析)
- [Visualizer / 粒子视觉](#visualizer-粒子视觉)
- [专辑封面](#专辑封面)
- [播放控制](#播放控制)
- [多源歌词（QQ → 酷狗 → 网易云）](#多源歌词qq-酷狗-网易云)
- [双语歌词](#双语歌词)
- [Windows 环境要求](#windows-环境要求)
- [Electron / Node.js 要求](#electron-nodejs-要求)
- [构建方法](#构建方法)
- [第三方音乐平台说明](#第三方音乐平台说明)
- [致谢](#致谢)
- [用户数据与隐私](#用户数据与隐私)
- [License](#license)

---
## 项目来源与二次开发声明


- 本项目（MineRadio Apple Music Edition）是**基于原 MineRadio 项目（[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)）的二次开发版本**，不是从零独立开发。
- 原 MineRadio 项目及其原始代码的版权归原作者（XxHuberrr）所有；本项目保留原项目全部版权声明、许可证文本与 NOTICE。
- 本项目在原项目基础上进行了功能扩展与修改，包括但不限于：Apple Music（Windows SMTC）外部播放状态接入、原生 WASAPI 音频可视化、FFT 频谱分析、专辑封面获取、SMTC 播放控制、多源歌词（QQ 音乐 / 酷狗音乐 / 网易云音乐）、双语歌词翻译与歌词源优先级设置等。
- **本项目与 Apple Inc. 没有官方关联，也不是 Apple 官方软件。** Apple Music、Apple 等相关商标及服务名称归其各自权利人所有。
- 原项目许可证（GPL-3.0）继续适用于原始代码部分；本仓库整体按仓库内 [LICENSE](./LICENSE)（GPL-3.0）授权，详见「[License](#license)」。


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

**艺人字段的数据来源各不相同（重要）**：

| 字段 | 来源 |
|---|---|
| 头像 | Apple Music 封面优先；缺失时用国内源兜底（网易云 / QQ 头像） |
| 流派 | Apple Music 的 `genreNames` |
| **简介** | **外部补充数据源**（Wikipedia / 网易云；返回结果带 `source` 字段标明出处）—— **不是 Apple Music 提供** |
| 歌单 / 专辑 / 曲目 | Apple Music Web 接口（`media-user-token`） |
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


## 构建方法

> 源码运行/预打包说明：见上文「💾 下载与安装」；下面只讲构建。


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


## 第三方音乐平台说明


MineRadio-Apple-Music-Specially-Customized-Edition 不是网易云音乐、QQ 音乐、酷狗音乐或腾讯音乐娱乐集团的官方客户端，也不隶属于任何音乐平台。第三方平台接入仅用于个人学习、本地客户端体验和用户自有账号的播放辅助。请遵守对应平台的用户协议、版权规则和会员权益规则。项目不提供绕过付费、绕过会员、破解音质或重新分发音乐内容的能力。


## 致谢


原 MineRadio 由 XxHuberrr 主要设计与打造。emily 作为早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此感谢

本二次开发版本的 Apple Music（SMTC）接入、原生音频可视化、多源歌词等功能由本仓库维护者完成；对原项目作者及所有社区贡献者表示感谢。


## 用户数据与隐私

**凭证**
* Apple Music Web 登录凭证（`media-user-token`）保存在本机用户数据目录的 `.apple-music-lyrics-credential.json`；
  旧时代（开发者账号）的 `.apple-music-credentials.json` / `.apple-music-token.json` 已退役，退出登录时清除（只删不读）。
* **携带该凭证的请求目前只有 Apple 自己的接口**：`https://music.apple.com` 与 `https://amp-api.music.apple.com`
  （代码核验：凭证的唯一消费方是 `apple-music-web-lyrics.js`，全部指向上述域名）。

**会离开本机的数据（如实列出）**
* 使用**多源歌词**时：向对应第三方歌词服务发送歌曲名 / 艺人 / 时长等查询参数。
* 使用**在线音乐源**（QQ / 酷狗 / 汽水 / 网易云 / Spotify 等）时：向对应服务发送搜索、详情等请求参数。
* **播放记录上报能力**：仓库中存在「最近播放上报」相关接口（如汽水侧），若启用会把播放记录发送给对应服务。
* **更新检查**：访问 GitHub API / Releases 获取版本信息，并可能读取定位服务（天气小组件使用 `ip-api.com` / Open-Meteo）。
* **音频捕获**：仅用于实时视觉，不落盘、不转发。
* 发布产物（安装包 / 便携版）不包含任何账号或令牌数据。

**核验范围说明（避免过度承诺）**
* 本节结论来自对仓库代码路径的检索（凭证消费方、第三方请求、上报接口）；
  **未**逐一审计全部网络调用、代理配置、日志与异常处理路径。
* 如有第三方代理 / 中间人 / 自定义服务被启用，凭证的接收方会相应变化 —— 这类配置由使用者自行掌握。
* 发现与实现不符，欢迎开 issue 指正。
## License

本分支沿用上游 MineRadio 的许可证（**GPL-3.0**，见仓库根目录 [LICENSE](LICENSE)），并保留上游版权声明。

* **上游作品**：原项目 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 及其贡献者，版权归其所有；本仓库为其二次开发（fork）。
* **第三方依赖与移植**：见 [NOTICE.md](NOTICE.md) 与 [docs/THIRD_PARTY_PORTS.md](docs/THIRD_PARTY_PORTS.md)。
* **原创资产**（图标、界面素材、文档、截图等）：除另有说明外，随本仓库按同一许可证提供；如标注来源则以来源声明为准。
* 若你发现版权声明、许可证或资产授权存在不一致，请开 issue，我们会优先更正。
