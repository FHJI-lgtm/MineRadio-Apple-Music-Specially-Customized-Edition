'use strict';
// ============================================================
// tools/lib/lyricify-log-sources.js
// 只读日志源定位（Lyricify Fusion）
//
// 说明：产品已改名为 Lyricify Fusion，但本机实际安装的 MSIX 包仍把数据目录写成
// "Lyricify Lite"（实测）。因此这里按优先级探测两个品牌目录，并把"实际用了哪个"
// 记录下来，绝不创建目录、绝不写文件、绝不为找不到路径而修改应用。
// ============================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const KNOWN_LOG_FILES = ['Log.txt', 'Log.Lyrics.txt', 'Log.LastFM.txt'];

function roamingLyricifyRoot(env) {
  const e = env || process.env;
  const appData = e.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Lyricify');
}

/** 按品牌名优先级列出候选日志目录（只做路径拼接，不创建） */
function candidateDirs(env) {
  const root = roamingLyricifyRoot(env);
  return [
    { dir: path.join(root, 'Lyricify Fusion', 'Logs'), brand: 'fusion' },
    { dir: path.join(root, 'Lyricify Lite', 'Logs'), brand: 'lite-legacy' },
  ];
}

function listLogFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const files = [];
  for (const name of names) {
    if (!/^Log.*\.txt$/i.test(name)) continue;
    const p = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    files.push({ name, path: p, size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, ino: st.ino });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** 只读列出 %APPDATA%\Lyricify 下所有 *\Logs 目录（含其它应用，仅列出供人工确认） */
function scanSiblingLogDirs(env) {
  const root = roamingLyricifyRoot(env);
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const logsDir = path.join(root, ent.name, 'Logs');
    let st = null;
    try { st = fs.statSync(logsDir); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const files = listLogFiles(logsDir);
    out.push({
      appDirName: ent.name,
      dir: logsDir,
      fileCount: files.length,
      newestMtimeMs: files.reduce((m, f) => Math.max(m, f.mtimeMs || 0), 0),
    });
  }
  return out;
}

function filterFiles(files, wanted) {
  if (!wanted || !wanted.length) return files;
  const set = new Set(wanted);
  return files.filter((f) => set.has(f.name));
}

/**
 * 定位日志源。绝不创建/修改任何东西。
 * @param {{logDir?:string, env?:object, files?:string[]}} [opts]
 */
function resolveLogSources(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const warnings = [];
  const tried = [];

  if (o.logDir) {
    const dir = path.resolve(o.logDir);
    let ok = false;
    try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
    if (!ok) {
      return { ok: false, directory: dir, brand: 'explicit', files: [], tried, warnings: ['显式 --log-dir 不存在或不是目录（未创建）'], siblings: [] };
    }
    const files = listLogFiles(dir);
    return {
      ok: files.length > 0,
      directory: dir,
      brand: 'explicit',
      files: filterFiles(files, o.files),
      tried,
      warnings: files.length ? [] : ['目录存在但没有匹配的日志文件'],
      siblings: [],
    };
  }

  for (const cand of candidateDirs(env)) {
    let ok = false;
    try { ok = fs.statSync(cand.dir).isDirectory(); } catch (e) { ok = false; }
    tried.push({ dir: cand.dir, brand: cand.brand, exists: ok });
    if (!ok) continue;
    const files = listLogFiles(cand.dir);
    if (!files.length) continue;
    return {
      ok: true,
      directory: cand.dir,
      brand: cand.brand,
      files: filterFiles(files, o.files),
      tried,
      warnings,
      siblings: scanSiblingLogDirs(env),
    };
  }

  warnings.push('未找到 ' + candidateDirs(env).map((c) => c.dir).join(' 或 ') + '（未创建任何目录）');
  return { ok: false, directory: null, brand: null, files: [], tried, warnings, siblings: scanSiblingLogDirs(env) };
}

/** 只读进程探测（tasklist 查询，不接触进程）。失败返回 unknown，绝不重试修复。 */
function detectProcess(timeoutMs) {
  try {
    const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Lyricify*', '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      timeout: timeoutMs || 4000,
      windowsHide: true,
    });
    const text = String(res.stdout || '');
    if (!text.trim() || /No tasks are running|No tasks/i.test(text)) {
      return { running: false, entries: [] };
    }
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m) entries.push({ imageName: m[1], pid: Number(m[2]) });
    }
    return { running: entries.length > 0, entries };
  } catch (e) {
    return { running: null, entries: [], error: String(e && e.message || e) };
  }
}

module.exports = {
  KNOWN_LOG_FILES,
  candidateDirs,
  roamingLyricifyRoot,
  listLogFiles,
  scanSiblingLogDirs,
  resolveLogSources,
  detectProcess,
};
