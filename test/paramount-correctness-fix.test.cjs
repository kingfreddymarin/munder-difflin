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
