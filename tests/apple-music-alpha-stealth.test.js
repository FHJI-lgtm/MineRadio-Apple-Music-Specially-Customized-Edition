'use strict';
/**
 * tests/apple-music-alpha-stealth.test.js
 *
 * Module-level state tests for the Apple Music stealth watchdog. The native bridge is faked, so
 * these run on any OS and assert the state machine only: apply / repair / gate / pause / rebind /
 * backoff / safe shutdown. No real window and no PowerShell is involved.
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../desktop/apple-music-alpha-stealth.js');
const { createAlphaStealth, constants } = mod;

const LAYERED = constants.WS_EX_LAYERED;
const TRANSPARENT = constants.WS_EX_TRANSPARENT;

function fakeScheduler() {
  let seq = 0;
  const jobs = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; jobs.set(id, { fn: fn, ms: ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    pending() { return jobs.size; },
    delays() { return Array.from(jobs.values()).map((j) => j.ms); },
    async runNext() {
      const first = jobs.entries().next();
      if (first.done) return false;
      const id = first.value[0];
      const job = first.value[1];
      jobs.delete(id);
      await job.fn();
      return true;
    },
  };
}

function fakeWindow(overrides) {
  const w = Object.assign({
    hwnd: 1001,
    exStyle: 0x00000100,
    alpha: -1,
    iconic: true,
    cls: constants.DEFAULT_TARGET_CLASS,
    present: true,
  }, overrides || {});
  return w;
}

function fakeBridge(w) {
  const calls = [];
  const bridge = {
    state: w,
    calls: calls,
    failApplyTimes: 0,
    find: async () => {
      if (!w.present) return { ok: true, found: false, target: null };
      return { ok: true, found: true, target: { hwnd: w.hwnd, cls: w.cls, iconic: w.iconic, visible: true, exStyle: w.exStyle, alpha: w.alpha } };
    },
    snapshot: async () => ({ ok: true, hwnd: w.hwnd, exStyle: w.exStyle, alpha: w.alpha, iconic: w.iconic, cls: w.cls }),
    apply: async () => {
      calls.push('apply');
      if (bridge.failApplyTimes > 0) { bridge.failApplyTimes -= 1; return { ok: false, error: 'APPLY_INJECTED_FAILURE' }; }
      w.exStyle = w.exStyle | LAYERED | TRANSPARENT;
      w.alpha = 1;
      return { ok: true, exStyle: w.exStyle, alpha: w.alpha };
    },
    check: async () => {
      calls.push('check');
      if (!w.present) return { ok: false, error: 'HWND_INVALID' };
      return {
        ok: true, isWindow: true, hwnd: w.hwnd, cls: w.cls, iconic: w.iconic, exStyle: w.exStyle,
        layered: (w.exStyle & LAYERED) !== 0, transparent: (w.exStyle & TRANSPARENT) !== 0, alpha: w.alpha,
      };
    },
    gateOn: async () => { calls.push('gateOn'); w.exStyle = (w.exStyle | LAYERED) & ~TRANSPARENT; w.alpha = 1; return { ok: true, exStyle: w.exStyle, alpha: w.alpha }; },
    gateOff: async () => { calls.push('gateOff'); w.exStyle = w.exStyle | LAYERED | TRANSPARENT; w.alpha = 1; return { ok: true, exStyle: w.exStyle, alpha: w.alpha }; },
    restore: async (_hwnd, original) => { calls.push('restore'); w.exStyle = original.originalExStyle; w.alpha = (w.exStyle & LAYERED) ? 255 : -1; return { ok: true, exStyle: w.exStyle, matchesOriginal: true, alpha: w.alpha }; },
    quit: () => ({ ok: true }),
  };
  return bridge;
}

function makeStealth(extra) {
  const w = fakeWindow(extra && extra.window);
  const bridge = fakeBridge(w);
  const sched = fakeScheduler();
  const logs = [];
  const stealth = createAlphaStealth(Object.assign({
    bridge: bridge,
    intervalMs: 1000,
    setTimeout: sched.setTimeout,
    clearTimeout: sched.clearTimeout,
    log: (line) => logs.push(line),
  }, (extra && extra.opts) || {}));
  return { w: w, bridge: bridge, sched: sched, logs: logs, stealth: stealth };
}

test('1. enable applies LAYERED + Alpha=1 + TRANSPARENT', async () => {
  const t = makeStealth();
  const st = await t.stealth.enable();
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.phase, 'active');
  assert.strictEqual(t.w.alpha, 1);
  assert.ok((t.w.exStyle & LAYERED) !== 0, 'layered set');
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0, 'transparent set');
  assert.strictEqual(st.hidden, true, 'status reports hidden');
  assert.strictEqual(t.sched.pending(), 1, 'watchdog scheduled');
});

test('2. the original window state is snapshotted before applying', async () => {
  const t = makeStealth({ window: { exStyle: 0x00040000, alpha: 200 } });
  await t.stealth.enable();
  assert.strictEqual(t.stealth._state.original.exStyle, 0x00040000);
  assert.strictEqual(t.stealth._state.original.iconic, true);
});

test('3. disable restores the original exStyle and clears stealth', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  const res = await t.stealth.disable();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(t.w.exStyle, 0x00000100, 'exStyle back to the original value');
  assert.strictEqual((t.w.exStyle & LAYERED), 0);
  assert.strictEqual((t.w.exStyle & TRANSPARENT), 0);
  assert.strictEqual(t.stealth.status().phase, 'off');
  assert.strictEqual(t.stealth.status().enabled, false);
  assert.ok(t.bridge.calls.indexOf('restore') >= 0);
});

test('4. alpha forced back to 255 is repaired by the next tick', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.w.alpha = 255;
  await t.stealth._tick();
  assert.strictEqual(t.w.alpha, 1, 'alpha repaired');
  assert.strictEqual(t.stealth.status().lastRepair, 'alpha');
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0, 'transparent untouched');
});

test('5. a cleared WS_EX_TRANSPARENT is repaired by the next tick', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.w.exStyle = t.w.exStyle & ~TRANSPARENT;
  await t.stealth._tick();
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0, 'transparent repaired');
  assert.strictEqual(t.stealth.status().lastRepair, 'transparent');
});

test('6. a cleared WS_EX_LAYERED is repaired (Layered + alpha) by the next tick', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.w.exStyle = t.w.exStyle & ~(LAYERED | TRANSPARENT);
  t.w.alpha = -1;
  await t.stealth._tick();
  assert.ok((t.w.exStyle & LAYERED) !== 0, 'layered repaired');
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0, 'transparent repaired');
  assert.strictEqual(t.w.alpha, 1, 'alpha repaired');
});

test('7. a vanished HWND pauses the watchdog and keeps waiting', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.w.present = false;
  await t.stealth._tick();
  const st = t.stealth.status();
  assert.strictEqual(st.phase, 'paused');
  assert.strictEqual(st.hwnd, 0);
  assert.strictEqual(st.enabled, true, 'still enabled: it waits for Apple Music to come back');
  assert.strictEqual(t.sched.pending(), 1, 'keeps polling');
});

test('8. a new HWND is rebound with its OWN snapshot', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.w.present = false;
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().phase, 'paused');
  // a new window appears with a different original exStyle
  t.w.present = true;
  t.w.hwnd = 2002;
  t.w.exStyle = 0x00090000;
  t.w.alpha = 255;
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().hwnd, 2002);
  assert.strictEqual(t.stealth._state.original.exStyle, 0x00090000, 'snapshot taken from the new window');
  assert.strictEqual(t.w.alpha, 1);
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0);
});

test('9. while the AMC gate is open the watchdog does NOT re-add TRANSPARENT', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  const opened = await t.stealth.beginTemporaryInputWindow('amc-play');
  assert.strictEqual(opened.ok, true);
  assert.strictEqual((t.w.exStyle & TRANSPARENT), 0, 'transparent removed for the click-driven chain');
  await t.stealth._tick();
  await t.stealth._tick();
  assert.strictEqual((t.w.exStyle & TRANSPARENT), 0, 'watchdog left the gate alone');
  assert.strictEqual(t.stealth.status().gate, true);
  assert.strictEqual(t.w.alpha, 1, 'alpha stays 1 during the gate');
});

test('10. alpha is still repaired while the gate is open, and transparent returns after it closes', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  await t.stealth.beginTemporaryInputWindow('amc-play');
  t.w.alpha = 255;
  await t.stealth._tick();
  assert.strictEqual(t.w.alpha, 1, 'alpha repaired even during the gate');
  assert.strictEqual((t.w.exStyle & TRANSPARENT), 0, 'transparent still off during the gate');
  await t.stealth.endTemporaryInputWindow();
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0, 'transparent back after the gate closes');
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().phase, 'active');
});

test('11. a failed apply goes into backoff instead of spinning', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.bridge.failApplyTimes = 1;
  t.w.alpha = 255;
  await t.stealth._tick();
  const st = t.stealth.status();
  assert.strictEqual(st.phase, 'backoff');
  assert.strictEqual(t.stealth._state.applyFailures, 1);
  const delays = t.sched.delays();
  assert.ok(delays.indexOf(1000) >= 0, 'first backoff step scheduled, saw: ' + JSON.stringify(delays));
});

test('12. repeated failures end in a safe shutdown (restore + stop)', async () => {
  const t = makeStealth({ opts: { maxApplyFailures: 3, backoffSteps: [1, 1, 1] } });
  await t.stealth.enable();
  t.bridge.failApplyTimes = 10;
  t.w.alpha = 255;
  await t.stealth._tick();
  await t.stealth._tick();
  await t.stealth._tick();
  const st = t.stealth.status();
  assert.strictEqual(st.phase, 'failed');
  assert.strictEqual(st.enabled, false, 'disabled after giving up');
  assert.ok(t.bridge.calls.indexOf('restore') >= 0, 'safe shutdown restored the window');
  assert.strictEqual(t.sched.pending(), 0, 'no further ticks scheduled');
  assert.ok(t.logs.some((l) => l.indexOf('failed permanently') >= 0));
});

test('13. orphan stealth state from a previous crash is cleaned up on startup', async () => {
  const t = makeStealth({ window: { exStyle: 0x00080120, alpha: 1 } });
  const res = await t.stealth.recoverOrphans();
  assert.strictEqual(res.found, true);
  assert.strictEqual(res.stealthy, true);
  assert.strictEqual((t.w.exStyle & LAYERED), 0, 'layered cleared');
  assert.strictEqual((t.w.exStyle & TRANSPARENT), 0, 'transparent cleared');
});

test('14. recoverOrphans leaves a normal window alone', async () => {
  const t = makeStealth({ window: { exStyle: 0x00000100, alpha: -1 } });
  const res = await t.stealth.recoverOrphans();
  assert.strictEqual(res.stealthy, false);
  assert.strictEqual(t.w.exStyle, 0x00000100);
});

test('15. the gate is refused when stealth is OFF (no window changes)', async () => {
  const t = makeStealth();
  const res = await t.stealth.beginTemporaryInputWindow('amc-play');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'STEALTH_OFF');
  assert.strictEqual((t.w.exStyle & LAYERED), 0);
});

test('16. a throwing bridge cannot kill the tick chain (and status goes stale-aware)', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  const originalCheck = t.bridge.check;
  t.bridge.check = async () => { throw new Error('INJECTED_BRIDGE_THROW'); };
  await assert.rejects(() => t.stealth._tick(), /INJECTED_BRIDGE_THROW/);   // the tick itself throws
  t.bridge.check = originalCheck;
  assert.strictEqual(t.stealth.status().enabled, true, 'still enabled after a throwing tick');
  assert.ok(t.stealth._state.lastTickAt > 0, 'lastTickAt recorded');
  await t.stealth._tick();                     // and the next tick still works
  assert.strictEqual(t.stealth.status().phase, 'active');
});

test('17. the user restoring the window by hand turns stealth OFF', async () => {
  const interactions = [];
  const t = makeStealth({ opts: { onUserInteraction: (e) => interactions.push(e.reason) } });
  await t.stealth.enable();
  assert.strictEqual(t.stealth._state.lastIconic, true, 'the tracker learned from the snapshot');
  t.stealth._state.suppressUntil = 0;             // the suppression window is only about OUR own touches
  t.stealth._state.lastForeground = false;
  t.w.iconic = false;                             // the user restored the window
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().enabled, false, 'stealth disabled');
  assert.strictEqual(t.stealth.status().phase, 'off');
  assert.ok(t.bridge.calls.indexOf('restore') >= 0, 'window restored');
  assert.deepStrictEqual(interactions, ['window restored by user']);
});

test('18. the user activating Apple Music turns stealth OFF', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  t.stealth._state.suppressUntil = 0;
  t.stealth._state.lastForeground = false;
  t.stealth._state.lastIconic = t.w.iconic;       // no restore transition in this test
  t.bridge.state.foreground = true;               // Apple Music took the foreground
  t.bridge.check = async () => ({ ok: true, isWindow: true, hwnd: t.w.hwnd, cls: t.w.cls, iconic: t.w.iconic, exStyle: t.w.exStyle, layered: (t.w.exStyle & LAYERED) !== 0, transparent: (t.w.exStyle & TRANSPARENT) !== 0, alpha: t.w.alpha, title: 'Apple Music', foreground: true });
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().enabled, false);
});

test('19. OUR OWN window touches (repair / gate) never look like a user action', async () => {
  const t = makeStealth();
  await t.stealth.enable();
  // a repair suppresses detection
  t.w.alpha = 255;
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().enabled, true, 'a repair does not disable stealth');
  // during the gate the chain legitimately restores/foregrounds the window
  await t.stealth.beginTemporaryInputWindow('amc-play');
  t.w.iconic = false;
  t.bridge.check = async () => ({ ok: true, isWindow: true, hwnd: t.w.hwnd, cls: t.w.cls, iconic: false, exStyle: t.w.exStyle, layered: (t.w.exStyle & LAYERED) !== 0, transparent: (t.w.exStyle & TRANSPARENT) !== 0, alpha: t.w.alpha, title: 'Apple Music', foreground: true });
  await t.stealth._tick();
  assert.strictEqual(t.stealth.status().enabled, true, 'the gate is not a user action');
  assert.strictEqual(t.stealth.status().gate, true);
  await t.stealth.endTemporaryInputWindow();
  assert.ok((t.w.exStyle & TRANSPARENT) !== 0);
});
