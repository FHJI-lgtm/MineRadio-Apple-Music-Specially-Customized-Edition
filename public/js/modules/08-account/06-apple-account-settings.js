// ============================================================
// 08-account/06-apple-account-settings.js
// Apple Music 账户设置 —— Apple Music 账户区域里的唯一入口。
//
// 里面只有两件事:
//   1. MineRadio 显示资料 (显示名称 / 显示头像): 纯本地 UI 资料, 不是 Apple 返回的 profile,
//      不上传、不写进任何凭证文件, 也不参与 Apple Music 登录态;
//   2. Web 账户 (当前登录状态 / 手动写入 Token): 写的是既有 Apple Music Web credential store
//      (media-user-token, safeStorage), 与网页登录窗口写的是同一个 store —— 没有第二套 token 存储,
//      也不碰 Developer 凭证文件 (.apple-music-credentials.json / .apple-music-token.json)。
//
// 边界:
//   - 退出 Web 登录只清 token / cookie, 不删除显示名称与头像 (两者在 localStorage, 互不相干);
//   - 改显示名称 / 头像不触碰 token、登录状态、SMTC 会话;
//   - token 不打印、不进 renderer 状态、不回显; 保存成功即清空输入框。
// ============================================================
var APPLE_DISPLAY_PROFILE_STORE_KEY = 'mineradio-apple-display-profile-v1';
var APPLE_DISPLAY_NAME_MAX_CHARS = 40;
var APPLE_DISPLAY_AVATAR_PIXELS = 160;
var APPLE_DISPLAY_AVATAR_MAX_CHARS = 512 * 1024;
var APPLE_DISPLAY_AVATAR_SOURCE_MAX_BYTES = 12 * 1024 * 1024;

var appleDisplayProfileCache = null;
var appleAvatarPickerBusy = false;
var appleWebTokenBusy = false;

function normalizeAppleDisplayName(value) {
  var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.slice(0, APPLE_DISPLAY_NAME_MAX_CHARS);
}

// 只接受本模块自己压出来的内联图片: 不引用外部 URL, 也不把用户图片写进任何凭证文件。
function isAppleDisplayAvatarDataUrl(value) {
  var text = String(value == null ? '' : value);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(text)) return false;
  return text.length <= APPLE_DISPLAY_AVATAR_MAX_CHARS;
}

function normalizeAppleDisplayProfile(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    displayName: normalizeAppleDisplayName(raw.displayName),
    avatarDataUrl: isAppleDisplayAvatarDataUrl(raw.avatarDataUrl) ? String(raw.avatarDataUrl) : '',
    savedAt: Number(raw.savedAt) > 0 ? Number(raw.savedAt) : 0
  };
}

function appleDisplayProfileStorage(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
}

function readAppleDisplayProfile(storage) {
  var store = appleDisplayProfileStorage(storage);
  if (!store) return normalizeAppleDisplayProfile(null);
  try {
    return normalizeAppleDisplayProfile(JSON.parse(store.getItem(APPLE_DISPLAY_PROFILE_STORE_KEY) || '{}'));
  } catch (e) {
    return normalizeAppleDisplayProfile(null);
  }
}

function writeAppleDisplayProfile(profile, storage) {
  var store = appleDisplayProfileStorage(storage);
  if (!store) return null;
  var next = normalizeAppleDisplayProfile(profile);
  next.savedAt = Date.now();
  try { store.setItem(APPLE_DISPLAY_PROFILE_STORE_KEY, JSON.stringify(next)); } catch (e) { return null; }
  return next;
}

// 进程内缓存: providerAvatarSrc / providerAccountIdentity 每次 UI 重绘都会被调用, 不重复解析 JSON。
function appleDisplayProfile() {
  if (!appleDisplayProfileCache) appleDisplayProfileCache = readAppleDisplayProfile();
  return appleDisplayProfileCache;
}

// patch 只覆盖传入的字段: 改名不动头像, 换头像不动名称。
function mergeAppleDisplayProfile(current, patch) {
  return normalizeAppleDisplayProfile(Object.assign({}, normalizeAppleDisplayProfile(current), patch || {}));
}

function saveAppleDisplayProfile(patch) {
  var next = writeAppleDisplayProfile(mergeAppleDisplayProfile(appleDisplayProfile(), patch));
  if (!next) return null;
  appleDisplayProfileCache = next;
  return next;
}

function clearAppleDisplayAvatar() {
  return saveAppleDisplayProfile({ avatarDataUrl: '' });
}

function appleDisplayProfileName() {
  return appleDisplayProfile().displayName;
}

function appleDisplayProfileAvatar() {
  return appleDisplayProfile().avatarDataUrl;
}

// ------------------------------------------------------------
// 账户设置面板: DOM 读写
// ------------------------------------------------------------
function appleAccountSettingsEls() {
  return {
    mask: document.getElementById('apple-account-settings-modal'),
    avatar: document.getElementById('apple-settings-avatar'),
    nameInput: document.getElementById('apple-settings-name-input'),
    status: document.getElementById('apple-settings-status'),
    statusText: document.getElementById('apple-settings-status-text'),
    tokenInput: document.getElementById('apple-web-token-input'),
    saveBtn: document.getElementById('apple-web-token-save-btn'),
    feedback: document.getElementById('apple-settings-feedback'),
    avatarInput: document.getElementById('apple-settings-avatar-input')
  };
}

function setAppleSettingsFeedback(text, kind) {
  var el = document.getElementById('apple-settings-feedback');
  if (!el) return;
  el.textContent = String(text || '');
  el.className = 'apple-settings-feedback' + (kind ? ' ' + kind : '');
}

function formatAppleSettingsStamp(value) {
  var time = Date.parse(String(value || ''));
  if (!isFinite(time)) return '';
  try { return new Date(time).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return ''; }
}

function appleAccountSettingsDefaultAvatar() {
  if (typeof providerAvatarSrc === 'function') return providerAvatarSrc('apple', null);
  return '';
}

function renderAppleAccountSettings() {
  var els = appleAccountSettingsEls();
  var profile = appleDisplayProfile();
  if (els.avatar) els.avatar.src = profile.avatarDataUrl || appleAccountSettingsDefaultAvatar();
  if (els.nameInput && document.activeElement !== els.nameInput) els.nameInput.value = profile.displayName;
}

// 显示资料变了以后, 只重绘用到它的账号 UI; 用户模态没打开就不去动 activeAccountProvider。
function refreshAppleDisplayProfileConsumers() {
  if (typeof renderUserBtn === 'function') renderUserBtn();
  var userModal = document.getElementById('user-modal');
  if (userModal && userModal.classList.contains('show') && typeof updateUserModalUi === 'function') updateUserModalUi();
}

function openAppleAccountSettings() {
  var els = appleAccountSettingsEls();
  if (!els.mask) return;
  setAppleSettingsFeedback('', '');
  renderAppleAccountSettings();
  if (typeof openGsapModal === 'function') openGsapModal(els.mask);
  else els.mask.classList.add('show');
  refreshAppleAccountSettingsStatus();
}

function closeAppleAccountSettings() {
  var els = appleAccountSettingsEls();
  // 粘进来的 token 不留在 DOM 里 (也不出现在任何状态对象里)。
  if (els.tokenInput) els.tokenInput.value = '';
  if (els.mask && typeof closeGsapModal === 'function') closeGsapModal(els.mask);
  else if (els.mask) els.mask.classList.remove('show');
}

// 状态真值来自主进程的 web credential store (只回 configured / updatedAt, 永不回 token)。
async function refreshAppleAccountSettingsStatus() {
  var els = appleAccountSettingsEls();
  var configured = false;
  var updatedAt = '';
  try {
    var bridge = window.desktopWindow;
    if (bridge && typeof bridge.getAppleLyricsCredentialStatus === 'function') {
      var res = await bridge.getAppleLyricsCredentialStatus();
      configured = !!(res && res.ok !== false && res.configured === true);
      updatedAt = String((res && res.updatedAt) || '');
    }
  } catch (e) {
    configured = false;
    updatedAt = '';
  }
  if (els.status) els.status.classList.toggle('online', configured);
  if (els.statusText) {
    els.statusText.textContent = configured
      ? ('已登录' + (updatedAt ? ' · 更新于 ' + formatAppleSettingsStamp(updatedAt) : ''))
      : '未登录（可用官方登录窗口，或手动写入 Token）';
  }
  if (typeof refreshAppleWebLoginStatus === 'function') {
    try { await refreshAppleWebLoginStatus(); } catch (e) { }
  }
}

// ------------------------------------------------------------
// MineRadio 显示资料: 显示名称 / 显示头像
// ------------------------------------------------------------
function saveAppleDisplayNameFromField() {
  var els = appleAccountSettingsEls();
  var saved = saveAppleDisplayProfile({ displayName: normalizeAppleDisplayName(els.nameInput ? els.nameInput.value : '') });
  if (!saved) {
    setAppleSettingsFeedback('显示名称保存失败（本地存储不可用）', 'fail');
    return null;
  }
  if (els.nameInput && els.nameInput.value !== saved.displayName) els.nameInput.value = saved.displayName;
  if (saved.displayName) {
    setAppleSettingsFeedback('显示名称已保存：' + saved.displayName, 'ok');
  } else {
    setAppleSettingsFeedback('已恢复 Apple Music 默认显示名称', 'ok');
  }
  refreshAppleDisplayProfileConsumers();
  return saved;
}

function triggerAppleAvatarUpload() {
  if (appleAvatarPickerBusy) return;
  var els = appleAccountSettingsEls();
  if (!els.avatarInput) return;
  els.avatarInput.value = '';
  els.avatarInput.click();
}

async function handleAppleAvatarInputChange() {
  var els = appleAccountSettingsEls();
  var file = els.avatarInput && els.avatarInput.files ? els.avatarInput.files[0] : null;
  try {
    await applyAppleAvatarFile(file);
  } finally {
    if (els.avatarInput) els.avatarInput.value = '';
  }
}

function isAppleAvatarImageFile(file) {
  if (!file) return false;
  if (/^image\/(png|jpeg|jpg|webp)$/.test(String(file.type || '').toLowerCase())) return true;
  return /\.(png|jpe?g|webp)$/i.test(String(file.name || ''));
}

// 复用项目已有的 FileReader 帮助函数 (07-fx/03-cover-picker-fonts.js), 没有就退回本模块实现。
function readAppleImageFileAsDataUrl(file) {
  if (typeof readFileAsDataUrl === 'function') return readFileAsDataUrl(file);
  return new Promise(function (resolve, reject) {
    try {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(reader.error || new Error('IMAGE_READ_FAILED')); };
      reader.readAsDataURL(file);
    } catch (e) {
      reject(e);
    }
  });
}

// 压到 160x160 的方形内联图, 只留在 localStorage; 不写凭证文件, 不上传。
function downscaleAppleAvatarDataUrl(sourceDataUrl) {
  return new Promise(function (resolve) {
    if (typeof document === 'undefined' || typeof Image === 'undefined') { resolve(''); return; }
    var img = new Image();
    img.onload = function () {
      try {
        var size = APPLE_DISPLAY_AVATAR_PIXELS;
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        if (!ctx) { resolve(''); return; }
        var sw = Number(img.naturalWidth || img.width) || size;
        var sh = Number(img.naturalHeight || img.height) || size;
        var scale = Math.max(size / sw, size / sh);
        var dw = sw * scale;
        var dh = sh * scale;
        ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
        resolve(String(canvas.toDataURL('image/jpeg', 0.86) || ''));
      } catch (e) {
        resolve('');
      }
    };
    img.onerror = function () { resolve(''); };
    img.src = String(sourceDataUrl || '');
  });
}

async function applyAppleAvatarFile(file) {
  if (appleAvatarPickerBusy) return false;
  if (!isAppleAvatarImageFile(file)) {
    setAppleSettingsFeedback('请选择 PNG / JPEG / WebP 图片', 'fail');
    return false;
  }
  if (Number(file.size || 0) > APPLE_DISPLAY_AVATAR_SOURCE_MAX_BYTES) {
    setAppleSettingsFeedback('图片太大，请换一张小于 12MB 的图片', 'fail');
    return false;
  }
  appleAvatarPickerBusy = true;
  setAppleSettingsFeedback('正在处理头像…', '');
  try {
    var source = await readAppleImageFileAsDataUrl(file);
    var avatar = await downscaleAppleAvatarDataUrl(source);
    if (!avatar) {
      setAppleSettingsFeedback('这张图片读不出来，请换一张', 'fail');
      return false;
    }
    if (!saveAppleDisplayProfile({ avatarDataUrl: avatar })) {
      setAppleSettingsFeedback('头像保存失败（本地存储不可用）', 'fail');
      return false;
    }
    renderAppleAccountSettings();
    refreshAppleDisplayProfileConsumers();
    setAppleSettingsFeedback('头像已更新（只用于 MineRadio 界面显示）', 'ok');
    return true;
  } catch (e) {
    setAppleSettingsFeedback('头像读取失败，请换一张图片', 'fail');
    return false;
  } finally {
    appleAvatarPickerBusy = false;
  }
}

function resetAppleDisplayAvatar() {
  if (!clearAppleDisplayAvatar()) {
    setAppleSettingsFeedback('恢复默认头像失败（本地存储不可用）', 'fail');
    return;
  }
  renderAppleAccountSettings();
  refreshAppleDisplayProfileConsumers();
  setAppleSettingsFeedback('已恢复默认头像', 'ok');
}

// ------------------------------------------------------------
// Web 账户: 手动写入 Token (既有 web credential store)
// ------------------------------------------------------------
function appleWebTokenErrorText(code) {
  var map = {
    EMPTY_TOKEN: '先把 media-user-token 粘贴到输入框',
    TOKEN_TOO_SHORT: 'Token 太短，请确认复制的是完整的 media-user-token',
    TOKEN_TOO_LONG: 'Token 太长，请确认没有多粘贴内容',
    TOKEN_SHAPE: 'Token 含非法字符，请重新复制一次',
    WRITE_FAILED: '本地写入失败，请重试',
    UNTRUSTED_SENDER: '当前窗口没有写入权限，请在 Mineradio 主窗口操作'
  };
  return map[String(code || '')] || '保存失败，请重试';
}

async function submitAppleWebToken() {
  if (appleWebTokenBusy) return;
  var els = appleAccountSettingsEls();
  var token = els.tokenInput ? String(els.tokenInput.value || '').trim() : '';
  if (!token) {
    setAppleSettingsFeedback('先把 media-user-token 粘贴到输入框', 'fail');
    return;
  }
  var bridge = window.desktopWindow;
  if (!bridge || typeof bridge.saveAppleWebToken !== 'function') {
    setAppleSettingsFeedback('当前环境不支持写入网页登录态，请在 Mineradio 桌面版中操作', 'fail');
    return;
  }
  appleWebTokenBusy = true;
  if (els.saveBtn) {
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = '写入中…';
  }
  setAppleSettingsFeedback('正在写入网页登录态…', '');
  try {
    var result = await bridge.saveAppleWebToken(token);
    if (!result || result.ok !== true) {
      setAppleSettingsFeedback(appleWebTokenErrorText(result && result.error), 'fail');
      return;
    }
    if (els.tokenInput) els.tokenInput.value = '';
    setAppleSettingsFeedback('网页登录态已保存', 'ok');
    if (typeof showToast === 'function') showToast('Apple Music 网页登录态已保存');
    if (typeof refreshAppleLoginStatus === 'function') {
      try { await refreshAppleLoginStatus(); } catch (e) { }
    }
  } catch (e) {
    setAppleSettingsFeedback('写入失败，请重试', 'fail');
  } finally {
    appleWebTokenBusy = false;
    if (els.saveBtn) {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = '手动写入 Token';
    }
    await refreshAppleAccountSettingsStatus();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    APPLE_DISPLAY_PROFILE_STORE_KEY: APPLE_DISPLAY_PROFILE_STORE_KEY,
    APPLE_DISPLAY_NAME_MAX_CHARS: APPLE_DISPLAY_NAME_MAX_CHARS,
    APPLE_DISPLAY_AVATAR_MAX_CHARS: APPLE_DISPLAY_AVATAR_MAX_CHARS,
    normalizeAppleDisplayName: normalizeAppleDisplayName,
    normalizeAppleDisplayProfile: normalizeAppleDisplayProfile,
    isAppleDisplayAvatarDataUrl: isAppleDisplayAvatarDataUrl,
    readAppleDisplayProfile: readAppleDisplayProfile,
    writeAppleDisplayProfile: writeAppleDisplayProfile,
    mergeAppleDisplayProfile: mergeAppleDisplayProfile,
    saveAppleDisplayProfile: saveAppleDisplayProfile,
    clearAppleDisplayAvatar: clearAppleDisplayAvatar,
    appleDisplayProfileName: appleDisplayProfileName,
    appleDisplayProfileAvatar: appleDisplayProfileAvatar,
    isAppleAvatarImageFile: isAppleAvatarImageFile,
    appleWebTokenErrorText: appleWebTokenErrorText
  };
}
