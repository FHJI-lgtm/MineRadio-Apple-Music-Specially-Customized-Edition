# MineRadio · Apple Music 特别定制版

> 让音乐不止于播放，也成为桌面的一部分。

MineRadio Apple Music 特别定制版是基于 MineRadio 持续开发的定制版本，围绕 **Windows 桌面音乐体验、Apple Music 资料库浏览、实时歌词与沉浸式粒子视觉** 进行扩展。

我们希望将音乐播放、歌曲信息、歌词和动态视觉整合到一个连贯的桌面体验中，让听歌不再只是一个后台播放过程。

> **本仓库是基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的二次开发（fork）版本**，在原 MineRadio 基础上新增 Apple Music（Windows）资料库浏览与播放控制、原生音频可视化、专辑封面、多源歌词等能力。原项目版权归原作者/原项目所有者所有，详见下文「[项目来源与二次开发声明](#项目来源与二次开发声明)」。

---

## ✨ 项目特色

### 🎵 Apple Music 资料库

* 浏览音乐资料库中的**专辑、艺人与歌单**。
* 查看专辑作品与艺人详情。
* 展示艺人头像、流派及可获取的简介信息。
* 将音乐资料与现有播放交互连接起来。
* 歌单详情支持 **播放歌单** 与 **随机播放**（直接驱动 Apple Music 自己的播放按钮）。

### 🎤 实时歌词

* 获取并显示与当前播放歌曲匹配的歌词。
* 支持多个歌词数据源的匹配与回退。
* 为歌词舞台与音乐视觉提供歌曲及时间信息。

### 🌌 沉浸式视觉舞台

* 基于专辑封面与音频数据呈现动态粒子视觉。
* 将音乐播放与桌面视觉效果结合。
* 延续 MineRadio 原有的视觉舞台设计与交互体验。

### 🖥️ Windows 桌面集成

* 通过 Windows **SMTC** 获取系统媒体会话信息。
* 结合系统媒体控制与现有桌面交互实现播放状态展示及控制。
* 将歌曲信息、歌词和音频响应视觉连接起来。
* **Apple Music 隐身模式**：被控制的 Apple Music 窗口视觉隐藏（Alpha=1 + 鼠标穿透），不再占据桌面。

---

## 🧩 Apple Music 接入原理（本版已改写）

本版对原有的「Apple Music 登录 / 账户」入口做了**完全重写**：不再依赖 Apple Music 开发者 API 的令牌或网页登录流程，
而是围绕**本机已登录的 Apple Music for Windows 客户端**建立三条通道。

### 1) 状态监听：Windows SMTC（只读）

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

### 2) 播放控制：UIA 驱动 + SMTC 校验（本版重点）

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

### 3) 资料库数据：Apple Music Web 接口（media-user-token）

资料库页面（歌单 / 艺人 / 专辑 / 喜爱歌曲）由主进程提供的本地只读接口驱动，例如：

```text
/api/apple/user/playlists        歌单列表
/api/apple/playlist/tracks       歌单曲目（分页取全）
/api/apple/library/albums        专辑列表
/api/apple/library/album/tracks  专辑曲目
/api/apple/library/artists       艺人列表
/api/apple/library/artist/detail 艺人详情（头像 / 流派 / 简介）
```

* 数据通过 **Apple Music Web 接口**取得：请求使用 **Bearer + `media-user-token`**（网页登录凭证），
  凭证由 `desktop/apple-music-lyrics-credential.js` 管理，**只保存在本机**，用于资料库查询与歌词获取。
* **开发者账号轴（Team ID / Key ID / P8 → ES256 JWT → `/v1/me/*`）已整体退休**：现在不需要 Apple 开发者密钥，
  只需要你自己的 Apple Music 账号在网页侧的登录凭证。
* `/api/apple/logout` 只做清理（删除历史遗留的 `.apple-music-token.json`，只删不读）。
* 设置里的「Apple Music 账户设置」= **登录 / 凭证入口**（media-user-token）+ **连接状态** + **隐身模式开关**。

### 4) 隐身模式（默认开启）

* 窗口属性 `Alpha=1` + `WS_EX_LAYERED` + `WS_EX_TRANSPARENT`：视觉隐藏与鼠标穿透，同时保留 UIA 控制能力。
* **看门狗**：每秒校验窗口属性，丢失即修复；失败按 1s→30s 退避，超限安全停机并恢复窗口。
* **播放门控**：控制播放期间临时摘掉透明位（播放链依赖真实点击），结束（含失败）必定戴回。
* 用户手动唤起或操作 Apple Music 时自动退出隐身；MineRadio 退出时恢复窗口。

### 5) 音频响应视觉

* 通过原生音频捕获（`desktop/smtc-audio-capture.ps1` + `native/MineRadioAudioCapture.exe`）取回系统播放音频，做 FFT 频谱与粒子响应。
* 音频只用于视觉呈现，不落盘、不转发。

---

## 🛠️ 技术方向

本项目围绕现有 MineRadio 架构进行持续改进，重点包括：

* Windows 系统媒体会话集成（SMTC 状态与控制）。
* Apple Music 资料库数据获取与展示。
* 多来源歌词匹配与回退。
* 桌面音频捕获与实时视觉响应。
* 本地数据缓存及桌面交互体验优化。

具体实现以当前仓库代码为准。

---

## 📌 项目状态

项目仍在持续开发中。资料库浏览、艺人详情、歌词与视觉舞台等功能会继续迭代，部分功能的兼容性和数据覆盖率可能因歌曲、系统环境及外部服务而异。

**当前版本：v2.0.0**（播放控制 + 资料库 + 隐身模式）。后续将继续完善资料库体验与**多音乐源整合（排期 2.1.0）**。

已知限制：

* 播放控制目前仅支持 **Apple Music for Windows** 作为音源。
* 播放控制依赖 UIA 与 SMTC，Apple Music 客户端界面更新可能导致个别入口需要适配。

---

## ⚠️ 说明

* 本项目为 MineRadio 的社区定制版本，不代表 Apple 或其他音乐平台的官方产品。
* Apple Music 相关功能依赖相应的客户端环境、账号状态及可用服务。
* 第三方服务的可用性、数据覆盖率与接口行为可能发生变化。
* 请遵守相关平台的用户协议、版权规则及适用法律。
* 项目的实际功能、许可证与第三方依赖说明以仓库中的对应文件为准。

---

## 🔐 用户数据与隐私

* Apple Music 登录凭证（`media-user-token`）**只保存在本机**，仅用于访问资料库与歌词；**不上传、不外传**。
* MineRadio 内部**不内置任何 Apple 密钥**；退出登录时会清除本地凭证（`/api/apple/logout`）。
* 音频捕获仅用于实时视觉，不落盘、不转发。
* 发布产物中不包含任何账号 / 令牌数据。

---

## 项目来源与二次开发声明

- 本项目（MineRadio Apple Music 特别定制版）是**基于原 MineRadio 项目（[XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio)）的二次开发（fork）版本**。
- 原项目的名称、代码与设计版权归原作者及原项目所有者所有；本分支仅在其基础上做扩展与定制。
- 本分支保留原项目的许可证与第三方依赖声明（见 `LICENSE`、`NOTICE.md`、`docs/THIRD_PARTY_PORTS.md`）。

---

## 🤝 致谢

感谢 MineRadio 原项目及其开发者为本项目提供的基础，也感谢参与功能测试、问题排查与体验反馈的用户。

---

## 📄 许可证

请参阅仓库中的 [LICENSE](LICENSE) 文件及相关第三方依赖声明。
