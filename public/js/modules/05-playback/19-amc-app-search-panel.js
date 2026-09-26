// ============================================================
// 19-amc-app-search-panel.js  (phase 4-search, additive)
//
// A PARALLEL panel for the Apple Music App search plane. It deliberately does NOT touch
// the existing provider chain (07-search.js / MUSIC_SEARCH_PROVIDER_ORDER / provider-fallback)
// and it does NOT wire playback at all - there is no play button and amc.playTrack is never
// called here on purpose, so that:
//
//   UI -> window.mineradio.amc.searchTracks -> amc:search -> apple-music-control.searchTracks
//      -> iTunes Search API -> results list
//
// can be debugged in isolation from the already-verified playback chain
// (iTunes -> -Url -> Apple Music -> SMTC -> identity).
//
// Mounted by exactly one entry in public/js/index-loader.js (before 11-main-loop.js).
// No globals are leaked: everything lives inside the IIFE.
// ============================================================
(function initAmcAppSearchPanel() {
  'use strict';

  var PANEL_ID = 'amcsp-root';
  var STYLE_ID = 'amcsp-style';
  var state = { open: false, busy: false, results: [], error: '', query: '' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      + '#amcsp-root{position:fixed;left:18px;bottom:96px;z-index:2147483000;font:12px/1.5 "Segoe UI",system-ui,sans-serif;color:#f2f2f7}'
      + '#amcsp-toggle{position:fixed;left:18px;bottom:56px;z-index:2147483000;padding:6px 12px;border-radius:999px;'
      + 'border:1px solid rgba(255,255,255,.28);background:rgba(20,20,24,.82);color:#f2f2f7;cursor:pointer;backdrop-filter:blur(8px)}'
      + '#amcsp-panel{display:none;width:380px;max-height:56vh;overflow:auto;padding:10px 12px;border-radius:14px;'
      + 'border:1px solid rgba(255,255,255,.18);background:rgba(16,16,20,.92);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.45)}'
      + '#amcsp-panel.amcsp-open{display:block}'
      + '#amcsp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:600}'
      + '#amcsp-head span small{opacity:.6;font-weight:400}'
      + '#amcsp-row{display:flex;gap:6px}'
      + '#amcsp-input{flex:1;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.22);'
      + 'background:rgba(0,0,0,.35);color:#fff;outline:none}'
      + '#amcsp-go{padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.10);color:#fff;cursor:pointer}'
      + '#amcsp-note{margin:8px 0 4px;opacity:.62;font-size:11px}'
      + '.amcsp-item{display:flex;gap:8px;padding:7px 0;border-top:1px solid rgba(255,255,255,.10)}'
      + '.amcsp-item img{width:44px;height:44px;border-radius:6px;object-fit:cover;flex:0 0 auto;background:rgba(255,255,255,.08)}'
      + '.amcsp-meta{min-width:0}'
      + '.amcsp-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.amcsp-sub{opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.amcsp-ids{opacity:.5;font-size:11px}'
      + '.amcsp-err{color:#ff9f9f;margin:6px 0}'
      + '.amcsp-empty{opacity:.6;margin:6px 0}';
    var s = el('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function build() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyle();

    var root = el('div');
    root.id = PANEL_ID;

    var toggle = el('button', '', 'AM App 搜索');
    toggle.id = 'amcsp-toggle';
    toggle.type = 'button';

    var panel = el('div');
    panel.id = 'amcsp-panel';

    var head = el('div');
    head.id = 'amcsp-head';
    var h = el('span', '', 'Apple Music App 搜索 ');
    h.appendChild(el('small', '', '(iTunes Search API)'));
    var close = el('button', '', '×');
    close.type = 'button';
    close.style.cssText = 'background:none;border:0;color:#fff;font-size:16px;cursor:pointer';
    head.appendChild(h);
    head.appendChild(close);

    var row = el('div');
    row.id = 'amcsp-row';
    var input = el('input');
    input.id = 'amcsp-input';
    input.type = 'text';
    input.placeholder = '搜索 Apple Music（iTunes API）...';
    var go = el('button', '', '搜索');
    go.id = 'amcsp-go';
    go.type = 'button';
    row.appendChild(input);
    row.appendChild(go);

    var note = el('div');
    note.id = 'amcsp-note';
    note.textContent = '只做搜索与展示；播放按钮故意未接（播放链已单独验证）。';

    var list = el('div');
    list.id = 'amcsp-list';

    panel.appendChild(head);
    panel.appendChild(row);
    panel.appendChild(note);
    panel.appendChild(list);
    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);

    toggle.addEventListener('click', function () { setOpen(!state.open); });
    close.addEventListener('click', function () { setOpen(false); });
    go.addEventListener('click', function () { run(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

    function setOpen(v) {
      state.open = !!v;
      panel.classList.toggle('amcsp-open', state.open);
      if (state.open) { try { input.focus(); } catch (e) { } }
    }

    function render() {
      list.innerHTML = '';
      if (state.error) { list.appendChild(el('div', 'amcsp-err', state.error)); }
      if (!state.results.length && !state.error && !state.busy) {
        list.appendChild(el('div', 'amcsp-empty', '输入关键词后回车或点"搜索"。'));
        return;
      }
      state.results.forEach(function (r) {
        var item = el('div', 'amcsp-item');
        if (r.artworkUrl) {
          var img = el('img');
          img.src = r.artworkUrl;
          img.alt = '';
          img.loading = 'lazy';
          item.appendChild(img);
        } else {
          item.appendChild(el('div', '', ''));
        }
        var meta = el('div', 'amcsp-meta');
        meta.appendChild(el('div', 'amcsp-title', r.title || '(无标题)'));
        meta.appendChild(el('div', 'amcsp-sub', (r.artist || '') + (r.album ? ' — ' + r.album : '')));
        var secs = r.durationMs ? Math.round(r.durationMs / 1000) : 0;
        meta.appendChild(el('div', 'amcsp-ids',
          'trackId=' + (r.trackId == null ? '?' : r.trackId) +
          '  storefront=' + (r.storefront || '?') +
          (secs ? '  ' + Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2) : '')));
        item.appendChild(meta);
        list.appendChild(item);
      });
    }

    function run() {
      if (state.busy) return;
      var q = String(input.value || '').trim();
      state.query = q;
      state.error = '';
      if (!q) { state.results = []; render(); return; }

      var amc = window.mineradio && window.mineradio.amc;
      if (!amc || typeof amc.searchTracks !== 'function') {
        state.results = [];
        state.error = 'IPC 不可用：window.mineradio.amc.searchTracks 不存在（本轮台账中该跳为 untested）。';
        render();
        return;
      }

      state.busy = true;
      state.results = [];
      render();
      list.appendChild(el('div', 'amcsp-empty', '搜索中...'));

      Promise.resolve(amc.searchTracks({ query: q, country: 'us', limit: 12 }))
        .then(function (res) {
          state.results = (res && res.results) || [];
          state.busy = false;
          if (!state.results.length) state.error = '没有结果（itunes 返回空）。';
          render();
        })
        .catch(function (err) {
          state.busy = false;
          state.results = [];
          state.error = '搜索失败：' + ((err && err.message) || err);
          render();
        });
    }

    render();
  }

  // Debug / fallback entry only. The floating button is OFF by default so the app stays clean;
  // the verified channel lives in the search bar's AM tab now. Enable with either
  //   ?amcPanel=1  in the URL, or  window.__AMC_PANEL_DEBUG = true  in the console.
  var AMC_PANEL_DEBUG = !!(window.__AMC_PANEL_DEBUG || String(location.search || '').indexOf('amcPanel=1') >= 0);
  function boot() {
    if (!AMC_PANEL_DEBUG) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', boot, { once: true }); return; }
    build();
  }
  boot();
})();