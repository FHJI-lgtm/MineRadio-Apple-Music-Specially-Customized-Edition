# Artwork Pipeline Audit —— 为什么 "SMTC 明明有正确 Thumbnail，却被 MineRadio 判定为失败"

> 范围：只读审计。**未修改任何代码、配置或运行状态**（TSP 已封板，本次完全没碰）。
> 审计时间：2026-10-06 17:30–17:40；现场样本：Apple Music 正在播放（审计期间为
> \`Chasing Paradise / Kygo & OneRepublic\`，用户截图样本为 \`Azizam / Ed Sheeran — Play\`）。

配套代码位置：

| 环节 | 文件 | 关键函数 |
|---|---|---|
| ① SMTC bridge 读缩略图 | [desktop/smtc-bridge.ps1](desktop/smtc-bridge.ps1) | \`ReadThumbnailDataUrl\` / \`ReadThumbnailWithRetry\`（L70–L120） |
| ② 主进程解析/兜底 | [desktop/main.js](desktop/main.js) | \`smtcResolveThumbnail\`（L5468）、\`smtcResolveThumbnailViaLocalCover\`（L5420）、\`smtcFetchItunesThumbnail\`（L5510） |
| ③ 渲染层落图 | [public/js/modules/12-smtc/03-smtc-ui.js](public/js/modules/12-smtc/03-smtc-ui.js) | \`smtcApplyVisualizerCover\`（L147） |
| ④ 封面真正落地 | [public/js/modules/02-visual/15-ripples-cover-depth.js](public/js/modules/02-visual/15-ripples-cover-depth.js) | \`applyCoverCanvas\`（L577）、\`coverApplyStillCurrent\`（L517） |
| ⑤ 本地封面兜底 | [desktop/native/MineRadioCoverResolver.cpp](desktop/native/MineRadioCoverResolver.cpp) | 读 Apple Music \`artwork.sqlite\` + \`INetCache\*.json\` |

---

## 0. 结论（一句话）

**缩略图在 SMTC 侧确实存在、而且 \`OpenReadAsync()\` 真的拿到了流对象；失败点只有一个：Windows PowerShell 5.1 无法把 WinRT 返回的 \`System.__ComObject\` 投影成 \`IRandomAccessStream\`，于是 bridge 每次都返回 \`thumbnail=null\`。**
这不是"偶尔"，是 **100% 失败**；用户观感里的"偶尔出错"来自它后面的两条兜底链（本地 artwork 索引 / iTunes 搜索）命中率不稳定。

---

## 1. 现场证据（全部为真实命令输出）

### 1.1 生产日志：每一次切歌都返回 null

\`C:\Users\limin\AppData\Roaming\MineRadio Apple Music Edition\logs\smtc.log\`（打包版运行期日志）：

\`\`\`
[2026-10-03T11:10:27.243Z] bridge: [SMTC][…] (THUMB) identity changed, thumbnail=null
[2026-10-04T10:12:04.415Z] bridge: [SMTC][…] (THUMB) identity changed, thumbnail=null
… （共 11 条，全部 thumbnail=null，没有任何一条成功）
\`\`\`

### 1.2 复现（独立运行 bridge，只读）

我校本机直接跑 \`desktop/smtc-bridge.ps1\`（只读，未干预 MineRadio 自己的 bridge 进程 PID 42024）：

\`\`\`
[SMTC][…] Session found
[SMTC][…] (T1) TITLE=Chasing Paradise ARTIST=Kygo & OneRepublic — Chasing Paradise - Single
[SMTC][…] (THUMB) identity changed, thumbnail=null      ← 当场复现
\`\`\`

### 1.3 逐级定位：SMTC 有图、流也拿到了，卡在"投影"

对同一时刻的真实 SMTC 会话逐步探测：

\`\`\`
STEP0 title=Chasing Paradise
STEP1 props.Thumbnail is null?           False        ← ① SMTC 确实提供了封面
STEP2 thumbnail runtime type             Windows.Storage.Streams.RandomAccessStreamReference
STEP3 OpenReadAsync op type              System.__ComObject
STEP4 stream null?                       False        ← ② 流对象拿到了
STEP5 stream type                        System.__ComObject
STEP6 ContentType                        (空)         ← 无法投影，属性读不到
STEP7 Size                               (空)         ← 无法投影，属性读不到
A-ERR: Cannot convert the "System.__ComObject" value of type "System.__ComObject"
       to type "Windows.Storage.Streams.IRandomAccessStream"     ← ③ bridge 的失败点
B-ERR: Method invocation failed because [System.__ComObject] does not contain
       a method named 'GetInputStreamAt'
\`\`\`

### 1.4 我尝试过的 7 种 PS 5.1 读法，全部失败

| # | 方法 | 结果 |
|---|---|---|
| 1 | \`[IRandomAccessStream]$stream\` 显式转换（bridge 现状） | ✗ Cannot convert \`__ComObject\` |
| 2 | 直接 \`AsStreamForRead($stream)\`（不做 cast） | ✗ 找不到重载 |
| 3 | \`AsStreamForRead([IInputStream]$stream)\` | ✗ 同样无法转换 |
| 4 | \`Marshal.GetIUnknownForObject\` → \`GetObjectForIUnknown\` | 拿到指针 0x2925510AD80，但换回来仍是 \`__ComObject\` |
| 5 | \`GetTypedObjectForIUnknown(ptr, WinRT 类型)\` | ✗ "The object's type must not be a Windows Runtime type" |
| 6 | \`__ComObject.InvokeMember('GetInputStreamAt')\` | ✗ NullReference（WinRT 对象没有 IDispatch） |
| 7 | \`DataReader\` 构造（需要 IInputStream） | ✗ 同 3 |

本机 PowerShell 版本 **5.1.26100.9444**，**未安装 PowerShell 7**（\`Get-Command pwsh\` 无结果，
\`Program Files\PowerShell\7\pwsh.exe\`、\`WindowsApps\pwsh.exe\` 均不存在）。

> 注：IID 已探明 —— \`IRandomAccessStreamWithContentType\` = \`cc254827-4b3d-438f-9232-10c76bc7e038\`，
> 这为"COM shim"路线提供了必要信息（见 §5 方案 A）。

---

## 2. 逐条回答你列的 7 个问题

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | SMTC Thumbnail 是否成功取得 | **取得成功**（\`props.Thumbnail != null\`，类型 \`RandomAccessStreamReference\`） | §1.3 STEP1/STEP2 |
| 2 | Thumbnail Stream 是否成功读取 | **打开成功、读取失败**：\`OpenReadAsync()\` 返回可用流对象，但 PS 5.1 无法投影成托管接口，一个字节都读不出来 | §1.3 STEP4/A-ERR |
| 3 | 图片 decode 是否成功 | **根本没走到**。renderer 只在收到 data URL 才 decode；当前 data URL 从未产生 | main L5456/5548 从不触发 |
| 4 | 哪个 validation 条件导致 fallback | **不是校验条件**，而是**数据源缺失**：\`smtcResolveThumbnail()\` 第一道就是 \`smtcThumb.length > 30\`，拿到 \`null\` 直接落到 cache/Resolver/iTunes 分支（main L5470） | 代码 + §1.1/§1.2 |
| 5 | 切歌异步竞态 / 旧封面覆盖新封面 | **未发现真实竞态**（设计是对的）：\`smtcSendThumbnail\` 按 identity 去重；iTunes 结果用 \`identityKey === 当前 identity\` 拦截（main L5547）；renderer 用 \`trackSwitchToken\` + \`coverProcessToken\` 双保险 | main L5356/L5547，ripples L579/646 |
| 6 | cache 是否错误复用旧 artwork | **未发现**：cache key = \`aumid\|title\|artist\|album\`，仅命中当前 identity；跨歌不会串（新歌必然 MISS） | main L5368/L5479 |
| 7 | renderer 最终拿到的 artwork 是否与 SMTC 一致 | **当前不一致**：SMTC 路径已死，实际封面来自"本地 artwork 索引 → iTunes"兜底链，**不保证等于 SMTC 那一张** | §3 因果链 |

另外两个**次要但真实**的发现：

* **浪费的重试延迟**：\`ReadThumbnailWithRetry\` 每首歌重试 3 次（每次 \`Await\` 最多 3s + 350ms sleep），
  而这条路在该平台上**结构性不可能成功** → 无谓拉长 bridge 的单次 \`EmitState\` 时间。
* **可观测性缺口**：失败只写一行 \`thumbnail=null\`，看不出是"SMTC 没有图"还是"有图读不出来"，
  生产上无法区分（本次审计就是靠额外探测才区分的）。建议补 \`thumbnailReason\` 字段。

---

## 3. 完整因果链（每一环都有现场证据）

\`\`\`
Apple Music（正确的粉色 Play 封面）
        │
        ▼
SMTC / Windows Media Control        ✅ props.Thumbnail != null
        │
        ▼
RandomAccessStreamReference.OpenReadAsync()   ✅ 返回真实流对象（__ComObject）
        │
        ▼
smtc-bridge.ps1  ReadThumbnailDataUrl          ❌ PS 5.1 无法投影 → 返回 null
        │                                          → 日志 (THUMB) thumbnail=null（100%）
        ▼
main.js  smtcResolveThumbnail(null)
        │
        ├─① 会话 cache（key=aumid|title|artist|album）  → 新歌必然 MISS
        │
        ├─② MineRadioCoverResolver.exe（Apple Music 本地索引）
        │     实测当前歌： {"ok":false,"reason":"NO_ARTWORK_MATCH","stage":"artwork-index"}
        │     实测用户样本：{"ok":false,"reason":"NO_METADATA_JSON","stage":"metadata-json"}   ❌
        │
        ├─③ iTunes Search API（"artist title" → results[0].artworkUrl100）  ⚠️
        │     可能命中单曲版/合辑/翻唱/同名曲 → 与 SMTC 封面不一致 → "封面偶尔出错"
        │
        └─④ 都失败 → 保持/清空封面 → 观感"没认领封面"
\`\`\`

**"偶尔"的解释**：① 必然 miss；② 的命中取决于 Apple Music 本地缓存
（\`artwork.sqlite\` 索引 + \`INetCache\*.json\` 元数据）当时的完整度 —— 实测同一台机器上也会 miss；
③ 是网络搜索，语义上不保证等于 Apple Music 的版本。所以"正确封面就在 SMTC 里却读不到"是**确定性故障**，
而用户看到的时好时坏来自②/③的命中率波动。

---

## 4. 明确"没坏"的部分（**不要动**）

审计确认下面这些设计与实现是正确的，修封面不需要碰它们：

* \`smtcSendThumbnail\` 的同值去重 + identity 变化时先发 \`null\` 清旧封面；
* iTunes 异步结果按 identity 拦截，旧歌请求不会覆盖新歌；
* renderer \`smtcApplyVisualizerCover\` 的 \`seq\` / \`trackSwitchToken\` / \`coverApplyStillCurrent\` 三层校验，
  以及 \`!smtcStore.active\` 时挂起到 pending 再冲刷的逻辑；
* \`applyCoverCanvas\` 的**主封面落地是同步的**（\`coverTex\`/\`uHasCover\`/\`album-bg\`/\`control-cover\` 立刻生效），
  \`timeout: 900\` 只作用于**重型边缘/深度纹理**那一步 —— 超时不会导致"封面丢失"，只会晚一点出深度效果；
* 会话内 LRU cache 的 key 与淘汰策略。

→ **结论：问题在"源"，不在"消费"。** 先修数据源，renderer 不需要改。

---

## 5. 修复候选（**等待授权，尚未实施**）

### 方案 A（PS 内 COM shim，无新二进制）
在 \`smtc-bridge.ps1\` 里用 \`Add-Type\` 编译一个最小 C# COM 垫片：
用 \`Marshal.GetIUnknownForObject\` 拿到的指针 + 已探明的 IID
（\`IRandomAccessStreamWithContentType = cc254827-4b3d-438f-9232-10c76bc7e038\`）声明
\`[ComImport, InterfaceType(InterfaceIsIUnknown)]\` 接口，并在 vtable 前置 IInspectable 的 3 个槽位，
再 QI 到 \`IInputStream\` 调 \`ReadAsync\` / 或用 \`IBuffer\` 取字节。
* 优点：零新依赖、零打包改动、改动集中在一个函数；
* 风险：需要精确的 vtable/ABI 处理（我尚未验证成功，需先做一次 PoC 验证）。

### 方案 B（把 bridge 宿主换成 PowerShell 7）
PS7（.NET + CsWinRT）能正确投影 WinRT 类型，\`AsStreamForRead\` 可直接用。
* 优点：代码改动最小（探测 \`pwsh.exe\` 优先，找不到回落 5.1 = 今天的行为）；
* 风险：**本机没有装 PowerShell 7**（已实测），修完在当前机器上不生效，除非用户安装；
  作为产品依赖也比较脆。

### 方案 C（原生 helper 增读缩略图）
仿照仓库既有的 \`MineRadioCoverResolver.exe\` 模式，加一个"读 SMTC 缩略图 → base64 stdout"的小工具，
bridge 读不到时调用它。
* 优点：平台最可靠（C++ 直接 COM/WinRT）；
* 风险：**本机没有编译工具链**（\`cl.exe\`/\`msbuild\`/\`vswhere\` 均未找到），我无法在这台机器上构建与验证，
  需要你在有工具链的环境编译并随包发布。

### 建议顺序
1. **先做方案 A 的 PoC**（30 分钟内可验证成败，零打包改动）；成功则直接落地为最小修复。
2. A 不可行再评估 B（取决于你是否接受"装 PowerShell 7"）。
3. C 作为长期最稳方案，但需要工具链与一次打包验证。

### 无论走哪条，都建议顺带做两个低风险改进（与修法无关）
* \`thumbnailReason\`（\`no-thumbnail\` / \`projection-unsupported\` / \`read-failed\` / \`too-large\`），让生产日志可区分；
* 当检测到本机平台不支持投影时，**跳过 3 次重试**（省掉每首歌最多 ~10s 的无谓阻塞）。

---

## 6. 安全声明

* 本次审计**只读**：运行了 \`desktop/smtc-bridge.ps1\` 的独立只读实例（14 秒，随后结束）、
  只读 WinRT 查询、只读了 MineRadio 自己的日志与仓库代码。
* **未修改**任何源码、配置、缓存、数据库；**未触碰** MineRadio 正在运行的 bridge（PID 42024，父进程 electron 14568）
  与 Lyricify Fusion 的任何文件/状态；**未改动 TSP**。
* 唯一新增的仓库文件是本审计报告；探针脚本与临时文件都在系统临时目录。
---

# 7. 方案 A PoC 结果（临时验证，**未落地**）

> 状态：**验证成功**。仅使用系统临时目录里的脚本；**未修改任何生产代码 / 兜底逻辑 / renderer / cache**。

## 7.1 结论

SMTC 缩略图**可以**在 Windows PowerShell 5.1 下完整读出。
关键不是 COM ABI 手写，而是 **换一个调用通道**：

| 通道 | 结果 |
|---|---|
| PowerShell 的 \`[Type]$obj\` 转换（LanguagePrimitives） | ❌ 抛 "Cannot convert System.__ComObject to IRandomAccessStream" |
| 手写 \`[ComImport]\` vtable 垫片（raw ABI） | ❌ 我按错误的方法顺序假设，\`get_Size\` 返回垃圾 HRESULT（\`0xF5EF1740\`） |
| **\`MethodInfo.Invoke\` 调投影接口的方法** | ✅ **成功**（CLR 的 binder 会自己做 COM QI，PS 的 cast 不会） |

## 7.2 可用配方（零 Add-Type、零原生代码、零新依赖）

\`\`\`powershell
Add-Type -AssemblyName System.Runtime.WindowsRuntime     # bridge 已经在做

# 1) 载入投影类型（必须在同一 AppDomain 内先加载）
$null = [Windows.Storage.Streams.IRandomAccessStream,   Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream,          Windows.Storage.Streams, ContentType=WindowsRuntime]

# 2) 反射取 MethodInfo（只做一次）
$iracT = [Type]::GetType('Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime')
$getIn = $iracT.GetMethod('GetInputStreamAt')
$asStream = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IInputStream' })[0]

# 3) 读（$stream 就是今天 OpenReadAsync 拿到的那个 __ComObject，bridge 现有代码不变）
$isObj = $getIn.Invoke($stream, @([uint64]0))            # → Windows.Storage.Streams.InputStreamOverStream
$net   = $asStream.Invoke($null, @($isObj))              # → System.IO.BufferedStream
$ms = New-Object System.IO.MemoryStream
$net.CopyTo($ms)                                         # → 完整图片字节
$bytes = $ms.ToArray()
\`\`\`

## 7.3 实测数据（真实运行，非示例）

主 runspace，连续 3 次（曲目 \`Don't You\`）：

\`\`\`
stream.Size(get_Size) = 66024
ContentType           = (空字符串)          ← 不能用它判类型，必须继续用 magic 嗅探
bytes read            = 66024
magic                 = FF D8 FF E0         ← JPEG
decoded image         = 600x600（System.Drawing 成功解码）
sha256                = 7a917d7aca3d665ce9a496b0a56db993…（3 次完全一致）
base64 length         = 88032
读取耗时              = 28 ms / 2 ms / 4 ms   ← 对比现在每首歌白等的 3×3s 重试
\`\`\`

**在 bridge 同构环境（Register-ObjectEvent 的 -Action 独立 runspace，用 \`[Console]::Out\` 输出）复测：**

\`\`\`json
{"type":"thumb","title":"Don't You","bytes":66024,"magic":"FFD8FFE0","b64len":88032,"ms":15}
\`\`\`

→ 与 \`smtc-bridge.ps1\` 的调用环境（事件 runspace + \`$global:\` 共享 + \`[Console]::Out\`）**完全同构**，15 ms 成功。

## 7.4 顺带修正的 ABI 事实（来自投影元数据，可用 \`GetMethods()\` 自证）

之前我按记忆假设的 \`IRandomAccessStream\` 方法顺序是错的。**真实顺序**（DeclaredOnly）：

\`\`\`
[0] UInt64 get_Size()
[1] Void   put_Size(UInt64)
[2] IInputStream GetInputStreamAt(UInt64)
[3] IOutputStream GetOutputStreamAt(UInt64)
[4] UInt64 get_Position()
[5] Void   Seek(UInt64)
[6] IRandomAccessStream CloneStream()
[7] Boolean get_CanRead()
[8] Boolean get_CanWrite()
\`\`\`
\`IRandomAccessStreamWithContentType\` 在此基础上追加 \`get_ContentType()\`。

其它已探明（同一方法）：

| 类型 | 实测 |
|---|---|
| \`IInputStream\` | \`IAsyncOperationWithProgress<uint32,uint32> ReadAsync(IBuffer, UInt32, InputStreamOptions)\` ← **不是** \`IAsyncOperation<uint32>\` |
| \`IBufferFactory\` | \`Buffer Create(UInt32 capacity)\` |
| \`IBuffer\` | \`get_Capacity / get_Length / put_Length\` |
| IID | RACTS \`cc254827-4b3d-438f-9232-10c76bc7e038\`、IRandomAccessStream \`905a0fe1-…\`、IInputStream \`905a0fe2-…\`、IBuffer \`905a0fe0-…\`、IBufferFactory \`71af914d-…\` |

→ 结论：**不需要走 raw ABI**；那一层（含 IInspectable 槽位、IAsyncOperationWithProgress）全部由 CLR 的投影 + \`MethodInfo.Invoke\` 代劳。

## 7.5 落地时的注意点（尚未实施，等你们决定）

1. 替换范围：**只有 \`smtc-bridge.ps1\` 的 \`ReadThumbnailDataUrl\` 内部**（约 15 行）。
   返回契约保持完全一致（成功返回 \`data:image/...;base64,...\`，失败返回 \`$null\`），
   因此 **main 的兜底链、renderer、cache、\`ReadThumbnailWithRetry\` 的调用点全部无需改动**。
2. \`MethodInfo\` 只在首次解析并缓存到 \`$global:\`（bridge 已有跨 runspace 用 \`$global:\` 的约定，事件 runspace 可直接复用）。
3. 保留原有护栏：\`≥4 字节\`、\`≤5MB\`、magic 嗅探（**必须保留**，因为实测 \`ContentType\` 是空的）。
4. 建议把重试从 3 次降为 1 次：新路径 15ms 就能成功，失败即真失败，不再是"平台不可能"。
5. 待落地时补验：遇到 PNG/WebP 封面的曲目（本次样本只有 JPEG）、以及切歌瞬间的并发调用。
6. \`System.IO.MemoryStream\` 上限保护：按现有 5MB 上限在循环里提前 return，避免异常大图撑爆内存。

## 7.6 本次 PoC 的边界声明

* 只运行了系统临时目录里的只读探针脚本；**未改动**仓库内任何生产文件（\`git status\` 只有上一轮任务的改动 + 本审计文档）。
* 未改 fallback、未改 renderer、未改 cache、未改 TSP。
* 未触发任何播放控制；只读 \`GetCurrentSession/TryGetMediaPropertiesAsync/OpenReadAsync/GetInputStreamAt\`。
* 探针进程已结束，未残留后台进程。
---

# 8. 方案 A 落地结果（已进入生产）

> 改动范围：**仅 \`desktop/smtc-bridge.ps1\` 的 THUMB 区块**（\`ReadThumbnailDataUrl\` + 两个纯函数 helper + \`ReadThumbnailWithRetry\`）。
> **未改**：fallback resolver、renderer、cache、IPC、SMTC state、TSP。返回契约完全不变。

## 8.1 实际改了什么

| 项 | 变化 |
|---|---|
| 流获取 | \`[Type]\` 转换（必然失败）→ **\`MethodInfo.Invoke\`**（\`IRandomAccessStream.GetInputStreamAt\` + \`AsStreamForRead\`） |
| MethodInfo 缓存 | 新增 \`global:GetThumbProbe\`：**懒初始化**；缓存缺失/成员为 null/调用抛错 → **就地丢弃并重建一次**（陈旧缓存永远不会变成永久 fallback） |
| 读取方式 | 原 \`CopyToAsync + Wait(3000)\` 在该流类型上抛异常 → 改为 **64KB 分块同步读 + 3000ms 总预算**（保留"绝不挂死 runspace"的初衷） |
| MIME | 不依赖 \`ContentType\`（实测为空）→ **magic 嗅探** JPEG/PNG/WebP → \`data:image/{jpeg,png,webp};base64,\` |
| 重试 | 3 次 → **1 次**（原来是在给"投影方式错误"打补丁，白等 ~10s） |
| 日志 | 失败统一 \`[SMTC][THUMB] read failed: <reason>\`；成功打 \`stream=…B\` / \`read=…B Nms\` / \`jpeg 600x600\` / \`accepted len=…\` |
| 新增纯函数 | \`ThumbBytesToFormat\` / \`ThumbImageSize\` / \`ThumbBytesToDataUrl\`（无 WinRT 依赖 → 可被回归测试直接驱动） |

护栏与生命周期保护全部保留：\`≥4B\`、\`≤5MB\`、读取总时限、事件 runspace 不阻塞、任何失败返回 \`$null\`。

## 8.2 "必须真跑"救回来的三个坑

静态检查通过 ≠ 可用。真正跑 bridge 后依次暴露：

1. **\`CopyToAsync\` 在该流类型上不可用** → \`Exception calling "CopyToAsync" … "Value cannot be null."\`（旧代码把"异步+超时"当成保护，实际它在 \`InputStreamOverStream\` 上直接抛）。→ 改成有总时限的分块同步读。
2. **我自己的编辑漏掉了 \`$ms = New-Object System.IO.MemoryStream\`** → \`You cannot call a method on a null-valued expression\`。靠 AST 提取生产函数 + 真实 SMTC props 的复现脚本定位到具体行。
3. **PS 5.1 的 UTF-8-without-BOM 陷阱**：该脚本无 BOM，PS 5.1 按 ANSI 解码；我最初加的中文注释字节会"吞掉"紧跟的标点 → \`ParseFile\` 报 2 处语法错误（**HEAD 版本 0 错误，显式 UTF-8 解析 0 错误**）。若直接上，bridge 会**整脚本解析失败**。
   → 本次新增/修改的注释一律改为 **ASCII**，并把这条约束写进文件头注释。
   ⚠️ **遗留风险**：该文件其余中文注释目前"碰巧"安全，但任何人再动这个文件都可能踩同一坑。建议后续单独做一次"加 UTF-8 BOM"的改动（不在本次范围内）。

## 8.3 回归测试（全部 10/10 PASS）

用 **AST 从生产脚本里提取真实函数**驱动（不是副本）：

\`\`\`
[1] PS 5.1 ParseFile errors = 0
[2] 格式矩阵（生产函数，真实向量）
  PASS  JPEG 600x600 magic+size+mime+roundtrip
  PASS  PNG  600x600 magic+size+mime+roundtrip
  PASS  WebP lyrics-stage.webp   1200x750  (WIC ground truth)
  PASS  WebP artist-detail.webp  2558x1599 (WIC ground truth)
[3] 边界
  PASS  <4B -> null        PASS  5MB+1 -> null        PASS  未知 magic -> unknown
[4] 真实 SMTC + 陈旧缓存
  PASS  live SMTC read ok (Smoking Cherry)
  PASS  stale cache -> rebuild and succeed
  PASS  two reads identical bytes
[SUMMARY] pass=10 fail=0
\`\`\`

* WebP 用仓库里真实 \`.webp\`（VP8 lossy），尺寸与 **Windows 自身 WIC 解码结果**逐一对齐，不是自己跟自己对。
* 并发/自愈：3 个 runspace 同时读同一 session → 3 份字节哈希完全一致；毒化缓存（三个成员全 null）→ 自动重建并成功；连续 5 次读取哈希稳定。

## 8.4 现场验收：连续快速切歌（真实点击，非模拟）

用户实际操作 Apple Music 快速连切，bridge 侧观测窗口内 **7 次 identity 变化、7 次读取全部成功、0 次失败**：

\`\`\`
[SMTC][THUMB] stream=98427B      read=98427B 56ms   jpeg 600x600   accepted len=131259
[SMTC][THUMB] stream=78229B      read=78229B  5ms   jpeg 600x600   accepted len=104331
[SMTC][THUMB] stream=154215B     read=154215B 4ms   jpeg 600x600   accepted len=205643
[SMTC][THUMB] stream=76066B      read=76066B  2ms   jpeg 600x600   accepted len=101447
[SMTC][THUMB] stream=64633B      read=64633B  5ms   jpeg 600x600   accepted len=86203
[SMTC][THUMB] stream=111811B     read=111811B 2ms   jpeg 600x600   accepted len=149107
[SMTC][THUMB] stream=124343B     read=124343B 3ms   jpeg 600x600   accepted len=165815
[SMTC][THUMB] read failed: …     ← 0 条
\`\`\`

读取延迟 **2–56ms**（旧路径：3 × ~3s 后仍失败）。状态行契约与跨曲一致性：

| 曲目 | 状态行 thumbnail | 字节 | magic | sha256(前24) |
|---|---|---|---|---|
| Best Friends | data:image/jpeg | 78229 | FFD8FFE0 | bfe958df8116876e8fd0ad07 |
| New Man | data:image/jpeg | 154215 | FFD8FFE0 | bd7b946f18f452e3b1f05f46 |
| In the Studio (feat. Junglebae) | data:image/jpeg | 76066 | FFD8FFE0 | b2466cdf9ecac5241dcc121d |
| Run | data:image/jpeg | 64633 | FFD8FFE0 | b1bf17da2e26245890209c5a |
| Call Out My Name | data:image/jpeg | 111811 | FFD8FFE0 | 9c16c07417ce3a7c19dc594c |
| Smoking Cherry | data:image/jpeg | 124343 | FFD8FFE0 | e8d3ea37832af5217daccd4f |

* 6 首曲目 → **6 张不同图像**；同一首重复出现时哈希完全一致（\`Run\`、\`Smoking Cherry\` 各出现 2 次）→ **无跨曲错配**（验证了"bridge 不会把 A 的图挂到 B 上"）。
* 同一 identity 的后续状态行不带 \`thumbnail\` 字段 —— 这是既有的 identity 去重设计（避免重复传 100KB+），不是丢失。

## 8.5 结论与遗留

* 封面主链现在是：**SMTC 原生 artwork 直接可用**；iTunes / 本地 resolver 只在"Apple Music 自己就没给图"时兜底。
* 生效时机：MineRadio 当前运行中的 bridge（PID 42024，15:03 启动）仍跑着旧代码，**下次 bridge 重生成 / 应用重启后自动生效**（脚本是 spawn 时从磁盘读取）。
* 遗留（均不在本次范围，未动）：① 上述 UTF-8 BOM 隐患；② 生产 SMTC 只观察到 JPEG，PNG/WebP 已在函数层用真实文件 + WIC 对齐验证，但未遇到真实 PNG/WebP artwork；③ 状态机层面的去重/节流未改（审计已确认其正确性）。


