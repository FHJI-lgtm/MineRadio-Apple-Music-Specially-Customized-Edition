/**
 * desktop/apple-music-alpha-stealth.js
 *
 * Apple Music "stealth mode": Alpha = 1 + WS_EX_LAYERED + WS_EX_TRANSPARENT, kept alive by a
 * lightweight watchdog.
 *
 * SCOPE (deliberately narrow):
 *   the watchdog only maintains those three window properties. It is NOT a player, NOT an SMTC
 *   controller, NOT a UIA controller, NOT a lyrics/currentPlaybackContext manager and NOT a
 *   playback retry layer. It never enumerates the UIA tree, never reads SMTC and never spawns a
 *   process per tick.
 *
 * NATIVE ACCESS
 *   Node has no FFI dependency in this project, so the native calls go through the same mechanism
 *   the desktop icon layer already uses: one PowerShell child process that compiles a small C#
 *   P/Invoke class and answers JSON lines on stdout. The signatures are the ones already proven in
 *   this repository (GetWindowLongPtr / SetWindowLongPtr / SetLayeredWindowAttributes /
 *   GetLayeredWindowAttributes), plus IsWindow / GetClassNameW / IsIconic / ShowWindow /
 *   GetWindowThreadProcessId for identification only.
 *
 *   The child process is long lived (one per stealth session). Nothing here spawns a process per
 *   watchdog tick.
 */

'use strict';

const { spawn } = require('child_process');

const LOG_PREFIX = '[AlphaWatchdog]';

// --- native constants (identical to the proven experiment / icon-layer values) ---
const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TRANSPARENT = 0x00000020;
const LWA_ALPHA = 0x00000002;
const ALPHA_INVISIBLE = 1;
const ALPHA_OPAQUE = 255;

const DEFAULT_TARGET_CLASS = 'WinUIDesktopWin32WindowClass';
const DEFAULT_PROCESS_NAME = 'AppleMusic';

/**
 * The persistent native helper. One instance == one PowerShell child process.
 * All methods resolve with a plain object; failures resolve with { ok: false, error }.
 */
function createNativeBridge(options) {
  const opts = options || {};
  const powershell = opts.powershell || 'powershell.exe';
  const script = nativeHelperScript();
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  let child = null;
  let buffer = '';
  let queue = [];
  let exited = false;
  let exitInfo = null;
  const exitHandlers = [];

  function settleAll(error) {
    const pending = queue;
    queue = [];
    for (const item of pending) {
      clearTimeout(item.timer);
      item.resolve({ ok: false, error: error || 'BRIDGE_CLOSED' });
    }
  }

  function onLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = { ok: false, raw: text, error: 'BAD_JSON' }; }
    const item = queue.shift();
    if (!item) return;
    clearTimeout(item.timer);
    item.resolve(parsed);
  }

  function start() {
    if (child && !exited) return { ok: true, already: true };
    exited = false;
    exitInfo = null;
    buffer = '';
    try {
      child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, error: 'SPAWN_FAILED: ' + (e && e.message) };
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx = -1;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { log('helper stderr: ' + String(chunk).trim().slice(0, 200)); });
    child.on('error', (e) => { exited = true; exitInfo = { error: String(e && e.message) }; settleAll('BRIDGE_ERROR'); });
    child.on('exit', (code, signal) => {
      exited = true;
      child = null;
      exitInfo = { code: code, signal: signal };
      settleAll('BRIDGE_EXITED');
      for (const fn of exitHandlers) { try { fn(exitInfo); } catch (e) { /* ignore */ } }
    });
    return { ok: true };
  }

  function send(command, payload, timeoutMs) {
    if (!child || exited) {
      const started = start();
      if (!started.ok) return Promise.resolve({ ok: false, error: started.error });
    }
    const line = JSON.stringify(Object.assign({ cmd: command }, payload || {}));
    return new Promise((resolve) => {
      const item = { resolve: resolve, timer: null };
      item.timer = setTimeout(() => {
        const idx = queue.indexOf(item);
        if (idx >= 0) queue.splice(idx, 1);
        resolve({ ok: false, error: 'TIMEOUT' });
      }, timeoutMs || 5000);
      queue.push(item);
      try { child.stdin.write(line + '\n'); } catch (e) {
        clearTimeout(item.timer);
        const idx = queue.indexOf(item);
        if (idx >= 0) queue.splice(idx, 1);
        resolve({ ok: false, error: 'WRITE_FAILED' });
      }
    });
  }

  return {
    start: start,
    isRunning: () => !!(child && !exited),
    lastExit: () => exitInfo,
    onExit: (fn) => { exitHandlers.push(fn); },
    find: (target) => send('find', target || {}, 6000),
    snapshot: (hwnd) => send('snapshot', { hwnd: hwnd }, 5000),
    apply: (hwnd) => send('apply', { hwnd: hwnd }, 5000),
    check: (hwnd) => send('check', { hwnd: hwnd }, 5000),
    restore: (hwnd, original) => send('restore', Object.assign({ hwnd: hwnd }, original || {}), 5000),
    gateOn: (hwnd) => send('gateOn', { hwnd: hwnd }, 5000),
    gateOff: (hwnd) => send('gateOff', { hwnd: hwnd }, 5000),
    quit: () => {
      if (child && !exited) {
        try { child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (e) { /* ignore */ }
        setTimeout(() => { try { if (child && !exited) child.kill(); } catch (e) { /* ignore */ } }, 800);
      }
      return { ok: true };
    },
  };
}

/** The PowerShell side: compiles the C# P/Invoke class once, then serves JSON commands on stdin. */
function nativeHelperScript() {
  const Q = String.fromCharCode(34);
  const lines = [];
  const add = (s) => lines.push(s);
  add("$ErrorActionPreference = 'Stop'");
  add("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
  add("Add-Type -TypeDefinition @'");
  add("using System;");
  add("using System.Runtime.InteropServices;");
  add("using System.Text;");
  add("public static class AlphaStealthNative {");
  add("  public const int GWL_EXSTYLE = -20;");
  add("  public const long WS_EX_LAYERED = 0x00080000L;");
  add("  public const long WS_EX_TRANSPARENT = 0x00000020L;");
  add("  public const uint LWA_ALPHA = 0x00000002;");
  add("  public const int SW_MINIMIZE = 6;");
  add("  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", EntryPoint=" + Q + "GetWindowLongPtr" + Q + ", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", EntryPoint=" + Q + "SetWindowLongPtr" + Q + ", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", SetLastError=true)] public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", SetLastError=true)] public static extern bool GetLayeredWindowAttributes(IntPtr hWnd, out uint colorKey, out byte alpha, out uint flags);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ")] public static extern bool IsWindow(IntPtr hWnd);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ")] public static extern bool IsIconic(IntPtr hWnd);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ")] public static extern bool IsWindowVisible(IntPtr hWnd);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ")] public static extern IntPtr GetForegroundWindow();");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);");
  add("  [DllImport(" + Q + "user32.dll" + Q + ")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);");
  add("  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);");
  add("  public static long ExStyle(IntPtr h) { return GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64(); }");
  add("  public static string ClassName(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetClassNameW(h, sb, sb.Capacity); return sb.ToString(); }");
  add("  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString(); }");
  add("  public static int ReadAlpha(IntPtr h) {");
  add("    if ((ExStyle(h) & WS_EX_LAYERED) == 0) return -1;");
  add("    uint ck = 0; byte a = 0; uint fl = 0;");
  add("    if (!GetLayeredWindowAttributes(h, out ck, out a, out fl)) return -1;");
  add("    return (int)a;");
  add("  }");
  add("  public static bool AddStyle(IntPtr h, long bits) {");
  add("    long ex = ExStyle(h);");
  add("    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex | bits));");
  add("    return (ExStyle(h) & bits) == bits;");
  add("  }");
  add("  public static bool RemoveStyle(IntPtr h, long bits) {");
  add("    long ex = ExStyle(h);");
  add("    SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex & ~bits));");
  add("    return (ExStyle(h) & bits) == 0;");
  add("  }");
  add("  public static bool SetAlpha(IntPtr h, byte alpha) {");
  add("    if ((ExStyle(h) & WS_EX_LAYERED) == 0) { AddStyle(h, WS_EX_LAYERED); }");
  add("    return SetLayeredWindowAttributes(h, 0, alpha, LWA_ALPHA);");
  add("  }");
  add("}");
  add("'@ -Language CSharp");
  add("function Get-Targets([string]$className, [string]$processName) {");
  add("  $pids = @(Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })");
  add("  $bag = New-Object System.Collections.ArrayList");
  add("  if ($pids.Count -eq 0) { return @() }");
  add("  $cb = [AlphaStealthNative+EnumProc]{");
  add("    param([IntPtr]$h, [IntPtr]$l)");
  add("    $wpid = 0");
  add("    [void][AlphaStealthNative]::GetWindowThreadProcessId($h, [ref]$wpid)");
  add("    if ($pids -contains [int]$wpid) {");
  add("      $cls = [AlphaStealthNative]::ClassName($h)");
  add("      if ($className -eq '' -or $cls -eq $className) {");
  add("        [void]$bag.Add([ordered]@{ hwnd = [int64]$h; cls = $cls; title = [AlphaStealthNative]::Title($h); pid = [int]$wpid; iconic = [AlphaStealthNative]::IsIconic($h); visible = [AlphaStealthNative]::IsWindowVisible($h); exStyle = [int64][AlphaStealthNative]::ExStyle($h); alpha = [int][AlphaStealthNative]::ReadAlpha($h) })");
  add("      }");
  add("    }");
  add("    return $true");
  add("  }");
  add("  [void][AlphaStealthNative]::EnumWindows($cb, [IntPtr]::Zero)");
  add("  return @($bag.ToArray())");
  add("}");
  add("function Reply($obj) { $obj | ConvertTo-Json -Compress -Depth 6 | Write-Output }");
  add("Write-Output (([ordered]@{ ok = $true; ready = $true }) | ConvertTo-Json -Compress)");
  add("while ($true) {");
  add("  $line = [Console]::In.ReadLine()");
  add("  if ($null -eq $line) { break }");
  add("  $line = $line.Trim()");
  add("  if ($line -eq '') { continue }");
  add("  $msg = $null");
  add("  try { $msg = $line | ConvertFrom-Json } catch { Reply @{ ok = $false; error = 'BAD_COMMAND' }; continue }");
  add("  $cmd = [string]$msg.cmd");
  add("  try {");
  add("    if ($cmd -eq 'quit') { Reply @{ ok = $true; bye = $true }; break }");
  add("    elseif ($cmd -eq 'find') {");
  add("      $cls = [string]$msg.className; if ($cls -eq '') { $cls = 'WinUIDesktopWin32WindowClass' }");
  add("      $proc = [string]$msg.processName; if ($proc -eq '') { $proc = 'AppleMusic' }");
  add("      $targets = @(Get-Targets $cls $proc)");
  add("      $picked = $null");
  add("      # several WinUI class windows exist; only the one titled Apple Music is real");
  add("      foreach ($t in $targets) { if ($t.title -eq 'Apple Music' -and $t.visible -and -not $t.iconic) { $picked = $t; break } }");
  add("      if (-not $picked) { foreach ($t in $targets) { if ($t.title -eq 'Apple Music') { $picked = $t; break } } }");
  add("      if (-not $picked) { $mainH = (Get-Process -Name $proc -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle; foreach ($t in $targets) { if ([int64]$t.hwnd -eq [int64]$mainH) { $picked = $t; break } } }");
  add("      if (-not $picked -and $targets.Count -gt 0) { $picked = $targets[0] }");
  add("      Reply @{ ok = $true; found = [bool]($picked -ne $null); target = $picked; candidates = $targets.Count }");
  add("    }");
  add("    elseif ($cmd -eq 'snapshot' -or $cmd -eq 'check' -or $cmd -eq 'apply' -or $cmd -eq 'gateOn' -or $cmd -eq 'gateOff' -or $cmd -eq 'restore') {");
  add("      $h = [IntPtr][int64]$msg.hwnd");
  add("      if (-not [AlphaStealthNative]::IsWindow($h)) { Reply @{ ok = $false; error = 'HWND_INVALID' }; continue }");
  add("      if ($cmd -eq 'snapshot') {");
  add("        Reply @{ ok = $true; hwnd = [int64]$h; exStyle = [int64][AlphaStealthNative]::ExStyle($h); alpha = [int][AlphaStealthNative]::ReadAlpha($h); iconic = [AlphaStealthNative]::IsIconic($h); visible = [AlphaStealthNative]::IsWindowVisible($h); cls = [AlphaStealthNative]::ClassName($h); title = [AlphaStealthNative]::Title($h) }");
  add("      } elseif ($cmd -eq 'check') {");
  add("        $ex = [int64][AlphaStealthNative]::ExStyle($h)");
  add("        Reply @{ ok = $true; isWindow = $true; hwnd = [int64]$h; exStyle = $ex; layered = (($ex -band 0x00080000) -ne 0); transparent = (($ex -band 0x00000020) -ne 0); alpha = [int][AlphaStealthNative]::ReadAlpha($h); iconic = [AlphaStealthNative]::IsIconic($h); cls = [AlphaStealthNative]::ClassName($h); title = [AlphaStealthNative]::Title($h); foreground = (([int64][AlphaStealthNative]::GetForegroundWindow()) -eq [int64]$h) }");
  add("      } elseif ($cmd -eq 'apply') {");
  add("        $layeredOk = [AlphaStealthNative]::AddStyle($h, 0x00080000)");
  add("        $alphaOk = [AlphaStealthNative]::SetAlpha($h, 1)");
  add("        $transOk = [AlphaStealthNative]::AddStyle($h, 0x00000020)");
  add("        $ex = [int64][AlphaStealthNative]::ExStyle($h)");
  add("        Reply @{ ok = ($layeredOk -and $alphaOk -and $transOk); layeredOk = $layeredOk; alphaOk = $alphaOk; transparentOk = $transOk; exStyle = $ex; alpha = [int][AlphaStealthNative]::ReadAlpha($h) }");
  add("      } elseif ($cmd -eq 'gateOn') {");
  add("        $layeredOk = [AlphaStealthNative]::AddStyle($h, 0x00080000)");
  add("        $alphaOk = [AlphaStealthNative]::SetAlpha($h, 1)");
  add("        $ok = [AlphaStealthNative]::RemoveStyle($h, 0x00000020)");
  add("        Reply @{ ok = ($layeredOk -and $alphaOk -and $ok); exStyle = [int64][AlphaStealthNative]::ExStyle($h); alpha = [int][AlphaStealthNative]::ReadAlpha($h) }");
  add("      } elseif ($cmd -eq 'gateOff') {");
  add("        $layeredOk = [AlphaStealthNative]::AddStyle($h, 0x00080000)");
  add("        $alphaOk = [AlphaStealthNative]::SetAlpha($h, 1)");
  add("        $ok = [AlphaStealthNative]::AddStyle($h, 0x00000020)");
  add("        Reply @{ ok = ($layeredOk -and $alphaOk -and $ok); exStyle = [int64][AlphaStealthNative]::ExStyle($h); alpha = [int][AlphaStealthNative]::ReadAlpha($h) }");
  add("      } elseif ($cmd -eq 'restore') {");
  add("        [void][AlphaStealthNative]::SetAlpha($h, 255)");
  add("        $want = [int64]$msg.originalExStyle");
  add("        [void][AlphaStealthNative]::SetWindowLongPtr($h, [AlphaStealthNative]::GWL_EXSTYLE, [IntPtr]$want)");
  add("        $ex = [int64][AlphaStealthNative]::ExStyle($h)");
  add("        Reply @{ ok = ($ex -eq $want); exStyle = $ex; matchesOriginal = ($ex -eq $want); alpha = [int][AlphaStealthNative]::ReadAlpha($h) }");
  add("      }");
  add("    }");
  add("    else { Reply @{ ok = $false; error = 'UNKNOWN_COMMAND' } }");
  add("  } catch { Reply @{ ok = $false; error = [string]$_.Exception.Message } }");
  add("}");
  return lines.join('\n');
}

/**
 * The watchdog / stealth state machine.
 * Everything native is injected through the bridge dependency, so this is unit-testable on any OS.
 */
function createAlphaStealth(deps) {
  const d = deps || {};
  const bridge = d.bridge || createNativeBridge({ log: d.log });
  const log = typeof d.log === 'function' ? d.log : function () {};
  const debug = !!d.debug;
  const targetClass = d.targetClass || DEFAULT_TARGET_CLASS;
  const processName = d.processName || DEFAULT_PROCESS_NAME;
  const expectedTitle = d.expectedTitle || 'Apple Music';
  const intervalMs = Number.isFinite(d.intervalMs) ? d.intervalMs : 1000;
  const backoffSteps = Array.isArray(d.backoffSteps) && d.backoffSteps.length ? d.backoffSteps : [1000, 2000, 4000, 8000, 16000, 30000];
  const maxApplyFailures = Number.isFinite(d.maxApplyFailures) ? d.maxApplyFailures : 6;
  const persist = typeof d.persist === 'function' ? d.persist : null;
  const onUserInteraction = typeof d.onUserInteraction === 'function' ? d.onUserInteraction : null;
  const scheduleFn = typeof d.setTimeout === 'function' ? d.setTimeout : setTimeout;
  const clearFn = typeof d.clearTimeout === 'function' ? d.clearTimeout : clearTimeout;

  const state = {
    enabled: false,
    phase: 'off',
    hwnd: 0,
    original: null,
    temporaryInputWindowOpen: false,
    temporaryInputWindowReason: null,
    applyFailures: 0,
    lastRepair: null,
    lastError: null,
    ticks: 0,
    lastTickAt: 0,
    lastSample: null,
    baselineIconic: null,
    lastIconic: null,
    lastForeground: null,
    suppressUntil: 0,
    lastDisabledReason: '',
  };

  let timer = null;

  function logLine(line) { log(LOG_PREFIX + ' ' + line); }

  function emitStatus() {
    if (persist) { try { persist(status()); } catch (e) { /* ignore */ } }
  }

  function status() {
    const s = state.lastSample;
    const fresh = state.lastTickAt > 0 && (Date.now() - state.lastTickAt) < Math.max(3000, intervalMs * 3);
    return {
      enabled: state.enabled,
      phase: state.phase,
      active: state.phase === 'active' || state.phase === 'backoff',
      hwnd: state.hwnd,
      fresh: fresh,
      hidden: fresh && state.phase === 'active' && !!s && s.transparent === true && s.alpha === ALPHA_INVISIBLE,
      gate: state.temporaryInputWindowOpen,
      lastRepair: state.lastRepair,
      lastDisabledReason: state.lastDisabledReason,
      lastError: state.lastError,
      ticks: state.ticks,
    };
  }

  function schedule(delayMs) {
    if (timer) { clearFn(timer); timer = null; }
    if (!state.enabled) return;
    const wait = Number.isFinite(delayMs) ? Math.max(0, delayMs) : intervalMs;
    timer = scheduleFn(() => { timer = null; runTickSafely(); }, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function bind() {
    const found = await bridge.find({ className: targetClass, processName: processName });
    if (!found || !found.ok || !found.found || !found.target) {
      state.phase = 'paused';
      state.lastError = (found && found.error) || 'NO_TARGET_WINDOW';
      return { ok: false, error: state.lastError };
    }
    const hwnd = Number(found.target.hwnd) || 0;
    const snap = await bridge.snapshot(hwnd);
    if (!snap || !snap.ok) {
      state.phase = 'paused';
      state.lastError = (snap && snap.error) || 'SNAPSHOT_FAILED';
      return { ok: false, error: state.lastError };
    }
    const isNewWindow = hwnd !== state.hwnd;
    state.hwnd = hwnd;
    state.original = { exStyle: snap.exStyle, alpha: snap.alpha, iconic: !!snap.iconic };
    state.baselineIconic = snap.iconic === true;
    state.lastForeground = null;
    markOwnWindowTouch(3000);
    state.title = snap.title || '';
    if (expectedTitle && snap.title && snap.title !== expectedTitle) {
      // never stealth the wrong window (the process also owns a hidden WinUI helper window)
      state.phase = 'paused'; state.lastError = 'WRONG_WINDOW_TITLE'; state.hwnd = 0;
      logLine('paused: unexpected window title');
      return { ok: false, error: state.lastError };
    }
    if (isNewWindow) { logLine('hwnd changed: ' + hwnd); }
    logLine('resumed: new hwnd ' + hwnd);
    return { ok: true, hwnd: hwnd, snapshot: state.original };
  }

  async function applyInvisibleState() {
    if (!state.hwnd) return { ok: false, error: 'NO_HWND' };
    const res = await bridge.apply(state.hwnd);
    if (!res || !res.ok) {
      state.lastError = (res && res.error) || 'APPLY_FAILED';
      return handleRepairFailure('apply #' + (state.applyFailures + 1));
    }
    state.applyFailures = 0;
    state.phase = 'active';
    markOwnWindowTouch(3000);
    if (state.lastIconic === null) { state.lastIconic = state.baselineIconic; }
    state.lastTickAt = Date.now();   // a successful apply is fresh evidence, before the first tick
    state.lastError = null;
    // record what the apply really produced, so status()/the UI is accurate before the first tick
    state.lastSample = {
      ok: true, isWindow: true, hwnd: state.hwnd, cls: targetClass,
      exStyle: res.exStyle, alpha: res.alpha,
      layered: ((res.exStyle & WS_EX_LAYERED) !== 0),
      transparent: ((res.exStyle & WS_EX_TRANSPARENT) !== 0),
    };
    logLine('applied (hwnd ' + state.hwnd + ')');
    return { ok: true, result: res };
  }

  function handleRepairFailure(label) {
    state.applyFailures += 1;
    const wait = backoffSteps[Math.min(state.applyFailures - 1, backoffSteps.length - 1)];
    state.phase = 'backoff';
    logLine('backoff ' + wait + 'ms (' + label + ' failed)');
    if (state.applyFailures >= maxApplyFailures) {
      safeShutdown('APPLY_FAILED_PERMANENTLY').catch(() => {});
      return { ok: false, permanent: true, error: state.lastError };
    }
    schedule(wait);
    return { ok: false, retryInMs: wait, error: state.lastError };
  }

  async function safeShutdown(reason) {
    logLine('failed permanently: ' + reason);
    state.phase = 'failed';
    state.enabled = false;
    stopWatchdog();
    if (state.hwnd && state.original) {
      const res = await bridge.restore(state.hwnd, { originalExStyle: state.original.exStyle });
      logLine(res && res.ok ? 'restored (safe shutdown)' : 'restore failed during safe shutdown');
    }
    emitStatus();
    return { ok: true };
  }

  // ------------------------------------------------------------
  // "The user is using Apple Music by hand" detection.
  //   * only meaningful while the AMC gate is CLOSED: the gate is MineRadio's own (UIA/click) operation
  //   * our own window touches suppress detection for a short window, so a repair or a gate close
  //     can never be mistaken for a user action
  //   * a user action = the window is restored (was minimized) or Apple Music takes the foreground
  // ------------------------------------------------------------
  function markOwnWindowTouch(ms) {
    state.suppressUntil = Date.now() + (Number.isFinite(ms) ? ms : 2500);
  }

  function refreshBaseline(sample) {
    if (!sample) return;
    state.baselineIconic = sample.iconic === true;
    state.lastForeground = sample.foreground === true;
  }

  function userInteractionDetected(sample) {
    const iconic = sample.iconic === true;
    const foreground = sample.foreground === true;
    const prevIconic = state.lastIconic;
    const prevForeground = state.lastForeground;
    // our own operations (gate open / repair / gate close) update the trackers without firing
    const muted = state.temporaryInputWindowOpen || Date.now() < state.suppressUntil;
    state.lastIconic = iconic;
    state.lastForeground = foreground;
    if (muted) return '';
    if (prevIconic === null || prevForeground === null) return '';
    if (prevIconic === true && iconic === false) return 'window restored by user';
    if (prevForeground === false && foreground === true) return 'window activated by user';
    return '';
  }

  async function disableForUserInteraction(reason) {
    logLine('disabled: user interaction (' + reason + ')');
    state.lastDisabledReason = 'user-interaction: ' + reason;
    if (onUserInteraction) { try { onUserInteraction({ reason: reason }); } catch (e) { /* ignore */ } }
    await api.disable();
  }

  // A tick must never be able to kill the watchdog chain: whatever happens (including a throwing
  // bridge), the next tick is scheduled. This is what a real-app injection exposed: a throw before
  // schedule() used to stop the chain while status() kept reporting a stale "active".
  function runTickSafely() {
    state.lastTickAt = Date.now();
    Promise.resolve()
      .then(() => tick())
      .catch((e) => {
        state.lastError = 'TICK_ERROR: ' + String(e && e.message);
        logLine('tick error: ' + String(e && e.message));
      })
      .then(() => {
        if (state.enabled && !timer) { schedule(intervalMs); }
      });
  }

  async function tick() {
    if (!state.enabled) return { ok: true, skipped: 'disabled' };
    try {
    state.ticks += 1;
    const gate = state.temporaryInputWindowOpen;

    if (!state.hwnd) {
      const bound = await bind();
      if (!bound.ok) { schedule(intervalMs); return { ok: false, error: bound.error }; }
      const applied = await applyInvisibleState();
      schedule(applied.ok ? intervalMs : (applied.retryInMs || intervalMs));
      return { ok: applied.ok };
    }

    const check = await bridge.check(state.hwnd);
    if (!check || !check.ok) {
      state.hwnd = 0;
      state.lastSample = null;
      state.phase = 'paused';
      state.lastError = (check && check.error) || 'WINDOW_GONE';
      logLine('paused: hwnd unavailable');
      emitStatus();
      schedule(intervalMs);
      return { ok: false, error: state.lastError };
    }

    state.lastSample = check;

    // A user who brings Apple Music up by hand wants to see it: leave stealth mode.
    const interaction = userInteractionDetected(check);
    if (interaction) {
      await disableForUserInteraction(interaction);
      return { ok: false, error: 'USER_INTERACTION', reason: interaction };
    }

    if (expectedTitle && check.title && check.title !== expectedTitle) {
      state.hwnd = 0;
      state.phase = 'paused';
      logLine('paused: window title changed to ' + check.title);
      schedule(intervalMs);
      return { ok: false, error: 'TITLE_CHANGED' };
    }

    if (check.cls !== targetClass) {
      state.hwnd = 0;
      state.phase = 'paused';
      logLine('paused: window class changed');
      schedule(intervalMs);
      return { ok: false, error: 'CLASS_CHANGED' };
    }

    const missingLayered = !check.layered;
    const missingTransparent = !check.transparent;
    const wrongAlpha = check.alpha !== ALPHA_INVISIBLE;

    if (gate) {
      if (missingLayered || wrongAlpha) {
        // never bridge.apply() here: that would re-add the transparent bit and swallow the chain clicks
        const res = await bridge.gateOn(state.hwnd);
        if (res && res.ok) {
          state.applyFailures = 0;
          state.lastRepair = 'alpha-during-gate';
          state.phase = 'active';
          logLine('repaired: alpha (gate open)');
          emitStatus();
          schedule(intervalMs);
          return { ok: true };
        }
        return handleRepairFailure('alpha repair during gate');
      }
      schedule(intervalMs);
      return { ok: true, gated: true };
    }

    if (missingLayered && missingTransparent) {
      const applied = await applyInvisibleState();
      if (applied.permanent) return applied;
      state.lastRepair = applied.ok ? 'full' : state.lastRepair;
      if (applied.ok) logLine('repaired: layered+transparent (full apply)');
      schedule(applied.ok ? intervalMs : (applied.retryInMs || intervalMs));
      return { ok: applied.ok };
    }

    if (missingLayered) {
      const applied = await applyInvisibleState();
      if (applied.permanent) return applied;
      state.lastRepair = applied.ok ? 'layered' : state.lastRepair;
      if (applied.ok) logLine('repaired: layered');
      schedule(applied.ok ? intervalMs : (applied.retryInMs || intervalMs));
      return { ok: applied.ok };
    }

    if (missingTransparent) {
      const res = await bridge.gateOff(state.hwnd);
      if (res && res.ok) { state.applyFailures = 0; state.lastRepair = 'transparent'; state.phase = 'active'; logLine('repaired: transparent'); emitStatus(); schedule(intervalMs); return { ok: true }; }
      return handleRepairFailure('transparent repair');
    }

    if (wrongAlpha) {
      const applied = await applyInvisibleState();
      if (applied.ok) { state.lastRepair = 'alpha'; logLine('repaired: alpha'); emitStatus(); return { ok: true }; }
      return applied;
    }

    state.phase = 'active';
    emitStatus();
    schedule(intervalMs);
    return { ok: true, stable: true };
    } finally {
      // belt and braces: if a branch above threw after its await, the chain still continues
      if (state.enabled && !timer) { schedule(intervalMs); }
    }
  }

  function stopWatchdog() { if (timer) { clearFn(timer); timer = null; } }

  const api = {
    async enable() {
      if (state.enabled) return status();
      state.enabled = true;
      state.phase = 'starting';
      state.applyFailures = 0;
      state.hwnd = 0;
      logLine('started');
      const bound = await bind();
      if (!bound.ok) { schedule(intervalMs); emitStatus(); return status(); }
      const applied = await applyInvisibleState();
      schedule(applied.ok ? intervalMs : (applied.retryInMs || intervalMs));
      emitStatus();
      return status();
    },
    async disable() {
      state.enabled = false;
      stopWatchdog();
      state.temporaryInputWindowOpen = false;
      state.temporaryInputWindowReason = null;
      let restored = null;
      if (state.hwnd && state.original) {
        restored = await bridge.restore(state.hwnd, { originalExStyle: state.original.exStyle });
        if (restored && restored.ok) logLine('restored');
        state.baselineIconic = null;
    state.lastForeground = null;
    state.lastIconic = null;
    markOwnWindowTouch(3000);
      }
      state.hwnd = 0;
      state.original = null;
      state.lastSample = null;
      state.phase = 'off';
      logLine('stopped');
      emitStatus();
      return { ok: !!(restored && restored.ok), restored: restored, status: status() };
    },
    async stopForQuit() {
      if (state.enabled) return api.disable();
      stopWatchdog();
      return { ok: true };
    },
    async beginTemporaryInputWindow(reason) {
      if (!state.enabled) return { ok: false, error: 'STEALTH_OFF' };
      if (state.temporaryInputWindowOpen) return { ok: true, already: true };
      if (!state.hwnd) {
        const bound = await bind();
        if (!bound.ok) return { ok: false, error: bound.error };
      }
      state.temporaryInputWindowOpen = true;
      state.temporaryInputWindowReason = reason || 'input';
      const res = await bridge.gateOn(state.hwnd);
      markOwnWindowTouch(4000);
      logLine('gate opened (' + state.temporaryInputWindowReason + ') ok=' + !!(res && res.ok));
      return { ok: !!(res && res.ok), result: res };
    },
    async endTemporaryInputWindow() {
      if (!state.temporaryInputWindowOpen) return { ok: true, already: true };
      state.temporaryInputWindowOpen = false;
      state.temporaryInputWindowReason = null;
      if (!state.enabled || !state.hwnd) return { ok: true, skipped: 'stealth off' };
      state.baselineIconic = null;   // re-learn from the next tick (the chain moves the window around)
      const res = await bridge.gateOff(state.hwnd);
      markOwnWindowTouch(4000);
      // our own chain may have restored/foregrounded the window: re-baseline after the suppression window
      logLine('gate closed ok=' + !!(res && res.ok));
      return { ok: !!(res && res.ok), result: res };
    },
    status: status,
    async recoverOrphans() {
      const found = await bridge.find({ className: targetClass, processName: processName });
      if (!found || !found.ok || !found.found || !found.target) return { ok: true, found: false };
      const t = found.target;
      const stealthy = ((t.exStyle & WS_EX_LAYERED) !== 0) && ((t.exStyle & WS_EX_TRANSPARENT) !== 0) && t.alpha === ALPHA_INVISIBLE;
      if (!stealthy) return { ok: true, found: true, stealthy: false };
      logLine('orphan stealth state detected on hwnd ' + t.hwnd + ' -> safe restore');
      const res = await bridge.restore(t.hwnd, { originalExStyle: t.exStyle & ~(WS_EX_LAYERED | WS_EX_TRANSPARENT) });
      logLine('restored (orphan cleanup) ok=' + !!(res && res.ok));
      return { ok: !!(res && res.ok), found: true, stealthy: true, restore: res };
    },
    _tick: tick,
    _state: state,
  };
  return api;
}

module.exports = {
  createAlphaStealth: createAlphaStealth,
  createNativeBridge: createNativeBridge,
  nativeHelperScript: nativeHelperScript,
  constants: {
    LOG_PREFIX: LOG_PREFIX,
    GWL_EXSTYLE: GWL_EXSTYLE,
    WS_EX_LAYERED: WS_EX_LAYERED,
    WS_EX_TRANSPARENT: WS_EX_TRANSPARENT,
    LWA_ALPHA: LWA_ALPHA,
    ALPHA_INVISIBLE: ALPHA_INVISIBLE,
    ALPHA_OPAQUE: ALPHA_OPAQUE,
    DEFAULT_TARGET_CLASS: DEFAULT_TARGET_CLASS,
  },
};
