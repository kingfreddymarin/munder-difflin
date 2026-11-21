import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('agent cards, list rows and tree nodes expose keyboard and context-menu actions with a restore path', () => {
  const menu = source('../src/features/team/agent-action-menu.tsx');
  const hook = source('../src/features/team/agent-actions.ts');
  // UI/keyboard structure lives in the menu component
  for (const phrase of ['onContextMenu', "event.key === 'F10'", 'Resume session', 'Start fresh']) assert.ok(menu.includes(phrase), `missing in menu: ${phrase}`);
  assert.match(menu, /agent\.restart/);
  assert.match(menu, /teamApi\.sendNote\(agentId, text\)/);
  // Action labels and business logic live in the shared hook (NSC-252/NSC-256)
  for (const phrase of ['Archive', 'Rename', 'Send note']) assert.ok(hook.includes(phrase), `missing in agent-actions hook: ${phrase}`);
  assert.match(hook, /teamApi\.archiveAgent\(agentId, true\)/);
  assert.match(source('../src/data/electron-provider.ts'), /act: 'inform'/);
  assert.match(source('../src/components/app/agent-summary.tsx'), /Right-click or Shift\+F10/);
  assert.match(source('../src/features/team/agents-panel.tsx'), /useAgentActionTargets/);
  assert.match(source('../src/features/team/graph-panel.tsx'), /useAgentActionTargets/);
  assert.match(source('../src/features/team/teams-editor.tsx'), /archivedAgents\.map/);
  assert.match(source('../src/features/team/teams-editor.tsx'), />Restore<\/Button>/);
});

test('chat attachments and dictation require explicit actions and report failures', () => {
  const chats = source('../src/pages/chats.tsx');
  assert.match(chats, /bridge\.attachFiles\(\)/);
  assert.match(chats, /onDrop=/);
  assert.match(chats, /saveClipboardImage/);
  assert.match(chats, /getUserMedia\(\{ audio: true \}\)/);
  assert.match(chats, /recorder\.current\.stop\(\)/);
  assert.match(chats, /track\.stop\(\)/);
  assert.match(chats, /aria-live="polite"/);
  assert.match(chats, /Attached file: \$\{file\.path\}/);
});

test('agent profile exposes an explicit provider/account/model switch that starts fresh', () => {
  const sheet = source('../src/features/team/agent-profile.tsx');
  assert.match(sheet, /type: 'agent\.switch'/);
  assert.match(sheet, /LauncherSelect discovery=\{models\?\.launchers\} provider=\{switchProvider\}/);
  assert.match(sheet, /start fresh/);
  assert.match(sheet, /unsaved conversation context was not transferred/);
  const main = source('../../src/main/index.ts');
  assert.match(main, /suppressLauncherSave: true/);
  assert.match(main, /preserveEngineSession/);
  assert.match(main, /target\.provider, target\.model \|\| undefined, targetLauncher, false/);
});
