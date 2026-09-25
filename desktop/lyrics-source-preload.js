// ============================================================
// lyrics-source-preload.js — 歌词源窗口 preload (独立窗口专用)
// 最小 IPC: 只传"搜索顺序", 不触碰歌词内容/SMTC/音频/封面。
//
// 凭证边界 (重要):
//   1) 本地缓存路径: Apple Music 歌词默认读取本机 Apple Music 应用自己维护的
//      官方歌词缓存 (…\Packages\AppleInc.AppleMusicWin_*\AC\INetCache\*\ttmlLyrics*.json),
//      这条路不需要任何凭证, 也永远不会要求登录。
//   2) 可选 Web 凭证: 为后续"官方歌词增强"预留的 Apple Music Web
//      media-user-token。它只做本地保存 / 状态读取 / 删除, 本窗口不发起任何
//      Apple Music 网络请求。
//   注意: 该 media-user-token 与 Apple Developer 凭证 (Team ID / Key ID / .p8 /
//   developer token / MusicKit user token) 是两套完全独立的东西, 后者不在本窗口、
//   也不由本模块管理。
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricsSource', {
  // 拖拽排序后上报新顺序 -> 主进程转发主窗口 renderer (现有排序状态)
  reportOrder: (order) => ipcRenderer.send('mineradio-lyrics-source-order-changed', {
    order: Array.isArray(order) ? order.map((s) => String(s).slice(0, 24)) : [],
  }),
  // 关闭按钮
  closeWindow: () => ipcRenderer.send('mineradio-lyrics-source-close'),
  // [重新搜索]: 按当前排序强制重搜当前歌曲 (主窗口执行, 绕过缓存)
  reSearch: () => ipcRenderer.send('mineradio-lyrics-source-research'),
  // 主进程通知重搜完成 (恢复按钮状态)
  onReSearchDone: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('mineradio-lyrics-source-research-done', listener);
    return () => ipcRenderer.removeListener('mineradio-lyrics-source-research-done', listener);
  },
  // 主进程推送当前搜索顺序 (打开时)
  onState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state || {});
    ipcRenderer.on('mineradio-lyrics-source-state', listener);
    return () => ipcRenderer.removeListener('mineradio-lyrics-source-state', listener);
  },
});

// Apple Music 歌词凭证 (media-user-token) 的最小 IPC。
// 只做: 状态 / 保存 / 删除。文件读写全部在主进程, 渲染进程拿不到文件路径,
// 也永远拿不到 token 明文 (只返回 configured + updatedAt)。
contextBridge.exposeInMainWorld('appleMusicLyricsCredential', {
  getStatus: () => ipcRenderer.invoke('mineradio-apple-lyrics-credential-status'),
  set: (token) => ipcRenderer.invoke('mineradio-apple-lyrics-credential-set', {
    mediaUserToken: String(token == null ? '' : token),
  }),
  clear: () => ipcRenderer.invoke('mineradio-apple-lyrics-credential-clear'),
  // 复用 Apple Music Web 登录窗口自动获取 media-user-token (不要求 Developer 凭证)。
  // 主进程只返回 { ok, configured, reused } 或 { ok: false, error, message }, 永不返回 token。
  loginWithAppleMusic: () => ipcRenderer.invoke('mineradio-apple-lyrics-credential-login'),
});
