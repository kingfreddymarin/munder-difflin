import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// default-models.ts has no imports, so it compiles to one self-contained module.
const outputDir = mkdtempSync(join(tmpdir(), 'paramount-default-models-test-'));
execFileSync('node_modules/.bin/tsc', [
  '--ignoreConfig', '--outDir', outputDir, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--skipLibCheck', 'src/lib/default-models.ts',
]);
const file = readdirSync(outputDir, { recursive: true }).find((name) => String(name).endsWith('default-models.js'));
const { defaultModelRows } = await import(pathToFileURL(join(outputDir, String(file))).href);

const catalog = { engines: [
  { id: 'claude', label: 'Claude Code', models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }] },
  { id: 'codex', label: 'Codex', models: [{ label: 'CLI default' }, { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
  { id: 'opencode', label: 'OpenCode', models: [{ label: 'CLI default' }, { id: 'anthropic/claude-opus-5-5', label: 'Opus via OpenCode' }] },
] };

test('defaultModelRows lists every engine with its full model list, not Claude only', () => {
  const rows = defaultModelRows(catalog, { defaultModel: 'claude-sonnet-5-5', providerDefaultModels: { codex: 'gpt-6-luna' } });
  assert.deepEqual(rows.map((row) => row.engine), ['claude', 'codex', 'opencode']);
  assert.deepEqual(rows[1].options.map((o) => o.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.equal(rows[0].value, 'claude-sonnet-5-5');
  assert.equal(rows[0].options.find((o) => o.id === 'claude-sonnet-5-5').label, 'Sonnet 5.5 · default');
  assert.equal(rows[0].options.find((o) => o.id === 'claude-opus-5-5').label, 'Opus 5.5');
  assert.equal(rows[1].options.find((o) => o.id === 'gpt-6-luna').label, 'GPT-6 Luna · default');
  assert.equal(rows[2].value, '');
  assert.ok(rows[2].options.every((o) => !o.label.endsWith('· default')));
});

test('defaultModelRows saves Claude to defaultModel and other engines to providerDefaultModels', () => {
  const [claude, codex] = defaultModelRows(catalog, {});
  assert.deepEqual(claude.patch('claude-opus-5-5'), { defaultModel: 'claude-opus-5-5' });
  assert.deepEqual(codex.patch('gpt-6.1-sol'), { providerDefaultModels: { codex: 'gpt-6.1-sol' } });
  assert.deepEqual(codex.patch(''), { providerDefaultModels: { codex: '' } });
});

test('defaultModelRows keeps a saved id the list no longer offers visible as custom', () => {
  const opencode = defaultModelRows(catalog, { providerDefaultModels: { opencode: 'openrouter/my-model' } })[2];
  assert.equal(opencode.value, 'openrouter/my-model');
  assert.deepEqual(opencode.options.at(-1), { id: 'openrouter/my-model', label: 'openrouter/my-model (custom) · default' });
});
