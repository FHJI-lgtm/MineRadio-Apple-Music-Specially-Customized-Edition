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

1. **账户状态/资料链**：`/api/apple/status`、`/api/apple/config` → `handleAppleStatus()` → `getAppleProfile()`（Developer `/v1/me/profile` + JWT）。这是 #2 的唯一实际触发点。
2. **登录 IPC 读凭据**：`desktop/main.js:34-37` 引入 `getAppleConfig / getAppleCredentials / saveAppleUserToken / clearAppleToken`；`:3234` 读 `getAppleCredentials()`（teamId/keyId/p8 文件）。
3. **死代码**：`handleAppleSearch`（`apple-music-api.js:829`；`server.js:138` 仍 import，但**已无 `/api/apple/search` 路由**）、`APPLE_AMP_API_BASE`（:36）、`appleApiHeaders` 的 `opts.originAmp`（:495）。
4. **Apple 写入**：能力已关闭（`public/js/modules/05-playback/06-track-detail-lyrics-actions.js:1449-1451` `like:false / collect:false`；:1611 的守卫早于 `likeCheckUrl` 使用即返回）→ `/api/apple/song/like|album/like|like/check` 三条路由**当前不可达**，但路由与 Developer handler 仍在。

## 三、最小后续切片（建议，本次未做）

1. 删死代码（`handleAppleSearch` + `server.js` import、`APPLE_AMP_API_BASE`、`originAmp`）—— 纯删，零行为变化。
2. `handleAppleStatus` 停止调用 `getAppleProfile()`（昵称/歌单数可由 web 轴或本地 token 派生），`capabilities` 改由 web 轴能力决定 → **JWT 与凭据读取归零**。
3. `desktop/main.js` 登录流程只读 web token store（`storefront` 从 web token 取），不再 `getAppleCredentials()`。
4. 可选：删 `/api/apple/song/like|album/like|like/check` 路由 + `handleAppleLibraryCheck/Set`。

完成 1-3 后验收项 #2 才能翻为 ✅；**在那之前不应打 `developer-api-retired`**。

## 四、本次 checkpoint

- 审计 commit：本文件。
- tag：`checkpoint/migration-mainline`（描述「迁移主线完成、旧 UI 已删」，不含「Developer 已退休」的断言）。

## 五、备注

`experiment/apple-music-windows-control/MVP-INTEGRATION-PLAN.md` §20 的退休表已过期（3A/3B/3C 早已完成、Step 4 与 UI 收口也已落地），本轮未改该表 —— 若需要，可作为下一次文档提交。