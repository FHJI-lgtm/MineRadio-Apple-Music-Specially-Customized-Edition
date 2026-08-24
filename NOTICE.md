# NOTICE

## 二次开发声明 / Secondary Development

本项目（MineRadio Apple Music Edition）为基于 [XxHuberrr/Mineradio](https://github.com/XxHuberrr/Mineradio) 的二次开发版本。

- 原 MineRadio 项目及其原始代码的版权归原作者（XxHuberrr）所有。
- 本项目在原项目基础上进行了功能扩展和修改，包括但不限于：Apple Music 外部播放状态接入（Windows SMTC）、SMTC 播放控制、专辑封面获取、原生音频可视化、FFT 频谱分析、多源歌词（QQ 音乐 / 酷狗音乐 / 网易云音乐）及双语歌词翻译等。
- 本项目与 Apple Inc. 没有官方关联，也不是 Apple 官方软件。Apple Music、Apple 等相关商标及服务名称归其各自权利人所有。
- 原项目的许可证（GPL-3.0）及其版权声明继续适用于原始代码部分；本仓库整体按仓库内 LICENSE（GPL-3.0）授权。

Mineradio 使用了以下第三方项目或服务。各项目版权归其原作者所有。

## Third-party Libraries

- Electron
- Three.js
- GSAP
- music-tempo
- NeteaseCloudMusicApi
- mpg123-decoder

## Community Contributions

- Cuefield AutoMix planner/runtime: adapted for experimental local testing from [SLYysl/cuefield-mineradio](https://github.com/SLYysl/cuefield-mineradio) (GPL-3.0). The optional remote-feedback component from that repository is not included; Mineradio stores Cuefield ratings locally in the current user's data directory.
- Wallpaper Engine local-library detection and import UX: independently adapted from the approach used by [ww085213/Mineradio-LX-Music](https://github.com/ww085213/Mineradio-LX-Music) at commit `a5ef80a219709080700be5b1d00f1ea71a5a2576` (GPL-3.0). Mineradio only indexes local `project.json` metadata; it does not execute imported Web/Application projects or replace the user's existing background-media settings.
- Full-desktop main-window mode and home-dashboard information hierarchy: initially adapted from [ww085213/Mineradio-LX-Music](https://github.com/ww085213/Mineradio-LX-Music) at commit `82826df814c32853d99697c0ee60f749a2fcad79`, with the homepage refreshed against `812e2dc2e18bbc263e61dbd0206cb765e003d6e9` (GPL-3.0). Mineradio keeps its own provider, queue, playlist, listening-history, WorkerW validation, DPI, lifecycle, and cleanup implementations; see `docs/THIRD_PARTY_PORTS.md` in the corresponding source distribution.
- Qishui Passport Web QR authentication bridge: focused port from [Wx2yZx/Mineradio-Qishui-QR-Login](https://github.com/Wx2yZx/Mineradio-Qishui-QR-Login) at commit `aaadaab7d011714f94fbe45b382ba8dcc7cf17b9` (declared `GPL-3.0-only`). Only the official QR create/poll, security-signing host, session persistence, and second-verification path are integrated; Mineradio keeps its own catalogue, playlist, entitlement, and playback adapters. The bundled ByteDance/Qishui web security runtime resources remain the property of their respective rights holders and are used only to interoperate with the user's own official account session.

## Third-party Services

Mineradio 可能与网易云音乐、QQ 音乐等第三方音乐服务进行用户自有账号相关的本地客户端交互。

Mineradio 不是任何音乐平台的官方客户端，也不隶属于网易云音乐、QQ 音乐或腾讯音乐娱乐集团。请用户自行遵守对应平台的服务协议、版权规则和会员权益规则。

## Original Design

Mineradio 名称、MR Logo、界面视觉设计、启动动画方向、粒子视觉体验和电影镜头系统的产品表达属于作者原创设计。

emily 作为 Mineradio 早期视觉底层想法与 `emily` 视觉预设改进方向的共创者和灵感来源之一，特此致谢。

感谢小天才e宝、应春日、锋将军、軌跡、林中、骊、风痕、花椰菜🥦在早期体验、测试反馈和发布准备中的帮助。
