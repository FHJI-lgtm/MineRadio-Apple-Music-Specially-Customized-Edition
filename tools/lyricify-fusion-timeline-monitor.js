#!/usr/bin/env node
'use strict';
// ============================================================
// tools/lyricify-fusion-timeline-monitor.js
// Lyricify Fusion 实时观测器（只读、被动、前台、可 Ctrl+C）
//
// 用法：
//   node tools/lyricify-fusion-timeline-monitor.js                # 默认：只跟新增内容
//   node tools/lyricify-fusion-timeline-monitor.js --once --json  # 单轮采集 + JSON 快照
//   node tools/lyricify-fusion-timeline-monitor.js --backfill-bytes 65536   # 显式读取有界历史
//   node tools/lyricify-fusion-timeline-monitor.js --compare --tsp <tsp.txt|jsonl>
//
// 安全（代码级保证）：
//   * 日志文件只用 fs.openSync(path,'r') 打开，永不写/截断/改名/删除源文件。
//   * 所有输出（游标 JSON、观测 JSONL）都强制落在本仓库目录内，写入前校验。
//   * 不启动/不停止/不重启 Lyricify Fusion，也不启动 Apple Music，不修改播放状态。
//   * 不读 Settings.json / token / cookie / 歌词库等与时间轴无关的数据。
//   * 内存有界（统计 ring + dedupe 上限），输出有界（JSONL 按大小轮转）。
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { resolveLogSources, detectProcess } = require('./lib/lyricify-log-sources');
const { LogTailer } = require('./lib/log-tailer');
const { parseRecord } = require('./lib/lyricify-log-parser');
const { TimelineStats } = require('./lib/timeline-stats');
const { compareTimelines, parseTspObservations } = require('./lib/tsp-comparator');
const { DedupeWindow } = require('./lib/dedupe-window');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(__dirname, '.state', 'monitor-cursor.json');
const DEFAULT_OUT_DIR = path.join(__dirname, 'out');
const SCHEMA_VERSION = 1;

// ------------------------------------------------------------
// 参数
// ------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--help' || t === '-h') { a.help = true; continue; }
    if (t === '--once') { a.once = true; continue; }
    if (t === '--json') { a.json = true; continue; }
    if (t === '--compare') { a.compare = true; continue; }
    if (t === '--no-process-check') { a.noProcessCheck = true; continue; }
    if (t === '--verbose') { a.verbose = true; continue; }
    if (t === '--log-dir') { a.logDir = argv[++i]; continue; }
    if (t === '--files') { a.files = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); continue; }
    if (t === '--state') { a.statePath = argv[++i]; continue; }
    if (t === '--out') { a.outPath = argv[++i]; continue; }
    if (t === '--interval') { a.intervalMs = Number(argv[++i]); continue; }
    if (t === '--stats-every') { a.statsEveryMs = Number(argv[++i]); continue; }
    if (t === '--backfill-bytes') { a.backfillBytes = Number(argv[++i]); continue; }
    if (t === '--max-out-bytes') { a.maxOutBytes = Number(argv[++i]); continue; }
    if (t === '--stop-file') { a.stopFile = argv[++i]; continue; }
    if (t === '--lock-file') { a.lockFile = argv[++i]; continue; }
    if (t === '--force') { a.force = true; continue; }
    if (t === '--tsp') { a.tspPath = argv[++i]; continue; }
    if (t === '--observations') { a.observationsPath = argv[++i]; continue; }
    if (t === '--from-start') { a.fromStart = true; continue; }
    a._.push(t);
  }
  return a;
}

const HELP = [
  'Lyricify Fusion 时间轴观测器（只读，永不修改 Lyricify Fusion 任何数据）',
  '',
  '选项：',
  '  --log-dir <dir>        显式指定日志目录（默认自动探测 %APPDATA%\\Lyricify\\{Lyricify Fusion,Lyricify Lite}\\Logs）',
  '  --files a,b            只跟踪指定日志文件（默认 Log*.txt）',
  '  --once                 只跑一轮采集后退出',
  '  --json                 输出 JSON（配合 --once 便于脚本消费）',
  '  --interval <ms>        轮询间隔（默认 500）',
  '  --stats-every <ms>     实时统计刷新间隔（默认 5000）',
  '  --backfill-bytes <n>   显式读取有界历史（默认 0 = 只看新增）',
  '  --state <file>         采集游标文件（默认 tools/.state/monitor-cursor.json）',
  '  --out <file>           观测 JSONL 输出（默认 tools/out/lyricify-fusion-observations-<日期>.jsonl）',
  '  --max-out-bytes <n>    输出文件轮转阈值（默认 32MB）',
  '  --stop-file <file>     优雅停止开关：该文件出现即保存游标并退出（默认 tools/.state/monitor.stop）',
  '  --lock-file <file>     单实例锁文件（默认 tools/.state/monitor.lock）',
  '  --force                跳过单实例检查（不推荐）',
  '  --no-process-check     不做只读进程探测',
  '  --compare              只读对比模式：读取已有观测 + TSP 观测',
  '  --observations <file>  --compare 用的 Lyricify 观测 JSONL',
  '  --tsp <file>           --compare 用的 TSP 观测（[TSP] 文本或 JSONL）',
  '  -h, --help             显示帮助',
  '',
  '安全边界：只读打开日志；不启动/不停止 Lyricify Fusion；不改配置/日志等级；',
  '          采集输出只写本仓库目录；Ctrl+C 正常退出并保存游标。',
].join('\n');

// ------------------------------------------------------------
// 写入保护：只允许写本仓库目录
// ------------------------------------------------------------
function assertInsideProject(p) {
  const resolved = path.resolve(p);
  const rel = path.relative(PROJECT_ROOT, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('拒绝写入仓库目录之外的路径: ' + resolved);
  }
  return resolved;
}

function loadState(statePath) {
  try {
    const text = fs.readFileSync(statePath, 'utf8');
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && obj.sources && typeof obj.sources === 'object') return obj;
  } catch (e) { /* 首次运行或状态损坏 -> 空状态 */ }
  return { version: SCHEMA_VERSION, sources: {} };
}

function saveState(statePath, state) {
  const target = assertInsideProject(statePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// ------------------------------------------------------------
// 输出（有界、可轮转）
// ------------------------------------------------------------
class JsonlSink {
  constructor(outPath, maxBytes) {
    this.path = assertInsideProject(outPath);
    this.maxBytes = maxBytes || 32 * 1024 * 1024;
    this.written = 0;
    this.rotations = 0;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    try { this.written = fs.statSync(this.path).size; } catch (e) { this.written = 0; }
  }
  _rotateIfNeeded(nextBytes) {
    if (this.written + nextBytes <= this.maxBytes) return;
    const backup = this.path + '.1';
    try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch (e) { }
    try { fs.renameSync(this.path, backup); } catch (e) { }
    this.written = 0;
    this.rotations += 1;
  }
  write(obj) {
    const line = JSON.stringify(obj) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    this._rotateIfNeeded(bytes);
    // 瞬时占用（杀毒/备份/另一个读取者持有共享锁）不应丢数据：有界重试
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fs.appendFileSync(this.path, line, 'utf8');
        this.written += bytes;
        this.failures = this.failures || 0;
        return true;
      } catch (err) {
        lastErr = err;
        const until = Date.now() + 60 * (attempt + 1);
        while (Date.now() < until) { /* 极短退避，不阻塞采集 */ }
      }
    }
    this.failures = (this.failures || 0) + 1;
    this.lastError = String(lastErr && lastErr.message || lastErr);
    return false;
  }
  close() { /* appendFileSync 无需关闭 */ }
}

// ------------------------------------------------------------
// 实时统计展示
// ------------------------------------------------------------
function fmtMs(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + 's';
  return Math.round(v) + 'ms';
}
function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return (v * 100).toFixed(1) + '%';
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh + ':' + mm + ':' + ss;
}
function fmtWindow(w) {
  const lines = [];
  const posNote = w.positionSamples === 0
    ? 'no position samples (Lyricify Fusion 该版本不输出播放位置)'
    : (w.positionInsufficient ? '样本不足 (' + w.positionSamples + ')' : fmtNum(w.positionSamples));
  lines.push('  [' + w.label + '] records=' + fmtNum(w.records) +
    '  record-interval(med/p95)=' + fmtMs(w.recordIntervalMs.median) + '/' + fmtMs(w.recordIntervalMs.p95));
  lines.push('        position samples=' + posNote +
    '  repeated=' + (w.positionSamples > 1 ? fmtNum(w.repeatedPositions) + ' (' + fmtPct(w.repeatRate) + ')' : 'n/a') +
    '  forward=' + (w.positionSamples > 1 ? fmtNum(w.forwardPositions) : 'n/a') +
    '  backward=' + (w.positionSamples > 1 ? fmtNum(w.backwardPositions) : 'n/a'));
  if (w.positionSamples > 1) {
    const jumps = Object.keys(w.jumpHistogram).map((k) => k + '=' + w.jumpHistogram[k]).join(' ');
    lines.push('        jump histogram=' + jumps);
  }
  lines.push('        duplicate events=' + fmtNum(w.duplicateEvents) +
    '  duplicate timestamps=' + fmtNum(w.duplicateTimestamps) +
    '  track changes=' + fmtNum(w.eventTypes['scrobble-reset'] || 0) + ' reset-events');
  lines.push('        log lag(med/p95)=' + fmtMs(w.logLagMs.median) + '/' + fmtMs(w.logLagMs.p95) +
    '  collector lag(mean)=' + fmtMs(w.collectorLagMs.mean) +
    '  precision-unknown=' + fmtPct(w.positionUnknownShare));
  lines.push('        pause/resume: 不可观测 (' + w.pauseResume.reason + ')');
  return lines.join('\n');
}
function formatStats(snapshot, meta) {
  const head = [];
  head.push('');
  head.push('[Lyricify Fusion Timeline Monitor]');
  head.push('Runtime:             ' + fmtDur(snapshot.nowMs - meta.startedAtMs) + (meta.once ? ' (single pass)' : ''));
  head.push('Mode:                READ-ONLY (' + (meta.once ? 'single pass' : 'follow new content') + ')');
  head.push('Log source:          ' + (meta.directory || 'n/a') + (meta.brand ? '  [' + meta.brand + ']' : ''));
  head.push('Sources:             ' + (meta.fileNames || []).join(', '));
  head.push('Process check:       ' + meta.processSummary);
  head.push('New records:         ' + fmtNum(snapshot.totalRecords) + ' (retained ' + fmtNum(snapshot.retainedRecords) + ')');
  head.push('Track changes(est):  ' + fmtNum(snapshot.trackChanges));
  head.push('Rotations detected:  ' + fmtNum(snapshot.rotations) + '   read errors: ' + fmtNum(snapshot.errors));
  head.push('Last record age:     ' + (snapshot.lastRecordAgeMs == null ? 'no data yet' : fmtMs(snapshot.lastRecordAgeMs)));
  head.push('Longest silence:     ' + fmtMs(snapshot.longestSilenceMs));
  head.push('Duplicates skipped:  ' + fmtNum(meta.suppressedDuplicates || 0) + ' (跨重启 / 重复读取防护)');
  head.push('Output:              ' + meta.outPath + ' (' + fmtNum(meta.outBytes) + ' B, ' + meta.outRotations +
    ' rotations, write failures ' + fmtNum(meta.outWriteFailures || 0) + ')');
  head.push('State:               ' + meta.statePath);
  head.push(fmtWindow(snapshot.run));
  for (const label of Object.keys(snapshot.windows)) {
    head.push(fmtWindow(snapshot.windows[label]));
  }
  return head.join('\n');
}

// ------------------------------------------------------------
// 对比模式（只读）
// ------------------------------------------------------------
function runCompare(args) {
  const obsPath = args.observationsPath || args._[1] || null;
  const tspPath = args.tspPath || null;
  if (!tspPath) {
    console.error('[compare] 缺少 --tsp <file>（TSP 观测来源）。');
    console.error('[compare] 说明：TSP 调试日志默认关闭且只输出到渲染进程控制台，本工具不会自行开启它。');
    console.error('[compare]       获得授权后可用 smtcTspDump() 导出 [TSP] 文本，或使用 JSONL 观测（含 t/stableMs）。');
    return 2;
  }
  if (!fs.existsSync(tspPath)) { console.error('[compare] 找不到 TSP 观测文件: ' + tspPath); return 2; }
  const tspText = fs.readFileSync(tspPath, 'utf8');
  const tsp = parseTspObservations(tspText);
  let observations = [];
  if (obsPath) {
    if (!fs.existsSync(obsPath)) { console.error('[compare] 找不到 Lyricify 观测文件: ' + obsPath); return 2; }
    observations = fs.readFileSync(obsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
  }
  const result = compareTimelines({ lyricifyObservations: observations, tspText });
  const out = {
    tspFormat: tsp.timeBasis,
    tspRecords: result.metrics.tspStructural.records,
    tspSamples: result.metrics.tspStructural.samples,
    lyricifyObservations: observations.length,
    feasibility: result.feasibility,
    refusals: result.refusals,
    metrics: result.metrics,
    notes: result.notes,
    warnings: result.warnings,
  };
  if (args.json) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('');
    console.log('[Lyricify Fusion ↔ MineRadio TSP Comparator] (read-only)');
    console.log('TSP observations:      ' + out.tspRecords + ' records / ' + out.tspSamples + ' samples (time basis: ' + out.tspFormat + ')');
    console.log('Lyricify observations: ' + out.lyricifyObservations);
    console.log('lyricify position      ' + (out.metrics.lyricifyStructural.positionSamples || 0) +
      ' samples, semantics=' + JSON.stringify(out.metrics.lyricifyStructural.positionSemantics));
    console.log('');
    for (const k of Object.keys(out.feasibility)) {
      const f = out.feasibility[k];
      console.log('  ' + (f.comparable ? '[comparable]    ' : '[NOT comparable] ') + k +
        (f.reasons && f.reasons.length ? ' :: ' + f.reasons.join(' | ') : ''));
    }
    console.log('');
    console.log('  TSP stable monotonic: ' + out.metrics.tspStructural.monotonic +
      ' (order violations=' + out.metrics.tspStructural.orderViolations + ', anchor-reset actions=' + out.metrics.tspStructural.anchorResetActions + ')');
    console.log('  TSP stable interval (med/p95): ' + fmtMs(out.metrics.tspStructural.stableIntervalMs.median) + ' / ' + fmtMs(out.metrics.tspStructural.stableIntervalMs.p95));
    console.log('  Lyricify record interval (med/p95): ' + fmtMs(out.metrics.lyricifyStructural.recordIntervalMs.median) + ' / ' + fmtMs(out.metrics.lyricifyStructural.recordIntervalMs.p95));
    console.log('  Lyricify playedMs rate (ms/s): ' + JSON.stringify(out.metrics.lyricifyRate.rateMsPerSec));
    if (out.metrics.eventAlignmentMs) console.log('  event alignment (med): ' + fmtMs(out.metrics.eventAlignmentMs.median));
    for (const r of out.refusals) console.log('  refused: ' + r.metric + ' -> ' + r.reasons.join(' | '));
  }
  return 0;
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }
  if (args.compare) return runCompare(args);

  const intervalMs = Number.isFinite(args.intervalMs) && args.intervalMs > 0 ? args.intervalMs : 500;
  const statsEveryMs = Number.isFinite(args.statsEveryMs) && args.statsEveryMs > 0 ? args.statsEveryMs : 5000;
  const statePath = args.statePath || DEFAULT_STATE_PATH;
  const stopFilePath = assertInsideProject(args.stopFile || path.join(__dirname, '.state', 'monitor.stop'));
  const lockPath = assertInsideProject(args.lockFile || path.join(__dirname, '.state', 'monitor.lock'));

  // 单实例保护：避免两个采集器同时写同一份输出/游标（重复消费与写冲突）
  if (!args.force) {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (e) { held = null; }
    if (held && Number.isFinite(held.pid)) {
      let alive = false;
      try { process.kill(held.pid, 0); alive = true; } catch (e) { alive = false; }
      if (alive) {
        console.error('[monitor] 已有采集器在运行 (pid ' + held.pid + ')。');
        console.error('          如需强制并行，请加 --force（不推荐：会重复写同一输出）。');
        return 4;
      }
    }
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: Date.now(), path: __filename }, null, 2), 'utf8');
    } catch (e) { /* 锁失败不阻塞采集 */ }
    const releaseLock = () => { try { fs.unlinkSync(lockPath); } catch (e) { } };
    process.on('exit', releaseLock);
    process.on('SIGINT', releaseLock);
    process.on('SIGTERM', releaseLock);
  }
  const outPath = args.outPath || path.join(DEFAULT_OUT_DIR, 'lyricify-fusion-observations-' + new Date().toISOString().slice(0, 10) + '.jsonl');
  const backfillBytes = Number.isFinite(args.backfillBytes) && args.backfillBytes > 0 ? args.backfillBytes : 0;

  const resolved = resolveLogSources({ logDir: args.logDir, files: args.files });
  if (!resolved.ok || !resolved.files.length) {
    console.error('[monitor] 未能定位 Lyricify Fusion 日志源（未创建/未修改任何文件）。');
    for (const t of resolved.tried) console.error('  候选: ' + t.dir + '  exists=' + t.exists);
    for (const w of resolved.warnings) console.error('  说明: ' + w);
    for (const s of resolved.siblings || []) console.error('  同级目录(未使用): ' + s.dir + '  files=' + s.fileCount);
    console.error('  可用 --log-dir 显式指定。本工具不会为了找日志而修改应用。');
    return 3;
  }

  const state = loadState(statePath);
  const tailers = resolved.files.map((f) => {
    const prev = state.sources[f.path] || null;
    return new LogTailer({
      path: f.path,
      offset: prev ? prev.offset : 0,
      lineNumber: prev ? prev.lineNumber : 0,
      fileKey: prev ? prev.fileKey : null,
      startAtEnd: !prev,
      maxBackfillBytes: backfillBytes,
    });
  });

  const stats = new TimelineStats({});
  const sink = new JsonlSink(outPath, args.maxOutBytes);
  const startedAtMs = Date.now();

  // 只读进程探测（一次性）
  let processSummary = 'skipped';
  if (!args.noProcessCheck) {
    const p = detectProcess();
    processSummary = p.running === true
      ? 'Lyricify Fusion running (pid ' + p.entries.map((e) => e.pid).join(',') + ')'
      : (p.running === false ? 'not running (本工具不会启动它，只等待)' : 'unknown');
  }

  const meta = {
    startedAtMs,
    once: args.once === true,
    directory: resolved.directory,
    brand: resolved.brand,
    fileNames: resolved.files.map((f) => f.name),
    processSummary,
    outPath: sink.path,
    outBytes: sink.written,
    outRotations: sink.rotations,
    statePath: assertInsideProject(statePath),
  };

  console.log('[Lyricify Fusion Timeline Monitor] 只读启动');
  console.log('  日志目录: ' + resolved.directory + '  [' + resolved.brand + ']');
  console.log('  跟踪文件: ' + resolved.files.map((f) => f.name + '(' + f.size + 'B)').join(', '));
  console.log('  起点: ' + (backfillBytes > 0 ? ('显式回读尾部 ' + backfillBytes + ' 字节') : (tailers.some((t) => t.offset > 0) ? '继续上次游标' : '文件末尾（只跟新增内容）')));
  console.log('  输出: ' + sink.path);
  console.log('  游标: ' + meta.statePath);
  console.log('  停止: Ctrl+C 或创建文件 ' + stopFilePath);
  console.log('  锁: ' + (args.force ? 'disabled (--force)' : lockPath));
  console.log('  进程: ' + processSummary);
  if (resolved.siblings && resolved.siblings.length > 1) {
    console.log('  注意: %APPDATA%\\Lyricify 下还有其它应用的日志目录（未采集）: ' +
      resolved.siblings.filter((s) => s.dir !== resolved.directory).map((s) => s.appDirName).join(', '));
  }

  // 跨重启去重：把游标里保存的最近记录指纹装回来（避免重启后重复计入同一条日志）
  const dedupe = new DedupeWindow({ limit: 2000, keys: state.recentKeys || [] });
  console.log('  去重指纹: 从游标恢复 ' + dedupe.size + ' 条（跨重启不重复计数）');
  let suppressedDuplicates = 0;
  let lastStatsAt = Date.now();
  let stopping = false;

  function remember(key) { return dedupe.add(key); }

  function persistState() {
    for (const t of tailers) {
      const s = t.getState();
      state.sources[s.path] = {
        offset: s.offset,
        lineNumber: s.lineNumber,
        fileKey: s.fileKey,
        rotations: s.rotations,
        lastSeenMs: Date.now(),
      };
    }
    state.version = SCHEMA_VERSION;
    state.updatedAtMs = Date.now();
    state.recentKeys = dedupe.keys();               // 跨重启去重指纹（有界）
    try { saveState(statePath, state); } catch (e) { console.error('[monitor] 保存游标失败: ' + (e && e.message || e)); }
  }

  // 跨重启去重指纹必须是"内容稳定"的：绝不使用会话内的行号（重启后会变），
  // 否则重读同一段日志会被当成新记录。同一批里真正重复的相同行用序号区分，
  // 这样"重复日志"这一现象仍然会被完整计入统计。
  const batchOccurrence = new Map();

  function dedupeKeyOf(fileName, obs) {
    const base = fileName + '|' + (obs.sourceTimestamp || '') + '|' + obs.eventType + '|' +
      (obs.sessionIdentity || '') + '|' + (obs.trackIdentity ? [obs.trackIdentity.title, obs.trackIdentity.artist, obs.trackIdentity.album].join('/') : '') + '|' +
      String(obs.rawMessage || '').slice(0, 120);
    const n = (batchOccurrence.get(base) || 0) + 1;
    batchOccurrence.set(base, n);
    return base + '#' + n;
  }

  function handleRecords(fileName, rawRecords) {
    batchOccurrence.clear();
    for (const raw of rawRecords) {
      const receivedAtMs = Date.now();
      const obs = parseRecord({
        firstLine: raw.firstLine,
        continuations: raw.continuations,
        sourceFile: fileName,
        sourceLine: raw.sourceLine,
        collectorTimestamp: new Date(receivedAtMs).toISOString(),
        collectorTimestampMs: receivedAtMs,
      });
      obs.collectorLagMs = Math.max(0, receivedAtMs - receivedAtMs);
      const dedupeKey = dedupeKeyOf(fileName, obs);
      if (!remember(dedupeKey)) { suppressedDuplicates += 1; continue; }
      stats.add(obs);
      sink.write(Object.assign({ schema: SCHEMA_VERSION }, obs));
      if (args.verbose) {
        console.log('  + ' + fileName + ':' + raw.sourceLine + ' [' + obs.eventType + ']' +
          (obs.trackIdentity && obs.trackIdentity.title ? ' ' + obs.trackIdentity.title : '') +
          (obs.rawPosition ? ' position=' + obs.rawPosition.valueMs + 'ms(' + obs.rawPosition.precision + '/' + obs.rawPosition.semantics + ')' : ''));
      }
    }
  }

  function pollOnce() {
    for (let i = 0; i < tailers.length; i += 1) {
      const t = tailers[i];
      const fileName = resolved.files[i].name;
      const res = t.poll();
      if (res.error) stats.addError(res.error, Date.now(), fileName);
      if (res.rotation !== 'none') {
        stats.addRotation(fileName, res.rotation, Date.now());
        console.log('  [rotation] ' + fileName + ' -> ' + res.rotation + ' (游标已重置)');
      }
      if (res.records.length) {
        handleRecords(fileName, res.records);
        persistState();          // 立即落盘游标：把"崩溃后重复消费"限制在一轮之内
      }
    }
  }

  function stop(code) {
    if (stopping) return;
    stopping = true;
    try { pollOnce(); } catch (e) { }
    for (const t of tailers) { const d = t.drain(); if (d.records.length) handleRecords(t.path.split(path.sep).pop(), d.records); }
    persistState();
    sink.close();
    const snap = stats.snapshot(Date.now());
    meta.outBytes = sink.written;
    meta.outRotations = sink.rotations;
    meta.outWriteFailures = sink.failures || 0;
    meta.suppressedDuplicates = suppressedDuplicates;
    if (args.json) {
      console.log(JSON.stringify({ schema: SCHEMA_VERSION, meta, snapshot: snap }, null, 2));
    } else {
      console.log('\n[monitor] 停止：游标已保存，未对 Lyricify Fusion 做任何修改。');
      console.log(formatStats(snap, meta));
    }
    process.exit(code || 0);
  }

  if (args.once) { pollOnce(); stop(0); return 0; }

  process.on('SIGINT', () => { console.log('\n[monitor] Ctrl+C：正在保存游标…'); stop(0); });
  process.on('SIGTERM', () => stop(0));
  process.on('uncaughtException', (err) => {
    console.error('[monitor] 未捕获异常（不影响 Lyricify Fusion）: ' + (err && err.stack || err));
    stop(1);
  });

  const timer = setInterval(() => {
    try {
      if (fs.existsSync(stopFilePath)) {
        try { fs.unlinkSync(stopFilePath); } catch (e) { }
        console.log('\n[monitor] 检测到停止开关 ' + stopFilePath + '：优雅退出。');
        stop(0);
        return;
      }
      pollOnce();
      const now = Date.now();
      if (now - lastStatsAt >= statsEveryMs) {
        lastStatsAt = now;
        for (const t of tailers) {
          const s = t.getState();
          state.sources[s.path] = { offset: s.offset, lineNumber: s.lineNumber, fileKey: s.fileKey, rotations: s.rotations, lastSeenMs: now };
        }
        try { saveState(statePath, state); } catch (e) { }
        meta.outBytes = sink.written;
        meta.outRotations = sink.rotations;
        meta.outWriteFailures = sink.failures || 0;
        meta.suppressedDuplicates = suppressedDuplicates;
        console.log(formatStats(stats.snapshot(now), meta));
      }
    } catch (e) {
      console.error('[monitor] 轮询异常（继续运行）: ' + (e && e.message || e));
    }
  }, intervalMs);

  process.on('exit', () => { try { clearInterval(timer); } catch (e) { } });
  return 0;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number' && code !== 0) process.exit(code);
}

module.exports = { parseArgs, formatStats, JsonlSink, assertInsideProject, main };
