'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');
const loadTs = require('./load-ts.cjs');
const { createSideAgents, isSideAgentPty, sideAgentCards } = loadTs('src/main/side-agent.ts');
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');

const fixtureContext = () => ({
  floorLabel: 'Floor display only',
  orchestratorId: 'main-orchestrator',
  orchestratorName: 'Orchestrator display only',
  capturedAt: '2026-11-21T08:00:00.000Z',
  cards: sideAgentCards({ tasks: [{ id: 'NSC-236', status: 'doing', title: 'PRIVATE_CARD_TEXT' }] })
});

function fixture(t) {
  let onExit;
  let context = fixtureContext();
  const spawned = new Map();
  const publications = [];
  const owner = { isDestroyed: () => false };
  const fakePty = {
    isCommandAvailable: () => true,
    spawn(opts, window) {
      spawned.set(opts.id, { opts, window });
      return { ok: true };
    },
    kill(id) {
      return { ok: spawned.delete(id) };
    },
    killByOwner(window) {
      for (const [id, entry] of spawned) if (entry.window === window) this.kill(id);
    },
    killAll() { spawned.clear(); },
    setExitHandler(handler) { onExit = handler; }
  };
  const side = createSideAgents(fakePty, () => context, (...args) => publications.push(args));
  t.after(() => side.closeAll());
  return { side, fakePty, owner, spawned, publications, context: (value) => { context = value; },
    exit(id, code, signal) { spawned.delete(id); onExit(id, code, { signal }); } };
}

test('launch uses a safe, bounded snapshot and a separate OpenCode profile', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.side.state(f.owner), { status: 'idle' });
  assert.equal(f.side.launch(f.owner, 'opencode', false).ok, true);
  const state = f.side.state(f.owner);
  assert.equal(state.status, 'running');
  assert.ok(isSideAgentPty(state.ptyId));
  assert.deepEqual(state.context, fixtureContext());
  const { opts } = f.spawned.get(state.ptyId);
  assert.equal(opts.command, 'opencode');
  assert.deepEqual(opts.args.slice(0, 2), ['--standalone', '--prompt']);
  const prompt = opts.args.at(-1);
  assert.match(prompt, /main-orchestrator.*NSC-236 doing/);
  assert.doesNotMatch(prompt, /Floor display|Orchestrator display|PRIVATE_CARD_TEXT|\n/);
  const profile = JSON.parse(readFileSync(join(opts.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json')));
  for (const action of ['tool.use', 'mcp.use', 'skill.use', 'plugin.use', 'websearch.use']) {
    assert.ok(profile.policies.some((rule) => rule.action === action && rule.resource === '*' && rule.effect === 'deny'));
  }
  const env = buildPtyEnv({
    HIVE_ROOT: '/real/floor', AGENT_ID: 'god', HIVE_BROKER_TOKEN: 'private',
    ANTHROPIC_API_KEY: 'private', OPENAI_API_KEY: 'private',
    OPENCODE_CONFIG_CONTENT: 'private', CLAUDE_CONFIG_DIR: '/real/claude',
    CODEX_HOME: '/real/codex', HOME: '/real/home', LANG: 'en_US.UTF-8'
  }, '/fixture/bin', opts.env, 'darwin', opts.envUnset, opts.inheritEnv);
  for (const key of ['HIVE_ROOT', 'AGENT_ID', 'HIVE_BROKER_TOKEN', 'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY', 'OPENCODE_CONFIG_CONTENT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    assert.equal(env[key], undefined);
  }
  assert.equal(env.HOME, dirname(opts.cwd));
  assert.equal(env.PATH, '/fixture/bin');
  if (process.platform !== 'win32') assert.equal(statSync(env.HOME).mode & 0o777, 0o700);
});

test('rejects malformed and finished cards, deduplicates and caps active references', () => {
  const cards = sideAgentCards({ tasks: [
    null, { id: 'NX-%PATH%', status: 'doing' }, { id: 'NSC-archived', status: 'done' },
    { id: 'NSC-1', status: 'doing' }, { id: 'NSC-1', status: 'blocked' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: `ACTIVE-${i}`, status: 'blocked' }))
  ] });
  assert.deepEqual(cards[0], { id: 'NSC-1', status: 'blocked' });
  assert.equal(cards.length, 12);
  assert.equal(cards.at(-1).id, 'ACTIVE-10');
  assert.deepEqual(sideAgentCards(null), []);
});

test('restart takes a fresh snapshot and launch, stop and exit stay window-owned', (t) => {
  const f = fixture(t);
  const other = { isDestroyed: () => false };
  f.side.launch(f.owner, 'opencode', false);
  const original = f.side.state(f.owner).ptyId;
  const originalHome = dirname(f.spawned.get(original).opts.cwd);
  assert.equal(f.side.owns(other, original), false);
  assert.equal(f.side.stop(other).ok, true);
  assert.equal(f.side.launch(f.owner, 'claude', false).ok, false);
  f.context({ ...fixtureContext(), capturedAt: '2026-11-21T08:30:00.000Z' });
  assert.equal(f.side.launch(f.owner, 'claude', true).ok, true);
  const replacement = f.side.state(f.owner);
  assert.notEqual(replacement.ptyId, original);
  assert.equal(replacement.context.capturedAt, '2026-11-21T08:30:00.000Z');
  assert.equal(existsSync(originalHome), false);
  assert.equal(f.side.owns(f.owner, original), false);
  const { opts } = f.spawned.get(replacement.ptyId);
  assert.equal(opts.command, 'claude');
  assert.ok(opts.args.includes('--tools=') && opts.args.includes('--strict-mcp-config'));
  f.exit(original, 1);
  assert.equal(f.side.state(f.owner).status, 'running');
  f.exit(replacement.ptyId, 0, 9);
  assert.equal(f.side.state(f.owner).status, 'exited');
  assert.equal(f.side.state(f.owner).signal, 9);
  assert.equal(existsSync(dirname(opts.cwd)), false);
  assert.deepEqual(f.publications.at(-1), [f.owner, replacement.ptyId]);
  f.side.launch(f.owner, 'opencode', false);
  assert.equal(f.side.stop(f.owner).ok, true);
  assert.equal(f.side.state(f.owner).status, 'stopped');
  assert.equal(f.spawned.size, 0);
  f.side.close(f.owner);
  assert.equal(f.side.state(f.owner).status, 'idle');
});

test('launch failures leave no phantom session and a failed restart preflight preserves the original', (t) => {
  const f = fixture(t);
  assert.match(f.side.launch(f.owner, 'custom', false).error, /Choose OpenCode/);
  f.context(null);
  assert.match(f.side.launch(f.owner, 'opencode', false).error, /Open a floor/);
  f.context(fixtureContext());
  f.fakePty.isCommandAvailable = () => false;
  assert.match(f.side.launch(f.owner, 'opencode', false).error, /Install OpenCode/);
  f.fakePty.isCommandAvailable = () => true;
  const spawn = f.fakePty.spawn;
  let rejectedHome;
  f.fakePty.spawn = (opts) => {
    rejectedHome = dirname(opts.cwd);
    return { ok: false, error: 'internal detail' };
  };
  assert.equal(f.side.launch(f.owner, 'opencode', false).ok, false);
  assert.equal(existsSync(rejectedHome), false);
  assert.deepEqual(f.side.state(f.owner), { status: 'idle' });
  f.fakePty.spawn = spawn;
  assert.equal(f.side.launch(f.owner, 'opencode', false).ok, true);
  const current = f.side.state(f.owner);
  const currentHome = dirname(f.spawned.get(current.ptyId).opts.cwd);
  f.fakePty.isCommandAvailable = () => false;
  assert.equal(f.side.launch(f.owner, 'claude', true).ok, false);
  assert.deepEqual(f.side.state(f.owner), current);
  f.side.closeAll();
  assert.equal(existsSync(currentHome), false);
  assert.equal(f.spawned.size, 0);
  assert.deepEqual(f.side.state(f.owner), { status: 'idle' });
});

test('a native side PTY accepts input, reports exit, and removes its provider profile',
  { skip: process.platform === 'win32', timeout: 20000 }, async (t) => {
    const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { setTimeout: delay } = require('node:timers/promises');
    const { PtyManager } = loadTs('src/main/pty.ts');
    const bin = mkdtempSync(join(tmpdir(), 'side-agent-bin-'));
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    const command = join(bin, 'opencode');
    writeFileSync(command, '#!/bin/sh\nprintf "side-fixture-ready\\n"\nread -r line\nif [ "$line" = "fixture question" ]; then exit 23; else exit 24; fi\n', { mode: 0o700 });
    const pty = new PtyManager();
    // Keep terminal allocation and environment construction real, using only a local executable.
    pty.resolveCommand = (name) => ({ path: command, found: name === 'opencode' });
    const side = createSideAgents(pty, fixtureContext, () => {});
    t.after(() => side.closeAll());
    let output = '';
    const owner = { isDestroyed: () => false, send: (channel, data) => {
      if (channel.startsWith('pty:data:')) output += data;
    } };
    const result = side.launch(owner, 'opencode', false);
    assert.equal(result.ok, true, result.error);
    const { ptyId } = side.state(owner);
    const home = dirname(pty.list()[0].cwd);
    for (let i = 0; i < 100 && !output.includes('side-fixture-ready'); i++) await delay(50);
    assert.match(output, /side-fixture-ready/);
    assert.equal(pty.write(ptyId, 'fixture question\r').ok, true);
    for (let i = 0; i < 100 && side.state(owner).status === 'running'; i++) await delay(50);
    assert.equal(side.state(owner).exitCode, 23);
    assert.equal(side.state(owner).status, 'exited');
    assert.equal(existsSync(home), false);
    assert.deepEqual(pty.list(), []);
  });
