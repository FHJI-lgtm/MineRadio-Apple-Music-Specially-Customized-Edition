'use strict';
// ============================================================
// Apple Music 账户设置 (统一入口) 回归网
//
//   TEST 1-5   MineRadio 显示资料: 归一化 / 读写 / 局部更新 / 恢复默认 / 落盘字段
//   TEST 6-7   显示资料与登录态分离, 且只作用在 Apple 的账号 UI 上
//   TEST 8-9   手动写入 Web Token 只走既有 web credential store, 没有第二套存储
//   TEST 10-12 Developer API 无新引用 / UI 入口与密码输入 / 模块不打印任何日志
//
// 说明: 显示资料真的存在 localStorage 里, 所以测试先装一个假 localStorage, 再 require
//       模块 —— 走的是和浏览器里一样的读写路径, 不是把实现抄一遍。
// 运行: node --test tests/apple-account-settings.test.js
// ============================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const MODULE_REL = 'public/js/modules/08-account/06-apple-account-settings.js';
const PANEL_REL = 'public/js/modules/08-account/03-login-modal-flows.js';
const moduleSrc = read(MODULE_REL);
const panelSrc = read(PANEL_REL);
const htmlSrc = read('public/index.html');
const preloadSrc = read('desktop/preload.js');
const mainSrc = read('desktop/main.js');
const loaderSrc = read('public/js/index-loader.js');
const utilsSrc = read('public/js/modules/08-account/01-login-modal-utils.js');
const userModalSrc = read('public/js/modules/08-account/04-user-modal-logout.js');

// "运行时引用" 只看代码: 注释里说明某个符号已被删除/不再使用, 不算引用。
// 只删块注释与整行注释 (保守): 尾随注释若被误判成引用, 是误报而不是漏报。
function stripCommentLines(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}
const moduleCode = stripCommentLines(moduleSrc);
const panelCode = stripCommentLines(panelSrc);
const preloadCode = stripCommentLines(preloadSrc);
const mainCode = stripCommentLines(mainSrc);

function makeStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(String(key)) ? map.get(String(key)) : null; },
    setItem(key, value) { map.set(String(key), String(value)); },
    removeItem(key) { map.delete(String(key)); },
    snapshot() { return Object.fromEntries(map); },
  };
}
const fakeStorage = makeStorage();
global.localStorage = fakeStorage;
const settings = require(path.join(ROOT, MODULE_REL));
const GOOD_AVATAR = 'data:image/jpeg;base64,' + 'A'.repeat(48);

test('1. 显示名称归一化: 折叠空白 / 去首尾 / 截断到 40 字', () => {
  assert.equal(settings.normalizeAppleDisplayName('  Abel   Tesfaye '), 'Abel Tesfaye');
  assert.equal(settings.normalizeAppleDisplayName('Abel\n\tTesfaye'), 'Abel Tesfaye');
  assert.equal(settings.normalizeAppleDisplayName(null), '');
  assert.equal(settings.normalizeAppleDisplayName(123456), '123456');
  assert.equal(settings.normalizeAppleDisplayName('x'.repeat(80)).length, settings.APPLE_DISPLAY_NAME_MAX_CHARS);
});

test('2. 显示资料存进 localStorage, 非法头像一律丢弃', () => {
  const written = settings.writeAppleDisplayProfile({ displayName: '  Abel  ', avatarDataUrl: GOOD_AVATAR }, fakeStorage);
  assert.equal(written.displayName, 'Abel');
  assert.equal(written.avatarDataUrl, GOOD_AVATAR);
  assert.ok(written.savedAt > 0);
  const readBack = settings.readAppleDisplayProfile(fakeStorage);
  assert.deepEqual(
    { displayName: readBack.displayName, avatarDataUrl: readBack.avatarDataUrl },
    { displayName: 'Abel', avatarDataUrl: GOOD_AVATAR }
  );

  assert.equal(settings.isAppleDisplayAvatarDataUrl('https://example.com/a.png'), false, '外链头像不入库');
  assert.equal(settings.isAppleDisplayAvatarDataUrl('data:image/svg+xml;base64,AAAA'), false, '只允许 png/jpeg/webp');
  assert.equal(settings.isAppleDisplayAvatarDataUrl('data:image/jpeg;base64,' + 'A'.repeat(settings.APPLE_DISPLAY_AVATAR_MAX_CHARS)), false, '超限头像不入库');

  const dropped = settings.writeAppleDisplayProfile({ displayName: 'Abel', avatarDataUrl: 'https://example.com/a.png' }, fakeStorage);
  assert.equal(dropped.avatarDataUrl, '');
  assert.equal(settings.readAppleDisplayProfile(fakeStorage).avatarDataUrl, '', '坏头像不会留在盘上');

  fakeStorage.setItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY, '{ not json');
  assert.equal(settings.readAppleDisplayProfile(fakeStorage).displayName, '', '坏 JSON 按未配置处理, 不抛错');
  settings.writeAppleDisplayProfile({ displayName: 'Abel', avatarDataUrl: GOOD_AVATAR }, fakeStorage);
});

test('3. 改名不动头像, 换头像不动名称 (走真实 save 路径)', () => {
  settings.saveAppleDisplayProfile({ displayName: 'Abel Tesfaye', avatarDataUrl: GOOD_AVATAR });
  assert.equal(settings.appleDisplayProfileName(), 'Abel Tesfaye');
  assert.equal(settings.appleDisplayProfileAvatar(), GOOD_AVATAR);

  settings.saveAppleDisplayProfile({ displayName: 'XxHuberrr' });
  assert.equal(settings.appleDisplayProfileName(), 'XxHuberrr');
  assert.equal(settings.appleDisplayProfileAvatar(), GOOD_AVATAR, '改名不得清掉头像');

  settings.saveAppleDisplayProfile({ avatarDataUrl: '' });
  assert.equal(settings.appleDisplayProfileName(), 'XxHuberrr', '换/清头像不得清掉名称');
  assert.equal(settings.appleDisplayProfileAvatar(), '');
  assert.deepEqual(
    settings.mergeAppleDisplayProfile({ displayName: 'A', avatarDataUrl: GOOD_AVATAR }, { displayName: '' }),
    { displayName: '', avatarDataUrl: GOOD_AVATAR, savedAt: 0 }
  );
});

test('4. 恢复默认头像只清头像, 名称保留', () => {
  settings.saveAppleDisplayProfile({ displayName: 'Abel Tesfaye', avatarDataUrl: GOOD_AVATAR });
  assert.ok(settings.clearAppleDisplayAvatar());
  assert.equal(settings.appleDisplayProfileAvatar(), '');
  assert.equal(settings.appleDisplayProfileName(), 'Abel Tesfaye');
  const parsed = JSON.parse(fakeStorage.getItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY));
  assert.equal(parsed.avatarDataUrl, '');
  assert.equal(parsed.displayName, 'Abel Tesfaye');
});

test('5. 落盘只有显示资料三个字段, 不含任何 token 字段', () => {
  settings.saveAppleDisplayProfile({ displayName: 'Abel', avatarDataUrl: GOOD_AVATAR });
  const parsed = JSON.parse(fakeStorage.getItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY));
  assert.deepEqual(Object.keys(parsed).sort(), ['avatarDataUrl', 'displayName', 'savedAt']);
  const raw = JSON.stringify(fakeStorage.snapshot());
  assert.ok(!/token/i.test(raw), '显示资料里不得出现 token');
});

test('6. 退出登录只清 token / cookie, 不删显示资料', () => {
  for (const rel of [
    'public/js/modules/08-account/04-user-modal-logout.js',
    'public/js/modules/08-account/02-login-status.js',
    'public/js/modules/08-account/03-login-modal-flows.js',
    'public/js/index-loader.js',
    'desktop/main.js',
    'desktop/preload.js',
  ]) {
    const src = read(rel);
    assert.ok(src.indexOf(settings.APPLE_DISPLAY_PROFILE_STORE_KEY) < 0, rel + ' 不得直接读写显示资料 store');
    assert.ok(src.indexOf('mineradio-apple-display-profile') < 0, rel + ' 不得引用显示资料 key');
  }
  // Apple 退出登录 = clearAppleMusicLoginSession: 只清登录窗口分区 + token, 不碰主窗口 localStorage
  const logoutFn = mainCode.slice(mainCode.indexOf('async function clearAppleMusicLoginSession()'), mainCode.indexOf('function loginEasterEggLockedResult()'));
  assert.match(logoutFn, /session\.fromPartition\(APPLE_LOGIN_PARTITION\)/, '退出登录只清登录窗口分区');
  assert.ok(logoutFn.indexOf('localStorage') < 0, '退出登录不得清主窗口 localStorage');
  assert.ok(!/localStorage\.(removeItem|clear)\(/.test(userModalSrc), '退出流程不得清 localStorage');
});

test('7. 显示资料只作用在 Apple 的账号 UI 上', () => {
  assert.match(utilsSrc, /if \(provider === 'apple' && typeof appleDisplayProfileAvatar === 'function'\) \{/);
  assert.match(utilsSrc, /if \(provider === 'apple' && typeof appleDisplayProfileName === 'function'\) \{/);
  assert.match(userModalSrc, /activeAccountProvider === 'apple' && typeof appleDisplayProfileName === 'function'/);
  assert.equal((utilsSrc.match(/appleDisplayProfileAvatar/g) || []).length, 2, '头像override 只应有一处判定 + 一次调用');
  // 其他平台的展示链没有被改: 仍然是 status.avatar / status.nickname
  assert.match(utilsSrc, /if \(status\.avatar\) return avatarSrc\(status\.avatar\);/);
  assert.match(userModalSrc, /name\.textContent = appleCustomName \|\| \(st && st\.nickname\) \|\| meta\.label;/);
});

test('8. 手动写入 Token 复用既有 web credential store 通道', () => {
  assert.match(preloadSrc, /saveAppleWebToken: \(token\) => ipcRenderer\.invoke\('mineradio-apple-lyrics-credential-set'/);
  assert.match(moduleSrc, /bridge\.saveAppleWebToken\(token\)/);
  assert.equal((mainCode.match(/ipcMain\.handle\('mineradio-apple-lyrics-credential-set'/g) || []).length, 1, '写通道只有一条');
  assert.match(mainCode, /function isTrustedAppleLyricsCredentialWriter\(event\) \{\n  return isTrustedLyricsSourceIpc\(event\) \|\| isTrustedMainWindowIpc\(event\);/);
  assert.match(mainCode, /if \(!isTrustedAppleLyricsCredentialWriter\(event\)\) return \{ ok: false, error: 'UNTRUSTED_SENDER' \};/);
  // 保存成功后输入框立即清空, token 不回显
  assert.ok((moduleSrc.match(/tokenInput\.value = ''/g) || []).length >= 2, '保存后与关闭时都要清空输入框');
});

test('9. 没有第二套 token 存储, 也不写 Developer 凭证文件', () => {
  for (const needle of ['apple-music-token.json', 'apple-music-credentials.json', 'saveAppleUserToken', 'saveAppleConfig', '/api/apple']) {
    assert.ok(moduleCode.indexOf(needle) < 0, '账户设置模块不得引用 ' + needle);
  }
  assert.ok(panelCode.indexOf('saveAppleUserToken') < 0, 'Apple 面板不得再写 Developer token store');
  assert.ok(panelCode.indexOf('/api/apple/login/token') < 0, 'Apple 面板不得再走 Developer token 路由');
  assert.ok(panelCode.indexOf('apple-manual-token-input') < 0, '散落的 token 输入框已并入账户设置');
  assert.ok(preloadCode.indexOf('apple-music-token') < 0, 'preload 不得引用 Developer token 文件');
});

test('10. Developer API 没有产生新的运行时引用', () => {
  const touched = [MODULE_REL, PANEL_REL, 'public/js/modules/08-account/01-login-modal-utils.js',
    'public/js/modules/08-account/04-user-modal-logout.js', 'public/js/index-loader.js', 'desktop/preload.js'];
  for (const rel of touched) {
    const code = stripCommentLines(read(rel));
    for (const symbol of ['getAppleDeveloperToken', 'signAppleDeveloperJwt', 'getAppleCredentials', '/v1/me/profile', 'Team ID', 'Key ID']) {
      assert.ok(code.indexOf(symbol) < 0, rel + ' 的代码不得引用 ' + symbol);
    }
  }
  const setHandler = mainCode.slice(
    mainCode.indexOf("ipcMain.handle('mineradio-apple-lyrics-credential-set'"),
    mainCode.indexOf("ipcMain.handle('mineradio-apple-lyrics-credential-clear'")
  );
  assert.ok(setHandler.indexOf('saveAppleUserToken') < 0);
  assert.ok(setHandler.indexOf('getAppleDeveloperToken') < 0);
  assert.equal((preloadSrc.match(/saveAppleWebToken/g) || []).length, 1);
});

test('11. UI: 单一入口 / 密码输入 / 模块已注册', () => {
  assert.match(htmlSrc, /id="apple-account-settings-modal"/);
  assert.match(htmlSrc, /id="apple-settings-avatar-input"[^>]*onchange="handleAppleAvatarInputChange\(\)"/);
  assert.match(htmlSrc, /<input id="apple-web-token-input"[^>]*type="password"/, '网页 Token 必须是密码输入');
  assert.match(htmlSrc, /onclick="submitAppleWebToken\(\)"/);
  assert.match(htmlSrc, /onclick="triggerAppleAvatarUpload\(\)"/);
  assert.match(htmlSrc, /onclick="resetAppleDisplayAvatar\(\)"/);
  assert.match(htmlSrc, /id="apple-settings-status"/);
  assert.match(htmlSrc, /id="apple-settings-feedback"/);
  // 账户区域只有一个统一入口
  assert.equal((panelSrc.match(/openAppleAccountSettings\(\)/g) || []).length, 1, 'Apple 面板只应有一个账户设置入口');
  assert.match(loaderSrc, /'js\/modules\/08-account\/06-apple-account-settings\.js'/);
  assert.match(read('public/css/index.css'), /\.apple-settings-section \{/);
});

test('12. 账户设置模块不打印任何日志 (token 不入日志)', () => {
  assert.ok(!/console\./.test(moduleSrc), '该模块不得有任何 console 调用');
  assert.ok(!/console\./.test(preloadSrc.slice(preloadSrc.indexOf('saveAppleWebToken') - 200, preloadSrc.indexOf('saveAppleWebToken') + 200)));
});

// ------------------------------------------------------------
// 面板行为 (vm + 假 DOM): 不是抄实现, 而是真的把模块跑起来看它怎么动 DOM / 怎么调 IPC
// ------------------------------------------------------------
function loadSettingsPanel(overrides = {}) {
  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    return {
      id, value: '', textContent: '', src: '', className: '', disabled: false,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c),
      },
      hasClass: (c) => classes.has(c),
    };
  };
  ['apple-account-settings-modal', 'apple-settings-avatar', 'apple-settings-name-input',
    'apple-settings-status', 'apple-settings-status-text', 'apple-web-token-input',
    'apple-web-token-save-btn', 'apple-settings-feedback', 'apple-settings-avatar-input',
  ].forEach((id) => elements.set(id, makeEl(id)));
  const storage = makeStorage();
  const savedTokens = [];
  const context = {
    console, Promise, Date, JSON, Object, Array, String, Number, Boolean, Math, Error, isFinite,
    setTimeout, clearTimeout,
    document: { getElementById: (id) => elements.get(id) || null, activeElement: null },
    localStorage: storage,
    window: {
      desktopWindow: Object.assign({
        getAppleLyricsCredentialStatus: async () => ({ ok: true, configured: true, updatedAt: '2026-09-27T02:00:00.000Z' }),
        saveAppleWebToken: async (token) => { savedTokens.push(token); return { ok: true, configured: true, updatedAt: '2026-09-27T02:00:00.000Z' }; },
      }, overrides.desktopWindow || {}),
    },
    module: { exports: {} },
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(moduleSrc, context);
  return { context, elements, storage, savedTokens };
}

test('13. 面板行为: 手动写入 Token —— 成功清空输入框, 失败给明确文案且不写盘', async () => {
  const panel = loadSettingsPanel();
  const input = panel.elements.get('apple-web-token-input');
  const feedback = panel.elements.get('apple-settings-feedback');

  input.value = '  0.valid-looking-token-value-0123456789  ';
  await panel.context.submitAppleWebToken();
  assert.deepEqual(panel.savedTokens, ['0.valid-looking-token-value-0123456789'], '写入前去掉首尾空白');
  assert.equal(input.value, '', '写入成功后输入框必须清空 (不回显 token)');
  assert.match(feedback.textContent, /已保存/);
  assert.ok(panel.storage.getItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY) === null, 'token 不进显示资料 store');
  assert.ok(!/0\.valid-looking-token/.test(feedback.textContent), '反馈文案不得回显 token');

  panel.context.window.desktopWindow.saveAppleWebToken = async () => ({ ok: false, error: 'TOKEN_TOO_SHORT' });
  input.value = 'short';
  await panel.context.submitAppleWebToken();
  assert.match(feedback.textContent, /Token 太短/, '错误码要有明确中文提示');
  assert.equal(input.value, 'short', '失败时保留用户输入, 便于修改');
  assert.match(feedback.className, /fail/);

  panel.context.window.desktopWindow.saveAppleWebToken = async () => ({ ok: false, error: 'UNTRUSTED_SENDER' });
  await panel.context.submitAppleWebToken();
  assert.match(feedback.textContent, /权限/, '未知/权限错误也有兜底文案');

  input.value = 'leftover-token-value-0123456789';
  panel.context.closeAppleAccountSettings();
  assert.equal(input.value, '', '关闭面板不得把 token 留在 DOM 里');
});

test('14. 面板行为: 未登录时打开面板显示未登录, 已配置时显示已登录', async () => {
  const panel = loadSettingsPanel({ desktopWindow: { getAppleLyricsCredentialStatus: async () => ({ ok: true, configured: false, updatedAt: '' }) } });
  await panel.context.refreshAppleAccountSettingsStatus();
  assert.match(panel.elements.get('apple-settings-status-text').textContent, /未登录/);
  assert.equal(panel.elements.get('apple-settings-status').hasClass('online'), false);

  const configured = loadSettingsPanel();
  await configured.context.refreshAppleAccountSettingsStatus();
  assert.match(configured.elements.get('apple-settings-status-text').textContent, /已登录/);
  assert.equal(configured.elements.get('apple-settings-status').hasClass('online'), true);
});

test('15. 面板行为: 显示名称保存只写显示资料, 头像入口只接受图片', async () => {
  const panel = loadSettingsPanel();
  const nameInput = panel.elements.get('apple-settings-name-input');
  nameInput.value = '  Abel   Tesfaye ';
  panel.context.saveAppleDisplayNameFromField();
  assert.equal(nameInput.value, 'Abel Tesfaye');
  assert.match(panel.elements.get('apple-settings-feedback').textContent, /Abel Tesfaye/);
  assert.deepEqual(Object.keys(panel.storage.snapshot()), [settings.APPLE_DISPLAY_PROFILE_STORE_KEY], '改名只动显示资料这一个 key');
  assert.equal(JSON.parse(panel.storage.getItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY)).displayName, 'Abel Tesfaye');

  assert.equal(await panel.context.applyAppleAvatarFile({ name: 'a.txt', type: 'text/plain', size: 12 }), false);
  assert.match(panel.elements.get('apple-settings-feedback').textContent, /PNG/);
  assert.equal(await panel.context.applyAppleAvatarFile({ name: 'b.png', type: 'image/png', size: 13 * 1024 * 1024 }), false);
  assert.match(panel.elements.get('apple-settings-feedback').textContent, /太大/);
  assert.equal(JSON.parse(panel.storage.getItem(settings.APPLE_DISPLAY_PROFILE_STORE_KEY)).avatarDataUrl, '', '被拒绝的图片不得写盘');
});

// 按大括号配对取出 main.js 里的真实函数体 (和其它 Apple 测试同一套做法)
function extractFunction(source, name) {
  const asyncStart = source.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少函数 ' + name);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('函数体括号不平衡: ' + name);
}

test('16. 退出 Apple Music 真的清掉 web credential store (回归: 旧代码在这行抛 ReferenceError)', async () => {
  const body = extractFunction(mainSrc, 'clearAppleMusicLoginSession');
  assert.ok(stripCommentLines(body).indexOf('clearAppleToken(') < 0, 'main.js 不得再调用未导入的 Developer clearAppleToken');

  const calls = [];
  const context = {
    console, Promise,
    APPLE_LOGIN_PARTITION: 'persist:apple-login',
    session: {
      fromPartition: (name) => ({
        clearStorageData: async (opts) => { calls.push({ kind: 'partition', name, opts }); },
      }),
    },
    appleMusicLyricsCredentialStore: {
      clear: () => { calls.push({ kind: 'web-credential' }); return { ok: true, configured: false }; },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(body, context);
  const result = await context.clearAppleMusicLoginSession();
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'apple');
  assert.equal(calls.length, 2, '既要清登录窗口分区, 也要清 web credential store');
  assert.equal(calls[0].kind, 'partition');
  assert.equal(calls[0].name, 'persist:apple-login');
  assert.equal(calls[0].opts.storages.join(','), 'cookies,localstorage,indexdb,cachestorage');
  assert.equal(calls[1].kind, 'web-credential', '清 web 凭证这一步必须真的被执行到');
});

test('17. main.js 不再调用任何已删除的 Developer 助手', () => {
  const code = stripCommentLines(mainSrc);
  for (const symbol of ['clearAppleToken', 'getAppleConfig', 'getAppleCredentials', 'saveAppleUserToken', 'getAppleDeveloperToken', 'signAppleDeveloperJwt', 'handleAppleStatus', 'getAppleProfile']) {
    assert.ok(code.indexOf(symbol) < 0, 'main.js 的代码不得出现 ' + symbol);
  }
});

test('18. Developer 读取/写入链已从 apple-music-api.js 与 server.js 下线', () => {
  const apiCode = stripCommentLines(read('apple-music-api.js'));
  for (const symbol of [
    'handleAppleStatus', 'getAppleProfile', 'normalizeAppleProfile', 'appleProfileCache',
    'getAppleConfig', 'saveAppleConfig', 'saveAppleUserToken', 'verifyAppleUserToken', 'getAppleConfigFile',
    'writeJsonFile', 'handleAppleUserPlaylists', 'handleApplePlaylistTracks', 'handleAppleAlbumDetail',
    'handleAppleLibrarySongs', 'APPLE_PROFILE_CACHE_TTL_MS',
  ]) {
    assert.ok(apiCode.indexOf(symbol) < 0, 'apple-music-api.js 不得再有 ' + symbol);
  }
  const serverCode = stripCommentLines(read('server.js'));
  for (const symbol of [
    'handleAppleStatus', 'getAppleProfile', 'saveAppleUserToken', 'getAppleConfig', 'getAppleDeveloperToken',
    'api/apple/login/token', 'api/apple/config',
  ]) {
    assert.ok(serverCode.indexOf(symbol) < 0, 'server.js 不得再有 ' + symbol);
  }
  // 账号轴那两条路由必须只剩 web 实现
  assert.match(serverCode, /handleAppleAccountStatusWeb\(\)/);
  assert.match(serverCode, /handleAppleUserPlaylistsWeb\(/);
});

console.log('[OK] Apple Music 账户设置: 显示资料存储 / 与登录态分离 / 手动 Web Token 复用既有 store / 无 Developer 新引用');
