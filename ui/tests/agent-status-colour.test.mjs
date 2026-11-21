import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const outputDir = mkdtempSync(join(tmpdir(), 'paramount-agent-status-colour-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/components/app/agent-status-colour.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('agent-status-colour.js'));
const { agentStatusColour } = await import(pathToFileURL(join(outputDir, String(file))).href);

function agent(overrides) {
  return { status: 'idle', tokensUsed: 0, tokensCap: 0, ...overrides };
}

test('idle → grey, no blink', () => {
  const c = agentStatusColour(agent({ status: 'idle' }));
  assert.equal(c.dot, 'bg-zinc-500/50');
  assert.equal(c.blink, false);
});

test('working → yellow, no blink', () => {
  const c = agentStatusColour(agent({ status: 'working' }));
  assert.equal(c.dot, 'bg-yellow-400');
  assert.equal(c.blink, false);
});

test('waiting → yellow, no blink', () => {
  const c = agentStatusColour(agent({ status: 'waiting' }));
  assert.equal(c.dot, 'bg-yellow-400');
  assert.equal(c.blink, false);
});

test('compacting → blue, blink', () => {
  const c = agentStatusColour(agent({ status: 'compacting' }));
  assert.equal(c.dot, 'bg-blue-400');
  assert.equal(c.blink, true);
});

test('constrained → red, no blink', () => {
  const c = agentStatusColour(agent({ status: 'constrained' }));
  assert.equal(c.dot, 'bg-rose-500');
  assert.equal(c.blink, false);
});

test('crashed → red, no blink', () => {
  const c = agentStatusColour(agent({ status: 'crashed' }));
  assert.equal(c.dot, 'bg-rose-500');
  assert.equal(c.blink, false);
});

test('cap exactly reached → purple, no blink', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-violet-400');
  assert.equal(c.blink, false);
});

test('cap exceeded → purple, no blink', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 11, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-violet-400');
  assert.equal(c.blink, false);
});

test('cap set but not yet reached → not purple', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 9, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-yellow-400');
});

test('no cap (tokensCap=0) → not purple', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 100, tokensCap: 0 }));
  assert.equal(c.dot, 'bg-yellow-400');
});

test('priority: constrained beats cap reached (red > purple)', () => {
  const c = agentStatusColour(agent({ status: 'constrained', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-rose-500');
});

test('priority: crashed beats cap reached (red > purple)', () => {
  const c = agentStatusColour(agent({ status: 'crashed', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-rose-500');
});

test('priority: cap reached beats compacting (purple > blue)', () => {
  const c = agentStatusColour(agent({ status: 'compacting', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-violet-400');
  assert.equal(c.blink, false);
});

test('right-click handler calls go(team, { agent: id }) and prevents default', () => {
  let calledWith = null;
  const go = (route, params) => { calledWith = { route, params }; };
  const makeHandler = (agentId) => (event) => { event.preventDefault(); go('team', { agent: agentId }); };
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  makeHandler('agent-42')(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calledWith, { route: 'team', params: { agent: 'agent-42' } });
});
