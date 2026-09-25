# Windows Apple Music 客户端「精准点歌」可行性侦察报告

- 实验目录：`experiment/apple-music-windows-control/`（分支 `experiment/apple-music-windows-control`）
- 被测目标：Song ID `1603171530` → `How Do I Make You Love Me?`
  （`https://music.apple.com/cn/song/how-do-i-make-you-love-me/1603171530`）
- 测试机：Windows 10/11 x64，Apple Music（Microsoft Store 版），实验期间未改动任何 MineRadio 主线代码
- 结论日期：本次侦察会话

---

## 0. 结论摘要（TL;DR）

1. **未发现可可靠调用的官方精准点歌接口。** Apple Music for Windows 对外声明的所有激活入口（23 个协议处理器、文件关联、AppUriHandler）都只接受「打开这个 URL / 打开这个文件」，没有任何「播放指定歌曲」参数；唯一可实例化的本地 COM 服务（`AMPLibraryAgent.exe`）在非打包进程里拿不到接口（`E_NOINTERFACE`）、没有 IDispatch、没有类型库；SMTC 只能控制已经在播的会话，不能选歌。
2. **唯一可落地路径是 UI Automation（UIA）驱动它自己的窗口**，且已 PoC 成功：指定 Song ID 后 Apple Music **实际选中并开始播放**了该歌曲（SMTC 同步显示 `How Do I Make You Love Me?` / `Playing`，见 §7）。
3. 实测端到端延迟：**2641 ms**（深链导航 1570 ms + 行实体化 156 ms + 双击→SMTC 报 Playing 425 ms）。
4. 该路径的代价是**脆弱性**：依赖本地化控件名、虚拟化列表、WinUI 自动化树布局与 Store 自动更新，属于「能用但需要容错设计」的方案，不是稳定 API。
5. 建议下一步：**仅**做 UIA 精准点歌的独立 PoC 加固（仍隔离在实验目录，不接主线，见 §9）。

---

## 1. 安装与打包类型

| 项目 | 实测值 |
| --- | --- |
| 包类型 | MSIX（Microsoft Store 安装，`SignatureKind = Store`） |
| 包全名 | `AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa` |
| PackageFamilyName | `AppleInc.AppleMusicWin_nzyj5cx40ttqa` |
| 版本 | `1.1540.23042.0` |
| 安装位置 | `C:\Program Files\WindowsApps\AppleInc.AppleMusicWin_1.1540.23042.0_x64__nzyj5cx40ttqa` |
| 发布者 ID | `nzyj5cx40ttqa` |

清单中声明了 **4 个应用**，`EntryPoint` 全部为 `Windows.FullTrustApplication`（全信任 Win32，不是 AppContainer 沙箱）：

| Application Id | 可执行文件 | 角色 |
| --- | --- | --- |
| `App` | `AppleMusic.exe` | 主 UI（WinUI 3） |
| `LibraryServer` | `AMPLibraryAgent.exe` | 库/服务代理（COM 服务端，见 §3） |
| `SharedHelper` | `SharedHelper.exe` | 辅助进程 |
| `AppleInc.Music.Defaults` | `appdefaults.exe` | 默认项注册 |

- 已声明能力：`runFullTrust`、`internetClient`、`allowElevation`、`unvirtualizedResources`。
- 执行别名（`%LOCALAPPDATA%\Microsoft\WindowsApps`）：`AppleMusic.exe`、`AppleMusic_Helper.exe`、`AppleInc.Music.Defaults.exe` —— 可从命令行直接启动。
- 主窗口类名：`WinUIDesktopWin32WindowClass`（原生 WinUI 3 / XAML）。
- **不是 WebView2 应用**：实测 `AppleMusic.exe` 没有任何子进程，系统里的 `msedgewebview2.exe` 全部挂在 `SearchHost.exe`（Windows 搜索）下 → 不存在 DevTools/CDP 远程调试面（`findings/14-final-state.txt`）。
- 机器上同时存在**旧版 iTunes**（`C:\Program Files\iTunes\iTunes.exe`），它会抢占部分 `itms/itmss` 注册（见 §2）。
- 更新方式为 Store 自动更新 → **版本漂移是长期风险**（见 §5、§6）。

---

## 2. 发现的协议 / URI Scheme

### 2.1 `windows.protocol`：23 个处理器，参数**全部**是 `/url "%1"`

```
daap, italss, itals, itmss, itms, itpc, itsradio,
itunes.assocprotocol.daap,    itunes.assocprotocol.italss, itunes.assocprotocol.itals,
itunes.assocprotocol.itlss,   itunes.assocprotocol.itls,   itunes.assocprotocol.itmss,
itunes.assocprotocol.itms,    itunes.assocprotocol.itpc,   itunes.assocprotocol.itsradio,
itunes.assocprotocol.itvlss,  itunes.assocprotocol.itvls,
itunesradio, itvlss, itvls, music, musics, itunes
```

我对整个 AppxManifest 做过全量遍历：**没有任何** `windows.protocol` 使用 `/play` 或其他「播放」参数，全部统一为 `/url "%1"`（即「按 URL 打开」）。

### 2.2 `/play` 只存在于文件关联（针对本地音频文件）

- `windows.fileTypeAssociation` 中 `Name="fileassociations_play"`，动词 `/play "%1"`，`MultiSelectModel=Player`，覆盖常见音频扩展名。
- 语义是「用播放器打开这个本地文件」，**不接受歌曲 ID 或商店 URL**。
- 另有 `/open "%1"` 挂在 `.itl/.itlp/.musicdb/.musiclibrary/.itms` 上（打开库/数据库文件）。

### 2.3 AppUriHandler（Web URL 交接）

- 声明 Hosts：`music.apple.com`、`buy.itunes.apple.com`。
- 含义是系统可以把这些域名的链接交给本应用打开；但它走的是**同一条 `/url "%1"`** 通道，`https` 的默认处理程序仍然是浏览器（Edge）。

### 2.4 注册表侧

| 位置 | 状态 |
| --- | --- |
| `HKLM\SOFTWARE\Classes\itms` / `itmss` / `pcast` | 被**旧版 iTunes** 注册，命令 `/url "%1"` |
| `HKCU\...\musics` / `music` / `itms` / `itmss` | 由 MSIX 包注册，只有 `URL Protocol` 与 `(default)=URL:<scheme>`，**没有** `shell\open\command` |
| `AssocQueryString(ASSOCSTR_COMMAND)` | 失败 `0x80070483`（包激活，不存在可读的命令行）→ 友好名显示为 “Apple Music” |
| `itms` / `itmss` | 解析为 OpenWith（Apple Music 与 iTunes 二义） |

### 2.5 深链实测（全部未点歌）

用目标歌曲 URL 做过 4 种深链，每次前后读取 SMTC：

| 方式 | 结果 |
| --- | --- |
| shell `musics://...` | 应用前台化并导航到专辑页，**未选中、未播放** |
| `AppleMusic.exe /url "musics://..."` | 同上 |
| `AppleMusic.exe /url "https://music.apple.com/cn/song/.../1603171530"` | 同上 |
| shell `https://music.apple.com/cn/song/.../1603171530` | 同上（由浏览器/应用交接打开） |

四次之后 SMTC 依然 `title 为空 / status = Opened`。截图见 `findings/shots/09-*.png`。

**即：深链能做到「打开歌曲所在专辑页」，做不到「选中并播放该歌曲」——正是本次任务明确排除的伪成功。**

---

## 3. 本地 IPC / AppService / COM / WinRT 接口

### 3.1 AppService / AppExtension

清单中**没有**声明任何 `windows.appService` 或 `windows.appExtension`。不存在官方给第三方本地应用预留的 AppService 控制端点。

### 3.2 Packaged COM 服务（唯一存在的本地服务端）

清单 `windows.comServer` → `AMPLibraryAgent.exe`（ExeServer）：

| 项目 | 值 |
| --- | --- |
| Class Id（显示名 `AMP.Core.IAMPMusicLibrary`） | `68E7097C-F969-4006-AAC3-95115F0ED1C4` |
| proxy/stub ClassId | `F707A913-E0CE-4FD4-BCE3-425DD153285B`（`AMPLibraryAgent.Proxies.dll`） |
| 声明接口 | `IAMPLibrary`（`F707A913-…`）、`IAMPMusicLibrary`（`68E7097C-…`）+ 10 个事件委托（Playback / PlaybackEventWithCallback / Library / LibraryRevisionChanged / CloudLibrary / FetchInvalidation / ActvityState / BusyChanged / StoreServicesUI / Devices） |

PackagedCom 注册表齐备：`HKLM\SOFTWARE\Classes\PackagedCom\ClassIndex\{68E7097C-…}\<PFN>`、`Package\<full>\Class\{…}`（`ServerId=0`）、`Server\0`（`ApplicationId=LibraryServer`、`Executable=AMPLibraryAgent.exe`、`TrustLevel=1`、`RuntimeBehavior=1`、`BnoIsolation=0`）。

**但是：**

| 探测（从非打包进程） | 结果 |
| --- | --- |
| `CoCreateInstance` / `Activator.CreateInstance(GetTypeFromCLSID(...))` | **成功**（返回 `System.__ComObject`） |
| `QI IAMPLibrary` / `QI IAMPMusicLibrary` | `0x80040155 E_NOINTERFACE` |
| `QI IDispatch` | `0x80004002 E_NOINTERFACE` |
| `QI IAgileObject` / `IMarshal` | 成功 |
| 类型库（typelib） | 全机不存在（HKCR/HKLM/HKCU 均无 Interface/TypeLib/AppID/CLSID 条目） |

→ 对象能创建，但**没有任何合法手段把接口指针取出来**（既无 IDispatch 也无 typelib），vtable 布局完全未公开。绕过方式只能是硬编码 vtable 偏移或解析私有 PDB——属于「二进制逆向/patch」，按任务约束**禁止**，且对 Store 自动更新而言必然失效。

### 3.3 进程 IPC / 端口

- **命名管道**：应用运行时全机 191–195 个管道，**没有任何** apple/music/itunes/daap 相关管道。
- **TCP**：`AMPLibraryAgent` **无监听端口**（查过 9698/9699/9700/9708 —— 它们是到 `:443` 的出站临时套接字）。清单里为 `AMPLibraryAgent.exe` 声明了入站 TCP+UDP 防火墙规则，但实测未观察到本机监听控制端口。
- **UDP**：绑定 `127.0.0.1:49892` / `127.0.0.1:49893` 两个端点，用途未识别（推测与设备发现/AirPlay 邻域有关），未作为控制通道验证。
- **服务/计划任务/自启**：Apple 相关项均与播放控制无关（Apple Mobile Device Service、AppleSoftwareUpdate、iTunesHelper）。
- **无 WinRT 可激活类**（无 `windows.activatableClass.*` 除上述 proxy/stub），**无 WebView2/CDP**，**无本地 HTTP 控制端口**。

---

## 4. SMTC 能做什么、不能做什么

通过反射枚举投影类型得到的**完整**表面：

**Manager**：`GetSessions` / `GetCurrentSession` / `RequestAsync` + 2 个事件。**没有**任何选曲方法。

**Session 方法**：

```
TryPlay, TryPause, TryTogglePlayPause, TryStop,
TrySkipNext, TrySkipPrevious, TryFastForward, TryRewind,
TryChangePlaybackPositionAsync(Int64), TryChangePlaybackRateAsync,
TryChangeShuffleActiveAsync, TryChangeAutoRepeatModeAsync,
TryChangeChannelUp, TryChangeChannelDown, TryRecord,
TryGetMediaPropertiesAsync
```

**MediaProperties 字段（全部只读）**：`AlbumArtist, AlbumTitle, AlbumTrackCount, Artist, Genres, PlaybackType, Subtitle, Thumbnail, Title, TrackNumber`

→ **没有 MediaId，没有任何 setter，没有「播放 ID 为 X 的歌曲」**。

**结论**：SMTC 只能对「应用已经自己开始播放」的会话做传输控制（播放/暂停/上下曲/进度/速度/随机/循环），**不能点歌**。
但它是一个**完美的验证/观测通道**：UIA 双击后 **425 ms** 内 SMTC 即报 `Playing` + 正确 title/artist，也就是 MineRadio 现有的 SMTC 监听链路可以无缝接手。

---

## 5. UI Automation 是否可行 —— 可行，且已 PoC 成功

### 5.1 自动化树可达

- WinUI 3 暴露完整 UIA 树（`AutomationElement.FromHandle(<Apple Music 窗口句柄>)`，窗口标题 `Apple Music`）。
- 观察到的可用节点：导航视图（NavView）、`Search_Button`（名称「单击搜索」）、`TransportBar` 下的 `TransportControl_PlayPauseStop`、ListView 的 ListItem 行（名称形如 `音轨 3 How Do I Make You Love Me? 3 分钟，34 秒钟`）。

### 5.2 两个必须踩过的坑（已定位并解决）

1. **列表行是虚拟化的**：直接 `SelectionItemPattern.Select()` / `InvokePattern.Invoke()` **不会**开始播放，且未实体化时 `BoundingRectangle` 为空（初版 PoC 因此双击到 (0,0) 失败）。
   必须先 `ScrollItemPattern.ScrollIntoView()` + `VirtualizedItemPattern.Realize()`（+ `SetFocus()`），行矩形才变为有效值（实测 `281,803,1521,69`）。
2. **只有合成双击才真正开始播放**：在实体化后的行上合成鼠标双击（取行左侧 `min(300, 0.30×宽度)` 处、垂直居中，**避开右侧悬停按钮**）才会触发播放。

### 5.3 第二条可行流：应用内搜索（不需要深链）

`Search_Button` invoke → 出现 1 个 `Edit` 控件（`name="搜索"`, `autoId="TextBox"`）→ `ValuePattern.SetValue(<歌名>)` → 结果列表出现 74 行，其中包含 `How Do I Make You Love Me? 歌曲 · Abel Tesfaye`。
即：**「搜索 → 点结果行」也能点歌**，不依赖专辑页导航，可作为深链失效时的回退路径。（搜索出结果耗时未做精细计时，等待 4 s 后稳定出现。）

### 5.4 实测延迟

| 阶段 | 实测 |
| --- | --- |
| 深链 → 目标行可见 | **1570 ms** |
| `ScrollIntoView` + `Realize` + `SetFocus` | **156 ms** |
| 合成双击 → SMTC 报 `Playing` | **425 ms** |
| **端到端合计** | **2641 ms** |

### 5.5 权限与运行前提

- **不需要提权**：Apple Music 以普通用户完整性级别运行，UIA 客户端同桌面同用户即可（未触发任何 UAC）。
- **需要交互式桌面**：UIA 与鼠标合成依赖活动的桌面会话；在断开的 RDP/无桌面（服务）上下文不可用。
- 需要 Apple Music 窗口可前台化/可聚焦（点击的是真实窗口）。

### 5.6 稳定性与版本敏感度（重要）

| 风险点 | 说明 |
| --- | --- |
| 本地化名称 | 行名形如 `音轨 N …`、按钮名「单击搜索」随系统语言变化；匹配需以歌名/艺人子串为主、避免依赖前缀 |
| 自动化 ID | `Search_Button`、`TransportControl_PlayPauseStop`、搜索框 `TextBox` 等相对稳定，但属于应用私有实现细节 |
| 虚拟化行为 | 列表虚拟化策略变化会直接破坏「实体化后点击」这一必经步骤 |
| 应用更新 | MSIX Store **自动更新**，UI 重构或自动化树调整都会使脚本失效（本次仅验证 `1.1540.23042.0`） |
| 输入合成 | 依赖前台窗口 + 鼠标坐标，受多显示器/DPI/缩放影响 |
| 时序 | 需要超时与重试（本次 2.6 s 是「已登录 + 已缓存 + 应用已运行」的理想值） |

---

## 6. 各方案对比

评分含义：可行性（能否达成「实际播放」）／稳定性（对版本与环境的耐受）／延迟／版本敏感度（越高越差）／复杂度／权限需求。

| 方案 | 可行性 | 稳定性 | 延迟 | 版本敏感度 | 复杂度 | 权限 |
| --- | --- | --- | --- | --- | --- | --- |
| 协议 / URI 深链（`musics://`、`/url <songURL>`、AppUriHandler） | **否**（只打开专辑页，不选歌不播放） | — | 1.6 s 到页面 | 中 | 低 | 无 |
| 文件关联 `/play` 动词 | **否**（只接受本地音频文件，不接受歌曲 ID/URL） | — | — | 低 | 低 | 无 |
| Packaged COM（`AMPLibraryAgent` / `IAMPMusicLibrary`） | **否**（可创建对象但 `E_NOINTERFACE`、无 IDispatch、无 typelib） | — | — | 高（私有 vtable） | 高（需逆向，**已禁止**） | 无 |
| AppService / WinRT 可激活类 | **不存在**（清单未声明） | — | — | — | — | — |
| 本地 IPC / 端口 / 命名管道 | **未发现**可用控制通道 | — | — | — | — | — |
| 进程注入 / 内存 patch / 二进制改写 | **禁止**（任务约束，且违反应用签名完整性） | — | — | — | — | — |
| SMTC | **否**（无选曲 API；`MediaProperties` 无 `MediaId`） | 高 | — | 低 | 低 | 无 |
| **UIA：深链 + 实体化 + 双击** | **是（已 PoC 成功）** | 中低（依赖 UI 结构，可加容错） | **~2.6 s** | **高** | 中 | 无（同用户桌面会话） |
| UIA：应用内搜索 + 点结果行 | **是（路径已验证）** | 中低 | ~1–4 s（未精细计时） | 高 | 中 | 无 |

---

## 7. 针对 Song ID `1603171530` 的实际 PoC 结果

**目标歌曲**：`How Do I Make You Love Me?`（艺人 `Abel Tesfaye`，专辑 `Dawn FM`）

### 7.1 深链路线：失败（4 次全部失败）

`musics://`、`AppleMusic.exe /url "musics://…"`、`AppleMusic.exe /url "https://…/1603171530"`、shell `https://…/1603171530`
→ 应用均前台化并停在 **专辑页（Dawn FM）**，SMTC 前后无变化（`title 为空 / status = Opened`）。
不属于成功：既未选中行，也未播放。证据：`findings/shots/09-*.png`、`findings/09-*.txt`。

### 7.2 UIA 路线：**成功**

流程：定位目标行 → `ScrollIntoView` + `Realize` + `SetFocus`（矩形 `281,803,1521,69`）→ 合成双击 → SMTC 立即报告：

```
title   = How Do I Make You Love Me?
artist  = Abel Tesfaye — Dawn FM
status  = Playing
position= 00:00:01 → 00:00:02
```

截图 `findings/shots/12-poc-uia-play-v2.png` 显示底部正在播放栏已切换为该歌曲。

**满足成功判据：指定 Song ID 后，Apple Music 实际选中并开始播放该歌曲。**
（`Select()`/`Invoke()` 单独调用不生效 —— 只有合成双击生效，见 §5.2。）

### 7.3 实验结束时的机器状态

`findings/14-final-state.txt`：SMTC 会话 `AppleInc.AppleMusicWin_nzyj5cx40ttqa!App`，`title=[How Do I Make You Love Me?]`，`status=Paused`（实验已把播放暂停，歌曲仍选中；Apple Music 窗口保持打开）。

---

## 8. 明确结论

> **未发现可可靠调用的官方精准点歌接口。**

依据（全部为实测，非推断）：

1. 23 个协议处理器参数统一为 `/url "%1"`，**不存在**任何 `/play` 形式的协议；`/play` 仅针对本地音频文件关联。
2. AppUriHandler（`music.apple.com`）是同一条 `/url` 通道，实测打开歌曲 URL 只到专辑页，不选歌不播放。
3. 唯一的本地服务 COM 对象可从非打包进程创建，但 `IAMPLibrary`/`IAMPMusicLibrary` 返回 `E_NOINTERFACE`、无 `IDispatch`、全机无 typelib → 接口不可合法获取（逆向属禁止手段）。
4. 清单**未声明** AppService/AppExtension/WinRT 可激活类；未发现命名管道、监听端口或本地 HTTP 控制面。
5. SMTC 反射枚举显示**没有**选曲方法，`MediaProperties` **没有** `MediaId` 字段。
6. 因此目前唯一可达成「实际播放指定歌曲」的路径是**驱动它自己的 UI**（UIA），该路径已被 PoC 验证，但属于非官方、脆弱依赖 UI 的实现方式。

---

## 9. 下一步实验建议（仅此一项）

**建议：在同一个隔离实验目录内，做一个「UIA 精准点歌」加固版独立 PoC，仍然不接 MineRadio 主线。**

范围与验收：

1. 形态：`experiment/apple-music-windows-control/poc/` 下的独立脚本/最小本地服务，对外暴露一个 `PlaySong(songId, songUrl, title, artist)` 入口。
2. 主路径：应用未运行则以 `%LOCALAPPDATA%\Microsoft\WindowsApps\AppleMusic.exe` 启动 → 等待窗口 → 深链打开歌曲 URL → UIA 定位目标行 → `ScrollIntoView` + `Realize` + `SetFocus` → 合成双击。
3. 回退路径：深链失效时改用「`Search_Button` → 搜索「歌名 + 艺人」→ 点结果行」。
4. 必须内建容错：按歌名/艺人**子串**匹配（不依赖本地化的 `音轨 N` 前缀）；每步超时与重试；用 **SMTC 校验**最终是否真的 `Playing` 且 title 匹配（这也是与 MineRadio 交接的天然接口）；多显示器/DPI 取行中心附近的稳健点击点。
5. 验收标准：对 3 首不同歌曲（含中文歌名）连续 20 次调用，成功率与耗时分布有实测记录；应用重启、已登录/未登录、歌曲不在媒体库等边界情况各测一次。
6. **明确不做**：不修改 MineRadio 任何主线文件；不改动 `desktop/smtc-bridge.ps1`、SMTC/WASAPI/歌词/播放核心；不新增 npm 依赖；不动凭证模型。只有在该 PoC 通过重复稳定性测试后，才另行讨论是否接入主线（并需单独评审）。

---

## 10. 隔离、约束与清理

- 全部改动位于分支 `experiment/apple-music-windows-control` 与目录 `experiment/apple-music-windows-control/`；`main` 未改动。
- 未新增 npm 依赖；未触碰 `desktop/` 下任何文件（`desktop/smtc-bridge.ps1` 仅作为 SMTC 调用技术的参考被读取）。
- 未进行逆向/注入/内存读取，未接触 Apple ID 口令、cookie 或会话令牌，未触碰 DRM（FairPlay）与音频解密。
- 删除方式：删除该目录并切回 `main` 即可完全移除本实验；无系统级残留（未写注册表、未安装服务、未改协议默认项）。
- 实验期间启动的 Apple Music 实例保持打开、播放已暂停，属可预期的临时状态。

## 11. 局限与未验证项（诚实声明）

1. **仅验证了一个版本**：`AppleInc.AppleMusicWin 1.1540.23042.0`；Store 自动更新后 UIA 结构可能变化，未做跨版本验证。
2. **未做逆向**：未解析 `AMPLibraryAgent.Proxies.dll` 的私有 vtable（属禁止手段），故「COM 不可用」的结论基于合法探测（QI/IDispatch/typelib）。
3. **UDP `127.0.0.1:49892/49893` 用途未识别**，未作为控制通道验证；不排除存在未被发现的控制面，但无官方文档、亦无合法调用方式。
4. **搜索路径耗时未精细计时**（仅等待 4 s 后确认结果稳定出现）。
5. 旧版 iTunes 的存在使 `itms/itmss` 关联二义；本次未对 iTunes 做播放能力测试（它不是 Apple Music 流媒体的播放器）。
6. 未验证多显示器/高 DPI、锁屏、断开的 RDP 会话等环境下 UIA 点击的表现（原理上不可用）。
7. 未修改任何用户可见设置（协议默认项、播放器默认项均未改动）。

## 12. 证据文件

| 文件 | 内容 |
| --- | --- |
| `findings/01-install-and-protocols.txt` | 系统/包/清单/协议注册扫描 |
| `findings/02-appxmanifest.xml`、`findings/02-manifest-and-protocol-resolution.txt` | 原始 AppxManifest 与协议解析、`AssocQueryString` 结果 |
| `findings/03-manifest-detail.txt` | Applications/Extensions 结构化遍历、`/play` 与 `/open` 上下文 |
| `findings/04-com-server-surface.txt` | comServer/proxyStub 全树、PackagedCom 注册表 |
| `findings/05-com-activation-test.txt` | COM 创建与 QI 探测（`E_NOINTERFACE`） |
| `findings/06-com-boundary-detail.txt` | IDispatch/IAgileObject/IMarshal、`AMPLibraryAgent.exe -Embedding` 命令行 |
| `findings/07-ipc-and-smtc-surface.txt` | 管道/端口/服务/自启 + SMTC 方法全表 |
| `findings/08-launch-and-window-stack.txt` | 启动方式、窗口类、管道/监听、SMTC 快照 |
| `findings/09-poc-deeplink.txt` | 4 种深链的前后 SMTC 对比（全部失败） |
| `findings/10-uia-tree-and-search-poc.txt` | UIA 树与搜索路径验证 |
| `findings/11-poc-uia-play.txt` | PoC v1（虚拟化导致失败） |
| `findings/12-poc-uia-play-v2.txt` | **PoC v2 成功记录** |
| `findings/13-latency-and-search.txt` | 延迟实测与搜索可行性 |
| `findings/14-final-state.txt` | 结束状态（无 WebView2 子进程；SMTC = 目标歌曲 + Paused） |
| `findings/shots/09-*.png` | 深链后停在专辑页 |
| `findings/shots/11-poc-uia-play.png` | PoC v1（失败） |
| `findings/shots/12-poc-uia-play-v2.png` | **PoC v2 成功：正在播放栏显示目标歌曲** |
| `recon/01..14-*.ps1` | 可重跑的侦察脚本（ASCII-only，PowerShell 5.1） |
