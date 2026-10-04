'use strict';
// ============================================================
// 出网代理配置 · 契约测试（静态 + 纯函数）
// ============================================================
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const P = require(path.join(__dirname, '..', 'desktop', 'outbound-proxy.js'));

test('出网代理：域名匹配', async (t) => {
  await t.test('境外域名命中代理名单（含子域）', () => {
    ['open.spotify.com', 'zh.wikipedia.org', 'api.github.com', 'is1-ssl.mzstatic.com'].forEach(function (h) {
      assert.equal(P.hostMatches(h, P.PROXY_HOST_SUFFIXES), true, h + ' 应走代理');
    });
  });

  await t.test('国内源与本地回调不得走代理', () => {
    ['music.163.com', 'mobiles.kugou.com', 'c.y.qq.com', 'p3-luna.douyinpic.com',
     'y.gtimg.cn', '127.0.0.1', 'localhost'].forEach(function (h) {
      assert.equal(P.hostMatches(h, P.PROXY_HOST_SUFFIXES), false, h + ' 不该走代理');
    });
  });

  await t.test('后缀匹配不能误伤（evil-spotify.com 不是 spotify.com）', () => {
    assert.equal(P.hostMatches('evil-spotify.com', P.PROXY_HOST_SUFFIXES), false);
    assert.equal(P.hostMatches('notspotify.com', P.PROXY_HOST_SUFFIXES), false);
    assert.equal(P.hostMatches('spotify.com', P.PROXY_HOST_SUFFIXES), true);
  });
});

test('出网代理：NO_PROXY 生成', async (t) => {
  await t.test('本地回调必须在 NO_PROXY 里（Spotify 的 127.0.0.1:43879/callback）', () => {
    const np = P.buildNoProxy();
    assert.ok(np.indexOf('.localhost') >= 0, '要含 localhost');
    assert.ok(np.indexOf('.127.0.0.1') >= 0, '要含 127.0.0.1');
  });

  await t.test('国内源要在 NO_PROXY 里', () => {
    const np = P.buildNoProxy();
    ['music.163.com', 'kugou.com', 'qq.com', 'douyinpic.com'].forEach(function (h) {
      assert.ok(np.indexOf(h) >= 0, 'NO_PROXY 应含 ' + h);
    });
  });

  await t.test('境外域名不得出现在 NO_PROXY 里（否则等于没走代理）', () => {
    const np = P.buildNoProxy();
    ['spotify.com', 'wikipedia.org', 'github.com', 'mzstatic.com'].forEach(function (h) {
      assert.equal(np.indexOf(h) >= 0, false, h + ' 不该被排除');
    });
  });
});

test('出网代理：接线与启动期约束', async (t) => {
  const PROXY_SRC = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'desktop', 'outbound-proxy.js'), 'utf8');
  const MAIN = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');

  await t.test('必须在探测到端口真的在监听时才启用', () => {
    // Clash 没开时强行设代理会让所有请求连到死端口 —— 比直连更糟
    assert.ok(PROXY_SRC.indexOf('probePort') > 0, '要探测端口');
    assert.ok(/if \(!proxy\.enabled\)/.test(PROXY_SRC), '未探测到就走直连');
  });

  await t.test('必须显式设置 fetch 的全局 dispatcher', () => {
    // 只设环境变量在运行期无效：undici 在模块加载时就读掉了 NODE_USE_ENV_PROXY
    assert.ok(PROXY_SRC.indexOf('setGlobalDispatcher') > 0, '要设全局 dispatcher');
    assert.ok(PROXY_SRC.indexOf('EnvHttpProxyAgent') > 0, '要用会读 NO_PROXY 的那个');
  });

  await t.test('要在加载 server.js 之前完成配置', () => {
    const proxyAt = MAIN.indexOf('outboundProxy.setupProxy');
    const serverAt = MAIN.indexOf("require(serverModulePath)");
    assert.ok(proxyAt > 0, 'main.js 要调用 setupProxy');
    assert.ok(serverAt > 0, '要加载 server.js');
    assert.ok(proxyAt < serverAt, '必须先配代理再加载 server（server 一加载就出网）');
  });

  await t.test('端口可用环境变量覆盖，便于测试与换代理', () => {
    assert.ok(PROXY_SRC.indexOf('MINERADIO_PROXY_PORT') > 0, '要支持指定端口');
    assert.ok(PROXY_SRC.indexOf('MINERADIO_PROXY') > 0, '要支持指定主机');
  });
});
