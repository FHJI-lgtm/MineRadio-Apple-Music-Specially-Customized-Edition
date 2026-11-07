'use strict';
// ============================================================
// tools/lib/tsp-comparator.js
// Lyricify Fusion 观测 vs MineRadio TSP Plus 观测 —— 只读对比
//
// 铁律（任务书第六阶段）：
//   * 只读既有观测数据；本模块不做任何写入，也不触发 TSP/播放状态变化。
//   * 不把 Lyricify 的日志 position 当作绝对真值。
//   * 精度/时间基准不足时，明确拒绝绝对偏差类指标，只给可可靠比较的指标。
//
// 输入（两者都来自"已经产生的数据"，本模块不负责开启任何日志）：
//   A. Lyricify 观测：由 tools/lib/lyricify-log-parser.js 产出的观测对象数组（JSONL 亦可）。
//   B. TSP 观测：两种格式都能吃
//        1) JSONL：{"t":<epochMs>,"stableMs":..,"smtcMs":..,"errorMs":..,"rate":..,"action":"..","track":".."}
//        2) 现有 [TSP] 调试文本行（smtcTspDump() / DevTools 控制台导出），例如
//           [TSP] SMTC=123.842 Stable=123.701 Error=+141ms rate=1.000 state=playing ... track="A|B|C"
//           行首可带 ISO 时间戳；没有时间戳时 timeBasis='none'，只做结构性对比。
// ============================================================

const TSP_SAMPLE_RE = /SMTC=(-?[\d.]+)\s+Stable=(-?[\d.]+)\s+Error=([+-]?\d+)ms\s+rate=([\d.]+)\s+state=(\w+)/;
const TSP_EXTRA_RE = /susp=(\d+)\/(\d+)\s+q=(-?\d+)\s+win=(-?\d+)\s+conf=([\d.]+)/;
const TSP_TRACK_RE = /track="([^"]*)"/;
const TSP_ANYWHERE_RE = /\[TSP\]\s*([\s\S]*)$/;
const LEADING_TS_RE = /^(?:\[(\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2}))\]|(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})))\s*/;
const LEADING_EPOCH_RE = /^\[(\d{13})\]\s*/;

function parseTspText(text) {
  const records = [];
  const warnings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw || raw.indexOf('[TSP]') < 0) continue;
    let line = raw.trim();
    let tMs = null;
    const em = LEADING_EPOCH_RE.exec(line);
    if (em) { tMs = Number(em[1]); line = line.slice(em[0].length); }
    else {
      const tm = LEADING_TS_RE.exec(line);
      if (tm) {
        const iso = tm[1] || tm[2];
        const parsed = Date.parse(iso.replace(' ', 'T'));
        if (Number.isFinite(parsed)) tMs = parsed;
        line = line.slice(tm[0].length);
      }
    }
    const body = (TSP_ANYWHERE_RE.exec(line) || [null, line])[1] || line;

    const sm = TSP_SAMPLE_RE.exec(body);
    if (sm) {
      const ex = TSP_EXTRA_RE.exec(body);
      const tr = TSP_TRACK_RE.exec(body);
      records.push({
        kind: 'sample',
        t: tMs,
        smtcMs: Number(sm[1]) * 1000,
        stableMs: Number(sm[2]) * 1000,
        errorMs: Number(sm[3]),
        rate: Number(sm[4]),
        phase: sm[5],
        suspicious: ex ? Number(ex[1]) : null,
        suspiciousNeeded: ex ? Number(ex[2]) : null,
        quantumMs: ex ? Number(ex[3]) : null,
        windowMs: ex ? Number(ex[4]) : null,
        confidence: ex ? Number(ex[5]) : null,
        track: tr ? tr[1] : null,
        raw: raw,
      });
      continue;
    }
    records.push({ kind: 'action', t: tMs, action: body, raw: raw });
  }
  if (!records.length) warnings.push('未在输入中找到 [TSP] 记录');
  const withTime = records.filter((r) => Number.isFinite(r.t)).length;
  return {
    records,
    warnings,
    samples: records.filter((r) => r.kind === 'sample'),
    timeBasis: withTime > 0 ? (withTime === records.length ? 'full' : 'partial') : 'none',
  };
}

function parseTspJsonl(text) {
  const records = [];
  const warnings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch (e) { warnings.push('第 ' + (i + 1) + ' 行不是 JSON，已跳过'); continue; }
    if (!obj || typeof obj !== 'object') continue;
    records.push({
      kind: obj.stableMs != null ? 'sample' : 'action',
      t: Number.isFinite(obj.t) ? obj.t : (Number.isFinite(obj.timeMs) ? obj.timeMs : null),
      smtcMs: Number.isFinite(obj.smtcMs) ? obj.smtcMs : null,
      stableMs: Number.isFinite(obj.stableMs) ? obj.stableMs : null,
      errorMs: Number.isFinite(obj.errorMs) ? obj.errorMs : null,
      rate: Number.isFinite(obj.rate) ? obj.rate : null,
      phase: obj.phase || null,
      anchorResets: Number.isFinite(obj.anchorResets) ? obj.anchorResets : null,
      action: obj.action || null,
      track: obj.track || null,
      raw: line,
    });
  }
  const samples = records.filter((r) => r.kind === 'sample' && Number.isFinite(r.stableMs));
  const withTime = samples.filter((r) => Number.isFinite(r.t)).length;
  return {
    records,
    samples,
    warnings,
    timeBasis: samples.length === 0 ? 'none' : (withTime === samples.length ? 'full' : (withTime > 0 ? 'partial' : 'none')),
  };
}

/** 自动识别 JSONL 还是 [TSP] 文本 */
function parseTspObservations(text) {
  const s = String(text || '');
  if (/\{[\s\S]*"stableMs"\s*:/.test(s)) return parseTspJsonl(s);
  return parseTspText(s);
}

function summarizeNumbers(values) {
  if (!values.length) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { count: sorted.length, mean: sum / sorted.length, median: pct(50), p95: pct(95), min: sorted[0], max: sorted[sorted.length - 1] };
}

/** 从时间序列求变化率（ms/s），并给出静止段（变化率为 0）占比 */
function rateProfile(samples, valueOf, timeOf) {
  const rates = [];
  const stalls = [];
  for (let i = 1; i < samples.length; i += 1) {
    const dt = timeOf(samples[i]) - timeOf(samples[i - 1]);
    const dv = valueOf(samples[i]) - valueOf(samples[i - 1]);
    if (!Number.isFinite(dt) || !Number.isFinite(dv) || dt <= 0) continue;
    const rate = dv / (dt / 1000);
    rates.push(rate);
    if (Math.abs(dv) < 1) stalls.push(dt);
  }
  return { rateMsPerSec: summarizeNumbers(rates), stallCount: stalls.length, stallDurationsMs: summarizeNumbers(stalls) };
}

/**
 * 只读对比。返回 feasibility（能不能比）+ metrics（能比的部分）+ refusals（拒绝原因）。
 * @param {{lyricifyObservations:Array, tspText?:string, minSamples?:number, alignToleranceMs?:number}} input
 */
function compareTimelines(input) {
  const o = input || {};
  const lyricify = Array.isArray(o.lyricifyObservations) ? o.lyricifyObservations : [];
  const minSamples = o.minSamples || 3;
  const alignToleranceMs = o.alignToleranceMs || 400;

  const tsp = o.tspText ? parseTspObservations(o.tspText) : { records: [], samples: [], warnings: ['未提供 TSP 观测数据'], timeBasis: 'none' };

  // ---------- Lyricify 侧画像 ----------
  const lyPos = lyricify.filter((x) => x && x.rawPosition && Number.isFinite(x.rawPosition.valueMs));
  const lyPrecisions = Array.from(new Set(lyPos.map((x) => x.rawPosition.precision)));
  const lySemantics = Array.from(new Set(lyPos.map((x) => x.rawPosition.semantics)));
  const lyHasAbsoluteTime = lyricify.length > 0 && lyricify.every((x) => Number.isFinite(x.collectorTimestampMs));
  const lySamples = lyPos.filter((x) => Number.isFinite(x.collectorTimestampMs));
  const lyProfile = rateProfile(lySamples, (x) => x.rawPosition.valueMs, (x) => x.collectorTimestampMs);

  // ---------- TSP 侧画像 ----------
  const tspSamples = (tsp.samples || []).filter((x) => Number.isFinite(x.stableMs));
  const tspHasAbsoluteTime = tsp.timeBasis === 'full';
  const tspTrackChanges = [];
  let lastTrack = null;
  for (const s of tsp.samples || []) {
    if (s.track && s.track !== lastTrack) { tspTrackChanges.push({ t: s.t, track: s.track }); lastTrack = s.track; }
  }
  const tspAnchorResetActions = (tsp.records || []).filter((r) => r.kind === 'action' && /anchor reset/i.test(r.action || ''));
  const tspOrderViolations = [];
  for (let i = 1; i < tspSamples.length; i += 1) {
    if (tspSamples[i].stableMs < tspSamples[i - 1].stableMs - 0.001) tspOrderViolations.push({ index: i, delta: tspSamples[i].stableMs - tspSamples[i - 1].stableMs });
  }
  const tspProfile = tspHasAbsoluteTime
    ? rateProfile(tspSamples, (x) => x.stableMs, (x) => x.t)
    : { rateMsPerSec: summarizeNumbers([]), stallCount: null, stallDurationsMs: summarizeNumbers([]) };

  // ---------- 可比性判定 ----------
  const refusals = [];
  const feasible = {};

  // 1) 绝对偏差：需要两侧都是"同一语义的播放位置"，且都有共同时间基准
  const sameSemantics = lySemantics.length === 1 && lySemantics[0] === 'smttc-raw-position';
  const absReasons = [];
  if (!lyPos.length) absReasons.push('Lyricify 侧没有 position 观测（实测该版本日志不输出播放位置）');
  if (lySemantics.indexOf('scrobbler-accumulated-played-ms') >= 0) {
    absReasons.push('Lyricify 侧仅有 playedMs，其语义是 scrobbler 累计播放时长，不是 SMTC 原始 position');
  }
  if (lySemantics.indexOf('player-display-position') >= 0 && lyPrecisions.indexOf('second') >= 0) {
    absReasons.push('Lyricify 侧只有秒级显示值，量化误差 ±1000ms，禁止当作原始精度');
  }
  if (!tspSamples.length) absReasons.push('TSP 侧没有 stable 观测');
  if (!lyHasAbsoluteTime) absReasons.push('Lyricify 侧缺少绝对时间基准');
  if (!tspHasAbsoluteTime) absReasons.push('TSP 侧观测没有绝对时间戳（[TSP] 文本行默认无时间），无法做时间对齐');
  feasible.absolutePositionDeviation = { comparable: absReasons.length === 0, reasons: absReasons };
  if (absReasons.length) refusals.push({ metric: 'absolutePositionDeviation', reasons: absReasons.slice() });

  // 2) 变化率（趋势）：只要两侧各自有时间序列就能各自求率，再定性对比
  const rateReasons = [];
  if (lySamples.length < minSamples) rateReasons.push('Lyricify 侧 position 样本不足（' + lySamples.length + ' < ' + minSamples + '）');
  if (!tspHasAbsoluteTime) rateReasons.push('TSP 侧无绝对时间戳，无法求 d(stable)/dt');
  feasible.rateTrend = { comparable: rateReasons.length === 0, reasons: rateReasons };
  if (rateReasons.length) refusals.push({ metric: 'rateTrend', reasons: rateReasons.slice() });

  // 3) 结构指标：重复率、记录节奏、事件类型分布 —— 不需要共同时间基准
  feasible.structural = { comparable: lyricify.length > 0 || tspSamples.length > 0, reasons: [] };

  // 4) 事件时序：Lyricify 的 track 事件 vs TSP 的 track 变化/anchor 重建
  const eventReasons = [];
  const lyTrackEvents = lyricify.filter((x) => x.eventType === 'scrobble-reset' && x.extras && x.extras.reason === 'Track');
  if (!lyTrackEvents.length) eventReasons.push('Lyricify 侧没有 track 事件');
  if (!tspTrackChanges.length) eventReasons.push('TSP 侧观测里没有 track 身份变化（需要带 track 字段的观测）');
  feasible.eventTiming = { comparable: eventReasons.length === 0, reasons: eventReasons };
  if (eventReasons.length) refusals.push({ metric: 'eventTiming', reasons: eventReasons.slice() });

  // ---------- 可比指标计算 ----------
  const metrics = {};

  metrics.lyricifyStructural = {
    observations: lyricify.length,
    positionSamples: lyPos.length,
    positionPrecisions: lyPrecisions,
    positionSemantics: lySemantics,
    eventTypes: countBy(lyricify, (x) => x.eventType),
    recordIntervalMs: summarizeNumbers(intervalsOf(lyricify.map((x) => x.collectorTimestampMs))),
  };
  metrics.tspStructural = {
    records: (tsp.records || []).length,
    samples: tspSamples.length,
    timeBasis: tsp.timeBasis,
    actions: countBy((tsp.records || []).filter((r) => r.kind === 'action'), (r) => String(r.action || '').slice(0, 40)),
    anchorResetActions: tspAnchorResetActions.length,
    monotonic: tspOrderViolations.length === 0,
    orderViolations: tspOrderViolations.length,
    stableIntervalMs: summarizeNumbers(intervalsOf(tspSamples.map((x) => x.t))),
  };
  metrics.lyricifyRate = lyProfile;
  metrics.tspRate = tspProfile;

  if (feasible.eventTiming.comparable && tspHasAbsoluteTime && lyHasAbsoluteTime) {
    const deltas = [];
    for (const ev of lyTrackEvents) {
      let best = null;
      for (const tc of tspTrackChanges) {
        if (!Number.isFinite(tc.t)) continue;
        const d = Math.abs(tc.t - ev.collectorTimestampMs);
        if (best == null || d < best) best = d;
      }
      if (best != null && best <= alignToleranceMs * 5) deltas.push(best);
    }
    metrics.eventAlignmentMs = summarizeNumbers(deltas);
  }

  return {
    ok: true,
    generatedAtMs: Date.now(),
    feasibility: feasible,
    refusals,
    metrics,
    notes: [
      'Lyricify 侧 position 语义：' + (lySemantics.length ? lySemantics.join(', ') : '无'),
      'TSP 侧时间基准：' + tsp.timeBasis,
      '绝对偏差只有在两侧语义一致且都有绝对时间戳时才计算；否则仅比较结构/趋势/事件时序。',
    ],
    warnings: [].concat(tsp.warnings || []),
  };
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) { const k = fn(x); out[k] = (out[k] || 0) + 1; }
  return out;
}
function intervalsOf(times) {
  const out = [];
  for (let i = 1; i < times.length; i += 1) {
    const a = times[i - 1], b = times[i];
    if (Number.isFinite(a) && Number.isFinite(b)) out.push(Math.max(0, b - a));
  }
  return out;
}

module.exports = { parseTspText, parseTspJsonl, parseTspObservations, compareTimelines, rateProfile, summarizeNumbers };
