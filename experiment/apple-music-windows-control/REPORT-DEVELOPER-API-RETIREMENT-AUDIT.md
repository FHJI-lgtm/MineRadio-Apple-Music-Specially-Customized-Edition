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

> 更新（2026-09-27，Slice D 之后）：原 1、2 已解决，剩余面收敛为下面 5 条。

1. ~~账户状态/资料链~~ **已解决**：`/api/apple/status` 自 `e06d3c0` 起由 `handleAppleAccountStatusWeb()` 服务；`/api/apple/config` POST 路由、`getAppleConfig`/`saveAppleConfig` import 与登录弹窗的凭据表单已在 Slice D 删除（§六）。
2. ~~登录 IPC 读凭据~~ **已解决**：`27881fb` 之后 `openAppleMusicLoginWindow` 不再 import/读取 Developer 凭据，改写 `saveAppleLyricsTokenCandidate()`（web 凭证 store）。
3. **`/api/apple/login/token` 仍走 Developer 面**：`server.js:5306` 的 `saveAppleUserToken(body)` + `handleAppleStatus()` → `getAppleProfile()` → `appleApiHeaders()` → `getAppleDeveloperToken()`（JWT）。渲染层入口是登录弹窗的「备用：粘贴 media-user-token」（`08-account/03-login-modal-flows.js` 的 `submitAppleManualToken`）。**这是验收项 #2 现在唯一实际触发点。**
4. **两条 token store 不是同一个**：账号轴读 `.apple-music-lyrics-credential.json`（`desktop/apple-music-web-reads-api.js:9-12`；`apple-music-web-api.js:39-52` 的 token 由主进程注入），而 3 写 `.apple-music-token.json` → 手动粘贴 token 后 `/api/apple/status` 仍报未连接，弹窗状态行会自相矛盾（`Apple Music 未登录 · Apple Music：已连接`）。
5. **死代码/死字段**：`apple-music-api.js` 的 `saveAppleConfig`（:194）与它的导出（:1395）已无调用方（唯一调用者 `/api/apple/config` 已删）；渲染层 `appleLoginStatus.privateKeyConfigured` 只剩写/默认值（`00-core-stores.js:48`、`02-login-status.js:514,521`、`04-user-modal-logout.js:154,245`、`desktop/apple-music-web-reads-api.js:225`），无任何读取处。
6. **Apple 写入**：能力已关闭（`public/js/modules/05-playback/06-track-detail-lyrics-actions.js:1449-1451` `like:false / collect:false`；:1611 的守卫早于 `likeCheckUrl` 使用即返回）→ `/api/apple/song/like|album/like|like/check` 三条路由**当前不可达**，但路由与 Developer handler 仍在。

## 三、最小后续切片（进度）

1. ~~删死代码（`handleAppleSearch` + `server.js` import、`APPLE_AMP_API_BASE`、`originAmp`）—— 纯删，零行为变化。~~ **已完成**（`3c95f9c`，全仓 0 残留）。
2. ~~`handleAppleStatus` 停止服务账号状态~~ **已完成**（`e06d3c0`：`/api/apple/status` → `handleAppleAccountStatusWeb`）。
3. ~~`desktop/main.js` 登录流程只读 web token store~~ **已完成**（`27881fb`）。
4. ~~登录弹窗的 Developer 凭据表单 + `/api/apple/config`~~ **已完成**（Slice D，§六）。
5. **待做**：把手动 token 路径并入 web 轴（`/api/apple/login/token` 改写入 `.apple-music-lyrics-credential.json`，或改为 main-process IPC），同步改 `submitAppleManualToken` 与文案 → 完成后 §二.3、§二.4 消除。
6. **待做**：删 `saveAppleConfig` 与 `appleLoginStatus.privateKeyConfigured` 死字段（纯删）。
7. 可选：删 `/api/apple/song/like|album/like|like/check` 路由 + `handleAppleLibraryCheck/Set`。

完成 5-6 后验收项 #2 才能翻为 ✅；**在那之前不应打 `developer-api-retired`**。

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
