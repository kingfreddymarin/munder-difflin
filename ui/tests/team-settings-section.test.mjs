import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// STD-8 (owner): Team configuration lives in Settings under a Team section; the Team page and the
// More menu link there. Existing controls are reused unchanged, so saved values carry over.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const settings = read('../src/pages/settings.tsx');
const team = read('../src/pages/team.tsx');
const shell = read('../src/app/app-shell.tsx');
const section = settings.slice(settings.indexOf('<TabsContent value="team">'), settings.indexOf('</TabsContent>', settings.indexOf('<TabsContent value="team">')));

test('Settings has a Team section holding orchestrator, teams and temp-worker configuration', () => {
  assert.match(settings, /<TabsTrigger value="team">Team<\/TabsTrigger>/);
  assert.ok(section.includes('<CoreSettings />'), 'orchestrator/model settings');
  assert.ok(section.includes('<TeamsEditor />'), 'teams and reporting lines');
  assert.match(section, /<LauncherSettings refreshToken=\{accountsRevision\} scope="temps" \/>/, 'temp-worker launcher default');
});

test('the Team page no longer hosts configuration and links to Settings › Team', () => {
  assert.doesNotMatch(team, /<LauncherSettings/);
  assert.doesNotMatch(team, /launcher-select/);
  assert.match(team, /go\('settings', \{ tab: 'team' \}\)\}>Team configuration is in Settings › Team</);
});

test('the More menu reaches Team configuration', () => {
  assert.match(shell, /item\('Team configuration', 'Orchestrator, teams and temp-worker defaults', \(\) => go\('settings', \{ tab: 'team' \}\)\)/);
});
