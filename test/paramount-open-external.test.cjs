'use strict';
// Lane a-shell: shell.openExternal (allow-listed links) and shell.openIn (Warp / VS Code on a folder).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { checkLink, hostAllowed } = loadTs('src/main/paramount-shell.ts');

function deps(overrides = {}) {
  const calls = { opened: [], launched: [], steps: [], events: [] };
  const shell = {
    platform: 'darwin',
    openExternal: async (url) => { calls.opened.push(url); },
    launch: async (appName, dir) => { calls.launched.push([appName, dir]); return { ok: true }; },
    logStep: (step) => calls.steps.push(step),
    ...overrides
  };
  return {
    calls,
    deps: {
      tasks: () => ({ tasks: [] }), patchTask: () => true, missions: () => [], saveMissions: () => {},
      agents: () => ({}), renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {},
      savePreference: () => {}, appendEvent: (e) => calls.events.push(e), publish: () => {},
      shell
    }
  };
}

test('opens allow-listed GitHub and Azure DevOps links', async () => {
  for (const url of [
    'https://github.com/kingfreddymarin/munder-difflin/pull/23572',
    'https://github.com/o/r/actions/runs/61204',
    'https://dev.azure.com/org/project/_workitems/edit/19871',
    'https://org.visualstudio.com/project/_build/results?buildId=61204'
  ]) {
    const { calls, deps: d } = deps();
    const result = await dispatchParamount({ type: 'shell.openExternal', url }, d);
    assert.equal(result.ok, true, url);
    assert.deepEqual(calls.opened, [new URL(url).href]);
    assert.equal(calls.steps[0].kind, 'paramount-shell');
    assert.equal(calls.steps[0].cid, result.event.correlationId);
  }
});

test('refuses other hosts, schemes and credentials with an errorId, and opens nothing', async () => {
  const refused = [
    'https://evil.com/github.com', 'https://github.com.evil.com/x', 'https://visualstudio.com/x', 'file:///etc/passwd',
    'javascript:alert(1)', 'https://user:pw@github.com/x', 'ftp://github.com/x', 'not a url', 'https://github.com/\nx', ''
  ];
  for (const url of refused) {
    const { calls, deps: d } = deps();
    const result = await dispatchParamount({ type: 'shell.openExternal', url }, d);
    assert.equal(result.ok, false, url);
    assert.equal(result.code, 'INVALID_INPUT', url);
    assert.match(result.errorId, /^E-/);
    assert.deepEqual(calls.opened, [], url);
  }
});

test('extra fields are refused', async () => {
  const { calls, deps: d } = deps();
  const result = await dispatchParamount({ type: 'shell.openExternal', url: 'https://github.com/x', token: 'x' }, d);
  assert.equal(result.code, 'INVALID_INPUT');
  assert.deepEqual(calls.opened, []);
});

test('a browser failure is INTERNAL with an errorId', async () => {
  const { deps: d } = deps({ openExternal: async () => { throw new Error('no handler'); } });
  const result = await dispatchParamount({ type: 'shell.openExternal', url: 'https://github.com/x' }, d);
  assert.equal(result.code, 'INTERNAL');
  assert.match(result.message, /no handler/);
});

test('host rules: exact hosts and *.visualstudio.com subdomains only', () => {
  assert.equal(hostAllowed('GitHub.com'), true);
  assert.equal(hostAllowed('api.github.com'), false);
  assert.equal(hostAllowed('a.visualstudio.com'), true);
  assert.equal(hostAllowed('visualstudio.com'), false);
  assert.equal(hostAllowed('evilvisualstudio.com'), false);
  assert.equal(checkLink('http://github.com/x').ok, true);
});

test('opens an existing folder in Warp and VS Code by its real path', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-open-')));
  try {
    for (const [app, name] of [['warp', 'Warp'], ['vscode', 'Visual Studio Code']]) {
      const { calls, deps: d } = deps();
      const result = await dispatchParamount({ type: 'shell.openIn', app, path: `${dir}/.` }, d);
      assert.equal(result.ok, true);
      assert.deepEqual(calls.launched, [[name, dir]]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses relative, missing, file and shell-looking paths', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-open-')));
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  try {
    const cases = [
      ['relative/dir', 'INVALID_INPUT'], [path.join(dir, 'missing'), 'NOT_FOUND'], [file, 'INVALID_INPUT'],
      [`${dir}; rm -rf ~`, 'NOT_FOUND'], [`$(touch ${dir}/pwned)`, 'INVALID_INPUT'], [`${dir}\nx`, 'INVALID_INPUT']
    ];
    for (const [p, code] of cases) {
      const { calls, deps: d } = deps();
      const result = await dispatchParamount({ type: 'shell.openIn', app: 'warp', path: p }, d);
      assert.equal(result.ok, false, p);
      assert.equal(result.code, code, p);
      assert.match(result.errorId, /^E-/);
      assert.deepEqual(calls.launched, [], p);
    }
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown app, missing app, non-mac and missing deps fail with codes', async () => {
  const dir = os.tmpdir();
  let r = await dispatchParamount({ type: 'shell.openIn', app: 'bash', path: dir }, deps().deps);
  assert.equal(r.code, 'INVALID_INPUT');
  r = await dispatchParamount({ type: 'shell.openIn', app: 'warp', path: dir }, deps({ launch: async () => ({ ok: false, error: 'Unable to find application named \'Warp\'', missingApp: true }) }).deps);
  assert.equal(r.code, 'NOT_FOUND');
  assert.match(r.message, /Warp is not installed/);
  r = await dispatchParamount({ type: 'shell.openIn', app: 'vscode', path: dir }, deps({ platform: 'linux' }).deps);
  assert.equal(r.code, 'UNSUPPORTED');
  const { deps: d } = deps();
  delete d.shell;
  r = await dispatchParamount({ type: 'shell.openExternal', url: 'https://github.com/x' }, d);
  assert.equal(r.code, 'UNSUPPORTED');
});

test('VS Code receives the canonical path to an existing file', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-open-file-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notes and changes.txt');
  fs.writeFileSync(file, 'Fixture');
  const { calls, deps: d } = deps();
  const result = await dispatchParamount({ type: 'shell.openIn', app: 'vscode', path: file }, d);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.launched, [['Visual Studio Code', file]]);
});
