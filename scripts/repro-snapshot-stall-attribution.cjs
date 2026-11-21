'use strict';
// Reproduces the production lag probe's attribution limits with the real
// Paramount tracing helpers. It does not claim to reproduce the captured
// 12.283-second cause: the runtime artifact has no nested dependency timings.
const assert = require('node:assert/strict');
const loadTs = require('../test/load-ts.cjs');
const { lagOp, startLagProbe } = loadTs('src/main/lag-probe.ts');
const { traced } = loadTs('src/main/paramountObservability.ts');

(async () => {
  const events = [];
  const stop = startLagProbe({
    now: () => Date.now(),
    log: (event) => events.push(event),
    intervalMs: 25,
    thresholdMs: 100,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await traced('paramount.snapshot', null, { fixture: true }, async () => {
      const endDependency = lagOp('snapshot.dependency:synthetic-sync-block');
      try {
        const until = Date.now() + 300;
        while (Date.now() < until) { /* deterministic main-thread stall */ }
      } finally {
        endDependency();
      }
      return { ok: true };
    }, { quiet: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    stop();
  }
  const stall = events.find((event) => event.kind === 'paramount-lag');
  assert.ok(stall, 'production lag probe should record the synthetic stall');
  assert.match(stall.op, /paramount\.snapshot/);
  assert.match(stall.op, /snapshot\.dependency:synthetic-sync-block/);
  console.log(JSON.stringify({
    result: 'reproduced synthetic main-thread stall; attribution remains overlapping-operation only',
    observedMs: stall.ms,
    activeOperations: stall.op,
    capturedRuntimeCause: 'not established',
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
