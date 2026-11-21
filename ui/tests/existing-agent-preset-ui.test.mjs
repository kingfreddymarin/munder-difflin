import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sheet = readFileSync(new URL('../src/features/team/agent-sheet.tsx', import.meta.url), 'utf8');
const preset = readFileSync(new URL('../src/features/team/agent-preset.ts', import.meta.url), 'utf8');

test('the selected existing agent Overview exposes the native preset save action', () => {
  assert.match(sheet, /<TabsContent value="overview">[\s\S]*?Save agent preset/);
  assert.match(sheet, /saveExistingAgentPreset\([\s\S]*?teamApi\.saveAgentPreset/);
  assert.match(preset, /spec: 'munder-difflin\/hire@1'/);
});
