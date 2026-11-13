'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readOrg, saveOrg, validateOrg } = loadTs('src/main/paramount-org.ts');

test('teams persist and validate existing members and reporting hierarchy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-org-'));
  const value = { version: 1, teams: [{ id: 'research', name: 'Research', leadId: 'lead', memberIds: ['member'] }], reportsTo: { member: 'lead' } };
  assert.deepEqual(saveOrg(root, value, ['lead', 'member']), { ...value, teams: [{ ...value.teams[0], memberIds: ['lead', 'member'] }] });
  assert.deepEqual(readOrg(root, ['lead', 'member']), { ...value, teams: [{ ...value.teams[0], memberIds: ['lead', 'member'] }] });
});

test('team organization rejects duplicate ids, unknown agents, self lines and cycles', () => {
  const base = { version: 1, teams: [], reportsTo: {} };
  assert.throws(() => validateOrg({ ...base, teams: [{ id: 'x', name: 'X', leadId: 'missing', memberIds: [] }] }, ['a']), /existing agents/);
  assert.throws(() => validateOrg({ ...base, reportsTo: { a: 'a' } }, ['a']), /itself/);
  assert.throws(() => validateOrg({ ...base, reportsTo: { a: 'b', b: 'a' } }, ['a', 'b']), /cycle/);
  assert.throws(() => validateOrg({ ...base, teams: [{ id: 'x', name: 'X', leadId: 'a', memberIds: [] }, { id: 'x', name: 'Y', leadId: 'a', memberIds: [] }] }, ['a']), /unique/);
});
