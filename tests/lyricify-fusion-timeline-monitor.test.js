'use strict';
// ============================================================
// tests/lyricify-fusion-timeline-monitor.test.js
// Lyricify Fusion 只读观测器 —— 合成日志测试
//
// 测试用的日志文件全部由本测试自己创建（系统临时目录下的
// mineradio-lyricify-monitor-tests/），测试结束即清理；
// 不读取、不写入、不触碰 Lyricify Fusion 的任何文件。
//
// 运行: node --test tests/lyricify-fusion-timeline-monitor.test.js
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const appRoot = path.resolve(__dirname, '..');
const { LogTailer } = require(path.join(appRoot, 'tools', 'lib', 'log-tailer.js'));
const parser = require(path.join(appRoot, 'tools', 'lib', 'lyricify-log-parser.js'));
const { TimelineStats } = require(path.join(appRoot, 'tools', 'lib', 'timeline-stats.js'));
const { compareTimelines, parseTspObservations } = require(path.join(appRoot, 'tools', 'lib', 'tsp-comparator.js'));
const { DedupeWindow } = require(path.join(appRoot, 'tools', 'lib', 'dedupe-window.js'));

const TMP_ROOT = path.join(os.tmpdir(), 'mineradio-lyricify-monitor-tests');
let caseDir = null;

function newCaseDir(name) {
  caseDir = path.join(TMP_ROOT, name + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
  fs.mkdirSync(caseDir, { recursive: true });
  return caseDir;
}
function rmCaseDir() {
  if (caseDir && fs.existsSync(caseDir)) {
    // Windows 上杀毒/索引可能瞬时不放锁 -> 有界重试
    try { fs.rmSync(caseDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }); } catch (e) { }
  }
  caseDir = null;
}
test.after(() => {
  // 只清理本次测试创建的目录；绝不触碰 Lyricify Fusion 目录
  try {
    if (fs.existsSync(TMP_ROOT)) fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  } catch (e) { }
});

const HUGE_IDLE = 1e9;   // 测试里用"下一条记录/显式 flush"触发末条，避免依赖真实时间

function ts(offsetSeconds, fraction) {
  // 固定基准时间，避免依赖真实时钟
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const d = new Date(base + offsetSeconds * 1000);
  const pad = (n, w) => String(n).padStart(w, '0');
  const iso = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' +
    pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) +
    '.' + (fraction || '0000000') + '+08:00';
  return iso;
}

// ------------------------------------------------------------
test('P1 解析器：真实格式（事件/时间轴异常/scrobble/检索）', () => {
  const rec = (first, cont) => parser.parseRecord({ firstLine: first, continuations: cont || [], sourceFile: 'Log.txt', sourceLine: 1, collectorTimestampMs: 1, collectorTimestamp: 'x' });

  const appStart = rec(ts(0) + ' [Event] App starting, version 1.3.0.260928-release');
  assert.strictEqual(appStart.eventType, 'app-start');
  assert.strictEqual(appStart.extras.version, '1.3.0.260928-release');
  assert.strictEqual(appStart.sourceTimestampPrecision, '100ns', '7 位小数应标注 100ns');

  const tErr = rec(ts(1) + ' [Error] [AppleInc.AppleMusicWin_nzyj5cx40ttqa!App] Error in OnAnyTimelinePropertyChanged Invoke', [
    'System.InvalidOperationException: Collection was modified; enumeration operation may not execute.',
    '   at Lyricify.Lite.Helpers.Internal.PlaybackInfo.SetPosition(...)',
  ]);
  assert.strictEqual(tErr.eventType, 'timeline-property-error');
  assert.strictEqual(tErr.sessionIdentity, 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App');
  assert.strictEqual(tErr.extras.exceptionType, 'System.InvalidOperationException');
  assert.strictEqual(tErr.playbackStatePresent, false, '不得伪造播放状态');

  const reset = rec(ts(2) + ' [Trace] Reset scrobble state: reason=Track, key=AppleInc.AppleMusicWin_nzyj5cx40ttqa!App|metadata|best friends|abel tesfaye|dawn fm|');
  assert.strictEqual(reset.eventType, 'scrobble-reset');
  assert.strictEqual(reset.extras.reason, 'Track');
  assert.deepStrictEqual(reset.trackIdentity, { title: 'best friends', artist: 'abel tesfaye', album: 'dawn fm', source: 'metadata-key' });

  const trig = rec(ts(3) + ' [Event] Scrobble trigger: session=AppleInc.AppleMusicWin_nzyj5cx40ttqa!App, title=Best Friends, artist=Abel Tesfaye, playedMs=61000, targetMs=60000');
  assert.strictEqual(trig.eventType, 'scrobble-trigger');
  assert.strictEqual(trig.rawPosition.valueMs, 61000);
  assert.strictEqual(trig.rawPosition.precision, 'millisecond');
  assert.strictEqual(trig.rawPosition.isRawSmtcPosition, false, 'playedMs 绝不是 SMTC 原始 position');
  assert.strictEqual(trig.rawPosition.semantics, 'scrobbler-accumulated-played-ms');
  assert.strictEqual(trig.durationMs, null, '不得伪造 duration');

  const search = rec(ts(4) + ' [Info] [Search Track] [AppleMusic] Stand Up • The Cab • Lock Me Up - EP •  • Perfect • 1553944486');
  assert.strictEqual(search.eventType, 'track-search');
  assert.strictEqual(search.extras.provider, 'AppleMusic');
  assert.strictEqual(search.trackIdentity.title, 'Stand Up');
});

test('P2 解析器：时间戳/格式异常不猜测、不伪造', () => {
  const bad = parser.parseRecord({ firstLine: '这不是一行带时间戳的日志', continuations: [], sourceFile: 'Log.txt', sourceLine: 7, collectorTimestampMs: 5, collectorTimestamp: 'x' });
  assert.strictEqual(bad.sourceTimestamp, null);
  assert.strictEqual(bad.sourceTimestampMs, null);
  assert.ok(bad.parseWarnings.indexOf('missing-or-invalid-timestamp') >= 0);
  assert.strictEqual(bad.rawMessage, '这不是一行带时间戳的日志');

  const orphan = parser.parseRecord({ firstLine: '   at Some.Stack.Frame()', continuations: [], sourceFile: 'Log.txt', sourceLine: 8, collectorTimestampMs: 6, collectorTimestamp: 'x' });
  assert.ok(orphan.parseWarnings.indexOf('no-level-tag') >= 0);
  assert.strictEqual(orphan.eventType, 'unclassified');
});

test('P3 秒级显示值绝不被当成原始精度', () => {
  const p = parser.positionFromSecondDisplay(47, '00:00:47');
  assert.strictEqual(p.valueMs, 47000);
  assert.strictEqual(p.precision, 'second');
  assert.strictEqual(p.resolutionMs, 1000);
  assert.strictEqual(p.isRawSmtcPosition, false);
  assert.strictEqual(p.isDisplayValueOnly, true);
  assert.ok(/不得当作原始 SMTC/.test(p.notes));
  // 观测里必须保留精度标注，而不是被抬成 47.000000s
  const obs = { rawPosition: p, collectorTimestampMs: 1, eventType: 'x' };
  assert.notStrictEqual(obs.rawPosition.precision, 'millisecond');
});

// ------------------------------------------------------------
// Windows 上刚创建的文件可能被瞬时限锁（EBUSY/EPERM）：测试写入做有界重试
function writeAppend(file, text) {
  let lastErr = null;
  for (let i = 0; i < 8; i += 1) {
    try { fs.appendFileSync(file, text, 'utf8'); return; } catch (e) {
      lastErr = e;
      if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) { /* backoff */ }
    }
  }
  throw lastErr;
}
function mkTailer(file, opts) {
  return new LogTailer(Object.assign({ path: file, idleFlushMs: HUGE_IDLE }, opts || {}));
}
function drain(t) { const out = { records: [] }; t.flushPending(out); return out.records; }
// 测试用：读取并把"末条待定记录"一起发射（真实运行里由 idleFlush / 下一条记录触发）
function pollAll(t) { const out = t.poll(); t.flushPending(out); return out; }
// Windows 上文件大小可见性偶有延迟（杀毒/索引短暂持锁），这里做有界重试，
// 否则测试会因为"刚写完还看不到"而偶发失败（真实采集器下一轮自然补上，不受影响）。
function pollAllEventually(t, attempts) {
  const n = attempts || 8;
  let out = pollAll(t);
  for (let i = 0; i < n && out.records.length === 0; i += 1) {
    const until = Date.now() + 20;
    while (Date.now() < until) { /* short backoff */ }
    out = pollAll(t);
  }
  return out;
}

test('T1 持续追加：每次追加都能读到', () => {
  const dir = newCaseDir('append');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, { startAtEnd: true });
  assert.deepStrictEqual(pollAll(t).records, []);
  writeAppend(f, ts(0) + ' [Event] Finished App loading\r\n');
  const out = pollAllEventually(t);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].firstLine.indexOf('Finished App loading') > 0, true);
  rmCaseDir();
});

test('T2 一次写入多行：全部按记录切分', () => {
  const dir = newCaseDir('batch');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  writeAppend(f, [ts(0) + ' [Event] A', ts(1) + ' [Event] B', ts(2) + ' [Event] C', ''].join('\r\n'));
  const out = pollAllEventually(t);
  assert.strictEqual(out.records.length, 3);
  assert.ok(out.records[1].firstLine.indexOf(' [Event] B') > 0);
  rmCaseDir();
});

test('T3 半行写入后补全：不丢字节、不重复消费', () => {
  const dir = newCaseDir('half');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  const line = ts(0) + ' [Event] Finished App loading';
  writeAppend(f, line.slice(0, 20));          // 半行
  assert.strictEqual(pollAll(t).records.length, 0, '半行不得被当成完整记录');
  writeAppend(f, line.slice(20) + '\r\n');    // 补全
  const out = pollAllEventually(t);
  assert.strictEqual(out.records.length, 1);
  assert.strictEqual(out.records[0].firstLine, line);
  assert.strictEqual(pollAll(t).records.length, 0, '不得重复消费');
  rmCaseDir();
});

test('T4 UTF-8 多字节字符跨写入边界：解码正确', () => {
  const dir = newCaseDir('utf8');
  const f = path.join(dir, 'Log.LastFM.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  const line = ts(0) + ' [Trace] Reset scrobble state: reason=Track, key=AppleInc.AppleMusicWin!App|metadata|晴天|周杰伦|叶惠美|';
  const buf = Buffer.from(line + '\r\n', 'utf8');
  const cut = buf.indexOf(Buffer.from('晴', 'utf8')) + 1;   // 从汉字中间切开
  fs.appendFileSync(f, buf.subarray(0, cut));
  assert.strictEqual(t.poll().records.length, 0);
  fs.appendFileSync(f, buf.subarray(cut));
  const out = pollAllEventually(t);
  assert.strictEqual(out.records.length, 1);
  const obs = parser.parseRecord({ firstLine: out.records[0].firstLine, continuations: [], sourceFile: 'Log.LastFM.txt', collectorTimestampMs: 1, collectorTimestamp: 'x' });
  assert.strictEqual(obs.trackIdentity.title, '晴天');
  rmCaseDir();
});

test('T5 重复记录：两次写入同一行会产生两条观测（可被统计层识别为重复事件）', () => {
  const dir = newCaseDir('dup');
  const f = path.join(dir, 'Log.Lyrics.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  const line = ts(0) + ' [Info] [Search Track] Stand Up • The Cab • Lock Me Up - EP •  • Perfect • 1553944486';
  writeAppend(f, line + '\r\n' + line + '\r\n');
  const out = pollAllEventually(t);
  assert.strictEqual(out.records.length, 2);
  const stats = new TimelineStats({ duplicateWindowMs: 1500 });
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  for (const r of out.records) {
    const obs = parser.parseRecord({ firstLine: r.firstLine, continuations: [], sourceFile: 'Log.Lyrics.txt', collectorTimestampMs: base, collectorTimestamp: 'x' });
    obs.collectorTimestampMs = base;
    stats.add(obs);
  }
  assert.strictEqual(stats.snapshot(base + 10).run.duplicateEvents, 1, '同类型同身份且时间接近 -> 记一次重复事件');
  rmCaseDir();
});

test('T6 采集器重启：带游标不重复处理历史', () => {
  const dir = newCaseDir('restart');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t1 = mkTailer(f, {});
  writeAppend(f, ts(0) + ' [Event] A\r\n' + ts(1) + ' [Event] B\r\n');
  assert.strictEqual(pollAll(t1).records.length, 2);
  const st = t1.getState();
  writeAppend(f, ts(2) + ' [Event] C\r\n');
  const t2 = mkTailer(f, { offset: st.offset, lineNumber: st.lineNumber, fileKey: st.fileKey });
  const out2 = pollAllEventually(t2);
  assert.strictEqual(out2.records.length, 1, '只消费新增的一条');
  assert.ok(out2.records[0].firstLine.indexOf(' [Event] C') > 0);
  rmCaseDir();
});

test('T7 文件截断（轮转/清空）：检测并从头重新跟踪', () => {
  const dir = newCaseDir('truncate');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  writeAppend(f, ts(0) + ' [Event] OLD-1\r\n' + ts(1) + ' [Event] OLD-2\r\n');
  pollAll(t);
  fs.writeFileSync(f, ts(2) + ' [Event] NEW-1\r\n', 'utf8');   // 截断重写
  const out = pollAllEventually(t);
  assert.strictEqual(out.rotation, 'truncated');
  assert.ok(out.records.some((r) => r.firstLine.indexOf('NEW-1') > 0));
  assert.strictEqual(t.getState().rotations, 1);
  rmCaseDir();
});

test('T8 原文件被改名后新建：识别为 recreated 并读新文件', () => {
  const dir = newCaseDir('recreate');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  writeAppend(f, ts(0) + ' [Event] OLD\r\n');
  t.poll();
  const before = t.getState();
  fs.renameSync(f, path.join(dir, 'Log.txt.old'));
  fs.writeFileSync(f, ts(1) + ' [Event] FRESH\r\n', 'utf8');
  const out = pollAllEventually(t);
  assert.strictEqual(out.rotation, 'recreated');
  assert.ok(out.records.some((r) => r.firstLine.indexOf('FRESH') > 0));
  assert.ok(t.getState().offset > 0);
  assert.notStrictEqual(before.offset, -1);
  rmCaseDir();
});

test('T9 文件暂时不可读：报错但绝不崩溃、绝不创建文件', () => {
  const dir = newCaseDir('missing');
  const f = path.join(dir, 'Log.DoesNotExist.txt');
  const t = mkTailer(f, {});
  const out = pollAllEventually(t);
  assert.ok(out.error && out.error.indexOf('stat-failed') === 0);
  assert.strictEqual(fs.existsSync(f), false, '绝不能为了采集而创建日志文件');
  // 文件后来出现 -> 正常读取
  fs.writeFileSync(f, ts(0) + ' [Event] LATE\r\n', 'utf8');
  const out2 = pollAllEventually(t);
  assert.strictEqual(out2.records.length, 1);
  rmCaseDir();
});

test('T9b 游标落在行中间（崩溃/回退）：必须丢掉残行，不得产生伪记录', () => {
  const dir = newCaseDir('midline');
  const f = path.join(dir, 'Log.LastFM.txt');
  fs.writeFileSync(f, '', 'utf8');
  const lineA = ts(0) + ' [Event] Scrobble trigger: session=S, title=A, artist=A, playedMs=1000, targetMs=1000';
  const lineB = ts(1) + ' [Trace] Reset scrobble state: reason=Track, key=App|metadata|B|C|D|';
  writeAppend(f, lineA + '\r\n' + lineB + '\r\n');
  // 游标故意指向第一行中间（模拟崩溃后落盘了半行偏移 / 手工回退）
  const midOffset = 30;
  assert.notStrictEqual(fs.readFileSync(f)[midOffset - 1], 0x0A, '测试前提：该偏移确实在行中间');
  const t = new LogTailer({ path: f, offset: midOffset, idleFlushMs: HUGE_IDLE });
  const out = pollAllEventually(t);
  assert.ok(out.skippedPartialBytes > 0, '必须报告丢弃的残行字节数');
  assert.strictEqual(out.records.length, 1, '只应剩下完整的那一行');
  const obs = parser.parseRecord({ firstLine: out.records[0].firstLine, continuations: out.records[0].continuations, sourceFile: 'Log.LastFM.txt', collectorTimestampMs: 1, collectorTimestamp: 'x' });
  assert.strictEqual(obs.eventType, 'scrobble-reset', '残行绝不能被当成 unclassified 伪记录');
  assert.strictEqual(obs.sourceTimestamp, null === obs.sourceTimestamp ? null : obs.sourceTimestamp);
  assert.ok(obs.sourceTimestamp, '完整那一行必须带时间戳');
  rmCaseDir();
});

test('T10 日志停止更新：不产生伪样本，最后记录延迟发射', () => {
  const dir = newCaseDir('idle');
  const f = path.join(dir, 'Log.LastFM.txt');
  fs.writeFileSync(f, '', 'utf8');
  let fakeNow = 1000;
  const t = new LogTailer({ path: f, idleFlushMs: 50, now: () => fakeNow });
  const line = ts(0) + ' [Event] Scrobble trigger: session=AppleMusic, title=T, artist=A, playedMs=1000, targetMs=1000';
  writeAppend(f, line + '\r\n');
  const first = t.poll();          // 记录被挂起（等可能的续行）
  assert.strictEqual(first.records.length, 0);
  const idle1 = t.poll();          // 文件没有增长
  assert.strictEqual(idle1.records.length, 0);
  fakeNow += 100000;               // 超过 idleFlushMs
  const flushed = t.poll();
  assert.strictEqual(flushed.records.length, 1, '静默到期后发射末条记录');
  fakeNow += 5000;
  const again = t.poll();
  assert.strictEqual(again.records.length, 0, '没有新内容就不得产生任何样本');
  rmCaseDir();
});

test('T11 无关日志混入：类型化保留但不伪造时间轴字段', () => {
  const dir = newCaseDir('noise');
  const f = path.join(dir, 'Log.txt');
  fs.writeFileSync(f, '', 'utf8');
  const t = mkTailer(f, {});
  writeAppend(f, ts(0) + ' [Error] [electron.app.douyin] Error in OnAnyTimelinePropertyChanged Invoke\r\n');
  writeAppend(f, ts(1) + ' [Info] TaskbarHelper: Failed to hook into taskbar.\r\n');
  const out = pollAllEventually(t);
  const obs = out.records.map((r) => parser.parseRecord({ firstLine: r.firstLine, continuations: r.continuations, sourceFile: 'Log.txt', collectorTimestampMs: 1, collectorTimestamp: 'x' }));
  assert.strictEqual(obs[0].eventType, 'timeline-property-error');
  assert.strictEqual(obs[0].sessionIdentity, 'electron.app.douyin');
  assert.strictEqual(obs[0].rawPosition, null);
  assert.strictEqual(obs[0].durationMs, null);
  assert.strictEqual(obs[1].eventType, 'taskbar-helper');
  rmCaseDir();
});

test('T12 统计层：样本不足 / 重复 / 静默 / 精度占比', () => {
  const stats = new TimelineStats({ minSamples: 3, windows: [{ label: '30s', ms: 30000 }] });
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const mk = (dtMs, pos) => {
    const obs = parser.parseRecord({
      firstLine: ts(dtMs / 1000) + ' [Event] Scrobble trigger: session=S, title=T, artist=A, playedMs=' + pos + ', targetMs=1000',
      continuations: [], sourceFile: 'Log.LastFM.txt', collectorTimestampMs: base + dtMs, collectorTimestamp: 'x',
    });
    obs.collectorTimestampMs = base + dtMs;
    return obs;
  };
  stats.add(mk(0, 1000));
  stats.add(mk(1000, 2000));
  assert.strictEqual(stats.snapshot(base + 1000).run.insufficient, true, '3 个以下样本 -> insufficient');
  stats.add(mk(2000, 2000));            // 重复 position
  stats.add(mk(20000, 9000));           // 大跳变 + 长静默
  const snap = stats.snapshot(base + 20000);
  const run = snap.run;
  assert.strictEqual(run.insufficient, false);
  assert.strictEqual(run.positionSamples, 4);
  assert.strictEqual(run.repeatedPositions, 1);
  assert.strictEqual(run.forwardPositions, 2);
  assert.strictEqual(run.pauseResume.observable, false, 'pause/resume 不可观测必须显式声明');
  assert.strictEqual(run.duration.observable, false);
  assert.strictEqual(snap.longestSilenceMs, 18000);
  assert.strictEqual(run.positionPrecision.millisecond, 4);
  assert.strictEqual(run.positionPrecision.second, 0);
  const w30 = snap.windows['30s'];
  assert.strictEqual(w30.records, 4);
  assert.ok(run.jumpHistogram['>=5s'] >= 1, '大跳变应进入 >=5s 桶');
});

test('T13 统计层：秒级与毫秒级 position 分账，缺失占比如实统计', () => {
  const stats = new TimelineStats({ minSamples: 1 });
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const msObs = { eventType: 'scrobble-trigger', rawPosition: parser.positionFromScrobble(5000, 1000, 'x'), collectorTimestampMs: base, sourceTimestampMs: base };
  const secObs = { eventType: 'display-position', rawPosition: parser.positionFromSecondDisplay(47, '00:00:47'), collectorTimestampMs: base + 1000, sourceTimestampMs: base + 1000 };
  const noPosObs = { eventType: 'app-event', rawPosition: null, collectorTimestampMs: base + 2000, sourceTimestampMs: base + 2000 };
  stats.add(msObs); stats.add(secObs); stats.add(noPosObs);
  const run = stats.snapshot(base + 3000).run;
  assert.strictEqual(run.positionPrecision.millisecond, 1);
  assert.strictEqual(run.positionPrecision.second, 1);
  assert.strictEqual(run.positionUnknownShare, 1 / 3);
});

// ------------------------------------------------------------
test('D1 跨重启去重：最后一段日志被重读时不得重复计数', () => {
  const w1 = new DedupeWindow({ limit: 100 });
  assert.strictEqual(w1.add('Log.LastFM.txt:2026-10-06T17:08:10.480+08:00'), true, '首次出现 = 新记录');
  assert.strictEqual(w1.add('Log.LastFM.txt:2026-10-06T17:08:10.480+08:00'), false, '同一指纹第二次 = 重复');

  // 模拟"采集器被强杀 -> 游标回退 -> 重启后重读同一段日志"
  const persisted = w1.keys();
  const w2 = new DedupeWindow({ limit: 100, keys: persisted });
  assert.strictEqual(w2.has('Log.LastFM.txt:2026-10-06T17:08:10.480+08:00'), true);
  assert.strictEqual(w2.add('Log.LastFM.txt:2026-10-06T17:08:10.480+08:00'), false, '重启后必须仍然识别为重复');
  assert.strictEqual(w2.add('Log.Lyrics.txt:2026-10-06T17:09:40.100+08:00'), true, '新日志仍然被正常计入');

  // 有界：超出 limit 的最旧指纹被淘汰
  const w3 = new DedupeWindow({ limit: 3 });
  w3.add('a'); w3.add('b'); w3.add('c'); w3.add('d');
  assert.strictEqual(w3.size, 3);
  assert.strictEqual(w3.has('a'), false, '最旧指纹被淘汰，内存有界');
});

test('C1 Comparator：playedMs / 秒级显示值 / 无时间基准 -> 拒绝绝对偏差', () => {
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const observations = [];
  for (let i = 0; i < 6; i += 1) {
    observations.push({ eventType: 'scrobble-trigger', rawPosition: parser.positionFromScrobble(60000 + i * 1000, 60000, 'x'), collectorTimestampMs: base + i * 1000, trackIdentity: { title: 'T' } });
    observations.push({ eventType: 'display-position', rawPosition: parser.positionFromSecondDisplay(47 + i, '00:00:47'), collectorTimestampMs: base + i * 1000 + 500 });
  }
  const tspText = [
    '[TSP] SMTC=123.842 Stable=123.701 Error=+141ms rate=1.000 state=playing susp=0/3 q=1000 win=1120 conf=0.75 track="A|T|Al"',
    '[TSP] SMTC=124.281 Stable=123.910 Error=+371ms rate=1.030 state=playing susp=0/3 q=1000 win=1120 conf=0.75 track="A|T|Al"',
    '[TSP] confirmed seek -> anchor reset raw=125.021 stable=124.201 dev=+820ms',
  ].join('\n');
  const res = compareTimelines({ lyricifyObservations: observations, tspText });
  assert.strictEqual(res.feasibility.absolutePositionDeviation.comparable, false);
  const reasons = res.refusals.find((r) => r.metric === 'absolutePositionDeviation').reasons.join(' | ');
  assert.ok(/playedMs/.test(reasons), '必须说明 playedMs 语义不匹配');
  assert.ok(/秒级显示值/.test(reasons), '必须说明秒级精度不足');
  assert.ok(/绝对时间戳/.test(reasons) || /时间基准/.test(reasons), '必须说明缺少共同时间基准');
  assert.strictEqual(res.feasibility.structural.comparable, true, '结构化指标仍然可比');
  assert.ok(res.metrics.tspStructural.samples === 2);
  assert.strictEqual(res.metrics.tspStructural.monotonic, true);
  assert.strictEqual(res.metrics.tspStructural.anchorResetActions, 1);
});

test('C2 Comparator：两侧都是毫秒级 + 有绝对时间戳 -> 允许计算（并保持只读）', () => {
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const observations = [];
  for (let i = 0; i < 5; i += 1) {
    observations.push({ eventType: 'raw-position', rawPosition: { valueMs: 100000 + i * 1000, precision: 'millisecond', semantics: 'smttc-raw-position', isRawSmtcPosition: true }, collectorTimestampMs: base + i * 1000 });
  }
  const tspJsonl = [];
  for (let i = 0; i < 5; i += 1) tspJsonl.push(JSON.stringify({ t: base + i * 1000, stableMs: 100050 + i * 1000, smtcMs: 100000 + i * 1000, errorMs: 50, rate: 1, track: 'A|T' }));
  const tsp = parseTspObservations(tspJsonl.join('\n'));
  assert.strictEqual(tsp.timeBasis, 'full');
  const res = compareTimelines({ lyricifyObservations: observations, tspText: tspJsonl.join('\n') });
  assert.strictEqual(res.feasibility.absolutePositionDeviation.comparable, true);
  assert.strictEqual(res.feasibility.rateTrend.comparable, true);
  assert.ok(res.metrics.lyricifyRate.rateMsPerSec.count >= 3);
  assert.ok(Math.abs(res.metrics.lyricifyRate.rateMsPerSec.median - 1000) < 1);
  assert.strictEqual(res.metrics.tspStructural.orderViolations, 0);
});

test('C3 Comparator：TSP 侧 stable 回退必须被检出', () => {
  const base = Date.parse('2026-10-06T17:00:00.0000000+08:00');
  const tspJsonl = [
    JSON.stringify({ t: base, stableMs: 5000 }),
    JSON.stringify({ t: base + 1000, stableMs: 6000 }),
    JSON.stringify({ t: base + 2000, stableMs: 5500 }),
  ].join('\n');
  const res = compareTimelines({ lyricifyObservations: [], tspText: tspJsonl });
  assert.strictEqual(res.metrics.tspStructural.monotonic, false);
  assert.strictEqual(res.metrics.tspStructural.orderViolations, 1);
});

test('C4 观测器 CLI 参数：默认只跟新增内容（不隐式回读历史）', () => {
  const monitor = require(path.join(appRoot, 'tools', 'lyricify-fusion-timeline-monitor.js'));
  const a = monitor.parseArgs(['--once', '--json']);
  assert.strictEqual(a.once, true);
  assert.strictEqual(a.backfillBytes, undefined, '默认不得带任何历史回读');
  const b = monitor.parseArgs(['--log-dir', 'X', '--files', 'Log.txt,Log.LastFM.txt', '--backfill-bytes', '4096']);
  assert.strictEqual(b.logDir, 'X');
  assert.deepStrictEqual(b.files, ['Log.txt', 'Log.LastFM.txt']);
  assert.strictEqual(b.backfillBytes, 4096);
});

test('C5 写入保护：拒绝把采集输出写到仓库之外', () => {
  const monitor = require(path.join(appRoot, 'tools', 'lyricify-fusion-timeline-monitor.js'));
  assert.throws(() => monitor.assertInsideProject(path.join(os.homedir(), 'AppData', 'Roaming', 'Lyricify', 'x.jsonl')), /拒绝写入仓库目录之外/);
  assert.ok(monitor.assertInsideProject(path.join(appRoot, 'tools', 'out', 'x.jsonl')));
});
