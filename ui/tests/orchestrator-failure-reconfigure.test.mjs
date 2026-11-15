import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// NSC-193 (owner repro 2026-11-15): the orchestrator start-failure banner had no way out.
// It must offer Reconfigure, routing to Settings › Setup, and keep the failure text.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const banner = read('../src/app/hook-socket-banner.tsx');
const settings = read('../src/pages/settings.tsx');
const body = banner.slice(banner.indexOf('export function OrchestratorFailureBanner'));

test('the orchestrator failure banner shows a Reconfigure button', () => {
  const button = body.slice(body.indexOf('<Button'), body.indexOf('</Button>') + '</Button>'.length);
  assert.match(button, /data-testid="orchestrator-reconfigure"/);
  assert.match(button, /\}>Reconfigure<\/Button>$/);
  assert.ok(body.indexOf('<Button') < body.lastIndexOf('</div>'), 'button renders inside the banner');
});

test('Reconfigure routes to Settings › Setup', () => {
  assert.match(body, /onClick=\{\(\) => go\('settings', \{ tab: 'setup' \}\)\}/);
  assert.match(settings, /<TabsTrigger value="setup">Setup<\/TabsTrigger>/);
  assert.match(settings, /<TabsContent value="setup">/);
});

test('the failure text and alert role are preserved', () => {
  assert.match(body, /role="alert" data-testid="orchestrator-start-error"/);
  assert.match(body, /The orchestrator did not start/);
  assert.match(body, /\{failure\.message\}/);
});
