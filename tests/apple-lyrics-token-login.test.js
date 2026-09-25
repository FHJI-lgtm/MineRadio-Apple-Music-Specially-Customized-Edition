'use strict';
// ============================================================
// A 方案测试: 歌词 Token 复用 Apple Music Web 登录窗口
//
//   TEST 25: openAppleMusicLyricsTokenLogin() 结果映射 —— 只回状态字段, 永不回传 token。
//   TEST 26: openAppleMusicLoginWindow(owner, 'lyrics-token') 真实函数体 ——
//            没有 Developer 凭证也能开登录窗口; cookie -> 现有歌词 credential store;
//            账号登录路径 (无 purpose) 行为完全不变; 超时/关窗/拒绝都有明确 error。
//   TEST 27: saveAppleLyricsTokenCandidate() 只做本地校验 + 现有 store; 日志不含 token。
//   TEST 28: IPC / preload / 存储模型 / 无 /v1/me/account / UI 契约。
//
// 说明: 直接从 desktop/main.js 按大括号取出**真实函数体**在 vm 里执行, 只把
//       Electron (BrowserWindow/session) 与 store 换成记录器。
// 运行: node tests/apple-lyrics-token-login.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const MAIN_FILE = path.join(appRoot, 'desktop', 'main.js');
const PRELOAD_FILE = path.join(appRoot, 'desktop', 'lyrics-source-preload.js');
const WINDOW_JS_FILE = path.join(appRoot, 'desktop', 'lyrics-source-window.js');
const WINDOW_HTML_FILE = path.join(appRoot, 'desktop', 'lyrics-source-window.html');
const STORE_FILE = path.join(appRoot, 'desktop', 'apple-music-lyrics-credential.js');

const FAKE_TOKEN = '0.fake-token-value-for-tests-0123456789abcdef';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// 按大括号配对取出真实函数体
function extractFunction(src, name) {
  const asyncStart = src.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('无法配对函数 ' + name);
}

function evalFunction(fnSrc, name, extra) {
  const ctx = Object.assign({
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, String, Number, Object, Array, Boolean, Error, Promise, isFinite, parseInt, parseFloat,
    setTimeout, clearTimeout, setInterval, clearInterval,
  }, extra || {});
  ctx.globalThis = ctx;
  return vm.runInNewContext(fnSrc + '\n; ' + name, ctx);
}

// ------------------------------------------------------------
// TEST 25: 歌词入口的结果映射 (返回值永不含 token)
// ------------------------------------------------------------
test('TEST 25: openAppleMusicLyricsTokenLogin 只回状态字段, 永不回传 token', async () => {
  const mainSrc = read(MAIN_FILE);
  const fnSrc = extractFunction(mainSrc, 'openAppleMusicLyricsTokenLogin');
  assert.match(fnSrc, /openAppleMusicLoginWindow\(owner, 'lyrics-token'\)/, '必须复用登录窗口并以 lyrics-token 模式调用');

  async function run(cannedResult) {
    const calls = [];
    const fn = evalFunction(fnSrc, 'openAppleMusicLyricsTokenLogin', {
      openAppleMusicLoginWindow: async (owner, purpose) => { calls.push({ owner, purpose }); return cannedResult; },
    });
    const result = await fn({ id: 'lyrics-window' });
    return { result, calls };
  }

  const ok = await run({ ok: true, provider: 'apple', opened: true, lyricsToken: true, junk: FAKE_TOKEN });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ok.result)), { ok: true, configured: true, reused: false });
  assert.strictEqual(ok.calls[0].purpose, 'lyrics-token');
  assert.ok(JSON.stringify(ok.result).indexOf(FAKE_TOKEN) < 0, '返回值不得包含 token');
  assert.ok(!('token' in ok.result) && !('mediaUserToken' in ok.result), '返回值不得含 token 字段');

  const reused = await run({ ok: true, reused: true, lyricsToken: true });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(reused.result)), { ok: true, configured: true, reused: true });

  const timeout = await run({ ok: false, provider: 'apple', error: 'LOGIN_TIMEOUT', message: '登录超时，请重试。' });
  assert.strictEqual(timeout.result.ok, false);
  assert.strictEqual(timeout.result.error, 'LOGIN_TIMEOUT');
  assert.ok(timeout.result.message.length > 0);

  const closed = await run({ ok: false, provider: 'apple', error: 'LOGIN_WINDOW_CLOSED', message: '登录窗口已关闭，未检测到登录态。' });
  assert.strictEqual(closed.result.error, 'LOGIN_WINDOW_CLOSED');

  const storeRejected = await run({ ok: false, provider: 'apple', error: 'TOKEN_SHAPE', message: 'x' });
  assert.strictEqual(storeRejected.result.error, 'TOKEN_SHAPE', '本地校验错误码必须透出 (便于 UI 提示)');

  const unknown = await run(undefined);
  assert.strictEqual(unknown.result.ok, false);
  assert.strictEqual(unknown.result.error, 'LOGIN_WINDOW_CLOSED');
  assert.ok(JSON.stringify(unknown.result).indexOf(FAKE_TOKEN) < 0);
});

// ------------------------------------------------------------
// TEST 26: 登录窗口真实函数体 —— 前置条件解耦 + cookie -> 歌词 store
// ------------------------------------------------------------
function makeLoginHarness(options) {
  options = options || {};
  const state = {
    windowCreations: 0,
    accountTokenSaves: 0,
    lyricsTokenSaves: [],
    openedUrls: [],
    lastWindow: null,
    cookieToken: options.cookieToken === undefined ? '' : options.cookieToken,
  };
  function FakeBrowserWindow() {
    state.windowCreations += 1;
    const handlers = {};
    const self = {
      _destroyed: false,
      webContents: {
        setWindowOpenHandler() {},
        on(name, cb) { handlers['wc:' + name] = cb; },
      },
      on(name, cb) { handlers[name] = cb; },
      isDestroyed() { return self._destroyed; },
      show() {},
      close() {
        if (self._destroyed) return;
        self._destroyed = true;
        if (handlers.closed) handlers.closed();
      },
      loadURL(url) {
        state.openedUrls.push(url);
        // 模拟登录页加载完成 -> 主进程做一次 cookie 检查
        if (handlers['wc:did-finish-load']) handlers['wc:did-finish-load']();
        return Promise.resolve();
      },
      ___handlers: handlers,
    };
    state.lastWindow = self;
    return self;
  }
  const cookieSession = { cookies: { on() {}, removeListener() {} } };
  const ctx = {
    getAppleCredentials: () => (options.credentials || { configured: false, missing: ['APPLE_MUSIC_TEAM_ID'], storefront: 'us' }),
    session: { fromPartition: () => cookieSession },
    BrowserWindow: FakeBrowserWindow,
    APPLE_LOGIN_PARTITION: 'persist:mineradio-apple-login',
    APPLE_MEDIA_USER_TOKEN_COOKIE: 'media-user-token',
    APPLE_LYRICS_TOKEN_LOGIN_TIMEOUT_MS: options.timeoutMs === undefined ? 180000 : options.timeoutMs,
    APP_ICON_ICO: 'icon.ico',
    shell: { openExternal: () => Promise.resolve() },
    appleMusicLoginUrl: (storefront) => 'https://music.apple.com/' + storefront,
    readAppleMediaUserToken: async () => state.cookieToken,
    saveAppleUserToken: async () => { state.accountTokenSaves += 1; return { ok: true }; },
    saveAppleLyricsTokenCandidate: (token) => {
      state.lyricsTokenSaves.push(token);
      return options.storeAccepts !== false;
    },
  };
  const fn = evalFunction(extractFunction(read(MAIN_FILE), 'openAppleMusicLoginWindow'), 'openAppleMusicLoginWindow', ctx);
  return { fn, state };
}

test('TEST 26: 没有 Developer 凭证也能开歌词登录窗口; cookie 写入歌词 store; 账号流程不变', async () => {
  const fakeOwner = { isDestroyed: () => false };
  // (a) lyrics 模式 + 无 Developer 凭证 + 从未登录: 必须真的打开登录窗口, 关窗后有明确失败态
  const noCreds = makeLoginHarness({ credentials: { configured: false, missing: ['APPLE_MUSIC_TEAM_ID'], storefront: 'us' } });
  const opened = noCreds.fn(fakeOwner, 'lyrics-token');
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(noCreds.state.windowCreations, 1, '没有 Developer 凭证时也必须能打开 Apple Music 登录窗口');
  assert.strictEqual(noCreds.state.openedUrls[0], 'https://music.apple.com/us');
  assert.strictEqual(noCreds.state.accountTokenSaves, 0, '歌词模式不得写 Developer 体系 token');
  noCreds.state.lastWindow.close();                       // 用户直接关窗
  const closedResult = await opened;
  assert.strictEqual(closedResult.ok, false);
  assert.strictEqual(closedResult.error, 'LOGIN_WINDOW_CLOSED');
  assert.ok(JSON.stringify(closedResult).indexOf(FAKE_TOKEN) < 0);

  // (b) lyrics 模式 + 登录后 cookie 到位: 自动捕获并写入现有歌词 store
  const withCookie = makeLoginHarness({ cookieToken: FAKE_TOKEN });
  const captured = withCookie.fn(fakeOwner, 'lyrics-token');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(withCookie.state.lyricsTokenSaves, [FAKE_TOKEN], 'cookie 必须交给现有歌词 store');
  assert.strictEqual(withCookie.state.accountTokenSaves, 0, '歌词模式不得写账号 token');
  const capturedResult = await captured;
  assert.strictEqual(capturedResult.ok, true);
  assert.strictEqual(capturedResult.lyricsToken, true);
  assert.ok(JSON.stringify(capturedResult).indexOf(FAKE_TOKEN) < 0, '成功结果不得包含 token');

  // (c) lyrics 模式 + 已有登录态: 直接复用, 不再开窗
  const reuse = makeLoginHarness({ cookieToken: FAKE_TOKEN });
  const reuseResult = await reuse.fn(fakeOwner, 'lyrics-token');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(reuseResult)), { ok: true, provider: 'apple', reused: true, lyricsToken: true });
  assert.strictEqual(reuse.state.windowCreations, 0, '已有登录态时不得重复开窗');
  assert.deepStrictEqual(reuse.state.lyricsTokenSaves, [FAKE_TOKEN]);

  // (d) 账号登录路径 (无 purpose) + 无 Developer 凭证: 旧的前置检查必须保留
  const accountNoCreds = makeLoginHarness({ credentials: { configured: false, missing: ['APPLE_MUSIC_TEAM_ID'], storefront: 'us' } });
  const gate = await accountNoCreds.fn(fakeOwner);
  assert.strictEqual(gate.ok, false);
  assert.strictEqual(gate.error, 'APPLE_MUSIC_CREDENTIALS_REQUIRED');
  assert.deepStrictEqual(gate.missing, ['APPLE_MUSIC_TEAM_ID']);
  assert.strictEqual(accountNoCreds.state.windowCreations, 0, '账号模式缺凭证时不得开窗');
  assert.deepStrictEqual(accountNoCreds.state.lyricsTokenSaves, [], '账号模式不得写歌词 store');

  // (e) 账号登录路径 + 已有登录态: 仍然写账号 token 文件, 不碰歌词 store
  const accountReuse = makeLoginHarness({ cookieToken: FAKE_TOKEN, credentials: { configured: true, missing: [], storefront: 'us' } });
  const accountReuseResult = await accountReuse.fn(fakeOwner);
  assert.strictEqual(accountReuseResult.ok, true);
  assert.strictEqual(accountReuseResult.reused, true);
  assert.strictEqual(accountReuse.state.accountTokenSaves, 1, '账号模式必须仍然写入账号 token');
  assert.deepStrictEqual(accountReuse.state.lyricsTokenSaves, [], '账号模式不得写歌词 store');

  // (f) lyrics 模式超时: 明确失败态, 不泄露 token
  const timedOut = makeLoginHarness({ timeoutMs: 5 });
  const timeoutResult = await timedOut.fn(fakeOwner, 'lyrics-token');
  assert.strictEqual(timeoutResult.ok, false);
  assert.strictEqual(timeoutResult.error, 'LOGIN_TIMEOUT');
  assert.ok(JSON.stringify(timeoutResult).indexOf(FAKE_TOKEN) < 0);

  // (g) lyrics 模式 + cookie 但本地校验不通过: 明确的 TOKEN_REJECTED, 不泄露 token
  const rejected = makeLoginHarness({ cookieToken: FAKE_TOKEN, storeAccepts: false });
  const rejectedPromise = rejected.fn(fakeOwner, 'lyrics-token');
  await new Promise((r) => setTimeout(r, 0));
  rejected.state.lastWindow.close();
  const rejectedResult = await rejectedPromise;
  assert.strictEqual(rejectedResult.ok, false);
  assert.strictEqual(rejectedResult.error, 'TOKEN_REJECTED');
  assert.ok(JSON.stringify(rejectedResult).indexOf(FAKE_TOKEN) < 0);
});

// ------------------------------------------------------------
// TEST 27: 歌词写入助手 —— 只做本地校验 + 现有 store; 日志绝不含 token
// ------------------------------------------------------------
test('TEST 27: saveAppleLyricsTokenCandidate 只写现有 store, 日志/返回值都不含 token', () => {
  const fnSrc = extractFunction(read(MAIN_FILE), 'saveAppleLyricsTokenCandidate');
  const warns = [];
  const savedTokens = [];
  const store = {
    set(token) { savedTokens.push(token); return { ok: true, configured: true }; },
  };
  const fn = evalFunction(fnSrc, 'saveAppleLyricsTokenCandidate', {
    appleMusicLyricsCredentialStore: store,
    console: { warn: (...args) => warns.push(args.join(' ')), log() {}, error() {} },
  });
  assert.strictEqual(fn(FAKE_TOKEN), true, 'store 成功时必须返回 true');
  assert.deepStrictEqual(savedTokens, [FAKE_TOKEN], '必须写入现有 appleMusicLyricsCredentialStore');

  const failing = evalFunction(fnSrc, 'saveAppleLyricsTokenCandidate', {
    appleMusicLyricsCredentialStore: { set: () => ({ ok: false, error: 'TOKEN_SHAPE' }) },
    console: { warn: (...args) => warns.push(args.join(' ')), log() {}, error() {} },
  });
  assert.strictEqual(failing(FAKE_TOKEN), false, '本地校验失败必须返回 false');

  const throwing = evalFunction(fnSrc, 'saveAppleLyricsTokenCandidate', {
    appleMusicLyricsCredentialStore: { set: () => { throw new Error('WRITE_FAILED ' + FAKE_TOKEN); } },
    console: { warn: (...args) => warns.push(args.join(' ')), log() {}, error() {} },
  });
  assert.strictEqual(throwing(FAKE_TOKEN), false, '抛错必须返回 false 而不是把错误抛出到登录流程');
  const joined = warns.join(' | ');
  assert.ok(joined.length > 0, '必须记录一条固定告警');
  assert.ok(joined.indexOf(FAKE_TOKEN) < 0, '日志绝不允许包含 token: ' + joined);
  assert.ok(fn(FAKE_TOKEN) !== FAKE_TOKEN, '助手绝不返回 token 本身');
});

// ------------------------------------------------------------
// TEST 28: IPC / preload / 存储模型 / 网络 / UI 契约
// ------------------------------------------------------------
test('TEST 28: IPC 只接受歌词窗口; preload 只暴露状态; 存储模型与网络边界不变', () => {
  const mainSrc = read(MAIN_FILE);
  const preloadSrc = read(PRELOAD_FILE);
  const windowJs = read(WINDOW_JS_FILE);
  const html = read(WINDOW_HTML_FILE);
  const storeSrc = read(STORE_FILE);

  // IPC: 新通道 + 可信发送方校验 + 只回状态
  assert.match(mainSrc, /ipcMain\.handle\('mineradio-apple-lyrics-credential-login', async \(event\) => \{\n  if \(!isTrustedLyricsSourceIpc\(event\)\) return \{ ok: false, error: 'UNTRUSTED_SENDER' \};\n  return openAppleMusicLyricsTokenLogin\(lyricsSourceWindow\);\n\}\);/);
  const channels = mainSrc.match(/ipcMain\.handle\('mineradio-apple-lyrics-credential-[a-z]+'/g) || [];
  assert.strictEqual(channels.length, 4, '必须只有 status/set/clear/login 四个歌词凭证通道, 实际 ' + channels.length);

  // 只有一套浏览器登录逻辑: Apple 登录函数里只出现一次 new BrowserWindow
  const loginFn = extractFunction(mainSrc, 'openAppleMusicLoginWindow');
  assert.strictEqual((loginFn.match(/new BrowserWindow\(/g) || []).length, 1, '登录窗口必须只有一处实现');
  assert.match(loginFn, /readAppleMediaUserToken\(cookieSession\)/, '必须复用现有 cookieSession 读取');
  assert.match(loginFn, /if \(!lyricsTokenMode && !credentials\.configured\)/, '前置检查必须只在账号模式下生效');
  assert.match(loginFn, /saveAppleLyricsTokenCandidate\(token\)/, '歌词模式下必须写现有歌词 store');
  assert.match(loginFn, /await saveAppleUserToken\(\{ musicUserToken: token, storefront: credentials\.storefront \}\)/, '账号模式必须保持原有保存逻辑');

  // 网络边界: 本轮不接入 /v1/me/account, 登录流程不发起请求
  assert.ok(mainSrc.indexOf('/v1/me/account') < 0, 'main.js 不得新增 /v1/me/account');
  assert.ok(loginFn.indexOf('fetch(') < 0 && loginFn.indexOf('https.request') < 0, '登录流程不得发起网络请求');

  // 存储模型不变: 只有一个 store 实例, 存储模块不含登录逻辑
  assert.strictEqual((mainSrc.match(/createAppleMusicLyricsCredentialStore\(/g) || []).length, 1, '不得新建第二套歌词凭证存储');
  assert.ok(storeSrc.indexOf('BrowserWindow') < 0 && storeSrc.indexOf('loginWithAppleMusic') < 0, '存储模块不得被注入登录逻辑');
  assert.match(storeSrc, /function createAppleMusicLyricsCredentialStore\(/);

  // preload: 只暴露状态型结果
  assert.match(preloadSrc, /loginWithAppleMusic: \(\) => ipcRenderer\.invoke\('mineradio-apple-lyrics-credential-login'\)/);
  const bridge = preloadSrc.slice(preloadSrc.indexOf('exposeInMainWorld(\'appleMusicLyricsCredential\''));
  assert.ok(bridge.indexOf('mediaUserToken') >= 0, '手动导入仍需传 token (既有行为)');
  assert.strictEqual((bridge.match(/mediaUserToken/g) || []).length, 1, '只有手动 set 一处可以传 token');

  // 渲染层: 脱敏状态显示不变, 登录处理器存在且不打印 token
  assert.match(windowJs, /stateEl\.textContent = configured\n      \? '已配置 · Token：●●●●●●●●'\n      : '未配置 Apple Music 歌词凭证';/);
  assert.match(windowJs, /function loginWithAppleMusic\(fromModal\)/);
  assert.match(windowJs, /api\.loginWithAppleMusic\(\)/);
  ['LOGIN_TIMEOUT', 'LOGIN_WINDOW_CLOSED', 'LOGIN_PAGE_FAILED', 'TOKEN_REJECTED', 'UNTRUSTED_SENDER'].forEach((code) => {
    assert.ok(windowJs.indexOf(code) >= 0, 'UI 必须为 ' + code + ' 提供明确文案');
  });
  assert.ok(!/console\.(log|warn|error)\(/.test(windowJs), '凭证 UI 不得打印任何日志 (避免 token 落日志)');
  assert.match(windowJs, /if \(loginBtn\) loginBtn\.disabled = !!busy;/, '登录中必须锁住按钮');

  // 页面: 文案 + 按钮
  assert.match(html, /<div class="way-name">Apple Music Web 的 media-user-token<\/div>/);
  assert.match(html, /登录 Apple Music 网页版后，可直接使用“登录 Apple Music 获取 Token”获取凭证；也可以手动从浏览器开发者工具的请求 Headers 中复制 media-user-token。/);
  assert.match(html, /此 Token 仅保存在本机，用于获取 Apple Music 官方歌词。/);
  assert.match(html, /<button class="mini-btn" id="cred-login">登录 Apple Music 获取 Token<\/button>/);
  assert.match(html, /<button class="mini-btn" id="cred-import">手动导入 Token<\/button>/);
  assert.match(html, /Token 仅保存在本机，不会显示完整内容，也不会写入日志。/);
  assert.ok(!/id="cred-login"[^>]*hidden/.test(html), '登录按钮本体必须常显 (是否隐藏由状态决定)');
  assert.match(html, /id="cred-login-row"/, '内联登录入口必须可被状态隐藏');
  assert.match(html, /<button class="mini-btn" id="cred-login-modal">登录 Apple Music 获取 Token<\/button>/, '重新获取弹窗内必须有登录获取入口');
  assert.match(windowJs, /loginRow\.hidden = configured/, '已配置时隐藏内联登录入口');
  assert.match(windowJs, /if \(loginModalBtn\) loginModalBtn\.addEventListener\('click', function \(\) \{ loginWithAppleMusic\(true\); \}\);/, '弹窗登录入口必须接线');
  assert.match(windowJs, /if \(fromModal\) closeModal\(\);/, '从弹窗登录成功后必须关闭弹窗');
  assert.ok(html.indexOf(FAKE_TOKEN) < 0, '页面不得出现任何 token');
});

// ------------------------------------------------------------
// TEST 29: 重启后仍显示已配置 —— 与状态 IPC 共用同一个 store
// ------------------------------------------------------------
test('TEST 29: 登录写入与状态读取共用同一个 store 常量 (重启后仍显示已配置)', () => {
  const mainSrc = read(MAIN_FILE);
  const storeConst = /const appleMusicLyricsCredentialStore = createAppleMusicLyricsCredentialStore\(\{/.test(mainSrc);
  assert.ok(storeConst, '必须仍只有一个 store 常量');
  const candidate = extractFunction(mainSrc, 'saveAppleLyricsTokenCandidate');
  assert.match(candidate, /appleMusicLyricsCredentialStore\.set\(token\)/, '登录结果必须写入该 store');
  assert.match(mainSrc, /ipcMain\.handle\('mineradio-apple-lyrics-credential-status',[\s\S]{0,200}appleMusicLyricsCredentialStore\.getStatus\(\)/, '状态 IPC 必须读同一个 store (重启后仍为 configured)');
  assert.ok(candidate.indexOf('app.getPath') < 0 && candidate.indexOf('fs.writeFile') < 0, '登录路径不得自己写文件 (存储模型不变)');
});
