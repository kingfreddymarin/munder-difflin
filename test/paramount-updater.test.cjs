'use strict';
// The Paramount shell runs initAutoUpdater with feed:false. The update actions
// a renderer can invoke must answer "unsupported" and never reach the Munder
// release feed or electron-updater (review finding 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-updater-'));
const handlers = new Map();
const reached = [];
function stub(id, exports) {
  const file = require.resolve(id);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('electron', {
  app: { isPackaged: true, getPath: () => userData, getVersion: () => '0.0.1' },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
  shell: { openExternal: () => reached.push('openExternal') }
});
const record = (what) => () => { reached.push(what); return Promise.resolve({}); };
stub('electron-updater', {
  autoUpdater: {
    on: () => {},
    checkForUpdates: record('checkForUpdates'),
    downloadUpdate: record('downloadUpdate'),
    quitAndInstall: () => reached.push('quitAndInstall')
  }
});
https.request = () => { reached.push('https.request'); throw new Error('network is off in tests'); };

const { initAutoUpdater } = loadTs('src/main/updater.ts');

test('feed:false: update actions return unsupported and never touch the feed', async () => {
  initAutoUpdater(() => null, { feed: false });
  for (const channel of ['update:restartAndInstall', 'update:checkNow', 'update:download']) {
    const result = await Promise.race([
      handlers.get(channel)(),
      new Promise((r) => setTimeout(() => r({ hung: channel }), 200))
    ]);
    assert.equal(result.ok, false, channel);
    assert.equal(result.unsupported, true, channel);
  }
  assert.deepEqual(reached, []);
});
