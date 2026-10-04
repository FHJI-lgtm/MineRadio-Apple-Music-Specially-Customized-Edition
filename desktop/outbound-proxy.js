'use strict';
// ====================================================================
// 出网代理自动配置
//
// 背景：这台机器上 Spotify / Wikipedia / GitHub 直连不通（需要 Clash 之类的本地代理），
// 而 Node/Electron 的内置 fetch **不会**自动走系统代理 —— 必须显式设置环境变量，
// 并开启 NODE_USE_ENV_PROXY。
//
// 原则：
//   1) **只在探测到代理端口真的在监听时才启用**。Clash 没开时若强行设代理，
//      所有请求都会连到死端口 —— 那比直连更糟。
//   2) **按域名白名单**（NO_PROXY）：只有确实需要代理的境外域名走代理，
//      国内音乐源（网易云/酷狗/QQ/汽水/Apple 中国节点）保持直连，不增加延迟与流量。
//   3) 端口/主机可用环境变量覆盖：MINERADIO_PROXY / MINERADIO_PROXY_PORT。
// ====================================================================

const net = require('net');

// 这些后缀走代理（境外、实测直连不通的）
const PROXY_HOST_SUFFIXES = [
  'spotify.com', 'scdn.co', 'spotifycdn.com',
  'wikipedia.org', 'wikimedia.org',
  'github.com', 'githubusercontent.com', 'githubassets.com',
  'mzstatic.com', 'apple.com',
];
// 这些后缀**一定不走**代理（国内源 + 本地回调）
const DIRECT_HOST_SUFFIXES = [
  'localhost', '127.0.0.1', '::1',
  'music.163.com', '126.net', '163.com',
  'kugou.com', 'kgimg.com', 'kglink.com',
  'qq.com', 'gtimg.cn', 'qpic.cn',
  'douyinpic.com', 'douyin.com', 'qishui.com', 'bytedance.com', 'byteimg.com',
];

function hostMatches(host, suffixes) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return false;
  return suffixes.some(function (s) { return h === s || h.slice(-(s.length + 1)) === '.' + s; });
}

// NO_PROXY 用后缀列表（Node 支持前缀 "."），本地与国内源都排除
function buildNoProxy() {
  const parts = ['.localhost', '.127.0.0.1'];
  DIRECT_HOST_SUFFIXES.forEach(function (s) {
    if (s === 'localhost' || s === '127.0.0.1' || s === '::1') return;
    parts.push('.' + s);
  });
  return parts.join(',');
}

function probePort(host, port, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (ok) {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(ok);
    };
    const socket = net.connect({ host: host, port: port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', function () { finish(true); });
    socket.once('timeout', function () { finish(false); });
    socket.once('error', function () { finish(false); });
  });
}

// 返回 { enabled, host, port } —— 只探测，不设置任何东西（便于测试）
async function detectProxy() {
  const host = String(process.env.MINERADIO_PROXY || '127.0.0.1');
  const explicitPort = Number(process.env.MINERADIO_PROXY_PORT) || 0;
  // Clash Verge 默认 7897；其余是常见备选。显式给了端口就只试它。
  const candidates = explicitPort ? [explicitPort] : [7897, 7890, 7891, 10809, 1080, 8118];
  for (const port of candidates) {
    // 已经在监听就不该被当成 HTTP 代理：用一次最小请求确认（Clash 对非代理请求回 400）
    if (await probePort(host, port, 300)) return { enabled: true, host: host, port: port };
  }
  return { enabled: false, host: host, port: explicitPort || 7897 };
}

function applyProxyEnv(proxy) {
  if (!proxy || !proxy.enabled) return false;
  const url = 'http://' + proxy.host + ':' + proxy.port;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || url;
  process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || url;
  process.env.ALL_PROXY = process.env.ALL_PROXY || url;
  // Node 必须显式开启才会用这些环境变量
  process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';
  process.env.NO_PROXY = process.env.NO_PROXY || buildNoProxy();
  process.env.no_proxy = process.env.no_proxy || process.env.NO_PROXY;
  return true;
}

// 让全局 fetch 走代理。
// 注意：**只设环境变量是无效的** —— undici 在模块加载时就读掉了 NODE_USE_ENV_PROXY，
// 运行期再设已经晚了（实测 fetch 仍报 UND_ERR_CONNECT_TIMEOUT，而同样的地址手动
// CONNECT 隧道能通）。必须显式设置全局 dispatcher。
// 用 EnvHttpProxyAgent 而不是裸 ProxyAgent：它会读 NO_PROXY，从而让国内源保持直连。
function applyGlobalFetchProxy() {
  try {
    const undici = require('undici');
    if (typeof undici.setGlobalDispatcher !== 'function' || typeof undici.EnvHttpProxyAgent !== 'function') {
      return { ok: false, reason: 'NO_UNDICI' };
    }
    // 经代理访问境外站点明显更慢：实测 Wikipedia 会触发 undici 默认的
    // HeadersTimeoutError（艺人简介因此拿不到）。这里放宽超时。
    undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({
      headersTimeout: 30000,
      bodyTimeout: 30000,
      connectTimeout: 20000,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 80) };
  }
}

async function setupProxy(log) {
  try {
    const proxy = await detectProxy();
    if (!proxy.enabled) {
      if (typeof log === 'function') log('[Proxy] 未探测到本地代理，走直连');
      return { enabled: false };
    }
    applyProxyEnv(proxy);
    const applied = applyGlobalFetchProxy();
    if (typeof log === 'function') {
      log('[Proxy] 已启用 ' + proxy.host + ':' + proxy.port
        + '（仅 ' + PROXY_HOST_SUFFIXES.length + ' 类域名走代理，国内源直连；fetch dispatcher='
        + (applied.ok ? 'ok' : applied.reason) + '）');
    }
    return Object.assign({}, proxy, { fetchDispatcher: applied.ok });
  } catch (err) {
    if (typeof log === 'function') log('[Proxy] 配置失败，走直连: ' + (err && err.message));
    return { enabled: false };
  }
}

module.exports = { setupProxy, detectProxy, applyProxyEnv, applyGlobalFetchProxy, buildNoProxy, hostMatches, PROXY_HOST_SUFFIXES, DIRECT_HOST_SUFFIXES };
