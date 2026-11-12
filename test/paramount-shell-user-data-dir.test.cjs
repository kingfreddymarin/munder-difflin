'use strict';
// An explicit --user-data-dir must win over the forced <appData>/Paramount
// path. Before the fix, a "disposable" test launch wrote into the real profile
// (task paramount-command-center, failures/2026-11-12T0812).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-appdata-'));
const disposable = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-udd-')), 'profile');
const calls = [];
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: {
      setName: () => {},
      commandLine: { getSwitchValue: (name) => (name === 'user-data-dir' ? disposable : '') },
      getPath: (name) => (name === 'appData' ? appData : calls.at(-1)),
      setPath: (name, p) => {
        if (!fs.existsSync(p)) throw new Error(`Failed to set path: ${p} does not exist`);
        calls.push(p);
      }
    },
    net: {},
    protocol: { registerSchemesAsPrivileged: () => {} }
  }
};

test('--user-data-dir: the disposable profile is used and the real one is never created', () => {
  const { paramountHome } = loadTs('src/main/paramountShell.ts');
  assert.deepEqual(calls, [disposable]);
  assert.equal(paramountHome(), disposable);
  assert.equal(fs.statSync(disposable).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(appData, 'Paramount')), false);
});
