'use strict';
// ============================================================
// tools/lib/dedupe-window.js
// 跨重启去重窗口：只保留最近 N 条记录指纹，可持久化到采集游标里。
// 用途：采集器被 Ctrl+C / 强杀 / 崩溃后重启时，最后一段日志可能被再次读到，
//       本窗口保证同一条日志不会被重复计入统计与输出。
// ============================================================

class DedupeWindow {
  constructor(opts) {
    const o = opts || {};
    this.limit = o.limit || 2000;
    this.set = new Set();
    this.order = [];
    if (Array.isArray(o.keys)) this.load(o.keys);
  }

  load(keys) {
    for (const k of keys) {
      if (!k || this.set.has(k)) continue;
      this.set.add(k);
      this.order.push(k);
    }
    this._trim();
    return this;
  }

  has(key) { return this.set.has(key); }

  /** @returns {boolean} true = 新记录；false = 已见过（重复） */
  add(key) {
    if (this.set.has(key)) return false;
    this.set.add(key);
    this.order.push(key);
    this._trim();
    return true;
  }

  keys() { return this.order.slice(); }
  get size() { return this.set.size; }

  _trim() {
    while (this.order.length > this.limit) {
      const old = this.order.shift();
      this.set.delete(old);
    }
  }
}

module.exports = { DedupeWindow };
