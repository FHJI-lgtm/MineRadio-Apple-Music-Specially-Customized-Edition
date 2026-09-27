# REPORT — Developer API 退休审计（2026-09-27）

只读审计为主；本文件之外未改任何代码。结论按验收项逐条给出，附文件:行证据。

## 一、逐条结论

| # | 验收项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 主流程已无 Developer API 依赖 | ⚠️ 基本成立（账户状态链除外） | 搜索/歌单/专辑/播放/歌词/UI 主链见 #3-#7；唯一残留见 #2 |
| 2 | JWT / Team ID / Key ID / P8 不再被运行时读取 | ❌ **不成立** | `apple-music-api.js:486 appleApiHeaders()` → `getAppleDeveloperToken()`(:370) → `signAppleDeveloperJwt()`(:358)，读 teamId/keyId/privateKey；`handleAppleStatus()`(:754) → `getAppleProfile()`(:798) → `appleGet('/v1/me/profile')` 走该 header 链。UI 触发：`08-account/02-login-status.js:567`（`/api/apple/status`）、`03-login-modal-flows.js:1576`（`/api/apple/config`）。另 `desktop/main.js:3234` 在登录流程里读 `getAppleCredentials()` |
| 3 | Web bearer + media-user-token 覆盖现有读操作 | ✅ | `server.js:5460`→`handleApplePlaylistTracksWeb`、`:5473`→`handleAppleAlbumDetailWeb`、`:5383`→`handleAppleUserPlaylistsWeb`（`desktop/apple-music-web-reads-api.js`）。唯一走 Developer 的读是 #2 的资料链 |
| 4 | AM 播放走 Windows App + SMTC | ✅ | `/api/apple/song/url` → `handleAppleSongUrl`(`apple-music-api.js:1405`) 已是**纯 stub**：`playable:false` + `restriction`，零凭据、零外部调用；播放与控制走 AMC(UIA)+SMTC |
| 5 | 歌词走现有 Web/歌词链 | ✅ | `apple-music-api.js:1425 handleAppleLyric` 是 **thin delegate** → `desktop/apple-music-lyrics-api.js:234`（注释明示为兼容 server.js 与既有脚本而保留的转发） |
| 6 | 旧 SMTC hover UI 已不存在 | ✅ | `95c53df`（`03-smtc-ui.js` 1035→392 行）+ `a92f641`；31 个旧标识符全仓扫描 0 残留；`05` 内嵌词源面板（−156 行）一并删除 |
| 7 | 新 UI 是唯一入口 | ✅ | 唯一入口 = 底栏「词」→ 同步设置（`#lyric-sync-entry-btn` → `toggleSyncSettingsPanel`），歌词源 = 独立窗口；三个设置节点由隐藏宿主 `smtcEnsureSettingsHost()` 创建、被面板**搬入**（单实例、无重复 id） |
| 8 | 不误删仍被依赖的 Developer 代码 | ✅ | 保留：`mapAppleTrack / appleErrorDetails / APPLE_LIKED_PLAYLIST_ID`（`apple-music-web-reads-api.js:27` 复用）、`getAppleConfig / getAppleCredentials / saveAppleUserToken / clearAppleToken`（登录流程 + web token store）、`resetAppleRuntimeStateForTests`；`scripts/apple-music-web-mapper-compat.js` 仍可作为新旧映射兼容校验 |
| 9 | 完整回归 | ⚠️ 37/38 | 全部 `tests/*.test.js` 实跑：**37 PASS / 1 FAIL**。失败者为 `update-external-only.test.js:29 assert.equal(packageData.version, '2.1.0')`，而 `package.json` 为 `1.2.3` —— **预先存在**：`git diff --name-only 4a6ae2f..HEAD` 中没有任何 `package.json`/update 相关文件 |

## 二、仍然存在的 Developer 面（不清除就不能称「退休」）

> 更新（2026-09-27，Developer 读取链下线之后）：原 1、2、3、4、5 已解决；只剩第 6 条（它比原判断更复杂，见该条更正）。

1. ~~账户状态/资料链~~ **已解决**：`/api/apple/status` 自 `e06d3c0` 起由 `handleAppleAccountStatusWeb()` 服务；`/api/apple/config` POST 路由、`getAppleConfig`/`saveAppleConfig` import 与登录弹窗的凭据表单已在 Slice D 删除（§六）。
2. ~~登录 IPC 读凭据~~ **已解决**：`27881fb` 之后 `openAppleMusicLoginWindow` 不再 import/读取 Developer 凭据，改写 `saveAppleLyricsTokenCandidate()`（web 凭证 store）。
3. ~~`/api/apple/login/token` 仍走 Developer 面~~ **已解决**（§七 + §八）：渲染层的「备用：粘贴 media-user-token」并入 Apple Music 账户设置后走 web credential store；路由本体与它背后的 `saveAppleUserToken` / `handleAppleStatus` / `getAppleProfile` / `getAppleDeveloperToken` 调用链已在 §八 删除。
4. ~~两条 token store 不是同一个~~ **已解决**（§七）：手动 token 与网页登录窗口现在写同一个 store（`.apple-music-lyrics-credential.json`，主进程 safeStorage），`/api/apple/status`、状态行与账户设置里的状态不再自相矛盾。Developer 的 `.apple-music-token.json` 已没有渲染层写入方（只剩上面那条无调用方的路由与退出登录时的一次 `clearAppleToken()`）。
5. ~~死代码/死字段~~ **已解决**（§八）：`saveAppleConfig`、`handleAppleStatus`/`getAppleProfile`/`normalizeAppleProfile`/`appleProfileCache`、`getAppleConfig`/`tokenConfigured`、`saveAppleUserToken`/`verifyAppleUserToken`、`writeJsonFile`/`getAppleConfigFile`、三个 Developer 读 handler、`handleAppleLibrarySongs`/`dedupeAppleTracks`/`appleCacheWrap` 全部删除；渲染层 `appleLoginStatus.privateKeyConfigured` 与 `appleConfigBusy` 也已从 store/normalizer/logout/web 状态里清掉。
6. **Apple 写入（更正：只有 song 那一对不可达）**：`/api/apple/song/like|song/like/check` 被 `adapter.like === false` 门掉（`05-playback/06-track-detail-lyrics-actions.js:1449`，守卫 :1611 / :1690）✔；但 `/api/apple/album/like|album/like/check` **没有**被 `collect:false` 门住 —— `albumCollectionConfig()`(:284) 照旧返回 apple 配置、`renderAlbumCollectionButton()`(:292) 照旧渲染「收藏专辑」、`syncAlbumCollectionState()`(:309) 与 `toggleAlbumCollection()`(:331) 照旧发请求。两条 album 路由**可达**，且仍会走 Developer JWT（`appleApiHeaders` → `getAppleDeveloperToken`），这是验收项 #2 现在唯一的可达触发点。

## 三、最小后续切片（进度）

1. ~~删死代码（`handleAppleSearch` + `server.js` import、`APPLE_AMP_API_BASE`、`originAmp`）—— 纯删，零行为变化。~~ **已完成**（`3c95f9c`，全仓 0 残留）。
2. ~~`handleAppleStatus` 停止服务账号状态~~ **已完成**（`e06d3c0`：`/api/apple/status` → `handleAppleAccountStatusWeb`）。
3. ~~`desktop/main.js` 登录流程只读 web token store~~ **已完成**（`27881fb`）。
4. ~~登录弹窗的 Developer 凭据表单 + `/api/apple/config`~~ **已完成**（Slice D，§六）。
5. ~~把手动 token 路径并入 web 轴~~ **已完成**（§七：`saveAppleWebToken` → 既有 `mineradio-apple-lyrics-credential-set` → `createAppleMusicLyricsCredentialStore`；`submitAppleManualToken` 与散落的 token 输入框已删除）。
6. ~~删 `saveAppleConfig`、`/api/apple/login/token`（连同 `handleAppleStatus` 调用链）与 `privateKeyConfigured` / `appleConfigBusy` 死字段~~ **已完成**（§八：`apple-music-api.js` 1419 → 844 行，`server.js` 同步收窄 import）。
7. **待定（有前提，不能当纯删）**：删 `/api/apple/song/like|album/like|like/check` 路由 + `handleAppleLibraryCheck/Set`。song 对是死路由；**album 对可达**（§二.6 更正），删它必须同时决定详情面板「收藏专辑」按钮的处置（隐藏 / 明确显示「Apple 暂不支持收藏」）。做完这条，`appleGet` / `appleApiHeaders` / `getAppleDeveloperToken` / `signAppleDeveloperJwt` / `getAppleCredentials` 才会整条变成死代码。

验收项 #2（JWT / Team ID / Key ID / P8 不再被运行时读取）：**账户轴、登录、播放、歌词、UI 路径上已成立**；唯一残留是 §三.7 的 album 收藏路由（可达但需要用户点「收藏专辑」）。做完 7 才能把 #2 整体翻 ✅，**在那之前不应打 `developer-api-retired`**。

## 四、本次 checkpoint

- 审计 commit：本文件。
- tag：`checkpoint/migration-mainline`（描述「迁移主线完成、旧 UI 已删」，不含「Developer 已退休」的断言）。

## 五、备注

`experiment/apple-music-windows-control/MVP-INTEGRATION-PLAN.md` §20 的退休表已过期（3A/3B/3C 早已完成、Step 4 与 UI 收口也已落地），本轮未改该表 —— 若需要，可作为下一次文档提交。

## 六、Slice D（2026-09-27）

Developer 账号轴收尾的 UI / 路由切除。改动：

- `public/js/modules/08-account/03-login-modal-flows.js`（1910 → 1816 行）：删 `parseAppleConfigInput`、`openAppleDeveloperCertificates`（含 `APPLE_DEVELOPER_CERTIFICATES_URL`）、`submitAppleConfigLogin`；面板文案改为「登录 Apple Music 网页账号」；Apple 分支隐藏只用于收集 Team ID / Key ID / P8 的 textarea；面板「保存」与官方模式按钮一律走 `openAppleWebLogin`；`openAppleWebLogin` 的凭据前置检查删除（`desktop/main.js` 已不再设该前置）。
- `server.js`：删 `/api/apple/config` POST 路由、`getAppleConfig`/`saveAppleConfig` import，以及 easter-egg 路由守卫表里的 `/api/apple/config`。
- `public/index.html`：Apple 节点副标题「开发者凭据 + 官方登录」→「网页账号 + 官方登录」。
- `tests/apple-music-playback-context.test.js` test 32：4 个已删标识符进 retired 清单（fs 全树扫描，防悬空调用）。

验证：`node --check` 全过；全仓 grep `parseAppleConfigInput|openAppleDeveloperCertificates|APPLE_DEVELOPER_CERTIFICATES_URL|submitAppleConfigLogin` 在源码树 0 残留；`node --test tests/*.test.js` 见提交信息。

**本切片未做**（见 §二）：`/api/apple/login/token` 与手动 token 行、`saveAppleConfig` 与 `privateKeyConfigured` 死代码。

## 七、Apple Music 账户设置（2026-09-27）

统一入口：登录弹窗 Apple 面板 →「Apple Music 账户设置」，实现全在 `public/js/modules/08-account/06-apple-account-settings.js`。

- **MineRadio 显示资料**（显示名称 / 显示头像）：纯本地 UI 资料，落在 `localStorage` 的 `mineradio-apple-display-profile-v1`（头像压成 160×160 内联图，≤512KB，不支持外链）。只作用在 Apple 的账号 UI 上 —— `providerAvatarSrc` / `providerAccountIdentity` / `updateUserModalUi` 各自只对 `provider === 'apple'` 让路，其他平台的展示链一字未改。它不改任何凭证、不出本机、不上传。
- **Web 账户**（当前状态 / 手动写入 Token）：`desktop/preload.js` 新增 `saveAppleWebToken` → 既有 IPC 通道 `mineradio-apple-lyrics-credential-set` → 既有 `createAppleMusicLyricsCredentialStore`（safeStorage）。主进程只把该通道的信任范围从「歌词窗口」放宽到「歌词窗口 + 主窗口」（`isTrustedAppleLyricsCredentialWriter`），没有第二条写通道、没有第二套存储；`clear` 仍只允许歌词窗口。写入成功后立刻刷新 web 登录状态（`refreshAppleWebLoginStatus` + `refreshAppleLoginStatus`）。
- **隔离**：退出登录 `clearAppleMusicLoginSession()` 只清登录窗口分区（`APPLE_LOGIN_PARTITION`）+ credential store，不碰主窗口 localStorage → 显示资料不会被退出登录删除；改显示资料也不触碰 token / 登录态 / SMTC / 播放链。
- **不复活 Developer**：新增代码对 `getAppleCredentials` / `getAppleDeveloperToken` / `signAppleDeveloperJwt` / `/v1/me/profile` / Team ID / Key ID / P8 零引用（"运行时引用" 按去掉注释后的代码判定），也不写 Developer 凭证文件。

测试：`tests/apple-account-settings.test.js`（15 项：显示资料 store 归一化与读写、局部更新、退出登录隔离、显示资料只作用于 Apple、web token 通道唯一性、Developer 符号零新引用、UI 入口与密码输入、vm + 假 DOM 的面板行为）。全量 `node --test tests/*.test.js` → **236 项，235 pass / 1 fail**（仍是既有的 `update-external-only` 版本断言）。

## 八、Developer 读取/写入链下线 + Apple 退出登录修复（2026-09-27）

两件事同一个提交（都是 Developer 账号轴的收尾）：

1. **修复退出登录（真 bug）**：`clearAppleMusicLoginSession()` 里残留的 `clearAppleToken()` 调用，在 `27881fb` 把该 import 一起删掉之后就无人解析 —— 每次「退出 Apple Music」都在这一行抛 ReferenceError，**下面清 web 凭证的代码永远跑不到**：退出后 media-user-token 仍在，重启又变回已登录。删掉该调用，退出登录恢复为「清登录窗口分区 + 清 web credential store」。
2. **下线 Developer 读取/写入链**（纯删，`apple-music-api.js` 1419 → 844 行）：
   - `server.js`：删 `/api/apple/login/token` 路由 + 随之无用的 6 个 import（`saveAppleUserToken` / `handleAppleStatus` / `getAppleDeveloperToken` / `handleAppleUserPlaylists` / `handleApplePlaylistTracks` / `handleAppleAlbumDetail`）。
   - `apple-music-api.js`：删 `handleAppleStatus`、`getAppleProfile`、`normalizeAppleProfile`、`appleProfileCache`、`getAppleConfig`、`tokenConfigured`、`saveAppleConfig`、`saveAppleUserToken`、`verifyAppleUserToken`、`writeJsonFile`、`getAppleConfigFile`、三个 Developer 读 handler、`handleAppleLibrarySongs`、`dedupeAppleTracks`、`appleCacheWrap` 及对应导出/常量。
   - 渲染层死字段：`appleLoginStatus.privateKeyConfigured`（store 默认值、normalizer 两处、两处 logout 重置、web 状态响应）与 `appleConfigBusy` 全部清除。
   - **保留（仍被依赖）**：`mapAppleTrack` / `mapAppleLibraryPlaylist` / `appleErrorDetails`（web 读取复用）、`getAppleCredentials` / `getAppleDeveloperToken` / `signAppleDeveloperJwt` / `appleApiHeaders` / `appleGet`（§三.7 的 like/album 路由仍在用）、`clearAppleToken`（`/api/apple/logout` 仍在用）、`handleAppleSongUrl`（纯 stub）、`handleAppleLyric`（web 委托）。
3. **测试**：`tests/apple-account-settings.test.js` 新增 TEST 16–18（vm 跑真实退出登录函数体并断言「既清分区也清 web 凭证」、main.js 不再调用任何已删助手、两条主线文件不再有 Developer 读取链）；`tests/apple-music-playback-context.test.js` test 32 的 retired 清单补 8 个已删标识符，并把本测试文件加入 skip（它自己就会点名这些标识符）。全量 `node --test tests/*.test.js` → **239 项，238 pass / 1 fail**（仍是既有的 `update-external-only` 版本断言）。
