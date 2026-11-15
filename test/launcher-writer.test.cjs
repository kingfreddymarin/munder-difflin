'use strict';
// NSC-227 B3 (PRODUCT-STANDARD-IN-APP-RECOVERY): a least-privilege writer for account launchers.
// It edits only the one file that defines a discovered alias, only to append or remove an allowlisted
// flag, only with a one-change grant from a preview, and it backs up, syntax-checks, writes atomically,
// reads back and restores on any mismatch. Every file here is a temp fixture; no real shell file is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createLauncherWriter, LAUNCHER_WRITER_FLAGS } = loadTs('src/main/launcher-writer.ts');

const TELEGRAM = '--channels plugin:telegram@claude-plugins-official';
const ZSHRC = [
  '# owner settings',
  'export PATH="$HOME/bin:$PATH"',
  "alias dc='CLAUDE_CONFIG_DIR=$HOME/.claude-work claude'",
  "alias dcx='CODEX_HOME=$HOME/.codex-work codex'",
  'setopt AUTO_CD',
  ''
].join('\n');

function fixture(t, files = { '.zshrc': ZSHRC }, opts = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-launcher-writer-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(home, name), body, { mode: 0o644 });
  let clock = 1_000;
  const syntax = [];
  const writer = createLauncherWriter({
    candidates: () => Object.keys(files).map((name) => path.join(home, name)),
    syntaxCheck: (file) => { syntax.push(fs.readFileSync(file, 'utf8')); return opts.syntaxOk === false ? { ok: false } : { ok: true }; },
    now: () => clock,
    randomId: (() => { let n = 0; return () => `id${++n}`; })(),
    ...(opts.fs ? { fs: opts.fs } : {})
  });
  return { home, writer, syntax, file: path.join(home, '.zshrc'), tick: (ms) => { clock += ms; } };
}
const backups = (home) => fs.readdirSync(home).filter((name) => name.includes('.paramount-backup-'));

test('only the exact owner-approved Claude Telegram flag is allowlisted', () => {
  assert.deepEqual([...LAUNCHER_WRITER_FLAGS].map((f) => [f.provider, f.flag]), [['claude', TELEGRAM]]);
});

test('preview then apply appends the flag to the one defining line; backup kept, nothing else changed', (t) => {
  const f = fixture(t);
  const preview = f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM });
  assert.equal(preview.ok, true);
  assert.equal(preview.file, f.file);
  assert.equal(preview.before, "alias dc='CLAUDE_CONFIG_DIR=$HOME/.claude-work claude'");
  assert.equal(preview.after, `alias dc='CLAUDE_CONFIG_DIR=$HOME/.claude-work claude ${TELEGRAM}'`);
  assert.equal(fs.readFileSync(f.file, 'utf8'), ZSHRC, 'a preview writes nothing');
  const applied = f.writer.apply(preview.grantId);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const after = fs.readFileSync(f.file, 'utf8');
  assert.equal(after, ZSHRC.replace(preview.before, preview.after));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o644, 'the file keeps its mode');
  assert.equal(fs.readFileSync(applied.backup, 'utf8'), ZSHRC, 'the backup holds the original');
  assert.equal(fs.statSync(applied.backup).mode & 0o777, 0o600);
  assert.equal(f.syntax.length, 1, 'the new content was syntax-checked before it replaced the file');
});

test('remove takes the flag back out; append twice or remove when absent is refused', (t) => {
  const f = fixture(t);
  assert.equal(f.writer.apply(f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).grantId).ok, true);
  assert.equal(f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'NO_CHANGE');
  const removed = f.writer.apply(f.writer.preview({ alias: 'dc', op: 'remove', flag: TELEGRAM }).grantId);
  assert.equal(removed.ok, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), ZSHRC);
  assert.equal(f.writer.preview({ alias: 'dc', op: 'remove', flag: TELEGRAM }).code, 'NO_CHANGE');
});

test('a grant is for one change only: reused, expired, unknown or stale grants are refused', (t) => {
  const f = fixture(t);
  const first = f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM });
  assert.equal(f.writer.apply(first.grantId).ok, true);
  assert.equal(f.writer.apply(first.grantId).code, 'GRANT_INVALID', 'used once');
  assert.equal(f.writer.apply('made-up').code, 'GRANT_INVALID');
  const late = f.writer.preview({ alias: 'dc', op: 'remove', flag: TELEGRAM });
  f.tick(5 * 60_000 + 1);
  assert.equal(f.writer.apply(late.grantId).code, 'GRANT_EXPIRED');
  const stale = f.writer.preview({ alias: 'dc', op: 'remove', flag: TELEGRAM });
  fs.appendFileSync(f.file, 'alias other=ls\n');
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.writer.apply(stale.grantId).code, 'FILE_CHANGED');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before, 'a file changed since the preview is left alone');
  f.writer.discard(f.writer.preview({ alias: 'dc', op: 'remove', flag: TELEGRAM }).grantId);
});

test('no free text: unknown flags, wrong provider, unknown ops and unknown launchers are refused', (t) => {
  const f = fixture(t);
  assert.equal(f.writer.preview({ alias: 'dc', op: 'append', flag: '--dangerously-skip-permissions' }).code, 'INVALID_FLAG');
  assert.equal(f.writer.preview({ alias: 'dc', op: 'append', flag: `${TELEGRAM}; rm -rf ~` }).code, 'INVALID_FLAG');
  assert.equal(f.writer.preview({ alias: 'dcx', op: 'append', flag: TELEGRAM }).code, 'INVALID_FLAG', 'a Codex launcher cannot take a Claude flag');
  assert.equal(f.writer.preview({ alias: 'dc', op: 'replace', flag: TELEGRAM }).code, 'INVALID_INPUT');
  assert.equal(f.writer.preview({ alias: 'rm', op: 'append', flag: TELEGRAM }).code, 'INVALID_INPUT');
  assert.equal(fs.readFileSync(f.file, 'utf8'), ZSHRC);
});

test('fails closed on an ambiguous or unsupported definition, credentials, symlinks and a missing alias', (t) => {
  const twoFiles = fixture(t, { '.zshrc': ZSHRC, '.zprofile': "alias dc='claude'\n" });
  assert.equal(twoFiles.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'AMBIGUOUS');
  const twice = fixture(t, { '.zshrc': ZSHRC + "alias dc='claude'\n" });
  assert.equal(twice.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'AMBIGUOUS');
  const fn = fixture(t, { '.zshrc': ZSHRC + 'dc() { claude "$@"; }\n' });
  assert.equal(fn.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'AMBIGUOUS', 'also defined as a function');
  const cond = fixture(t, { '.zshrc': "if true; then alias dc='claude'; fi\n" });
  assert.equal(cond.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'UNSUPPORTED_DEFINITION');
  const sub = fixture(t, { '.zshrc': "alias dc='claude $(cat token)'\n" });
  assert.equal(sub.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'UNSUPPORTED_DEFINITION');
  const secret = fixture(t, { '.zshrc': "alias dc='ANTHROPIC_API_KEY=sk-test claude'\n" });
  const refused = secret.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM });
  assert.equal(refused.code, 'CREDENTIAL_IN_DEFINITION');
  assert.ok(!JSON.stringify(refused).includes('sk-test'), 'the refusal never echoes the definition');
  const none = fixture(t, { '.zshrc': 'setopt AUTO_CD\n' });
  assert.equal(none.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'NOT_FOUND');
  const link = fixture(t, { 'real-zshrc': ZSHRC });
  fs.symlinkSync(path.join(link.home, 'real-zshrc'), path.join(link.home, '.zshrc'));
  const linked = createLauncherWriter({ candidates: () => [path.join(link.home, '.zshrc')], syntaxCheck: () => ({ ok: true }), now: () => 0, randomId: () => 'x' });
  assert.equal(linked.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).code, 'SYMLINK');
});

test('a file swapped for a symlink after the preview is refused and left alone', (t) => {
  const f = fixture(t);
  const preview = f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM });
  fs.renameSync(f.file, path.join(f.home, 'moved'));
  fs.symlinkSync(path.join(f.home, 'moved'), f.file);
  assert.equal(f.writer.apply(preview.grantId).code, 'PATH_CHANGED');
  assert.equal(fs.readFileSync(path.join(f.home, 'moved'), 'utf8'), ZSHRC);
  assert.deepEqual(backups(f.home), []);
});

test('a syntax failure writes nothing and leaves no temp file', (t) => {
  const f = fixture(t, undefined, { syntaxOk: false });
  const result = f.writer.apply(f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).grantId);
  assert.equal(result.code, 'SYNTAX_FAILED');
  assert.equal(fs.readFileSync(f.file, 'utf8'), ZSHRC);
  assert.deepEqual(fs.readdirSync(f.home).sort(), ['.zshrc']);
});

test('a read-back mismatch restores the backup', (t) => {
  // Something writes to the file between the atomic rename and the read-back.
  const realFs = { lstatSync: fs.lstatSync, realpathSync: fs.realpathSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync,
    renameSync: (a, b) => { fs.renameSync(a, b); if (!b.includes('.paramount-')) { tampered += 1; if (tampered === 1) fs.appendFileSync(b, 'echo injected\n'); } } };
  let tampered = 0;
  const f = fixture(t, undefined, { fs: realFs });
  const result = f.writer.apply(f.writer.preview({ alias: 'dc', op: 'append', flag: TELEGRAM }).grantId);
  assert.equal(result.code, 'VERIFY_FAILED');
  assert.equal(result.restored, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), ZSHRC, 'the original is back');
  assert.equal(backups(f.home).length, 1, 'the backup is kept for the owner');
});

test('a real zsh syntax check accepts the edited fixture and rejects a broken one', { skip: !fs.existsSync('/bin/zsh') }, (t) => {
  const { zshSyntaxCheck } = loadTs('src/main/launcher-writer.ts');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-zsh-n-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ok'), ZSHRC);
  fs.writeFileSync(path.join(dir, 'bad'), "alias dc='claude\nif then\n");
  assert.equal(zshSyntaxCheck(path.join(dir, 'ok')).ok, true);
  assert.equal(zshSyntaxCheck(path.join(dir, 'bad')).ok, false);
});
