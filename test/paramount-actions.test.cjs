'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const root = path.join(__dirname, '..');
const load = (name) => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
const runs = (workflow) => Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.run ?? ''));
const productBuild = /npm run build\b|electron-builder/;

test('ordinary CI validates source without generating a product build', () => {
  const ci = load('ci.yml');
  assert.ok(runs(ci).every((run) => !productBuild.test(run)));
  assert.deepEqual(ci.on.pull_request['branches-ignore'], ['release']);
  assert.equal(ci.jobs.typecheck.uses, './.github/workflows/typecheck.yml');
  assert.equal(ci.jobs.tests.uses, './.github/workflows/tests.yml');
  assert.deepEqual(ci.jobs.tests.needs, ['typecheck']);
});

test('release orchestration is triggered only by a PR targeting release, never tags or manual runs', () => {
  const release = load('release.yml');
  assert.deepEqual(Object.keys(release.on), ['pull_request']);
  assert.deepEqual(release.on.pull_request.branches, ['release']);
  for (const event of ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited']) {
    assert.ok(release.on.pull_request.types.includes(event), event);
  }
  assert.equal(release.jobs.typecheck.uses, './.github/workflows/typecheck.yml');
  assert.deepEqual(release.jobs.tests.needs, ['typecheck']);
  assert.deepEqual(release.jobs.build.needs, ['typecheck', 'tests']);
  assert.equal(release.jobs.build.uses, './.github/workflows/build.yml');
});

test('validation actions are reusable and contain no product build steps', () => {
  for (const name of ['typecheck.yml', 'tests.yml']) {
    const workflow = load(name);
    assert.deepEqual(Object.keys(workflow.on), ['workflow_call']);
    assert.ok(runs(workflow).every((run) => !productBuild.test(run)), name);
    assert.equal(workflow.permissions.contents, 'read');
  }
  assert.ok(runs(load('typecheck.yml')).some((run) => /npm run typecheck/.test(run)));
  assert.ok(runs(load('tests.yml')).some((run) => /npm run test:focused/.test(run)));
});

test('packaging cannot be independently dispatched and preserves read-only artifact delivery', () => {
  const build = load('build.yml');
  assert.deepEqual(Object.keys(build.on), ['workflow_call']);
  assert.equal(build.permissions.contents, 'read');
  assert.match(build.jobs.dmg.if, /github.event_name == 'pull_request'/);
  assert.match(build.jobs.dmg.if, /github.base_ref == 'release'/);
  const commands = runs(build).join('\n');
  assert.match(commands, /--config electron-builder\.config\.cjs/);
  assert.match(commands, /--publish never/);
  assert.match(commands, /shasum -a 256/);
  const upload = build.jobs.dmg.steps.find((step) => step.uses?.startsWith('actions/upload-artifact') && step.with?.path?.includes('dist/*.dmg'));
  assert.ok(upload);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.match(upload.with.path, /build-info\.json/);
});
