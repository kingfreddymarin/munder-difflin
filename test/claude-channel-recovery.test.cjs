'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareClaudeTelegramChannel, createClaudeChannelUpdater, TELEGRAM_CHANNEL } = require('./load-ts.cjs')('src/main/claude-channel-recovery.ts');

const source = ['claude', 'dc', 'dcm'].map((name) => `function ${name}() {\n  ${name === 'dcm' ? 'CLAUDE_CONFIG_DIR="$HOME/.claude-minion" ' : ''}command claude --permission-mode default "$@"\n}`).join('\n');
const syntaxCheck = (text) => spawnSync('/bin/zsh', ['-n'], { input: text, encoding: 'utf8' }).status === 0;

test('prepares only the three Claude channel aliases, syntax checks, and is idempotent', () => {
  const plan = prepareClaudeTelegramChannel(source, syntaxCheck);
  assert.deepEqual(plan.changed, ['claude', 'dc', 'dcm']);
  assert.equal((plan.updated.match(/--channels/g) || []).length, 3);
  assert.ok(plan.updated.includes(`--channels ${TELEGRAM_CHANNEL} "$@"`));
  assert.match(plan.updated, /CLAUDE_CONFIG_DIR="\$HOME\/\.claude-minion" command claude --permission-mode default --channels/);
  const again = prepareClaudeTelegramChannel(plan.updated, syntaxCheck);
  assert.deepEqual(again.changed, []);
  assert.equal(again.updated, plan.updated);
});

test('rejects missing launchers, conflicting channel settings, and syntax failures without an edit', () => {
  assert.throws(() => prepareClaudeTelegramChannel(source.replace(/function dcm\(\)[\s\S]*$/, ''), syntaxCheck), /Missing launcher dcm/);
  assert.throws(() => prepareClaudeTelegramChannel(source.replace('command claude --permission-mode', 'command claude --channels plugin:another@source --permission-mode'), syntaxCheck), /already configures channels/);
  assert.throws(() => prepareClaudeTelegramChannel(source, () => false), /syntax checking/);
});

test('updater performs a fixed-target update and verifies backup bytes, mode, syntax, and one-use token', (t) => {
  const { dir, target, file } = fixture(t);
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck });
  const prepared = updater.prepare(target);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.changed, ['claude', 'dc', 'dcm']);
  const applied = updater.apply(prepared.planId);
  assert.equal(applied.ok, true);
  assert.equal(applied.recovery, 'unchanged');
  assert.equal(mode(target), 0o640);
  assert.equal(syntaxCheck(fs.readFileSync(target, 'utf8')), true);
  assert.match(applied.backup, /^~\/.minion-aliases\.sh\.backup-/);
  const backup = path.join(dir, path.basename(applied.backup));
  assert.equal(fs.readFileSync(backup, 'utf8'), source);
  assert.equal(mode(backup), 0o640);
  assert.equal(syntaxCheck(fs.readFileSync(backup, 'utf8')), true);
  assert.equal(updater.apply(prepared.planId).ok, false);
});

test('stale/intervening target edits are preserved and not overwritten', (t) => {
  const { target, file } = fixture(t);
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck });
  const prepared = updater.prepare(target);
  const external = `${source}\n# concurrent edit\n`;
  fs.writeFileSync(target, external, { mode: 0o640 });
  const applied = updater.apply(prepared.planId);
  assert.equal(applied.ok, false);
  assert.equal(applied.recovery, 'unchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), external);
});

test('edit during temporary-file preparation aborts before replacing the changed target', (t) => {
  const { target } = fixture(t);
  let armed = false;
  const file = realFileOps({ writeFile: (real, p, text, mode, exclusive) => {
    real.writeFile(p, text, mode, exclusive);
    if (armed && p.includes('.minion-aliases-') && p.endsWith('.tmp')) fs.appendFileSync(target, '# editor raced final check\n');
  } });
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck });
  const prepared = updater.prepare(target);
  armed = true;
  const result = updater.apply(prepared.planId);
  assert.equal(result.ok, false);
  assert.equal(result.recovery, 'unchanged');
  assert.match(fs.readFileSync(target, 'utf8'), /editor raced final check/);
});

test('post-replace verification failure restores exact original bytes and mode', (t) => {
  const { dir, target } = fixture(t);
  let injected = false;
  const file = realFileOps({ readFile: (real, p) => {
    const value = real.readFile(p);
    if (!injected && p === target && value !== source) { injected = true; return `${value}# injected verification mismatch\n`; }
    return value;
  } });
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck });
  const prepared = updater.prepare(target);
  const result = updater.apply(prepared.planId);
  assert.equal(injected, true);
  assert.equal(result.ok, false);
  assert.equal(result.recovery, 'restored');
  assert.equal(fs.readFileSync(target, 'utf8'), source);
  assert.equal(mode(target), 0o640);
  assert.equal(syntaxCheck(fs.readFileSync(target, 'utf8')), true);
  const backup = path.join(dir, path.basename(result.backup));
  assert.equal(fs.readFileSync(backup, 'utf8'), source);
  assert.equal(mode(backup), 0o640);
});

test('failed restoration reports manual recovery and leaves a verified safe backup', (t) => {
  const { dir, target } = fixture(t);
  let injected = false;
  let updateRenameDone = false;
  const file = realFileOps({
    readFile: (real, p) => {
      const value = real.readFile(p);
      if (!injected && p === target && value !== source) { injected = true; return `${value}# injected verification mismatch\n`; }
      return value;
    },
    rename: (real, from, to) => {
      if (to === target && from.includes('.minion-aliases-restore-')) throw Object.assign(new Error('injected restore EIO'), { code: 'EIO' });
      real.rename(from, to);
      if (to === target) updateRenameDone = true;
    },
  });
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck });
  const prepared = updater.prepare(target);
  const result = updater.apply(prepared.planId);
  assert.equal(updateRenameDone, true);
  assert.equal(result.ok, false);
  assert.equal(result.recovery, 'manual-restore');
  assert.match(result.error, /restore the verified backup manually/);
  assert.ok(result.backup);
  const backup = path.join(dir, path.basename(result.backup));
  assert.equal(fs.readFileSync(backup, 'utf8'), source);
  assert.equal(mode(backup), 0o640);
  assert.equal(syntaxCheck(fs.readFileSync(backup, 'utf8')), true);
});

test('wrong target, symlink target, and expired review cannot be applied', (t) => {
  const { dir, target, file } = fixture(t);
  const updater = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck, now: () => 1000, token: () => 'a'.repeat(48) });
  assert.equal(updater.prepare(path.join(dir, 'other.sh')).ok, false);
  const prepared = updater.prepare(target);
  const symlink = path.join(dir, 'link.sh');
  fs.symlinkSync(target, symlink);
  assert.equal(createClaudeChannelUpdater({ targetPath: symlink, file, syntaxCheck }).prepare(symlink).ok, false);
  void prepared;
  let current = 1000;
  const expiring = createClaudeChannelUpdater({ targetPath: target, file, syntaxCheck, now: () => current, token: () => 'b'.repeat(48) });
  const expiringPlan = expiring.prepare(target);
  current += 5 * 60_000 + 1;
  const expired = expiring.apply(expiringPlan.planId);
  assert.equal(expired.ok, false);
  assert.equal(expired.recovery, 'unchanged');
  assert.equal(fs.readFileSync(target, 'utf8'), source);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'paramount-channel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.minion-aliases.sh');
  fs.writeFileSync(target, source, { mode: 0o640 });
  fs.chmodSync(target, 0o640);
  return { dir, target, file: realFileOps() };
}
function mode(file) { return fs.lstatSync(file).mode & 0o777; }
function realFileOps(overrides = {}) {
  const real = {
    lstat: (p) => fs.lstatSync(p), readFile: (p) => fs.readFileSync(p, 'utf8'),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    writeFile: (p, text, mode, exclusive) => fs.writeFileSync(p, text, { encoding: 'utf8', mode, flag: exclusive ? 'wx' : 'w' }),
    chmod: (p, mode) => fs.chmodSync(p, mode), rename: (from, to) => fs.renameSync(from, to), unlink: (p) => fs.unlinkSync(p),
  };
  return Object.fromEntries(Object.entries(real).map(([key, fn]) => [key, (...args) => overrides[key] ? overrides[key](real, ...args) : fn(...args)]));
}

test('in-app picker remains scoped and unavailable chat accounts require explicit reselection', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../ui/src/components/app/prereq-list.tsx'), 'utf8');
  const chats = fs.readFileSync(path.join(__dirname, '../ui/src/pages/chats.tsx'), 'utf8');
  assert.match(main, /dialog\.showOpenDialog\([\s\S]+claudeChannelTarget[\s\S]+properties: \['openFile'\]/);
  assert.match(main, /createClaudeChannelUpdater\([\s\S]+targetPath: claudeChannelTarget/);
  assert.match(main, /claudeChannelUpdater\.prepare\(selected\.filePaths\[0\]\)/);
  assert.match(main, /claudeChannelUpdater\.apply\(planId\)/);
  assert.match(main, /spawnSync\('\/bin\/zsh', \['-n'\]/);
  assert.match(ui, /Review Telegram launcher update[\s\S]+Apply reviewed change/);
  assert.match(ui, /opens access to <code>~\//);
  assert.match(chats, /focus\?\.status === 'crashed'[\s\S]+EngineSignInActions/);
  const actions = fs.readFileSync(path.join(__dirname, '../ui/src/components/app/engine-sign-in-actions.tsx'), 'utf8');
  assert.match(actions, /Refresh and reselect account/);
  assert.match(actions, /unresolvedAccount[\s\S]+onResolveAccount/);
});
