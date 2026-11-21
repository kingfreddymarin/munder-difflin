'use strict';
// Focused acceptance tests for createLauncherDiscoveryCache transient-failure recovery.
// Failure-before / success-after pairs establish the corrected behavior.
// No real shell is invoked; probes are counted via injected async functions.
// Time is controlled via the injected `now` option so backoff tests run instantly.

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const loadTs = require(path.join(__dirname, 'load-ts.cjs'));
const { createLauncherDiscoveryCache } = loadTs('src/main/council-account-launchers.ts');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeOk() { return { status: 'ok', choices: [], profiles: [] }; }
function makeTimeout() { return { status: 'timeout', choices: [], profiles: [], message: 'timed out' }; }

/** Returns an async discover that returns a timeout for the first `failCount`
 *  calls, then ok for all subsequent calls, keeping a probe counter. */
function makeProbe({ failCount = 1 } = {}) {
  let probes = 0;
  return { probes: () => probes, fn: async () => (++probes <= failCount ? makeTimeout() : makeOk()) };
}

/** Fake clock: starts at 0, can be advanced by callers. */
function makeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ─── FAILURE-BEFORE tests (baseline; must still match the historical defect) ──

test('FAILURE-BEFORE: warm() after a cached timeout never re-probes without a backoff window', async () => {
  // Reproduce the original defect: pre-fix warm() gated on `!cached` only.
  // The test here is a documentation test; the same assertion passes before AND
  // after the fix because immediate re-calls are still gated (by backoff now).
  const { fn, probes } = makeProbe();
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync fallback'); }, fn, { now: clock.now });
  await cache.warm();
  assert.equal(cache.current().status, 'timeout', 'first warm() gives timeout');
  await cache.warm(); // time=0, within backoff → no probe
  await cache.warm(); // time=0, within backoff → no probe
  assert.equal(probes(), 1, 'immediate re-calls do not trigger extra probes');
});

// ─── SUCCESS-AFTER tests (corrected behavior) ──────────────────────────────

test('SUCCESS: warm() retries after the backoff window elapses; not before', async () => {
  const { fn, probes } = makeProbe({ failCount: 1 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync'); }, fn, { retryMs: 1000, now: clock.now });

  // First warm: timeout cached, failedAt=0, retryInterval=2000 (1000*2 after first fail)
  await cache.warm();
  assert.equal(cache.current().status, 'timeout');
  assert.equal(probes(), 1);

  // 500ms later — still within backoff; no retry
  clock.advance(500);
  const before = cache.warm();
  assert.equal(before, undefined, 'warm() returns undefined within backoff window');
  assert.equal(probes(), 1, 'no probe while in backoff');

  // 2000ms total elapsed — backoff window (retryMs*2=2000) exceeded; warm() fires
  clock.advance(1500); // total=2000
  const result = await cache.warm();
  assert.equal(probes(), 2, 'probe fires after backoff window');
  assert.equal(result?.status, 'ok', 'second probe returns ok');
  assert.equal(cache.current().status, 'ok', 'cache updated to ok after retry');
});

test('SUCCESS: after recovery to ok, warm() does not probe again', async () => {
  const { fn, probes } = makeProbe({ failCount: 1 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync'); }, fn, { retryMs: 1000, now: clock.now });

  await cache.warm(); // timeout
  clock.advance(2000); // past backoff
  await cache.warm(); // ok
  const countAfterOk = probes();

  // Any number of warm() calls after recovery should not probe again
  for (let i = 0; i < 5; i++) {
    const r = cache.warm();
    assert.equal(r, undefined, `warm() after ok must return undefined (call ${i})`);
  }
  assert.equal(probes(), countAfterOk, 'no additional probes after recovery');
});

test('SUCCESS: in-flight probe is shared — concurrent warm() calls produce exactly one probe', async () => {
  const { fn, probes } = makeProbe({ failCount: 1 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync'); }, fn, { retryMs: 1000, now: clock.now });

  // Fire initial warm (timeout)
  await cache.warm();
  clock.advance(2000); // past backoff

  // Trigger several concurrent warm()s — only one probe should fire
  const p1 = cache.warm();
  const p2 = cache.warm();
  const p3 = cache.warm();
  await Promise.all([p1, p2, p3]);
  assert.equal(probes(), 2, 'only one probe fires for concurrent warm() calls after backoff');
});

test('SUCCESS: explicit refresh() always probes regardless of backoff state', async () => {
  const { fn, probes } = makeProbe({ failCount: 2 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync'); }, fn, { retryMs: 60_000, now: clock.now });

  await cache.warm(); // first probe → timeout
  assert.equal(probes(), 1);

  // time=0: within 60s backoff; warm() would not retry
  const warm = cache.warm();
  assert.equal(warm, undefined, 'warm() gated by backoff');

  // But refresh() always fires
  const r = await cache.refresh();
  assert.equal(probes(), 2, 'refresh() fires even within backoff window');
  assert.equal(r.status, 'timeout', 'second probe still times out (failCount=2)');

  // Third refresh() gets ok
  const r2 = await cache.refresh();
  assert.equal(probes(), 3);
  assert.equal(r2.status, 'ok');
  assert.equal(cache.current().status, 'ok');
});

test('SUCCESS: exponential backoff doubles on successive failures up to maxRetryMs', async () => {
  const { fn, probes } = makeProbe({ failCount: 10 }); // always fails
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(
    () => { throw new Error('sync'); }, fn,
    { retryMs: 1000, maxRetryMs: 4000, now: clock.now }
  );

  await cache.warm(); // fail #1 → retryInterval = 2000
  clock.advance(2000);
  await cache.warm(); // fail #2 → retryInterval = 4000 (min(2000*2, 4000))
  assert.equal(probes(), 2);

  // next retry window is 4000ms; advancing 2000 should not trigger retry
  clock.advance(2000);
  const r = cache.warm();
  assert.equal(r, undefined, 'retry window doubled and not yet elapsed');
  assert.equal(probes(), 2, 'no extra probe before doubled window');

  // advance another 2000ms (total 4000ms since last fail) → retry fires
  clock.advance(2000);
  await cache.warm();
  assert.equal(probes(), 3, 'retry fires after doubled window');
});

test('SUCCESS: cold path — no prior result — warm() probes immediately', async () => {
  const { fn, probes } = makeProbe({ failCount: 0 }); // always ok
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(() => { throw new Error('sync'); }, fn, { now: clock.now });
  const r = await cache.warm();
  assert.equal(probes(), 1);
  assert.equal(r?.status, 'ok');
  assert.equal(cache.current().status, 'ok');
});

test('SUCCESS: sync fallback not called when discoverAsync is provided', async () => {
  let syncCalled = false;
  const sync = () => { syncCalled = true; return makeOk(); };
  const { fn } = makeProbe({ failCount: 1 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(sync, fn, { retryMs: 1000, now: clock.now });

  await cache.warm(); // async probe → timeout
  clock.advance(5000);
  await cache.warm(); // async retry → ok
  assert.equal(syncCalled, false, 'sync discover is never called when discoverAsync is provided and cached result exists');
});

// ─── Cold-read (non-blocking current()) regression tests ──────────────────

test('SUCCESS: current() during async warmup returns NOT_DISCOVERED sentinel; never calls sync probe', async () => {
  // Mirrors discovery-cold-read.cjs repro: sync must not be called when probe is inflight.
  let syncCalls = 0;
  let resolveProbe;
  const sync = () => { syncCalls++; return makeOk(); };
  const asyncProbe = () => new Promise((r) => { resolveProbe = r; });
  const cache = createLauncherDiscoveryCache(sync, asyncProbe);

  const pending = cache.warm(); // inflight probe, cached still undefined

  // current() during warmup must not call sync and must return a non-undefined sentinel
  const cold = cache.current();
  assert.equal(syncCalls, 0, 'sync fallback must not be called while async probe is inflight');
  assert.ok(cold !== undefined, 'current() returns a sentinel (not undefined) during warmup');
  assert.notEqual(cold.status, 'ok', 'sentinel is not a successful result');

  // Resolve the probe and verify cache updates
  resolveProbe(makeOk());
  await pending;
  assert.equal(cache.current().status, 'ok', 'current() returns ok after probe resolves');
  assert.equal(syncCalls, 0, 'sync fallback was never called throughout');
});

test('SUCCESS: current() after backoff retry resolves to ok without sync probe', async () => {
  // End-to-end: timeout → backoff → retry → current() returns ok.
  let syncCalls = 0;
  const sync = () => { syncCalls++; return makeOk(); };
  const { fn, probes } = makeProbe({ failCount: 1 });
  const clock = makeClock();
  const cache = createLauncherDiscoveryCache(sync, fn, { retryMs: 1000, now: clock.now });

  await cache.warm(); // first probe → timeout
  assert.equal(cache.current().status, 'timeout', 'cached timeout result returned directly after first probe');

  // Advance past backoff; retry fires
  clock.advance(2000);
  await cache.warm();
  assert.equal(probes(), 2, 'retry probe fired after backoff');
  assert.equal(cache.current().status, 'ok', 'current() returns ok after retry');
  assert.equal(syncCalls, 0, 'sync discover never called at any point');
});
