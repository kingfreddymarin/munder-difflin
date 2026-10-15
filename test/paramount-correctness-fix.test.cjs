'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { createAutoModeExpiry, retryDelay, EXPIRY_RETRY_MS } = loadTs('src/main/autoModeExpiry.ts');

function harness({ expiresAt, failWrites = 0, now = 1_000_000 }) {
  const s = { cfg: { autoMode: true, autoModeExpiresAt: expiresAt }, forced: false, logs: [], timers: [], failWrites, now };
  const expiry = createAutoModeExpiry({
    read: () => ({ ...s.cfg, autoMode: s.forced ? false : s.cfg.autoMode }),
    write: (patch) => {
      if (s.failWrites > 0) { s.failWrites -= 1; throw new Error('EROFS: read-only file system'); }
      s.cfg = { ...s.cfg, ...patch, autoMode: s.forced ? false : patch.autoMode };
      delete s.cfg.autoModeExpiresAt;
    },
    forceOff: (on) => { s.forced = on; },
    log: (e) => s.logs.push(e),
    newErrorId: () => `E-${s.logs.length}`,
    now: () => s.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; s.timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; }
  });
  const effectiveAutoMode = () => (s.forced ? false : s.cfg.autoMode);
  const fireLast = () => { const t = s.timers.at(-1); assert.ok(t && !t.cleared); t.fn(); };
  return { s, expiry, effectiveAutoMode, fireLast };
}

test('yolo expiry: write failure keeps bypass off in memory and retries with backoff', () => {
  const h = harness({ expiresAt: new Date(999_000).toISOString(), failWrites: 2 });
  h.expiry.arm();
  assert.equal(h.effectiveAutoMode(), false, 'bypass must be off even though the write failed');
  assert.equal(h.s.logs[0].kind, 'paramount-error');
  assert.equal(h.s.logs[0].op, 'yolo-expiry');
  assert.ok(h.s.logs[0].errorId);
  assert.equal(h.s.timers.at(-1).ms, EXPIRY_RETRY_MS.first);
  h.fireLast();
  assert.equal(h.effectiveAutoMode(), false);
  assert.equal(h.s.timers.at(-1).ms, EXPIRY_RETRY_MS.first * 2, 'backoff doubles');
  h.fireLast();
  assert.equal(h.s.forced, false, 'latch released once the off state is persisted');
  assert.equal(h.s.cfg.autoMode, false);
  assert.equal(h.s.cfg.autoModeExpiresAt, undefined);
  assert.equal(h.s.logs.at(-1).kind, 'paramount-yolo-expired');
});

test('yolo expiry: backoff is capped', () => {
  assert.equal(retryDelay(1), 5_000);
  assert.equal(retryDelay(50), EXPIRY_RETRY_MS.max);
});

test('yolo expiry: a future stamp arms a timer, no write', () => {
  const h = harness({ expiresAt: new Date(1_000_000 + 60_000).toISOString() });
  h.expiry.arm();
  assert.equal(h.s.timers.at(-1).ms, 60_000);
  assert.equal(h.effectiveAutoMode(), true);
  h.s.now += 60_000;
  h.fireLast();
  assert.equal(h.effectiveAutoMode(), false);
});

test('yolo expiry: re-arming clears the previous timer', () => {
  const h = harness({ expiresAt: new Date(1_000_000 + 60_000).toISOString() });
  h.expiry.arm();
  h.expiry.arm();
  assert.equal(h.s.timers[0].cleared, true);
  assert.equal(h.s.timers.length, 2);
});

const { normalizeAutoModePatch, touchesAutoModeExpiry } = loadTs('src/main/autoModeExpiry.ts');

test('config:update: a plain YOLO toggle clears the timed-window stamp', () => {
  assert.deepEqual(normalizeAutoModePatch({ autoMode: true }), { autoMode: true, autoModeExpiresAt: undefined });
  assert.deepEqual(normalizeAutoModePatch({ autoMode: false }), { autoMode: false, autoModeExpiresAt: undefined });
  assert.ok(Object.hasOwn(normalizeAutoModePatch({ autoMode: true }), 'autoModeExpiresAt'), 'key present so writeConfig overrides the stored stamp');
});

test('config:update: an explicit stamp with autoMode on is kept; off always clears it', () => {
  const at = '2026-10-15T10:00:00.000Z';
  assert.deepEqual(normalizeAutoModePatch({ autoMode: true, autoModeExpiresAt: at }), { autoMode: true, autoModeExpiresAt: at });
  assert.equal(normalizeAutoModePatch({ autoMode: false, autoModeExpiresAt: at }).autoModeExpiresAt, undefined);
});

test('config:update: unrelated patches pass through and do not re-arm', () => {
  const p = { notifications: true };
  assert.equal(normalizeAutoModePatch(p), p);
  assert.equal(touchesAutoModeExpiry(p), false);
  assert.equal(touchesAutoModeExpiry(null), false);
  assert.equal(touchesAutoModeExpiry({ autoMode: true }), true);
  assert.equal(touchesAutoModeExpiry({ autoModeExpiresAt: '2026-10-15T10:00:00.000Z' }), true);
});

test('config:update scenario: Settings off→on after a timed window leaves no stale expiry', () => {
  const h = harness({ expiresAt: new Date(1_000_000 + 3_600_000).toISOString() });
  h.expiry.arm();
  const first = h.s.timers.at(-1);
  for (const patch of [{ autoMode: false }, { autoMode: true }]) {
    h.s.cfg = { ...h.s.cfg, ...normalizeAutoModePatch(patch) };
    if (touchesAutoModeExpiry(patch)) h.expiry.arm();
  }
  assert.equal(first.cleared, true, 'old timer cleared');
  assert.equal(h.s.timers.length, 1, 'no new timer: YOLO is now always-on');
  assert.equal(h.effectiveAutoMode(), true);
});

test('probePort: an invalid port resolves { ok: false, code } instead of rejecting', async () => {
  const { probePort } = loadTs('src/main/portProbe.ts');
  for (const port of [-1, 0, 65536, 1.5, NaN]) {
    assert.deepEqual(await probePort(port), { ok: false, code: 'INVALID_PORT' }, `port ${port}`);
  }
});
