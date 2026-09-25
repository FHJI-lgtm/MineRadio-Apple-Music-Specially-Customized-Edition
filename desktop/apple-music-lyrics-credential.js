'use strict';

// ============================================================
// apple-music-lyrics-credential.js
// Apple Music 歌词凭证 (media-user-token) 的独立存储模块。
//
// 只保存一样东西: Apple Music Web 的 media-user-token。
//
// 与项目里已有的 Apple Developer 凭证体系完全独立, 互不影响:
//   Apple Developer 体系 (apple-music-api.js):
//     Team ID / Key ID / .p8 private key / developer token /
//     MusicKit music-user-token
//     -> 文件 .apple-music-credentials.json / .apple-music-token.json
//   本模块 (Apple Music 歌词凭证):
//     media-user-token (Apple Music Web 网页端使用的用户令牌)
//     -> 文件 .apple-music-lyrics-credential.json
//   本模块不读取、不写入、不修改 apple-music-api.js 的任何数据结构。
//
// 安全约定:
//   - 优先使用 Electron 内置 safeStorage 加密后落盘 (Windows 上走 DPAPI,
//     只有当前 Windows 用户账户能解密), 不引入任何新依赖;
//   - 运行环境不支持加密时退化为明文存储, 并在文件内标记 enc:'plain';
//   - 本模块的任何日志、任何返回值都不包含 token 明文;
//   - getStatus() 只暴露 { configured, updatedAt }。
//
// 本模块只做三件事: 保存 / 读取状态 / 删除。
// 不发起任何网络请求, 不调用 Apple Music 接口, 不实现网页登录。
// ============================================================

const fs = require('fs');
const path = require('path');

const CREDENTIAL_FILE_NAME = '.apple-music-lyrics-credential.json';
const CREDENTIAL_VERSION = 1;

// media-user-token 是较长的、不含空白字符的串 (JWT 或 base64 风格的令牌)。
// 这里只做最小格式约束, 不做任何语义/在线校验。
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 8192;
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

function normalizeToken(value) {
  let token = String(value == null ? '' : value).trim();
  // 允许用户从开发者工具里连引号一起复制: 去掉成对的首尾引号。
  if (token.length >= 2) {
    const first = token.charAt(0);
    const last = token.charAt(token.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      token = token.slice(1, -1).trim();
    }
  }
  return token;
}

// 返回空字符串表示通过; 否则返回错误码 (不含 token 内容)。
function tokenShapeError(token) {
  if (!token) return 'EMPTY_TOKEN';
  if (token.length < TOKEN_MIN_LENGTH) return 'TOKEN_TOO_SHORT';
  if (token.length > TOKEN_MAX_LENGTH) return 'TOKEN_TOO_LONG';
  if (!TOKEN_SHAPE.test(token)) return 'TOKEN_SHAPE';
  return '';
}

function createAppleMusicLyricsCredentialStore(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const filePath = String(opts.filePath || '');
  const safeStorage = opts.safeStorage || null;
  if (!filePath) throw new Error('apple-music-lyrics-credential: filePath is required');

  function encryptionAvailable() {
    try {
      return !!(
        safeStorage
        && typeof safeStorage.isEncryptionAvailable === 'function'
        && safeStorage.isEncryptionAvailable()
      );
    } catch (_) {
      return false;
    }
  }

  // 无副作用读取: 文件不存在/损坏/无法解密一律按"未配置"处理, 不抛错。
  function readRecord() {
    let parsed = null;
    try {
      if (!fs.existsSync(filePath)) return null;
      const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!text) return null;
      parsed = JSON.parse(text);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const stored = normalizeToken(parsed.mediaUserToken);
    const updatedAt = String(parsed.updatedAt == null ? '' : parsed.updatedAt).trim();
    if (!stored) return null;

    if (parsed.enc === 'safeStorage') {
      if (!safeStorage || typeof safeStorage.decryptString !== 'function') return null;
      try {
        const token = normalizeToken(safeStorage.decryptString(Buffer.from(stored, 'base64')));
        if (!token) return null;
        return { token, updatedAt };
      } catch (_) {
        // 例如换了 Windows 账户或 DPAPI 不可用: 视为未配置, 不打印任何内容。
        return null;
      }
    }
    return { token: stored, updatedAt };
  }

  function writeRecord(token, updatedAt) {
    const encrypted = encryptionAvailable() && typeof safeStorage.encryptString === 'function';
    let stored = token;
    let enc = 'plain';
    if (encrypted) {
      // 加密失败不应导致明文兜底静默发生: 抛给调用方转成 WRITE_FAILED。
      stored = safeStorage.encryptString(token).toString('base64');
      enc = 'safeStorage';
    }
    const payload = {
      v: CREDENTIAL_VERSION,
      enc,
      mediaUserToken: stored,
      updatedAt,
    };
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) { /* 目录已存在或由 Electron 预先创建 */ }
    // 原子写: 先写临时文件再改名, 避免写入中断留下半截凭证。
    const tempFile = filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempFile, filePath);
  }

  return {
    filePath,

    fileName: CREDENTIAL_FILE_NAME,

    // 只返回是否已配置与更新时间; 永远不返回 token。
    getStatus() {
      const record = readRecord();
      if (!record) return { configured: false, updatedAt: '' };
      return { configured: true, updatedAt: record.updatedAt };
    },

    // 仅供主进程内部使用 (第二阶段只读 PoC / 后续正式 Provider)。
    // 绝不注册到任何 IPC / preload 通道, renderer 永远拿不到此方法的返回值。
    // 返回空字符串表示未配置或无法解密。
    readTokenForMainProcess() {
      const record = readRecord();
      return record ? record.token : '';
    },

    // 保存用户粘贴的 media-user-token。返回值不含 token。
    set(userToken) {
      const token = normalizeToken(userToken);
      const shapeError = tokenShapeError(token);
      if (shapeError) {
        return { ok: false, error: shapeError, configured: this.getStatus().configured };
      }
      const updatedAt = new Date().toISOString();
      try {
        writeRecord(token, updatedAt);
      } catch (error) {
        // 只记录错误类型, 不记录 token 与文件内容。
        console.warn('[AppleLyricsCredential] save failed:', (error && error.code) || (error && error.name) || 'unknown');
        return { ok: false, error: 'WRITE_FAILED', configured: this.getStatus().configured };
      }
      return { ok: true, configured: true, updatedAt };
    },

    // 真正删除已保存的数据 (文件 + 残留临时文件)。
    clear() {
      let existed = false;
      try {
        existed = fs.existsSync(filePath);
      } catch (_) {
        existed = false;
      }
      try {
        if (existed) fs.rmSync(filePath, { force: true });
      } catch (error) {
        console.warn('[AppleLyricsCredential] clear failed:', (error && error.code) || (error && error.name) || 'unknown');
        return { ok: false, error: 'CLEAR_FAILED', configured: this.getStatus().configured };
      }
      try {
        const dir = path.dirname(filePath);
        const prefix = path.basename(filePath) + '.';
        for (const name of fs.readdirSync(dir)) {
          if (name.startsWith(prefix) && name.endsWith('.tmp')) {
            try { fs.rmSync(path.join(dir, name), { force: true }); } catch (_) {}
          }
        }
      } catch (_) { /* 残留临时文件清理失败不影响删除结果 */ }
      return { ok: true, configured: false };
    },
  };
}

module.exports = {
  createAppleMusicLyricsCredentialStore,
  CREDENTIAL_FILE_NAME,
};
