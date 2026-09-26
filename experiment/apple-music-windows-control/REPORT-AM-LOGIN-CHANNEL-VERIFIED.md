# AM section login channel verified (2026-09-26 13:47-13:53)

Slice: commit `feee40f` - a dedicated `amc:open-login` channel for the AM section
(`main.js` handler + `isTrustedMainWindowIpc` sender check + `openAppleMusicLoginWindow(owner, 'lyrics-token')`),
`preload.js` bridge (`mineradio.amc.openLogin`), and `07-search.js` switched to it. No easter-egg gate.

## Why the previous wiring was wrong (isolated cleanly)

`0fd283d` reused `apple-music-open-login`, whose call omits `purpose`. In
`openAppleMusicLoginWindow` (main.js:3232-3243) that means `lyricsTokenMode = false`, so the
developer-credential precondition runs and returns, before any window exists:

```
APPLE_MUSIC_CREDENTIALS_REQUIRED  ->  "Apple Music 登录需要先配置 Apple 开发者 Team ID、Key ID 与 P8 私钥。"
```

The lyrics entry never had that problem because it passes `'lyrics-token'` (main.js:3420-3421), and it is
restricted to the lyrics window (`isTrustedLyricsSourceIpc`, main.js:5793-5799).

## Observed runtime evidence

| time | observation | what it proves |
|---|---|---|
| 13:47 | `[amc] login click` in the console | the button click reaches the renderer handler (the binding fix from `58b450c` works) |
| 13:52 | row shows red `登录窗口已关闭，未检测到登录态。` | the **window path ran**: that exact string/`LOGIN_WINDOW_CLOSED` can only come from the window branch (main.js:3370-3373). A screenshot of the window was not taken; this signature is stronger evidence than one. |
| 13:53 | row shows `● 已登录` | real login captured -> `saveAppleLyricsTokenCandidate` -> credential store -> `getStatus().configured` -> UI, with no fixed delay |

No `APPLE_MUSIC_CREDENTIALS_REQUIRED` appeared at any point, confirming the new channel skips the
developer-credential precondition as designed.

## Still untested at the time of writing

- step 7-8: restart persistence (`● 已登录` after a restart)
- step 9: five-provider search regression
- step 10-11: AM playback regression (auto-scroll locate -> play -> auto-minimize -> SMTC verdict)

## Dual-state caveats (recorded, deliberately NOT fixed here)

The media-user-token has two homes:

1. the persistent partition cookie `persist:mineradio-apple-login` (read by `readAppleMediaUserToken`);
2. the safeStorage credential store `.apple-music-lyrics-credential.json` (what the AM indicator reads).

Consequences observed in practice:

- clearing only (2) has no effect: the next click re-imports (1) through the reuse branch
  (`saveAppleLyricsTokenCandidate(initialToken)` -> `{ ok: true, reused: true }`) **without opening a window**;
- `apple-music-clear-login` clears (1) but not (2) (main.js:3430-3437), so the indicator can keep showing
  `已登录` after a logout;
- the credential-store clear channel is lyrics-window-only (main.js:5818), and was deliberately not widened.

One authoritative login state plus a complete logout is the follow-up slice; the semantics of
"click login when a session already exists (reuse vs force sign-in)" belongs to that same slice.