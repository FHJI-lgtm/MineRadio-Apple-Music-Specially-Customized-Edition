# Phase 3.7E-① — 冻结链等待点只读审计

**范围**：`poc/lib/am-common.ps1`、`am-smtc.ps1`、`am-uia.ps1`、`am-play.ps1`（**一行未改**）。
方法：对 `Start-Sleep | Wait-* | *Ms 参数 | Timeout | Retries | 轮询 do/while` 全量检索（112 处匹配），逐条归类。

**分类口径**：
- **S = 系统必要**（受窗口激活/渲染/属性更新等外部延迟约束，轮询命中即退出）
- **C = 代码自己等待**（固定 sleep，无外部依赖证据 → 候选）
- **N = 本流程无关**（当前 deep link 成功路径不会走到）

---

## 1. 总表

| 文件:行 | 点 | 原值 | 类型 | 说明 / 依据 |
|---|---|---|---|---|
| am-play:37 | `PageWaitMs` | **12000** | S | deep link 等待的**上限**，**轮询命中即 break**，不影响成功用例耗时 |
| am-play:127 | deep link 轮询间隔 | **300ms** | **C** | 决定"页面已就绪"的**检出粒度**：平均多付 ~150ms，最坏 300ms |
| am-play:105 | 置前后固定等待 | 200ms | **C** | 无外部依赖证据 |
| am-play:97 | 若由本链启动 AM 后的等待 | 800ms | S(条件) | 仅当 AM 未运行时；本环境 AM 已运行 → **不走到** |
| am-play:61 → am-smtc:77 | `Wait-AmSmtcSettled` | 上限 **1500**，轮询 **100** | S | `-PauseFirst` 基线；非 Playing 即退出 |
| am-play:283 → am-smtc:90 | `Wait-AmPlayback` | 上限 **6000**，轮询 **120** | S | SMTC 确认；**实测段 p50=144ms ≈ 1 个轮询** |
| am-play:35 | `Retries` | **2** | C(失败路径) | 只影响失败重试；成功用例 1 次即出 |
| am-play:305 | 重试间隔 | 500ms | N | 仅失败重试 |
| am-play:193/194 | search 模式轮询 / 上限 | 250 / 6000 | N | **search 模式**（本次 deep link 路线不走） |
| am-play:231 | search 后导航轮询 | 400ms | N | 同上 |
| am-uia:61,75,80 | `Ensure-AmRunning` | 上限 30000，轮询 300 | S(条件) | AM 已在跑 → 立即返回 |
| am-uia:106,114 | `Restore-AmWindow` 等待 | **600ms** | **C**(条件) | **仅当窗口最小化/出屏时**；本基准要求窗口正常可见 → **不走到** |
| am-uia:135,141 | `Get-AmRoot` 重试 | **6 × 400ms**（上限 2400） | S | 首次成功即返回；**最坏 2.4s 是超时路径** |
| am-uia:412 | 点击路径内 sleep | **120ms** | **C** | 无依据 |
| am-uia:415 | 点击路径内 sleep | **450ms** | **C** | 无依据（位于取安全点/行播放前后） |
| am-uia:517 | 点击路径内 sleep | **350ms** | **C** | 无依据 |
| am-uia:533 | 点击路径内 sleep | **200ms** | **C** | 无依据 |
| am-uia:535 | 点击路径内 sleep | **130ms** | **C** | 无依据 |
| am-uia:419,425 | `Wait-AmRect` | 上限 600，轮询 100 | S | 轮询命中即退 |
| am-uia:437…478 | `Realize-AmRow` | 上限 2000；子等待 500/700/800/800/600；滚动步间 250 ×≤6 | S | 逐级升级策略；正常行第一次即得矩形 |
| am-uia:167,172-210 | `Invoke-AmSearch` | 上限 4000；150/250/120ms | N | search 模式专用 |
| am-uia:245 | `Invoke-AmNavigateUrl` 尾部 sleep | **500ms** | **C（已确认，成功路径必走，无条件）** | 见第 6 节 |

## 6. 已确认项：`am-uia.ps1:245`（原"待查"）

**归属**：`Invoke-AmNavigateUrl([string]$Url)`（`am-uia.ps1:233-247`）。
**可达性**：**成功路径必走**。它位于该函数**末尾、`return` 之前**，且与导航成败无关：

```powershell
233: function Invoke-AmNavigateUrl([string]$Url) {
236:   if (Test-Path $exe) { ... Start-Process ... $method = 'AppleMusic.exe /url' }
242:   if (-not $method) { try { Start-Process $Url ... } catch { $method = 'failed' } }
245:   Start-Sleep -Milliseconds 500      # <-- 无条件
246:   return @{ method = $method; ok = ($method -ne 'failed') }
```

调用方 `am-play.ps1:120` 在 deep link 模式下**唯一入口**：`$nav = Invoke-AmNavigateUrl $Url`，
返回后立刻进入轮询循环（首个等待是 `am-play:127` 的 300ms）。

→ 因此这 500ms **既不是失败 fallback，也不是异常分支**，而是**每次 deep link 导航都固定付出的 500ms**，
且与轮询的 300ms **串联**（`500 + 300×k`）。

**对前台占用的意义（待 benchmark 判定）**：导航本身会激活 AM 窗口（T3 可能落在这 500ms 之内），
所以它对 `foreground occupancy` 的净贡献取决于 T3 的相对位置——这正是 ④ 要测的：

| 可能结果 | 含义 |
|---|---|
| 固定等待 1950ms，实际前台 ~900ms | 部分等待发生在 AM 已可继续操作之后 → **有可抠空间** |
| 固定等待 1950ms，实际前台 1450–1600ms | 这些等待确实在撑同步 → 不应盲删 |

**成功路径（deep link + 已运行 AM + 窗口正常可见 + 无重试）会走到的等待点**：
`500`(导航后,无条件) · `300`(导航轮询) · `200`(置前) · `120`+`450`+`350`+`200`+`130`(点击路径) · `100/120`(SMTC 轮询) ·
`Wait-AmRect/Realize` 的**上限**（命中即退）。

---

## 2. 回答"这一秒是系统的，还是代码自己在等"

把可归因的**代码固定等待**相加（成功路径）：

```
120 + 450 + 350 + 200 + 130  = 1250ms   ← 点击路径内的固定 sleep（am-uia）
+ 200                        = 1450ms   ← 置前后固定等待（am-play:105）
→ 仅"无外部依据的固定等待"就 ≥ 1.25s
```

外加**轮询粒度**造成的检出延迟：
```
deep link 就绪检出：0–300ms（均值 ~150）
SMTC 确认检出：0–120ms（实测 p50 144ms）
```

**结论**：现有实现里，**"前台占用"里至少 1.25s 属于代码自己等待**，不是系统必要时间；
再加上轮询粒度的 ~0.15–0.27s。这与你我共同怀疑的方向一致，但**必须由 benchmark 实测确认**
（哪些 sleep 真正被系统状态覆盖、缩短后成功率是否不变）。

⚠ 同时必须记住：**`PageWaitMs=12000` 本身不是耗时**（上限 + 命中即退），不要把它当成"慢"的原因；
真正与"等待"相关的是 **300ms 轮询间隔**。

---

## 3. 本轮新发现（对 ③ 有直接价值）

**冻结链已经内建了分阶段计时并随返回值给出**（`am-play.ps1:54`、`:81`）：

```
t = { ensureAppMs, uiRootMs, searchMs, settleMs, listMs, selectMs, realizeMs, clickMs, smtcMs, e2eMs }
a = { 同上，按阶段覆盖 }
result.contentMatchMs / result.navigateMs
```

→ **在不修改任何代码的前提下**，benchmark 可以直接**读取返回对象**拿到
`ensureApp / uiRoot / list / realize / click / smtc` 的**分阶段耗时**，
再用外部 50ms observer 提供的 `T3`（AM 成为前台）与之对齐，即可得到你要的分解：

```
Foreground Occupancy
├── T4 - T3   AM → UIA ready
├── T6 - T3   UIA → 交互上界（T7 仍不可严格得）
├── T9 - T3   交互 → SMTC
└── T10 - T3  SMTC → 恢复前台
```

这纠正了我上一轮方案里"只能外部观测"的说法：**内部分阶段耗时本来就可得（只读）**，
外部 observer 只负责 `T3/T10/T11` 与轮询粒度声明。

---

## 4. 待查的 1 处 + 明确不改的 3 处

| 项 | 处理 |
|---|---|
| `am-uia.ps1:245` 的 500ms sleep | **待查**：先确认它属于哪个函数、在成功路径上是否会被执行（只读确认，不改） |
| `PageWaitMs=12000` | **不改**（上限，命中即退） |
| 300ms 导航轮询 | **不改**（本轮只审计；它是"检出粒度"候选，需 benchmark 证据） |
| `Retries=2` | **不改**（仅失败路径） |

---

## 5. 下一步（严格按你定的顺序）

1. 只读确认 `am-uia.ps1:245` 的归属与可达性（1 次静态阅读）；
2. 20 首**可解析性预检**（失败者记录原因并换歌，锁定最终 20 首）；
3. 外部 observer + **空轮询基线**（声明 measurement resolution ≈ 50ms + 采样开销）；
4. 20 组 baseline（每首一次，失败不覆盖）→ 产出分解与 median/P90/min/max；
5. 只有在前 4 步数据齐备后，才**只改一个东西**（最可能的候选：`am-uia` 点击路径内的固定 sleep 组合）
   并重跑 benchmark 对比。

**本轮未运行 benchmark、未改任何代码、未碰已关闭路线。**
