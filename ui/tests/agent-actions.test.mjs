import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const hookSrc = readFileSync(new URL('../src/features/team/agent-actions.ts', import.meta.url), 'utf8');
const menuSrc = readFileSync(new URL('../src/features/team/agent-action-menu.tsx', import.meta.url), 'utf8');
const sheetSrc = readFileSync(new URL('../src/features/team/agent-sheet.tsx', import.meta.url), 'utf8');

const ACTION_IDS = ['open-terminal', 'open-profile', 'rename', 'pause', 'restart', 'archive', 'send-note'];

test('agent-actions hook exports AgentActionId union covering all required actions', () => {
  for (const id of ACTION_IDS) {
    assert.ok(hookSrc.includes(`'${id}'`), `AgentActionId missing: ${id}`);
  }
});

test('agent-actions hook returns all action ids in actions array', () => {
  for (const id of ACTION_IDS) {
    assert.ok(hookSrc.includes(`id: '${id}'`), `actions array missing entry for: ${id}`);
  }
});

test('pause action label flips between Pause and Resume based on onHold', () => {
  assert.match(hookSrc, /onHold \? ['"]Resume['"] : ['"]Pause['"]/);
});

test('pause action calls hiveSetAgentHold with toggled value', () => {
  assert.match(hookSrc, /bridge\.hiveSetAgentHold\(agentId, next\)/);
  assert.match(hookSrc, /const next = !onHold/);
});

test('rename action calls hiveRenameAgent', () => {
  assert.match(hookSrc, /bridge\.hiveRenameAgent\(agentId, newName\)/);
});

test('agent-action-menu imports useAgentActions from shared hook', () => {
  assert.match(menuSrc, /import.*useAgentActions.*from ['"]\.\/agent-actions['"]/);
});

test('agent-action-menu uses the shared actions array from useAgentActions', () => {
  assert.match(menuSrc, /const \{.*actions.*\}.*=.*useAgentActions\(/);
  assert.match(menuSrc, /actions\.map\(/);
});

test('agent-sheet imports useAgentActions from shared hook', () => {
  assert.match(sheetSrc, /import.*useAgentActions.*from ['"]\.\/agent-actions['"]/);
});

test('agent-sheet filters out open-profile from action list', () => {
  assert.match(sheetSrc, /filter\(.*\.id.*!==.*['"]open-profile['"]\)/);
});

test('agent-sheet uses shared actions array in its Overview tab button row', () => {
  assert.match(sheetSrc, /profileActions\.map\(/);
  assert.match(sheetSrc, /runAction\(action\.id\)/);
});

test('agent-sheet renders pause-state label from shared hook (not duplicated)', () => {
  // The label must come from the hook, not be hardcoded twice in the sheet
  const pauseInSheet = [...sheetSrc.matchAll(/['"]Pause['"]/g)].length;
  assert.equal(pauseInSheet, 0, 'Pause label should not be hardcoded in agent-sheet; it comes from the shared hook');
});

test('agent-sheet handles rename inline with renameAgent from shared hook', () => {
  assert.match(sheetSrc, /renameAgent\(name\)/);
  assert.match(sheetSrc, /sheetMode.*===.*['"]rename['"]/);
});

test('agent-sheet handles restart inline via dispatch with agent.restart', () => {
  assert.match(sheetSrc, /type: ['"]agent\.restart['"]/);
  assert.match(sheetSrc, /sheetMode.*===.*['"]restart['"]/);
});

test('electron-api.d.ts declares hiveSetAgentHold and hiveRenameAgent as optional members', () => {
  const apiSrc = readFileSync(new URL('../src/data/electron-api.d.ts', import.meta.url), 'utf8');
  assert.match(apiSrc, /hiveSetAgentHold\?/);
  assert.match(apiSrc, /hiveRenameAgent\?/);
});
