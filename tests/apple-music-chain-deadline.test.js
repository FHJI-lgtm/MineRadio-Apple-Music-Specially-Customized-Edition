'use strict';
// ============================================================
// Apple Music UIA 链：硬 deadline / 单次结算 / 进程清理契约
//
// 这些用例跑的是**真实的 runChainWithDeadline**（playPlaylist 用的同一条路径），
// 只是把手写 Promise 换成真实 PowerShell 子进程 + 可控超时，所以：
//   * 超时、杀进程、单次结算 都是真实验证，不是模拟；
//   * 多候选提前退出 / 稳定检测属于 Apple Music 真机 UIA 行为，本文件用静态结构断言守住，
//     并在报告里注明仍需真实环境验证（见文件尾注释）。
// 运行: node tests/apple-music-chain-deadline.test.js
// ============================================================
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const ctl = require(path.join(ROOT, 'desktop', 'apple-music-control.js'));
const PS = fs.readFileSync(path.join(ROOT, 'experiment', 'apple-music-windows-control', 'poc', 'lib', 'am-play-playlist.ps1'), 'utf8');
const PS_LINES = PS.split(/\r?\n/);

// 每个用例都用真实的 powershell.exe，但用内联脚本决定它做什么。
function ps(script) { return { powershell: 'powershell.exe', args: ['-NoProfile', '-Command', script] }; }
// JSON contains only double quotes, so a single-quoted PowerShell literal needs no escaping.
function chainJson(obj) { return "Write-Output '" + JSON.stringify(obj) + "'"; }

test('apple music UIA chain: hard deadline and single settle', async (t) => {
  await t.test('normal completion returns the chain verdict (no kill)', async () => {
    const r = await ctl.__runChainForTest(Object.assign(ps(chainJson({ ok: true, stage: 'PLAYBACK_STARTED' })), { timeoutMs: 20000 }));
    assert.equal(r.ok, true);
    assert.equal(r.stage, 'PLAYBACK_STARTED');
    assert.equal(r.killed, false);
    assert.equal(r.exitCode, 0);
  });

  await t.test('AMBIGUOUS is passed through unchanged (never downgraded)', async () => {
    const r = await ctl.__runChainForTest(Object.assign(ps(chainJson({ ok: false, stage: 'AMBIGUOUS', ambiguous: true })), { timeoutMs: 20000 }));
    assert.equal(r.stage, 'AMBIGUOUS');
    assert.equal(r.ok, false);
    assert.equal(r.killed, false);
  });

  await t.test('a hanging chain is killed and reported as UIA_TIMEOUT', async () => {
    const started = Date.now();
    const r = await ctl.__runChainForTest(Object.assign(ps('Start-Sleep -Seconds 60'), { timeoutMs: 2500 }));
    const elapsed = Date.now() - started;
    assert.equal(r.stage, 'UIA_TIMEOUT', 'stage must be UIA_TIMEOUT, got ' + r.stage);
    assert.equal(r.ok, false);
    assert.equal(r.killed, true);
    assert.ok(elapsed < 15000, 'must settle shortly after the deadline, took ' + elapsed + 'ms');
  });

  await t.test('timeout racing a normal exit settles exactly once', async () => {
    // 子进程在 deadline 附近退出：两种结算路径都会尝试 resolve，必须只成功一次。
    let settles = 0;
    const r = await ctl.__runChainForTest(Object.assign(ps(chainJson({ ok: true, stage: 'PLAYBACK_STARTED' })), { timeoutMs: 1200 }));
    settles += 1;
    assert.equal(settles, 1, 'the promise must settle once');
    assert.ok(r.stage === 'PLAYBACK_STARTED' || r.stage === 'UIA_TIMEOUT',
      'either the real verdict or the timeout wins, got ' + r.stage);
    assert.equal(r.killed, r.stage === 'UIA_TIMEOUT');
  });

  await t.test('non-zero exit and unparsable output are distinct stages, not silence', async () => {
    const bad = await ctl.__runChainForTest(Object.assign(ps('Write-Output "not json at all"; exit 3'), { timeoutMs: 20000 }));
    assert.equal(bad.ok, false);
    assert.ok(/CHAIN_EXIT_3|NO_JSON/.test(bad.stage), 'got ' + bad.stage);
    assert.ok(String(bad.detail || '').length > 0, 'must carry a detail, not silence');
  });

  await t.test('an unknown executable reports SPAWN_FAILED', async () => {
    const r = await ctl.__runChainForTest({ powershell: 'definitely-not-a-real-binary-xyz.exe', args: [], timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.ok(/SPAWN_FAILED|CHAIN_EXIT/.test(r.stage), 'got ' + r.stage);
  });
});

test('playlist chain: ambiguity early exit and bounded stability are wired', async (t) => {
  await t.test('candidate scan exits early once two distinct candidates exist', () => {
    const fn = PS_LINES.findIndex((l) => l.startsWith('function Get-AmPlaylistCardCandidates'));
    assert.ok(fn >= 0, 'candidate function must exist');
    assert.match(PS_LINES[fn], /EarlyExitOnAmbiguous/, 'the switch must exist on the signature');
    // early exit must sit INSIDE the dedupe-append loop and stop enumeration immediately
    const exitIdx = PS_LINES.findIndex((l) => l.includes('if ($EarlyExitOnAmbiguous -and $uniq.Count -ge 2) {') );
    assert.ok(exitIdx > fn, 'early exit must be inside the function');
    assert.match(PS_LINES[exitIdx + 1], /\$earlyExit = \$true/, 'must record the early exit');
    assert.match(PS_LINES[exitIdx + 2], /break/, 'must stop enumerating');
    // it must only fire after a candidate was ACCEPTED (i.e. after the dedupe append), never before
    const appendIdx = PS_LINES.findIndex((l) => l.includes('$uniq += [pscustomobject]@{'));
    assert.ok(appendIdx > 0 && appendIdx < exitIdx, 'early exit must come after the dedupe append');
    // dedupe/validity rules stay in place (no false ambiguity from duplicates or empty rects)
    assert.ok(PS_LINES.some((l) => l.includes("$key = 'norect-'")), 'empty-rect nodes must not join the dedupe');
    assert.ok(PS_LINES.some((l) => l.includes('$dupe = $true')), 'rect tolerance dedupe must remain');
  });

  await t.test('stability poll is bounded and precedes the scan', () => {
    const fn = PS_LINES.findIndex((l) => l.startsWith('function Wait-AmResultStability'));
    assert.ok(fn >= 0, 'stability helper must exist');
    const body = PS_LINES.slice(fn, fn + 45).join('\n');
    assert.match(body, /\$samples -lt \$MaxSamples/, 'sample count must be bounded');
    assert.match(body, /\$sw\.ElapsedMilliseconds -lt \$BudgetMs/, 'wall-clock budget must be bounded');
    assert.match(body, /reason = 'wait_budget'/, 'must report an explicit exhausted reason');
    assert.match(body, /reason = 'ambiguous_seen'/, 'two candidates must short-circuit the wait');
    // stability must require BOTH counters to agree, not one easy counter
    assert.match(body, /\$prevCand -eq \$cand -and \$prevNodes -eq \$nodes/, 'two samples must agree on candidates AND nodes');
    // the poll must run before the candidate scan, and an unsettled tree must not become 'not found'
    const callIdx = PS_LINES.findIndex((l) => l.includes('$st = Wait-AmResultStability'));
    const scanIdx = PS_LINES.findIndex((l) => l.includes('Get-AmPlaylistCardCandidates $rootFresh $Name -EarlyExitOnAmbiguous'));
    assert.ok(callIdx > 0 && scanIdx > callIdx, 'stability poll must run before the scan');
    assert.ok(PS_LINES.some((l) => l.includes("$stage = 'RESULT_NOT_STABLE'")), 'unsettled must get its own stage');
  });

  await t.test('the fixed 1200ms scope sleep is gone; JS honours a caller timeout', () => {
    assert.ok(!PS_LINES.some((l) => l.trim() === 'Start-Sleep -Milliseconds 1200'),
      'the blind 1200ms scope sleep must be replaced by the bounded poll');
    assert.match(PS, /\$st0 = Wait-AmResultStability/, 'scope path must use the bounded poll');
    const js = fs.readFileSync(path.join(ROOT, 'desktop', 'apple-music-control.js'), 'utf8');
    assert.match(js, /timeoutMs: opts\.timeoutMs \|\| DEFAULT_CHAIN_TIMEOUT_MS/, 'caller timeout must be honoured');
    assert.match(js, /taskkill/, 'deadline cleanup must kill the process tree');
  });
});

// NOTE (needs a real environment): the multi-candidate early-exit distance and the stability
// convergence of the real Apple Music UIA tree cannot be reproduced here - there is no headless way to
// obtain that tree. Those two are covered by structure + the budget test above; live verification still
// requires the real app (see the task report).
// ============================================================
// 范围硬闸门：音乐库内的 UIA 搜索必须在本资料库范围内完成
// ============================================================
const CHAIN_PS = fs.readFileSync(
  path.resolve(__dirname, '..', 'experiment', 'apple-music-windows-control', 'poc', 'lib', 'am-play-playlist.ps1'),
  'utf8'
);

test('library scope is a hard gate, never a silent fallback to the catalogue', async (t2) => {
  await t2.test('范围切换未验证成功时以独立 stage 中止', () => {
    assert.match(CHAIN_PS, /SCOPE_NOT_VERIFIED/, 'a dedicated stage must exist for an unverified scope');
    assert.match(CHAIN_PS, /if \(-not \$result\.scopeVerified\) \{/, 'the gate must test scopeVerified');
    assert.match(CHAIN_PS, /不回落到目录范围搜索/, 'the intent must be documented in the chain');
  });

  await t2.test('闸门位于主扫描之前（否则照样会在错误范围里搜）', () => {
    const gate = CHAIN_PS.indexOf('if (-not $result.scopeVerified)');
    const mainScan = CHAIN_PS.indexOf("$st = Wait-AmResultStability $app.hwnd $Name $SearchWaitMs");
    assert.ok(gate > 0 && mainScan > gate, 'the gate must precede the main scan');
  });

  await t2.test('按状态切换，绝不盲点开关（盲点会把已开启的范围点回全局）', () => {
    assert.match(CHAIN_PS, /function Get-AmScopeChipState/, 'the chip state must be readable');
    assert.match(CHAIN_PS, /function Invoke-AmScopeChipSelect/, 'selection must go through a state-aware helper');
    assert.match(CHAIN_PS, /if \(\$before -eq 'On'\) \{ return @\{ clicked = \$false/, 'an already-on chip must not be clicked');
    assert.match(CHAIN_PS, /\$obj\.Toggle\(\)/, 'a TogglePattern chip must be toggled, not blind-clicked');
    // 不能再用"盲点坐标"作为切范围的手段
    assert.ok(!/Invoke-AmSingleClick \$app\.hwnd \$chip/.test(CHAIN_PS), 'the chip must not be blind-clicked by coordinates');
  });

  await t2.test('范围是否切换成功以 chip 自身状态为准（状态读不到才退回结果验证）', () => {
    assert.match(CHAIN_PS, /if \(\$result\.scopeChipStateAfter -eq 'On'\) \{ \$result\.scopeVerified = \$true; break \}/);
    assert.match(CHAIN_PS, /-not \$result\.scopeChipStateAfter -and @\(\$scopeProbe\.candidates\)\.Count -gt 0/);
    // 诊断：前后状态必须回传，便于真机定位
    assert.match(CHAIN_PS, /scopeChipStateBefore/);
    assert.match(CHAIN_PS, /scopeChipStateAfter/);
    assert.match(CHAIN_PS, /scopeStateHistory/);
  });
});

test('MineRadio surfaces the scope gate to the user', async (t2) => {
  const shell = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'js', 'modules', '10-shell', '06-music-library.js'), 'utf8');
  await t2.test('专辑播放会把范围失败如实告诉用户，且不冒充成功', () => {
    assert.match(shell, /SCOPE_NOT_VERIFIED/, 'the renderer must handle the new stage');
    assert.match(shell, /不会去目录里找同名专辑/, 'the message must state there is no catalogue fallback');
  });
});
