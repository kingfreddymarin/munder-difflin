'use strict';

/**
 * Generated hive documents are refreshed during hive-service bootstrap, not as a
 * side effect of ordinary task or agent mutations. These regressions exercise the
 * public HiveManager paths and pin the main-process bootstrap wiring without
 * starting Electron, a PTY, or a CLI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const GENERATED_NOTICE_PREFIX = '<!-- Generated and managed by Munder Difflin.';
const GENERATED_DOCS = [
  { filename: 'PROTOCOL.md', sentinel: 'PROTOCOL_SENTINEL\n', heading: '# Hive protocol' },
  { filename: 'COMMANDS.md', sentinel: 'COMMANDS_SENTINEL\n', heading: '# Claude Code commands' }
];

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-generated-docs-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { hive, root: path.join(home, 'hive') };
}

function writeSentinels(root) {
  for (const { filename, sentinel } of GENERATED_DOCS) {
    fs.writeFileSync(path.join(root, filename), sentinel, 'utf8');
  }
}

function assertSentinels(root) {
  for (const { filename, sentinel } of GENERATED_DOCS) {
    assert.equal(fs.readFileSync(path.join(root, filename), 'utf8'), sentinel);
  }
}

function readGeneratedDoc(root, filename) {
  return fs.readFileSync(path.join(root, filename), 'utf8');
}

function assertGenerated(root, docs = GENERATED_DOCS) {
  for (const { filename, heading } of docs) {
    const contents = readGeneratedDoc(root, filename);
    assert.equal(contents.startsWith(GENERATED_NOTICE_PREFIX), true);
    assert.equal(contents.split('\n').includes(heading), true);
  }
}

test('writeTasks preserves existing generated hive docs', (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  hive.writeTasks([]);

  assertSentinels(root);
});

test('ensureAgent preserves existing generated hive docs', async (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  await hive.ensureAgent({ id: 'agent-1', name: 'Agent', provider: 'claude', cwd: root });

  assertSentinels(root);
});

test('new agent workspaces get a durable handoff file and explicit session context instructions', async (t) => {
  const { hive, root } = floor(t);
  const injection = await hive.ensureAgent({ id: 'agent-1', name: 'Agent', provider: 'pi', cwd: root });
  const agentDir = path.join(root, 'agents', 'agent-1');
  const handoff = path.join(agentDir, 'handoff.md');
  assert.match(fs.readFileSync(handoff, 'utf8'), /State, Next, Files, and Open/);
  const prompt = injection.args.join('\n');
  assert.ok(prompt.includes(handoff));
  assert.match(prompt, /Rules section of .*memory\.md/);
  assert.match(prompt, /START of a task, read every file in/);

  fs.writeFileSync(handoff, '## KEEP THIS HANDOFF\n', 'utf8');
  await hive.ensureAgent({ id: 'agent-1', name: 'Agent', provider: 'pi', cwd: root });
  assert.equal(fs.readFileSync(handoff, 'utf8'), '## KEEP THIS HANDOFF\n');
});

test('refreshGeneratedDocs replaces stale generated hive docs', (t) => {
  const { hive, root } = floor(t);
  writeSentinels(root);

  hive.refreshGeneratedDocs();

  for (const { filename, sentinel } of GENERATED_DOCS) {
    assert.equal(readGeneratedDoc(root, filename).includes(sentinel), false);
  }
  assertGenerated(root);
});

test('hive-service bootstrap refreshes generated hive docs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ts = require('typescript');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const bootstrap = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrapHiveServices');
  assert.ok(bootstrap, 'bootstrapHiveServices() is missing');
  // Execute the production prefix, including its real admission guards and doc
  // callbacks. Stop before unrelated services start; no sockets or real floor.
  const statements = bootstrap.body.statements;
  const end = statements.findIndex(node => node.getText(tree).includes("stage('hive.generated-docs'"));
  assert.ok(end >= 0);
  const script = ts.transpileModule(`(()=>{${statements.slice(0,end+1).map(n=>n.getText(tree)).join('\n')}})()`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for (const [state, enabled, expected] of [['open',true,['ensure','refresh']], ['open',false,[]], ['refused',true,[]]]) {
    const calls=[];
    require('node:vm').runInNewContext(script, {
      performance:{now:()=>0},lagOp:()=>()=>{},console:{error:()=>{}},broadcastParamountInvalidation:()=>{},
      readConfig:()=>({harnessHome:'/fixture'}),floorGate:{claim:()=>({state,refusal:{owner:'other',pid:1,floor:'/fixture'}})},
      hive:{enabled:()=>enabled,ensureHive:()=>calls.push('ensure'),refreshGeneratedDocs:()=>calls.push('refresh')}
    });
    assert.deepEqual(calls,expected,'docs refresh once after ensure, only on an admitted floor');
  }
  assert.equal(source.match(/hive\.refreshGeneratedDocs\(\);/g)?.length,1);
});

test('floor startup records named stage timings for the main-thread lag report', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(source, /stage\('floor\.lock-claim'/);
  assert.match(source, /stage\('hive\.generated-docs'/);
  assert.match(source, /stage\('hive\.archive-orphans'/);
  assert.match(source, /kind: 'paramount-startup-stages', phase: 'floor-services'/);
  assert.match(source, /lagOp\(`floor-entry:\$\{name\}`\)/);
});

test('ensureHive restores missing generated hive docs', (t) => {
  const { hive, root } = floor(t);
  for (const { filename } of GENERATED_DOCS) fs.rmSync(path.join(root, filename));

  hive.ensureHive();

  assertGenerated(root);
});

test('ensureHive restores only the missing generated hive doc', (t) => {
  const { hive, root } = floor(t);
  const [missing, preserved] = GENERATED_DOCS;
  fs.rmSync(path.join(root, missing.filename));
  fs.writeFileSync(path.join(root, preserved.filename), preserved.sentinel, 'utf8');

  hive.ensureHive();

  assertGenerated(root, [missing]);
  assert.equal(readGeneratedDoc(root, preserved.filename), preserved.sentinel);
});
