'use strict';
// Matrix row 16: model defaults follow the configured catalog; Munder 0.5.7's
// default (Opus 5.5) is used only when the catalog offers it.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { supportedModel, resolveAgentModel, offeredModelIds, MUNDER_DEFAULT_MODEL } = loadTs('src/main/paramount-models.ts');

const offered = (provider) => ({ claude: ['claude-opus-5-5', 'claude-sonnet-5-5'], codex: ['gpt-5-codex'] }[provider] ?? []);

test('a model the catalog offers is kept; anything else falls to the engine default', () => {
  assert.equal(supportedModel('claude', 'claude-opus-5-5', offered), 'claude-opus-5-5');
  assert.equal(supportedModel('claude', 'claude-opus-4-8', offered), undefined);
  assert.equal(supportedModel('codex', 'claude-opus-5-5', offered), undefined, 'a Claude model never reaches another engine');
  assert.equal(supportedModel('claude', undefined, offered), undefined);
});

test('choices resolve in priority order, skipping unsupported ones', () => {
  assert.equal(resolveAgentModel('claude', ['claude-sonnet-5-5', 'claude-opus-5-5'], offered), 'claude-sonnet-5-5');
  assert.equal(resolveAgentModel('claude', ['stale-pick', MUNDER_DEFAULT_MODEL], offered), 'claude-opus-5-5');
  assert.equal(resolveAgentModel('codex', [MUNDER_DEFAULT_MODEL, 'claude-sonnet-4-6'], offered), undefined);
});

test('offered ids come from the first catalog that parses, version-filtered', () => {
  const parse = (raw) => (raw && raw.providers ? raw : null);
  const filter = (catalog) => Object.entries(catalog.providers).map(([id, models]) => ({ id, models: models.filter((m) => !m.hidden) }));
  const remote = { providers: { claude: [{ id: 'claude-fable-5-2' }, { id: 'claude-opus-5-5' }, { id: 'x', hidden: true }, { label: 'default' }] } };
  const baked = { providers: { claude: [{ id: 'claude-opus-4-8' }] } };
  assert.deepEqual(offeredModelIds('claude', [null, remote, baked], '0.4.6', parse, filter), ['claude-fable-5-2', 'claude-opus-5-5']);
  assert.deepEqual(offeredModelIds('claude', ['garbage', baked], '0.4.6', parse, filter), ['claude-opus-4-8']);
  assert.deepEqual(offeredModelIds('codex', [remote], '0.4.6', parse, filter), []);
});

test('config defaults match Munder 0.5.7 and are offered by the bundled catalog', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src/main/config.ts'), 'utf8');
  assert.match(src, /godModel: 'claude-opus-5-5'/);
  assert.match(src, /defaultModel: 'claude-opus-5-5'/);
  assert.doesNotMatch(src, /godModel: 'claude-opus-4-8'|defaultModel: 'claude-fable-5'/);
  const baked = require('../src/shared/modelCatalog.json');
  assert.ok(baked.providers.claude.some((m) => m.id === MUNDER_DEFAULT_MODEL));
});
