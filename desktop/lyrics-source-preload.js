// ============================================================
// lyrics-source-preload.js — 歌词源窗口 preload (独立窗口专用)
// 最小 IPC: 只传"搜索顺序", 不触碰歌词内容/SMTC/音频/封面。
//
// 注意: 本窗口不涉及任何 Apple Music 凭证。
//   Apple Music 歌词源读取的是本机 Apple Music 应用自己维护的官方歌词缓存
//   (…\Packages\AppleInc.AppleMusicWin_*\AC\INetCache\*\ttmlLyrics*.json),
//   不需要 Developer Token / Music User Token / Cookie / 账号密码,
//   因此这里不提供、也不应提供任何凭证导入入口。
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
