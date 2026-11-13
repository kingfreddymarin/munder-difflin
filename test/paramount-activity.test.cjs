'use strict';
// Owner use of 52051eda: the Team graph never showed anyone working. Busy follows Munder's floor rule:
// terminal output within the idle window is working, a quiet or missing terminal is idle.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { agentActivity } = loadTs('src/main/paramount-activity.ts');

test('a terminal that printed inside the idle window is busy; a quiet or missing one is not', () => {
  const now = 100_000;
  const out = agentActivity({
    god: { lastOutputAt: now - 30_000 },
    jim: { lastOutputAt: now - 2_000, tokens: 1200, inputTokens: 600, outputTokens: 200,
      cacheReadTokens: 300, cacheCreationTokens: 100, costUsd: 0.12, breaker: 'healthy',
      lastTool: 'Edit', context: { tokens: 50, limit: 200 } },
    kev: {},
  }, now, 12_000);
  assert.equal(out.god.busy, false);
  assert.deepEqual(out.jim, { busy: true, doing: 'Edit', tokens: 1200, inputTokens: 600, outputTokens: 200,
    cacheReadTokens: 300, cacheCreationTokens: 100, costUsd: 0.12, breaker: 'healthy', contextPct: 25 });
  assert.deepEqual(out.kev, { busy: false, doing: '', tokens: null, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheCreationTokens: null, costUsd: null, breaker: null, contextPct: null });
});

test('the Paramount snapshot carries the live activity', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /activity: paramountActivity\(\)/);
});
