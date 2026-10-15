'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { extractMentions, parsePorcelain, parseLog, buildArtifactMap } = loadTs('src/main/paramount-terminal.ts');

function deps(agents, terminal) {
  const events = [];
  return { events, deps: {
    tasks: () => ({ tasks: [] }), patchTask: () => true, missions: () => [], saveMissions() {},
    agents: () => agents, renameAgent: () => ({ ok: true }), setAgentTokenCap() {}, setNotifications() {},
    savePreference() {}, appendEvent: (e) => events.push(e), publish() {}, terminal
  } };
}

test('extractMentions finds absolute paths and links, trims punctuation', () => {
  const m = extractMentions('Wrote /Users/me/repo/src/a.ts, see https://github.com/o/r/pull/12. And `/tmp/x.log`');
  assert.deepEqual(m.paths, ['/Users/me/repo/src/a.ts', '/tmp/x.log']);
  assert.deepEqual(m.urls, ['https://github.com/o/r/pull/12']);
});

test('parsePorcelain keeps the new path of a rename', () => {
  assert.deepEqual(parsePorcelain(' M a.ts\0R  new.ts\0old.ts\0?? n/\0'), [
    { status: 'M', path: 'a.ts' }, { status: 'R', path: 'new.ts' }, { status: '??', path: 'n/' }]);
});

test('parseLog splits commits and files', () => {
  const out = '\x1eabc123\x1fFix it\x1f2026-10-15T00:00:00Z\n\nsrc/a.ts\nsrc/b.ts\n';
  assert.deepEqual(parseLog(out), [{ commit: 'abc123', subject: 'Fix it', at: '2026-10-15T00:00:00Z', files: ['src/a.ts', 'src/b.ts'] }]);
});

test('terminal.artifacts maps a real git tree and the agent\'s own messages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-term-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q'); writeFileSync(join(dir, 'done.ts'), 'x'); git('add', '.'); git('commit', '-qm', 'First');
  writeFileSync(join(dir, 'done.ts'), 'y'); mkdirSync(join(dir, 'new')); writeFileSync(join(dir, 'new', 'f.ts'), 'z');
  const messages = [
    { id: 'm1', from: 'jim', subject: 'done', body: `see ${join(dir, 'done.ts')} and https://github.com/o/r/pull/7`, created_at: '2026-10-15T01:00:00Z' },
    { id: 'm2', from: 'pam', body: '/Users/someone/else.ts' }];
  const { deps: d, events } = deps({ jim: { cwd: dir } }, { messages: () => messages });
  const r = dispatchParamount({ type: 'terminal.artifacts', agentId: 'jim' }, d);
  assert.equal(r.ok, true);
  const a = r.artifacts;
  assert.ok(a.repo && a.repo.head);
  assert.deepEqual(a.warnings, []);
  const kinds = (k) => a.artifacts.filter((x) => x.kind === k).map((x) => x.label).sort();
  assert.deepEqual(kinds('changed'), ['done.ts', 'new/']);
  assert.deepEqual(kinds('committed'), ['done.ts']);
  assert.deepEqual(kinds('commit'), ['First']);
  assert.deepEqual(kinds('link'), ['https://github.com/o/r/pull/7']);
  const mentioned = a.artifacts.find((x) => x.kind === 'mentioned');
  assert.ok(mentioned.dir && mentioned.messageId === 'm1');
  assert.ok(!a.artifacts.some((x) => x.label === '/Users/someone/else.ts'), 'other agents\' messages are excluded');
  assert.equal(events.length, 1);
});

test('a missing cwd and a failing message source become logged warnings, not failures', () => {
  const steps = [];
  const map = buildArtifactMap('jim', '/definitely/not/here', { messages: () => { throw new Error('boom'); }, logStep: (s) => steps.push(s) }, 'cid1');
  assert.equal(map.repo, null);
  assert.deepEqual(map.warnings.map((w) => w.source), ['cwd', 'messages']);
  assert.ok(map.warnings.every((w) => w.errorId));
  assert.deepEqual(steps.map((s) => s.errorId), map.warnings.map((w) => w.errorId));
});

test('terminal.artifacts rejects bad input, unknown agents and builds without it', () => {
  const { deps: d } = deps({ jim: { cwd: '/' } }, { messages: () => [] });
  const bad = dispatchParamount({ type: 'terminal.artifacts', agentId: 'jim', extra: 1 }, d);
  assert.equal(bad.ok, false); assert.equal(bad.code, 'INVALID_INPUT'); assert.ok(bad.errorId);
  assert.equal(dispatchParamount({ type: 'terminal.artifacts', agentId: 'nope' }, d).code, 'NOT_FOUND');
  const { deps: none } = deps({ jim: {} }, undefined);
  assert.equal(dispatchParamount({ type: 'terminal.artifacts', agentId: 'jim' }, none).code, 'UNSUPPORTED');
});
