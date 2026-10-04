'use strict';
/*
 * 音乐源数据可得性审计（只读）
 * ------------------------------------------------------------------
 * 目的：在动 2.1.0 的代码之前，先把「每个源究竟能拿到多少数据」量出来。
 *   - 登录态与身份（uin / userId）
 *   - 个人库规模：收藏歌单数、喜欢歌曲数、收藏专辑数
 *   - 单曲可播性：/song/url 是否真的给流、是什么格式与码率
 * 只读，不改任何数据；没有登录态时如实报「未登录」，不报错。
 *
 * 用法：node scripts/audit-music-sources.js
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const out = [];
function log(s) { out.push(s); console.log(s); }
function section(t) { log(''); log('=== ' + t + ' ==='); }

// ---- cookie 文件读取 ----
// 源码实例写在 server.js 所在目录；打包版写在 Electron userData
// （实测：C:\Users\<u>\AppData\Roaming\MineRadio Apple Music Edition\）。
// 优先环境变量覆盖，其余按候选顺序找第一个存在的。
const CANDIDATE_DIRS = [
  process.env.MR_COOKIE_DIR || '',
  ROOT,
  path.join(process.env.APPDATA || '', 'MineRadio Apple Music Edition'),
  path.join(process.env.APPDATA || '', 'mineradio-apple-music-edition'),
].filter(Boolean);

function findCookie(file) {
  for (const d of CANDIDATE_DIRS) {
    const p = path.join(d, file);
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return { value: v, from: p };
    } catch (_) { /* 继续找 */ }
  }
  return { value: '', from: '' };
}
const FOUND = {
  netease: findCookie('.cookie'),
  qq: findCookie('.qq-cookie'),
  kugou: findCookie('.kugou-cookie'),
};
const COOKIES = {
  netease: FOUND.netease.value,
  qq: FOUND.qq.value,
  kugou: FOUND.kugou.value,
};

// ---- 网易云：直接用项目既有的 NeteaseCloudMusicApi 包 ----
async function auditNetease() {
  section('网易云 (netease)');
  let N = null;
  try { N = require('NeteaseCloudMusicApi'); } catch (e) { log('  模块缺失: ' + e.message); return; }
  const cookie = COOKIES.netease;
  log('  cookie 文件: ' + (cookie ? '有 (' + cookie.length + ' 字符)' : '无'));
  let status = null;
  try { status = await N.login_status({ cookie, timestamp: Date.now() }); } catch (e) { log('  login_status 失败: ' + String(e.message).slice(0, 120)); }
  const prof = status && status.body && status.body.data && status.body.data.profile;
  log('  登录态: ' + (prof ? ('已登录 uid=' + prof.userId + ' 昵称=' + (prof.nickname || '')) : '未登录'));
  if (!prof) return;
  const uid = prof.userId;
  // 收藏歌单
  try {
    const r = await N.user_playlist({ uid, limit: 1000, cookie, timestamp: Date.now() });
    const pl = (r.body && r.body.playlist) || [];
    const own = pl.filter(p => p && p.userId === uid).length;
    const sub = pl.length - own;
    log('  收藏歌单: 共 ' + pl.length + ' 个（自建 ' + own + '，收藏 ' + sub + '）');
  } catch (e) { log('  收藏歌单: 失败 ' + String(e.message).slice(0, 100)); }
  // 喜欢的歌曲
  try {
    const r = await N.likelist({ uid, cookie, timestamp: Date.now() });
    const ids = (r.body && r.body.ids) || [];
    log('  喜欢的歌曲: ' + ids.length + ' 首');
  } catch (e) { log('  喜欢的歌曲: 失败 ' + String(e.message).slice(0, 100)); }
  // 收藏专辑
  try {
    const r = await N.album_sublist({ limit: 100, offset: 0, cookie, timestamp: Date.now() });
    const list = (r.body && r.body.data) || (r.body && r.body.albums) || [];
    log('  收藏专辑: ' + (Array.isArray(list) ? list.length : '未知') + ' 张');
  } catch (e) { log('  收藏专辑: 失败 ' + String(e.message).slice(0, 100)); }
  // 可播性取样：拿喜欢的歌里前 3 首试 song_url
  try {
    const lr = await N.likelist({ uid, cookie, timestamp: Date.now() });
    const ids = ((lr.body && lr.body.ids) || []).slice(0, 3);
    if (!ids.length) { log('  可播性取样: 跳过（没有喜欢的歌）'); return; }
    for (const id of ids) {
      const u = await N.song_url_v1({ id, level: 'exhigh', cookie, timestamp: Date.now() });
      const d = (u.body && u.body.data && u.body.data[0]) || {};
      log('    song ' + id + ' -> url=' + (d.url ? 'YES' : '无') + ' 码率=' + (d.br || '-') + ' 类型=' + (d.type || '-') + (d.freeTrialInfo ? ' [试听片段]' : ''));
    }
  } catch (e) { log('  可播性取样: 失败 ' + String(e.message).slice(0, 120)); }
}

// ---- QQ 音乐 ----
async function auditQQ() {
  section('QQ 音乐 (qq)');
  const cookie = COOKIES.qq;
  log('  cookie 文件: ' + (cookie ? '有 (' + cookie.length + ' 字符)' : '无'));
  if (!cookie) { log('  登录态: 未登录（无 cookie 文件）'); return; }
  // QQ 侧没有独立 api 模块：个人库读取直接写在 server.js 的 /api/qq/* 路由里，
  // 依赖 qqMusicRequest 的内部签名，无法在独立进程里复用。
  // 因此 QQ 的规模数据必须通过运行中的应用（/api/qq/user/playlists 等）读取。
  log('  说明: QQ 的个人库读取实现在 server.js 的 /api/qq/* 路由内（无独立模块），');
  log('        需要运行中的应用上下文才能探测数量；本脚本只报 cookie 有无。');
}

// ---- 酷狗 ----
async function auditKugou() {
  section('酷狗 (kugou)');
  const cookie = COOKIES.kugou;
  log('  cookie 文件: ' + (cookie ? '有 (' + cookie.length + ' 字符)' : '无'));
  if (!cookie) { log('  登录态: 未登录（无 cookie 文件）'); return; }
  let K = null;
  try { K = require(path.join(ROOT, 'kugou-api.js')); } catch (e) { log('  模块加载失败: ' + e.message); return; }
  try { log('  hasLogin=' + K.kugouCookieHasLogin(cookie) + '  hasPlayback=' + K.kugouCookieHasPlayback(cookie) + '  userId=' + (K.kugouCookieUserId(cookie) || '-')); } catch (e) { log('  状态解析失败: ' + e.message); }
  try {
    const info = K.getKugouLoginInfo ? await K.getKugouLoginInfo(cookie) : null;
    log('  getKugouLoginInfo: ' + JSON.stringify(info).slice(0, 240));
  } catch (e) { log('  getKugouLoginInfo 失败: ' + String(e.message).slice(0, 120)); }
  // 注意：酷狗这些函数是**位置参数**，不是对象参数（server.js 的调用方式为准）
  try {
    const r = await K.handleKugouUserPlaylists(cookie);
    const pl = (r && (r.playlists || r.data)) || [];
    log('  收藏/自建歌单: ' + (Array.isArray(pl) ? pl.length + ' 个' : JSON.stringify(r).slice(0, 120)));
    if (Array.isArray(pl) && pl.length) {
      const first = pl[0];
      log('    首个歌单: ' + (first.name || first.title || '?') + '  id=' + (first.id || first.listid || '?'));
      try {
        const t = await K.handleKugouPlaylistTracks(first.id || first.listid, cookie, {});
        const songs = (t && (t.songs || t.tracks || t.data)) || [];
        log('    曲目数: ' + (Array.isArray(songs) ? songs.length : '未知'));
      } catch (e) { log('    曲目读取失败: ' + String(e.message).slice(0, 100)); }
    }
  } catch (e) { log('  歌单: 失败 ' + String(e.message).slice(0, 140)); }
  try {
    const songs = await K.handleKugouSearch('周杰伦', 3, cookie, 0);
    log('  搜索可用性: ' + (Array.isArray(songs) ? songs.length + ' 条' : '未知'));
    const one = Array.isArray(songs) ? songs[0] : null;
    if (one) {
      log('    样本: ' + (one.name || one.title || '?') + ' hash=' + String(one.hash || one.fileHash || '-').slice(0, 12));
      const u = await K.handleKugouSongUrl({ hash: one.hash || one.fileHash, albumId: one.albumId, albumAudioId: one.albumAudioId, quality: 'high' }, cookie);
      log('    可播性取样: url=' + (u && u.url ? 'YES' : '无') + ' playable=' + (u && u.playable) + ' 错误=' + ((u && u.error) || '-'));
      if (u && u.url) log('      链接前缀: ' + String(u.url).slice(0, 70));
    }
  } catch (e) { log('  搜索/可播性: 失败 ' + String(e.message).slice(0, 140)); }
}

(async () => {
  log('音乐源数据可得性审计 —— ' + new Date().toISOString());
  log('工作区: ' + ROOT);
  for (const k of Object.keys(COOKIES)) {
    const f = FOUND[k];
    log('  cookie[' + k + '] = ' + (f.value ? (f.value.length + ' 字符  <- ' + f.from) : '（未找到）'));
  }
  try { await auditNetease(); } catch (e) { log('网易云审计异常: ' + String(e.message).slice(0, 160)); }
  try { await auditQQ(); } catch (e) { log('QQ 审计异常: ' + String(e.message).slice(0, 160)); }
  try { await auditKugou(); } catch (e) { log('酷狗审计异常: ' + String(e.message).slice(0, 160)); }
  section('完成');
  log('提示：登录后重跑本脚本即可对比数据量。');
  try {
    const dir = path.join(ROOT, 'docs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'music-source-audit.txt'), out.join('\n'), 'utf8');
    console.log('\n（结果已写入 docs/music-source-audit.txt）');
  } catch (_) {}
})().catch(e => { console.error('FATAL', String(e && e.stack || e).slice(0, 400)); process.exit(1); });
