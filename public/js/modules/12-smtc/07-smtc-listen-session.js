// ============================================================
// 12-smtc/07-smtc-listen-session.js
// 从 SMTC 反推**外部 Apple Music 播放会话**，写入 P0 事件表。
//
// 为什么需要它:
//   MineRadio 的行为黑匣子(02b-play-events.js)只挂在 playQueueAt 上, 那是**内部播放**
//   的入口。用 Apple Music 听歌时走的是 UIA 点击 + SMTC, playQueueAt 永远不会被调用,
//   于是"用户到底听了什么"一条都记不到, 权重永远停在先验值。
//
// 设计约束(重要):
//   1. **不碰时间轴稳定器**。这里独立 setInterval 轮询只读的 smtcStore,
//      不改 00-smtc-store.js 的任何一行 —— 那套 v4 锚点外推模型是歌词对齐的命脉。
//   2. **与内部播放互斥**。内部播放器在放时不记录外部会话, 否则一次收听会被记两遍。
//   3. **明确标记来源**。这些事件带 provider='smtc-external', 并且**不写入**四源统计
//      (playEventsSongStats), 而是按跨源签名写入 playEventsSignatureStats ——
//      两者在评分层按不同键查找, 不会互相污染。
//   4. **没有真实曲目 ID**。SMTC 只给 title/artist/album/durationMs, 所以 key 是合成的
//      ('smtc:标题|艺人'), 另外附一个 sig 供与候选池做保守匹配。
// ============================================================

var smtcListenCfg = {
  ticker: 0,
  intervalMs: 1000,     // SMTC 本身 2~4s 一个采样, 1s 轮询足够且便宜
  maxDeltaMs: 4200,     // 单次累计上限, 与 02-listen-stats.js 的内部播放同规则
  // 抗抖动下限(不是"负面反馈门槛"): SMTC 桥在切歌瞬间会闪出几乎不前进的样本。
  // 低于这个量且几乎没有进度的会话不算一次收听。真实短跳过(>=1s)仍然会被记录。
  minListenMs: 500,
  minProgress: 0.02
};

var smtcListenSession = null;
var smtcListenLastCommand = null;
var smtcListenSerial = 0;

function smtcListenText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// 会话身份: 与 00-smtc-store.js 的 trackChanged 判定保持一致(title/artist/album/aumid)
function smtcListenIdentity(state) {
  return smtcListenText(state.aumid) + '|' + smtcListenText(state.title) + '|' +
    smtcListenText(state.artist) + '|' + smtcListenText(state.album);
}

// Apple Music 的 SMTC artist 字段是 "<艺人> — <专辑>" 拼起来的
// (见 desktop/apple-music-control.js:321 的 splitArtistAlbum 注释; 实测 "Charlie Puth — Voicenotes")。
// **不拆开的话, 跨源签名会带专辑名 -> 永远匹配不上候选池 -> AM 收听一条都归因不到, 整个 B 方案失效。**
// 与 desktop/apple-music-control.js#splitArtistAlbum 用**同一套**规则:
//   raw.split(/\s+[\u2014\u2013-]\s+/) 取第一段
// 那里的注释写明了实测值 "Abel Tesfaye - Dawn FM" (U+2014), 并且明确要求
// **在归一化之前拆** —— 归一化会把分隔符变成普通空格。
// 不要改成"拿 artist 去比 album 字段": 实测 album 字段的文案与嵌入文本并不总是一致。
var SMTC_LISTEN_ARTIST_ALBUM_RE = /\s+[\u2014\u2013-]\s+/;

function smtcListenCleanArtist(state) {
  var raw = smtcListenText(state && state.artist);
  if (!raw) return '';
  return (raw.split(SMTC_LISTEN_ARTIST_ALBUM_RE)[0] || '').trim();
}

// 合成 key: SMTC 不给曲目 ID, 只能用 标题|艺人
function smtcListenKey(state) {
  return 'smtc:' + smtcListenText(state.title) + '|' + smtcListenCleanArtist(state);
}

// 跨源签名: 与 02c-shuffle-score.js 的 shuffleSongSignature 同一算法,
// 这样 Apple Music 听到的歌才能被归因到候选池里同一首歌(保守: 名称不剥括号, Live 版不会误配)。
// 宽松签名(不含艺人): 用于跨源归因回退。算法在 02c, 保证两侧一致。
function smtcListenLooseSignature(state) {
  var payload = { name: smtcListenText(state.title), durationMs: Number(state.durationMs) || 0 };
  if (typeof shuffleLooseSignature === 'function') return shuffleLooseSignature(payload);
  return smtcListenText(state.title).toLowerCase() + '|' + Math.round((Number(state.durationMs) || 0) / 5000);
}

function smtcListenLooseVariants(state) {
  var payload = { name: smtcListenText(state.title), durationMs: Number(state.durationMs) || 0 };
  if (typeof shuffleLooseSignatureVariants === 'function') return shuffleLooseSignatureVariants(payload);
  var only = smtcListenLooseSignature(state);
  return only ? [only] : [];
}

function smtcListenSignature(state) {
  var payload = {
    artist: smtcListenCleanArtist(state),
    name: smtcListenText(state.title),
    durationMs: Number(state.durationMs) || 0
  };
  if (typeof shuffleSongSignature === 'function') return shuffleSongSignature(payload);
  return payload.artist.toLowerCase() + '|' + payload.name.replace(/\s+/g, '').toLowerCase() +
    '|' + Math.round(payload.durationMs / 1000);
}

// 由 03-smtc-ui.js 的 smtcControlCommand 调用: 只有用户在 MineRadio 界面按了上一首/下一首
// 才拿得到方向。Apple Music 自己的界面 / 键盘媒体键引起的切歌没有方向信息。
function smtcListenNoteCommand(command) {
  if (command !== 'next' && command !== 'previous') return;
  smtcListenLastCommand = { command: command, at: Date.now() };
}

function smtcListenConsumeCommand(sessionStartedAt) {
  var pending = smtcListenLastCommand;
  if (!pending) return '';
  smtcListenLastCommand = null;
  // 只认本次会话开始之后(或开始前 1s 内)发出的命令, 避免上一次的残留被算进来
  if (Number(pending.at) < (Number(sessionStartedAt) || 0) - 1000) return '';
  return pending.command;
}

function smtcListenBegin(state, identity, now) {
  smtcListenSerial += 1;
  smtcListenSession = {
    identity: identity,
    key: smtcListenKey(state),
    sig: smtcListenSignature(state),
    sigLoose: smtcListenLooseSignature(state),
    sigLooseVariants: smtcListenLooseVariants(state),
    name: smtcListenText(state.title),
    // 存**拆干净**的艺人: 否则 playEventsArtistStats 会按 "艺人 — 专辑" 建索引, 艺人亲和度全错
    artist: smtcListenCleanArtist(state),
    artistRaw: smtcListenText(state.artist),
    album: smtcListenText(state.album),
    sessionId: 'smtc-' + now.toString(36) + '-' + smtcListenSerial.toString(36),
    startedAt: now,
    lastWallAt: now,
    lastPositionMs: Math.max(0, Number(state.positionMs) || 0),
    durationMs: Math.max(0, Number(state.durationMs) || 0),
    listenMs: 0,
    maxProgress: 0,
    sawPlaying: false
  };
  // 外部播放时 playQueueAt 永远不会被调用, 所以影子推演必须由这里触发,
  // 否则"用 Apple Music 听歌"期间一条决策数据都攒不到。
  if (typeof smartShuffleShadowProbe === 'function') {
    try { smartShuffleShadowProbe('smtc-track-start'); } catch (e) { }
  }
}

function smtcListenFinalize(reason) {
  var session = smtcListenSession;
  smtcListenSession = null;
  if (!session) return null;
  var listenMs = Math.max(0, Math.round(session.listenMs));
  var durationMs = Math.max(0, Number(session.durationMs) || 0);
  var maxProgress = Math.max(0, Number(session.maxProgress) || 0);

  // 抗抖动: 桥在切歌瞬间闪出的空样本不算收听
  if (listenMs < smtcListenCfg.minListenMs && maxProgress < smtcListenCfg.minProgress) return null;

  var completed = maxProgress >= 0.95 || (reason === 'track-change' && maxProgress >= 0.9);
  var earlySkip = !completed && maxProgress < 0.3;
  var command = smtcListenConsumeCommand(session.startedAt);
  var endReason = command ? command : (completed ? 'ended' : (reason || 'session-end'));

  var record = null;
  if (typeof playEventRecord === 'function') {
    record = playEventRecord({
      type: 'play',
      external: true,
      provider: 'smtc-external',
      key: session.key,
      sig: session.sig,
      sigLoose: session.sigLoose,
      sigLooseVariants: session.sigLooseVariants,
      sessionId: session.sessionId,
      name: session.name,
      artist: session.artist,
      album: session.album,
      durationMs: durationMs,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      listenMs: listenMs,
      maxProgress: maxProgress,
      listenRatio: durationMs > 0 ? Math.min(1, listenMs / durationMs) : 0,
      endReason: endReason,
      userInitiated: command === 'next' || command === 'previous',
      unknownDirection: !command && !completed,
      earlySkip: earlySkip,
      completed: completed,
      effective: completed || listenMs >= 45000 || maxProgress >= 0.5,
      playMode: (typeof playMode !== 'undefined' && playMode) || '',
      insertedBy: 'user',
      context: null
    });
  }
  return record;
}

function smtcListenTick() {
  try {
    if (typeof smtcStore === 'undefined' || !smtcStore) return;
    var now = Date.now();

    // 内部播放器在放 -> 外部会话必须让位, 否则同一次收听被记两遍
    if (typeof internalAudioPlayingNow === 'function' && internalAudioPlayingNow()) {
      if (smtcListenSession) smtcListenFinalize('internal-takeover');
      return;
    }

    if (smtcStore.active !== true) {
      if (smtcListenSession) smtcListenFinalize('session-end');
      return;
    }

    var identity = smtcListenIdentity(smtcStore);
    if (!smtcListenSession || smtcListenSession.identity !== identity) {
      if (smtcListenSession) smtcListenFinalize('track-change');
      smtcListenBegin(smtcStore, identity, now);
      return;
    }

    var session = smtcListenSession;
    var playing = smtcStore.isPlaying === true;
    if (playing) {
      session.sawPlaying = true;
      var positionMs = Math.max(0, Number(smtcStore.positionMs) || 0);
      var deltaPosition = positionMs - (Number(session.lastPositionMs) || 0);
      var deltaWall = now - (Number(session.lastWallAt) || now);
      // 与内部播放同规则: 取"位置增量"与"墙钟增量"的较小值, 单帧封顶
      var delta = deltaPosition > 0 ? Math.min(deltaPosition, deltaWall || deltaPosition, smtcListenCfg.maxDeltaMs) : 0;
      if (delta > 0 && delta < 8000) session.listenMs += delta;
      var duration = Math.max(session.durationMs, Number(smtcStore.durationMs) || 0);
      if (duration > 0) {
        session.durationMs = duration;
        session.maxProgress = Math.max(session.maxProgress, positionMs / duration);
      }
      session.lastPositionMs = positionMs;
    }
    session.lastWallAt = now;
  } catch (e) {
    // 轮询绝不能把渲染进程带崩
  }
}

function smtcListenStart() {
  if (smtcListenCfg.ticker) return false;
  if (typeof smtcStore === 'undefined' || !smtcStore) return false;
  smtcListenCfg.ticker = setInterval(smtcListenTick, smtcListenCfg.intervalMs);
  return true;
}

function smtcListenStop() {
  if (!smtcListenCfg.ticker) return false;
  clearInterval(smtcListenCfg.ticker);
  smtcListenCfg.ticker = 0;
  return true;
}

if (typeof window !== 'undefined' && window) {
  try { window.smtcListenTick = smtcListenTick; } catch (e) { }
}
smtcListenStart();
