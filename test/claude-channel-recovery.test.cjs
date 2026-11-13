'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepareClaudeTelegramChannel, TELEGRAM_CHANNEL } = require('./load-ts.cjs')('src/main/claude-channel-recovery.ts');

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

test('in-app apply is restricted to one picker-selected file and backs up, syntax-checks, and verifies', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../ui/src/components/app/prereq-list.tsx'), 'utf8');
  const chats = fs.readFileSync(path.join(__dirname, '../ui/src/pages/chats.tsx'), 'utf8');
  assert.match(main, /dialog\.showOpenDialog\([\s\S]+claudeChannelTarget[\s\S]+properties: \['openFile'\]/);
  assert.match(main, /if \(target !== claudeChannelTarget\)/);
  assert.match(main, /lstatSync\(target\)[\s\S]+info\.isSymbolicLink\(\)/);
  assert.match(main, /copyFileSync\(target, backup\)[\s\S]+chmodSync\(backup, mode\)/);
  assert.match(main, /spawnSync\('\/bin\/zsh', \['-n'\]/);
  assert.match(main, /renameSync\(temporary, target\)[\s\S]+hash\(readFileSync\(target, 'utf8'\)\) !== hash\(plan\.updated\)/);
  assert.match(ui, /Review Telegram launcher update[\s\S]+Apply reviewed change/);
  assert.match(ui, /opens access to <code>~\//);
  assert.match(chats, /focus\?\.status === 'crashed'[\s\S]+EngineSignInActions/);
});
