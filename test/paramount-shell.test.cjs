'use strict';
// First launch on a clean profile: the Paramount userData dir does not exist
// yet and Electron's app.setPath throws for a missing directory, so the shell
// must create it before setting it (review finding 1).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-appdata-'));
const calls = [];
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: {
      setName: () => {},
      getPath: (name) => (name === 'appData' ? appData : calls.at(-1)),
      // Mirror Electron: setPath on a missing directory throws.
      setPath: (name, p) => {
        if (!fs.existsSync(p)) throw new Error(`Failed to set path: ${p} does not exist`);
        calls.push(p);
      }
    },
    net: {},
    protocol: { registerSchemesAsPrivileged: () => {} }
  }
};

test('clean profile: missing Paramount userData dir is created, then set', () => {
  const expected = path.join(appData, 'Paramount');
  assert.equal(fs.existsSync(expected), false);
  const { paramountHome } = loadTs('src/main/paramountShell.ts');
  assert.equal(fs.statSync(expected).isDirectory(), true);
  assert.deepEqual(calls, [expected]);
  assert.equal(paramountHome(), expected);
});
