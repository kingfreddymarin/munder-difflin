'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { heartbeatDigest, orchestratorInboxNudge } = require('./load-ts.cjs')('src/main/heartbeatDigest.ts');

test('heartbeat is a short actionable nudge with references instead of pasted diagnostics', () => {
  const digest = heartbeatDigest(120000, 1);
  assert.match(digest, /^Heartbeat: 1 message waiting\. Read your inbox and handle it\./);
  assert.match(digest, /\$AGENT_DIR\/inbox/);
  assert.match(digest, /\$HIVE_ROOT\/log\.jsonl/);
  assert.equal(digest.split('\n').length, 2);
  assert.ok(digest.length < 250);
  assert.doesNotMatch(digest, /Recent log:|Board \(head\)|Drain your inbox NOW|\{"/);
});

test('heartbeat handles plural mail and quiet floors without contradictory inbox claims', () => {
  assert.match(heartbeatDigest(0, 3), /^Heartbeat: 3 messages waiting/);
  assert.match(heartbeatDigest(180000), /^Heartbeat: quiet for 3m/);
  assert.doesNotMatch(heartbeatDigest(0, 1), /No undrained inboxes|Active agents/);
});

test('the main-agent terminal nudge points to its actual inbox without asking it to message itself', () => {
  const text = orchestratorInboxNudge(2);
  assert.match(text, /^2 inbox messages waiting/);
  assert.match(text, /\$AGENT_DIR\/inbox/);
  assert.doesNotMatch(text, /message god|Recent log|NOW/);
  assert.ok(text.length < 200);
});
