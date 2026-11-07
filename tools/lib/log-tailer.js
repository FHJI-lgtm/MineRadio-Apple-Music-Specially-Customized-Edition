'use strict';
// ============================================================
// tools/lib/log-tailer.js
// 只读增量日志跟踪器（Lyricify Fusion 日志专用）
//
// 硬约束：
//   * 只以 'r' 模式打开日志文件，永不写入/截断/改名/删除。
//   * 只读取 [offset, size) 区间；offset 由调用方持久化，重启不重复消费。
//   * 不启动、不重启、不干涉 Lyricify Fusion。
//
// 读取算法（关键，避免"半行被重复消费"）：
//   读 [offset, size) -> 找最后一个换行符
//     * 没有换行符：本次不消费任何字节（offset 不动）-> 下次连同新数据一起重读
//     * 有换行符 i：只消费 [offset, offset+i+1)（完整行），offset 前移 i+1；
//       其后的残字节留在文件里，下一轮自然重读，绝不会重复计入已完成的行。
//
// 处理能力（任务书第三阶段）：
//   持续追加 / 一次写多行 / 单行跨缓冲区 / UTF-8 多字节跨边界 / 长时间不更新 /
//   截断与轮转 / 改名后新建 / 重复消费防护 / 记录续行（异常堆栈）
// ============================================================

const fsDefault = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

const RECORD_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\s+\[/;

function fileKeyOf(stat) {
  if (!stat) return null;
  // birthtime + ino（Node 在 Windows 上也提供文件索引）足以识别"同名新文件"
  return [stat.birthtimeMs, stat.ino, stat.dev].join(':');
}

class LogTailer {
  /**
   * @param {object} opts
   * @param {string} opts.path 日志文件绝对路径（只读）
   * @param {number} [opts.offset] 起始偏移（来自持久化游标）
   * @param {boolean} [opts.startAtEnd] 无游标时：只跟新增内容（默认行为）
   * @param {string|null} [opts.fileKey] 上次记录的文件身份
   * @param {number} [opts.lineNumber] 上次记录的行号
   * @param {number} [opts.idleFlushMs] 末条记录延迟发射窗口（用于收全异常堆栈续行）
   * @param {number} [opts.maxBackfillBytes] 显式历史基线时的最大回读字节（默认 0）
   * @param {object} [opts.fs] 注入 fs（测试用）
   * @param {()=>number} [opts.now] 注入单调时钟
   */
  constructor(opts) {
    if (!opts || !opts.path) throw new Error('LogTailer: path is required');
    this.path = opts.path;
    this.fs = opts.fs || fsDefault;
    this.now = opts.now || (() => Date.now());
    this.idleFlushMs = opts.idleFlushMs != null ? opts.idleFlushMs : 800;
    this.maxBackfillBytes = opts.maxBackfillBytes != null ? opts.maxBackfillBytes : 0;

    this.offset = Number.isFinite(opts.offset) ? opts.offset : 0;
    this.lineNumber = Number.isFinite(opts.lineNumber) ? opts.lineNumber : 0;
    this.fileKey = opts.fileKey || null;
    this.startAtEnd = opts.startAtEnd === true;
    this.rotations = 0;
    this.lastError = null;
    this.lastGrowthMs = 0;
    this.pendingBytes = 0;

    this._pendingRecord = null;             // { firstLine, continuations:[], lineNumber }
    this._initialized = false;
  }

  getState() {
    return {
      path: this.path,
      offset: this.offset,
      lineNumber: this.lineNumber,
      fileKey: this.fileKey,
      rotations: this.rotations,
    };
  }

  /** 首次定位：无游标时按 startAtEnd / 有界回读 决定起点 */
  _initPosition(size) {
    if (this._initialized) return;
    this._initialized = true;
    if (this.offset > 0) return;
    if (this.maxBackfillBytes > 0) { this.offset = Math.max(0, size - this.maxBackfillBytes); return; }
    if (this.startAtEnd) { this.offset = size; return; }
    this.offset = 0;
  }

  /**
   * 读取一次增量。永不抛异常；错误写进返回值。
   * @returns {{records:Array, bytesRead:number, rotation:string, error:string|null, idle:boolean, pendingBytes:number}}
   */
  poll() {
    const out = { records: [], bytesRead: 0, rotation: 'none', error: null, idle: false, pendingBytes: 0 };
    let stat = null;
    try {
      stat = this.fs.statSync(this.path);
    } catch (err) {
      this.lastError = 'stat-failed: ' + (err && err.code ? err.code : String(err && err.message || err));
      out.error = this.lastError;
      this._flushIfIdle(out);
      return out;
    }

    const key = fileKeyOf(stat);
    if (this.fileKey && key && key !== this.fileKey) {
      this._resetPosition();
      this.fileKey = key;
      this.rotations += 1;
      out.rotation = 'recreated';
    } else if (!this.fileKey) {
      this.fileKey = key;
    }

    if (this.offset > stat.size) {
      this._resetPosition();
      this.rotations += 1;
      out.rotation = 'truncated';
    }

    this._initPosition(stat.size);
    out.pendingBytes = Math.max(0, stat.size - this.offset);

    const available = stat.size - this.offset;
    if (available <= 0) {
      out.idle = true;
      this.lastError = null;
      this._flushIfIdle(out);
      return out;
    }

    let fd = null;
    try {
      fd = this.fs.openSync(this.path, 'r');                 // 只读
      const buf = Buffer.allocUnsafe(available);
      const read = this.fs.readSync(fd, buf, 0, available, this.offset);
      out.bytesRead = read;
      if (read <= 0) { out.idle = true; this._flushIfIdle(out); return out; }

      const chunk = buf.subarray(0, read);
      const lastLf = chunk.lastIndexOf(0x0A);
      if (lastLf < 0) {
        // 没有任何完整行：不消费、不缓存（避免重复计数），等下次一起读
        out.idle = true;
        this.lastError = null;
        this._flushIfIdle(out);
        return out;
      }

      // 起点是否落在行首？若 offset 指在行中间（崩溃 / 手工回退 / 写入中断），
      // 必须先丢掉这一行的残片，否则半行会被当成一条"无时间戳记录"（实测踩到过）。
      let complete;
      if (this._offsetAtLineStart()) {
        complete = chunk.subarray(0, lastLf + 1);
      } else {
        const firstLf = chunk.indexOf(0x0A);
        if (firstLf < 0 || firstLf >= lastLf) {
          out.idle = true;
          out.skippedPartialBytes = read;      // 整块都是半行：不消费
          this.lastError = null;
          this._flushIfIdle(out);
          return out;
        }
        out.skippedPartialBytes = firstLf + 1;
        complete = chunk.subarray(firstLf + 1, lastLf + 1);
      }
      this.offset += complete.length;
      this.lastGrowthMs = this.now();
      out.pendingBytes = Math.max(0, stat.size - this.offset);

      const decoder = new StringDecoder('utf8');
      const text = decoder.write(complete);
      const lines = text.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) this._consumeLine(line, out);
      this.lastError = null;
    } catch (err) {
      this.lastError = 'read-failed: ' + String(err && err.message || err);
      out.error = this.lastError;
    } finally {
      if (fd != null) { try { this.fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }

    this._flushIfIdle(out);
    return out;
  }

  /** offset 是否正好落在行首（offset==0 或前一个字节是 LF） */
  _offsetAtLineStart() {
    if (this.offset <= 0) return true;
    let fd = null;
    try {
      fd = this.fs.openSync(this.path, 'r');
      const b = Buffer.allocUnsafe(1);
      const n = this.fs.readSync(fd, b, 0, 1, this.offset - 1);
      if (n !== 1) return true;
      return b[0] === 0x0A;
    } catch (e) {
      return true;                              // 读不到就按行首处理（不阻塞采集）
    } finally {
      if (fd != null) { try { this.fs.closeSync(fd); } catch (e) { /* ignore */ } }
    }
  }

  _resetPosition() {
    this.offset = 0;
    this.lineNumber = 0;
    this.pendingBytes = 0;
    this._pendingRecord = null;
  }

  _consumeLine(line, out) {
    if (line === '') return;
    this.lineNumber += 1;
    if (RECORD_START_RE.test(line)) {
      const prev = this._takePending();
      if (prev) out.records.push(prev);
      this._pendingRecord = { firstLine: line, continuations: [], lineNumber: this.lineNumber };
    } else if (this._pendingRecord) {
      this._pendingRecord.continuations.push(line);
    } else {
      this._pendingRecord = { firstLine: line, continuations: [], lineNumber: this.lineNumber, orphan: true };
    }
  }

  _takePending() {
    const p = this._pendingRecord;
    this._pendingRecord = null;
    if (!p) return null;
    return { firstLine: p.firstLine, continuations: p.continuations, sourceLine: p.lineNumber, orphan: p.orphan === true };
  }

  /** 文件静默超过 idleFlushMs -> 发射末条记录（保证异常堆栈续行收全） */
  _flushIfIdle(out) {
    if (!this._pendingRecord) return;
    if (!this.lastGrowthMs) return;
    if ((this.now() - this.lastGrowthMs) >= this.idleFlushMs) {
      const p = this._takePending();
      if (p) out.records.push(p);
    }
  }

  /** 强制发射末条待定记录 */
  flushPending(out) {
    const target = out || { records: [] };
    const p = this._takePending();
    if (p) target.records.push(p);
    return target;
  }

  /** 停止时：把待定记录交出来；未完成半行只报告字节数，不猜测补全 */
  drain() {
    const out = { records: [], pendingBytes: this.pendingBytes };
    this.flushPending(out);
    return out;
  }
}

module.exports = { LogTailer, fileKeyOf, RECORD_START_RE };
