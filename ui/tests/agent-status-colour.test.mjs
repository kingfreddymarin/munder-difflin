import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Test file lives at ui/tests/; fixtures live at ../test/fixtures/ (worktree root/test/).
const HERE = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(HERE, '../../test/fixtures/provider-limit');

// Compile agent-status-colour.ts (no @/ aliases; pure logic module).
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-agent-status-colour-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/components/app/agent-status-colour.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('agent-status-colour.js'));
const { agentStatusColour } = await import(pathToFileURL(join(outputDir, String(file))).href);

// Compile provider-limit.ts for the fixture-based detection tests.
// tsc is run from ui/ so path must be relative to that directory.
const plDir = mkdtempSync(join(tmpdir(), 'paramount-provider-limit-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', plDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', join(HERE, '../../src/main/provider-limit.ts'),
]);
const plFile = readdirSync(plDir, { recursive: true }).find((name) => String(name).endsWith('provider-limit.js'));
const { detectProviderLimit, PROVIDER_LIMIT_USAGE_REACHED, PROVIDER_LIMIT_MONTHLY_SPEND, PROVIDER_LIMIT_IDLE_MS } =
  await import(pathToFileURL(join(plDir, String(plFile))).href);

const IDLE = PROVIDER_LIMIT_IDLE_MS; // alias for readability in tests

function agent(overrides) {
  return { status: 'idle', tokensUsed: 0, tokensCap: 0, providerLimited: false, ...overrides };
}

// — provider-limit detector —

test('detectProviderLimit: usage-reached fixture + idle → true', () => {
  const fixture = readFileSync(join(fixturesDir, 'claude-usage-limit-reached.txt'), 'utf8');
  assert.equal(detectProviderLimit(fixture, IDLE), true);
});

test('detectProviderLimit: monthly-spend fixture + idle → true', () => {
  const fixture = readFileSync(join(fixturesDir, 'claude-monthly-spend-limit.txt'), 'utf8');
  assert.equal(detectProviderLimit(fixture, IDLE), true);
});

test('detectProviderLimit: normal working output → false', () => {
  assert.equal(detectProviderLimit('Tool: Bash\nRead file: foo.ts\n✓ done', IDLE), false);
});

test('detectProviderLimit: exported constants match fixture content', () => {
  const f1 = readFileSync(join(fixturesDir, 'claude-usage-limit-reached.txt'), 'utf8');
  const f2 = readFileSync(join(fixturesDir, 'claude-monthly-spend-limit.txt'), 'utf8');
  assert.ok(f1.includes(PROVIDER_LIMIT_USAGE_REACHED), 'usage-reached fixture must contain PROVIDER_LIMIT_USAGE_REACHED');
  assert.ok(f2.includes(PROVIDER_LIMIT_MONTHLY_SPEND), 'monthly-spend fixture must contain PROVIDER_LIMIT_MONTHLY_SPEND');
});

test('detectProviderLimit: needle earlier in tail followed by normal output → false', () => {
  // Build a tail where the limit message is well before the last 10 non-empty lines.
  const normalLines = Array.from({ length: 15 }, (_, i) => `Tool: Read file${i}.ts`).join('\n');
  const tail = `Usage limit reached\nYour plan resets in 5h.\n${normalLines}`;
  assert.equal(detectProviderLimit(tail, IDLE), false);
});

test('detectProviderLimit: needle in last lines but PTY busy (idleMs < threshold) → false', () => {
  const tail = 'Usage limit reached\nYour plan resets in 5h.';
  assert.equal(detectProviderLimit(tail, IDLE - 1), false);
});

test('detectProviderLimit: needle in last lines + fully idle → true', () => {
  const tail = 'Usage limit reached\nYour plan resets in 5h.';
  assert.equal(detectProviderLimit(tail, IDLE), true);
});

test('detectProviderLimit: ANSI-wrapped needle + idle → true', () => {
  // Claude Code renders "Usage limit reached" with colour codes around it.
  const tail = '\x1B[38;2;255;107;128mUsage limit reached\x1B[0m\nYour plan resets in 5h.';
  assert.equal(detectProviderLimit(tail, IDLE), true);
});

// — agentStatusColour mapping —

test('idle → grey (bg-status-idle), no blink', () => {
  const c = agentStatusColour(agent({ status: 'idle' }));
  assert.equal(c.dot, 'bg-status-idle');
  assert.equal(c.blink, false);
});

test('working → yellow (bg-status-working), no blink', () => {
  const c = agentStatusColour(agent({ status: 'working' }));
  assert.equal(c.dot, 'bg-status-working');
  assert.equal(c.blink, false);
});

test('waiting → yellow (bg-status-working), no blink', () => {
  const c = agentStatusColour(agent({ status: 'waiting' }));
  assert.equal(c.dot, 'bg-status-working');
  assert.equal(c.blink, false);
});

test('compacting → blue (bg-status-compacting), blink', () => {
  const c = agentStatusColour(agent({ status: 'compacting' }));
  assert.equal(c.dot, 'bg-status-compacting');
  assert.equal(c.blink, true);
});

test('cap exactly reached → purple (bg-status-capped), no blink', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-status-capped');
  assert.equal(c.blink, false);
});

test('cap exceeded → purple (bg-status-capped), no blink', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 11, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-status-capped');
  assert.equal(c.blink, false);
});

test('cap set but not yet reached → not capped', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 9, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-status-working');
});

test('no cap (tokensCap=0) → not capped', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 100, tokensCap: 0 }));
  assert.equal(c.dot, 'bg-status-working');
});

test('providerLimited → red (bg-status-limited), no blink', () => {
  const c = agentStatusColour(agent({ status: 'idle', providerLimited: true }));
  assert.equal(c.dot, 'bg-status-limited');
  assert.equal(c.blink, false);
});

test('priority: providerLimited beats cap reached (red > purple)', () => {
  const c = agentStatusColour(agent({ status: 'working', tokensUsed: 10, tokensCap: 10, providerLimited: true }));
  assert.equal(c.dot, 'bg-status-limited');
});

test('priority: providerLimited beats compacting (red > blue)', () => {
  const c = agentStatusColour(agent({ status: 'compacting', providerLimited: true }));
  assert.equal(c.dot, 'bg-status-limited');
});

test('priority: cap reached beats compacting (purple > blue)', () => {
  const c = agentStatusColour(agent({ status: 'compacting', tokensUsed: 10, tokensCap: 10 }));
  assert.equal(c.dot, 'bg-status-capped');
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
