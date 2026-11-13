import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/app/app-shell.tsx', import.meta.url), 'utf8');

test('global More menu exposes existing secondary screens and floor picker', () => {
  for (const label of ['More app actions', 'Open another floor…', 'Agents & temps', 'Automations', 'Engines & models', 'Terminal', 'Connections', 'Settings', 'Diagnostics']) {
    assert.ok(source.includes(label), `missing More menu entry: ${label}`);
  }
  assert.match(source, /type: 'floor\.picker', open: true/);
  assert.match(source, /go\('settings', \{ tab: 'providers' \}\)/);
  assert.match(source, /go\('settings', \{ tab: 'connections' \}\)/);
  assert.match(source, /<DropdownMenuContent align="end" collisionPadding=\{8\}/);
});
