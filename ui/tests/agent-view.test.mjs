import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Talking to an agent is its live terminal (Munder parity): every agent click opens it,
// the orchestrator comes first, and the chats page is out of primary navigation.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-agent-view-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/app/agent-view.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('agent-view.js'));
const view = await import(pathToFileURL(join(outputDir, String(file))).href);
rmSync(outputDir, { recursive: true });

const agent = (id, role = 'engineer') => ({ id, name: id.toUpperCase(), role });
const agents = [agent('jim'), agent('god', 'paramount'), agent('pam')];
const terms = (...ids) => ids.map((agentId) => ({ agentId, cwd: '/x', lines: [] }));

test('an agent opens its terminal route', () => {
  assert.equal(view.AGENT_VIEW, 'terminal');
  assert.deepEqual(view.agentViewParams('pam'), { a: 'pam' });
});

test('the roster puts the orchestrator first and marks live terminals', () => {
  const roster = view.terminalRoster(agents, terms('pam', 'god'));
  assert.deepEqual(roster.map((r) => `${r.agent.id}:${r.live}`), ['god:true', 'jim:false', 'pam:true']);
});

test('the terminal page shows the requested agent, else the live orchestrator, else the first live terminal', () => {
  assert.equal(view.selectedAgentId('jim', agents, terms('pam')), 'jim');
  assert.equal(view.selectedAgentId(null, agents, terms('pam', 'god')), 'god');
  assert.equal(view.selectedAgentId(null, agents, terms('pam')), 'pam');
  assert.equal(view.selectedAgentId(null, agents, []), undefined);
});

const src = (path) => readFileSync(path, 'utf8');
test('chats is not in primary navigation; terminal is', () => {
  const nav = src('src/config/navigation.tsx');
  const main = nav.slice(nav.indexOf('export const mainNav'), nav.indexOf('export const footerNav'));
  assert.doesNotMatch(main, /id: 'chats'/);
  assert.match(main, /id: 'terminal'/);
});

test('Home, Team, agent links, the agent sheet and the sidebar open the terminal, not a chat', () => {
  for (const path of ['src/pages/home.tsx', 'src/pages/team.tsx', 'src/components/app/agent-link.tsx', 'src/features/team/agent-sheet.tsx', 'src/app/app-shell.tsx']) {
    const code = src(path);
    assert.match(code, /go\(AGENT_VIEW, agentViewParams\(/, `${path} opens the agent's terminal`);
  }
  assert.match(src('src/pages/team.tsx'), /const openAgent = \(id: string\) => go\(AGENT_VIEW, agentViewParams\(id\)\)/);
  assert.match(src('src/pages/home.tsx'), /const openAgent = \(id: string\) => go\(AGENT_VIEW, agentViewParams\(id\)\)/);
  assert.doesNotMatch(src('src/features/team/agent-sheet.tsx'), /go\('chats'/);
  assert.doesNotMatch(src('src/components/app/agent-link.tsx'), /go\('chats'/);
});

test('a live terminal has no separate input box: keystrokes go to xterm', () => {
  const page = src('src/pages/terminal.tsx');
  // The text box exists only for a session without a pty (no desktop bridge).
  assert.match(page, /\{!session\.ptyId && <div className="flex items-center gap-2">\s*<Input/);
});
