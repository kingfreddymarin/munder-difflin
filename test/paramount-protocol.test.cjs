'use strict';
// Review findings 3 and 4: paramount:// must be served on every session that
// loads the UI (floors use their own persist:floor-* partition), must not leave
// the bundled UI root (lexically or through a symlink), and Paramount must
// never claim Munder Difflin's munderdifflin:// deep links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

function fakeSession(name) {
  const handled = [];
  return { name, handled, protocol: { handle: (scheme, fn) => {
    if (handled.some((h) => h.scheme === scheme)) throw new Error(`${scheme} already handled on ${name}`);
    handled.push({ scheme, fn });
  } } };
}

const defaultSession = fakeSession('default');
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { isPackaged: true, setName() {}, setPath() {}, commandLine: { getSwitchValue: () => '' }, getPath: () => os.tmpdir() },
    protocol: { registerSchemesAsPrivileged() {} },
    session: { defaultSession },
    net: { fetch: async (url) => ({ url }) }
  }
};
process.resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-res-'));
const { registerParamountProtocol, resolveUiAsset } = loadTs('src/main/paramountShell.ts');

test('registers paramount:// on each session once, including floor partitions', () => {
  const floorA = fakeSession('persist:floor-1');
  const floorB = fakeSession('persist:floor-2');
  registerParamountProtocol();
  registerParamountProtocol(floorA);
  registerParamountProtocol(floorB);
  registerParamountProtocol(floorA); // idempotent: a second handle() would throw
  registerParamountProtocol();
  for (const s of [defaultSession, floorA, floorB]) {
    assert.deepEqual(s.handled.map((h) => h.scheme), ['paramount'], s.name);
  }
});

test('resolveUiAsset serves files, falls back to index.html, rejects escapes', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ui-')));
  const root = path.join(base, 'ui');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), '//');
  fs.writeFileSync(path.join(base, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(base, 'secret.txt'), path.join(root, 'leak.txt'));
  fs.symlinkSync(base, path.join(root, 'outside'));

  assert.equal(resolveUiAsset(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'));
  assert.equal(resolveUiAsset(root, '/some/route'), path.join(root, 'index.html'));
  assert.equal(resolveUiAsset(root, '/../secret.txt'), null);
  assert.equal(resolveUiAsset(root, '/..%2Fsecret.txt'), null);
  assert.equal(resolveUiAsset(root, '/leak.txt'), null, 'file symlink escaping the root');
  assert.equal(resolveUiAsset(root, '/outside/secret.txt'), null, 'dir symlink escaping the root');
});

test('Paramount never claims or handles munderdifflin:// deep links', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.doesNotMatch(src, /setAsDefaultProtocolClient\s*\(/);
  assert.doesNotMatch(src, /app\.on\(\s*['"]open-url['"]/);
  assert.doesNotMatch(src, /startsWith\(\s*['"]munderdifflin:\/\//);
});
