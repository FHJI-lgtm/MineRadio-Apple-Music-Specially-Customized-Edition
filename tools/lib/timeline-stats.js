'use strict';
// ============================================================
// tools/lib/timeline-stats.js
// 时间轴观测统计（30s / 60s / 5min / 本次运行累计）
//
// 诚实性要求：
//   * 样本不足时返回 insufficient=true 与样本数，绝不外推、绝不填占位数字。
//   * "pause/resume" 在 Lyricify Fusion 日志里不可观测 -> observable=false，
//     并且只把"日志静默"作为另一个明确命名的指标 longSilenceMs 报告。
//   * position 相关指标只统计真正带 position 的观测；毫秒/秒级分开计数。
// ============================================================

const JUMP_BUCKETS_MS = [
  { label: '<50ms', max: 50 },
  { label: '50-150ms', max: 150 },
  { label: '150-500ms', max: 500 },
  { label: '500-1000ms', max: 1000 },
  { label: '1-2s', max: 2000 },
  { label: '2-5s', max: 5000 },
  { label: '>=5s', max: Infinity },
];

const DEFAULT_WINDOWS = [
  { label: '30s', ms: 30000 },
  { label: '60s', ms: 60000 },
  { label: '5min', ms: 300000 },
];

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function summarize(values) {
  if (!values.length) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function identityKeyOf(obs) {
  if (obs && obs.sessionIdentity) return obs.sessionIdentity;
  const t = obs && obs.trackIdentity;
  if (t) return [t.title, t.artist, t.album].join('|');
  return null;
}

class TimelineStats {
  /**
   * @param {object} [opts]
   * @param {Array<{label:string,ms:number}>} [opts.windows]
   * @param {number} [opts.maxRecords] 内存上限（超出丢弃最旧）
   * @param {number} [opts.maxWindowMs] 保留最长窗口
   * @param {number} [opts.duplicateWindowMs] "重复记录"判定窗口
   * @param {number} [opts.minSamples] 低于该样本数判定 insufficient
   */
  constructor(opts) {
    const o = opts || {};
    this.windows = o.windows || DEFAULT_WINDOWS;
    this.maxRecords = o.maxRecords || 20000;
    this.maxWindowMs = o.maxWindowMs || Math.max.apply(null, this.windows.map((w) => w.ms));
    this.duplicateWindowMs = o.duplicateWindowMs || 1500;
    this.minSamples = o.minSamples || 5;
    this.records = [];              // 有界 ring
    this.totalRecords = 0;
    this.droppedRecords = 0;
    this.trackChangeCount = 0;
    this.lastIdentityKey = null;
    this.longestSilenceMs = 0;
    this.lastRecordMs = null;
    this.firstRecordMs = null;
    this.rotationEvents = [];
    this.errors = [];
  }

  addRotation(sourceFile, kind, atMs) {
    this.rotationEvents.push({ sourceFile, kind, atMs });
    if (this.rotationEvents.length > 200) this.rotationEvents.shift();
  }

  addError(message, atMs, sourceFile) {
    this.errors.push({ message, atMs, sourceFile: sourceFile || null });
    if (this.errors.length > 200) this.errors.shift();
  }

  add(obs) {
    if (!obs) return;
    const at = Number.isFinite(obs.collectorTimestampMs) ? obs.collectorTimestampMs : Date.now();
    if (this.lastRecordMs != null) {
      const gap = at - this.lastRecordMs;
      if (gap > this.longestSilenceMs) this.longestSilenceMs = gap;
    }
    this.lastRecordMs = at;
    if (this.firstRecordMs == null) this.firstRecordMs = at;

    const key = identityKeyOf(obs);
    if (obs.eventType === 'scrobble-reset' && obs.extras && obs.extras.reason === 'Track' && key) {
      if (this.lastIdentityKey !== null && key !== this.lastIdentityKey) this.trackChangeCount += 1;
      this.lastIdentityKey = key;
    }

    this.records.push(obs);
    this.totalRecords += 1;
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
      this.droppedRecords += 1;
    }
  }

  _prune(nowMs) {
    const cutoff = nowMs - this.maxWindowMs;
    let i = 0;
    while (i < this.records.length && (this.records[i].collectorTimestampMs || 0) < cutoff) i += 1;
    if (i > 0) this.records.splice(0, i);
  }

  _computeWindow(list, label) {
    const out = {
      label,
      records: list.length,
      insufficient: list.length < this.minSamples,
      minSamples: this.minSamples,
    };

    // ---- 时间戳与延迟 ----
    const logLags = [];
    const sourceTimestamps = [];
    for (const o of list) {
      if (o.sourceTimestampMs != null && o.collectorTimestampMs != null) {
        const lag = o.collectorTimestampMs - o.sourceTimestampMs;
        if (Number.isFinite(lag)) logLags.push(lag);
      }
      if (o.sourceTimestampMs != null) sourceTimestamps.push(o.sourceTimestampMs);
    }
    out.logLagMs = summarize(logLags);
    out.collectorLagMs = summarize(list.map((o) => (Number.isFinite(o.collectorLagMs) ? o.collectorLagMs : 0)));

    const sortedTs = sourceTimestamps.slice().sort((a, b) => a - b);
    let dupTs = 0;
    for (let i = 1; i < sortedTs.length; i += 1) if (sortedTs[i] === sortedTs[i - 1]) dupTs += 1;
    out.duplicateTimestamps = dupTs;

    // ---- 记录间隔（事件节奏）----
    const recordIntervals = [];
    for (let i = 1; i < list.length; i += 1) {
      const a = list[i - 1].collectorTimestampMs;
      const b = list[i].collectorTimestampMs;
      if (Number.isFinite(a) && Number.isFinite(b)) recordIntervals.push(Math.max(0, b - a));
    }
    out.recordIntervalMs = summarize(recordIntervals);

    // ---- 重复事件（同类型 + 同身份，在 duplicateWindowMs 内）----
    let duplicates = 0;
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      const sameType = prev.eventType === cur.eventType;
      const sameIdentity = identityKeyOf(prev) === identityKeyOf(cur);
      const dt = (cur.collectorTimestampMs || 0) - (prev.collectorTimestampMs || 0);
      if (sameType && sameIdentity && dt >= 0 && dt <= this.duplicateWindowMs) duplicates += 1;
    }
    out.duplicateEvents = duplicates;

    // ---- position 维度 ----
    const positions = list.filter((o) => o.rawPosition && Number.isFinite(o.rawPosition.valueMs));
    out.positionSamples = positions.length;
    out.positionInsufficient = positions.length < 2;
    const precisionCounts = { millisecond: 0, second: 0, other: 0 };
    for (const o of positions) {
      const p = o.rawPosition.precision;
      if (p === 'millisecond') precisionCounts.millisecond += 1;
      else if (p === 'second') precisionCounts.second += 1;
      else precisionCounts.other += 1;
    }
    out.positionPrecision = precisionCounts;
    out.positionBearingRecords = positions.length;
    out.positionMissingRecords = list.length - positions.length;
    out.positionUnknownShare = list.length ? (list.length - positions.length) / list.length : null;

    const deltas = [];
    let repeated = 0, forward = 0, backward = 0;
    const jumps = {};
    for (const b of JUMP_BUCKETS_MS) jumps[b.label] = 0;
    for (let i = 1; i < positions.length; i += 1) {
      const d = positions[i].rawPosition.valueMs - positions[i - 1].rawPosition.valueMs;
      deltas.push(d);
      if (d === 0) repeated += 1;
      else if (d > 0) forward += 1;
      else backward += 1;
      const abs = Math.abs(d);
      if (abs > 0) {
        for (const bucket of JUMP_BUCKETS_MS) {
          if (abs <= bucket.max) { jumps[bucket.label] += 1; break; }
        }
      }
    }
    out.repeatedPositions = repeated;
    out.forwardPositions = forward;
    out.backwardPositions = backward;
    out.repeatRate = deltas.length ? repeated / deltas.length : null;
    out.positionDeltaMs = summarize(deltas.map((d) => Math.abs(d)));
    out.jumpHistogram = jumps;

    // position 采样间隔
    const posIntervals = [];
    for (let i = 1; i < positions.length; i += 1) {
      const a = positions[i - 1].sourceTimestampMs;
      const b = positions[i].sourceTimestampMs;
      if (a != null && b != null) posIntervals.push(Math.max(0, b - a));
    }
    out.positionIntervalMs = summarize(posIntervals);

    // ---- 事件类型分布 ----
    const byType = {};
    for (const o of list) byType[o.eventType] = (byType[o.eventType] || 0) + 1;
    out.eventTypes = byType;

    // ---- 不可观测项（明确声明，不给假数字）----
    out.pauseResume = {
      observable: false,
      count: null,
      reason: 'Lyricify Fusion 日志不记录播放状态（无 Pause/Resume/Playing 关键字，已实测）',
    };
    out.duration = {
      observable: false,
      count: null,
      reason: 'Lyricify Fusion 日志不记录 duration',
    };
    out.playbackState = {
      observable: false,
      count: null,
      reason: 'Lyricify Fusion 日志不记录 SMTC PlaybackStatus',
    };
    return out;
  }

  snapshot(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    this._prune(now);
    const result = {
      nowMs: now,
      totalRecords: this.totalRecords,
      retainedRecords: this.records.length,
      droppedRecords: this.droppedRecords,
      trackChanges: this.trackChangeCount,
      longestSilenceMs: this.longestSilenceMs,
      lastRecordAgeMs: this.lastRecordMs == null ? null : now - this.lastRecordMs,
      lastIdentityKey: this.lastIdentityKey,
      rotations: this.rotationEvents.length,
      errors: this.errors.length,
      windows: {},
      run: this._computeWindow(this.records, 'run'),
    };
    for (const w of this.windows) {
      const list = this.records.filter((o) => (o.collectorTimestampMs || 0) >= now - w.ms);
      result.windows[w.label] = this._computeWindow(list, w.label);
    }
    return result;
  }
}

module.exports = { TimelineStats, summarize, percentile, JUMP_BUCKETS_MS, identityKeyOf };
