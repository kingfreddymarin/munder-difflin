'use strict';
// Paramount traceability: correlation ids, errorIds on every failure, crash
// reports, the diagnostics bundle and secret redaction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const obs = loadTs('src/main/paramountObservability.ts');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

const SECRETS = {
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  slack: 'xoxb-1234567890-abcdefghijkl',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
  signing: 'f00dfeedcafebeef0123',
  groq: 'gsk_abcdefghijklmnopqrstuvwxyz'
};
function assertNoSecret(value, label) {
  const json = JSON.stringify(value);
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.ok(!json.includes(secret), `${label}: ${name} secret leaked`);
  }
}
function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-obs-')); }
function memorySink() { const lines = []; return { lines, sink: (e) => lines.push(JSON.parse(JSON.stringify(e))) }; }

function deps(overrides = {}) {
  return {
    tasks: () => ({ tasks: [{ id: 'P-1', humanQA: [{ q: 'Go?' }] }] }),
    patchTask: () => true,
    missions: () => [],
    saveMissions: () => {},
    agents: () => ({ jim: {} }),
    renameAgent: () => ({ ok: true }),
    setAgentTokenCap: () => {},
    setNotifications: () => {},
    savePreference: () => {},
    appendEvent: () => {},
    publish: () => {},
    ...overrides
  };
}

// ─── (1) correlation ids, start/end, duration, outcome ──────────────────────
test('traced logs start and end with one cid, duration and ok outcome', async () => {
  const { lines, sink } = memorySink();
  let t = 1000;
  const result = await obs.traced('paramount.dispatch', sink, { commandType: 'x' }, () => ({ ok: true }), { now: () => (t += 7) });
  assert.deepEqual(result, { ok: true });
  assert.equal(lines.length, 2);
  const [start, end] = lines;
  assert.equal(start.kind, 'paramount-op');
  assert.equal(start.phase, 'start');
  assert.equal(end.phase, 'end');
  assert.equal(end.outcome, 'ok');
  assert.equal(end.durationMs, 7);
  assert.match(start.cid, /^[0-9a-f-]{36}$/);
  assert.equal(start.cid, end.cid);
});

test('each traced call gets its own correlation id', async () => {
  const { lines, sink } = memorySink();
  await obs.traced('a', sink, {}, () => ({ ok: true }));
  await obs.traced('a', sink, {}, () => ({ ok: true }));
  assert.notEqual(lines[0].cid, lines[2].cid);
});

test('a dispatch carries its correlation id onto the event', async () => {
  const { lines, sink } = memorySink();
  const audited = [];
  const result = await obs.traced('paramount.dispatch', sink, {}, (span) =>
    dispatchParamount({ type: 'account.notify', id: 'desktop', on: true }, deps({ appendEvent: (e) => audited.push(e) }), span));
  assert.equal(result.ok, true);
  assert.equal(result.event.correlationId, lines[0].cid);
  assert.equal(audited[0].correlationId, lines[0].cid);
});

test('a failing log sink never turns success into failure', async () => {
  const result = await obs.traced('x', () => { throw new Error('disk full'); }, {}, () => ({ ok: true }));
  assert.deepEqual(result, { ok: true });
});

// ─── (2) errorId + code + message on every failure, same id in the log ─────
test('validation failure carries errorId, code and message, logged under the same id', async () => {
  const { lines, sink } = memorySink();
  const result = await obs.traced('paramount.dispatch', sink, {}, (span) =>
    dispatchParamount({ type: 'question.answer', messageId: 'P-404:0', option: 'yes' }, deps(), span));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
  assert.equal(result.message, 'Question task not found');
  assert.equal(result.error, result.message);
  assert.match(result.errorId, /^E-[0-9a-z]+-[0-9a-f]{8}$/);
  const error = lines.find((l) => l.kind === 'paramount-error');
  assert.equal(error.errorId, result.errorId);
  assert.equal(error.cid, result.correlationId);
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.context.commandType, 'question.answer');
  const end = lines.find((l) => l.phase === 'end');
  assert.equal(end.outcome, 'fail');
  assert.equal(end.errorId, result.errorId);
});

test('every dispatch failure path returns a code and errorId', () => {
  const cases = [
    [null, 'INVALID_COMMAND'],
    [{ type: 'nope' }, 'INVALID_COMMAND'],
    [{ type: 'automation.toggle', id: 'x' }, 'INVALID_INPUT'],
    [{ type: 'automation.toggle', id: 'x', enabled: true }, 'NOT_FOUND'],
    [{ type: 'access.set' }, 'INVALID_INPUT'],
    [{ type: 'access.set', agentId: 'jim', sourceId: 'ado', access: 'rw' }, 'UNSUPPORTED'],
    [{ type: 'layout.panels', panels: [] }, 'UNSUPPORTED'],
    [{ type: 'diagnostics.bundle' }, 'UNSUPPORTED'],
    [{ type: 'diagnostics.bundle', logLines: 0 }, 'INVALID_INPUT'],
    [{ type: 'diagnostics.save', name: 'x.json' }, 'UNSUPPORTED'],
    [{ type: 'diagnostics.save', name: '../x.json' }, 'INVALID_INPUT'],
    [{ type: 'diagnostics.save', name: 'x.txt' }, 'INVALID_INPUT'],
    [{ type: 'diagnostics.save', name: 'x.json', path: '/tmp/x.json' }, 'INVALID_INPUT']
  ];
  for (const [command, code] of cases) {
    const result = dispatchParamount(command, deps());
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.equal(result.code, code, JSON.stringify(command));
    assert.equal(typeof result.errorId, 'string');
    assert.equal(typeof result.correlationId, 'string');
  }
});

test('a throw after a write is UNCERTAIN_STATE with the stack in the log only', async () => {
  const { lines, sink } = memorySink();
  const result = await obs.traced('paramount.dispatch', sink, {}, (span) =>
    dispatchParamount({ type: 'account.notify', id: 'desktop', on: true },
      deps({ setNotifications: () => { throw new Error(`config write failed ${SECRETS.openai}`); } }), span));
  assert.equal(result.code, 'UNCERTAIN_STATE');
  assert.equal(result.stack, undefined, 'renderer never receives a stack');
  const error = lines.find((l) => l.errorId === result.errorId && l.kind === 'paramount-error');
  assert.match(error.stack, /config write failed/);
  assertNoSecret(lines, 'error log');
  assertNoSecret(result, 'renderer failure');
});

test('a thrown handler becomes INTERNAL; rethrow mode puts the errorId in the message', async () => {
  const { lines, sink } = memorySink();
  const failure = await obs.traced('paramount.snapshot', sink, {}, () => { throw new Error('preferences corrupt'); });
  assert.equal(failure.code, 'INTERNAL');
  assert.equal(lines.find((l) => l.kind === 'paramount-error').errorId, failure.errorId);
  await assert.rejects(
    obs.traced('paramount.snapshot', sink, {}, () => { throw new Error('preferences corrupt'); }, { rethrow: true }),
    (err) => {
      const id = /^\[(E-[^\]]+)\] INTERNAL: preferences corrupt$/.exec(err.message)?.[1];
      assert.ok(id, err.message);
      assert.ok(lines.some((l) => l.kind === 'paramount-error' && l.errorId === id));
      return true;
    });
});

// ─── (3) crash capture ──────────────────────────────────────────────────────
test('all four crash sources write a 0600 report and a log line with the same errorId', () => {
  const root = tmpRoot();
  const { lines, sink } = memorySink();
  const handlers = {};
  const fake = { on: (name, fn) => { handlers[name] = fn; } };
  const appHandlers = {};
  const fakeApp = { on: (name, fn) => { appHandlers[name] = fn; } };
  const originalError = console.error;
  console.error = () => {};
  try {
    obs.installCrashCapture({ root: () => root, sink, runtime: () => ({ version: '9.9.9' }) }, fake, fakeApp);
    handlers.uncaughtException(new Error(`boom ${SECRETS.slack}`));
    handlers.unhandledRejection('rejected');
    appHandlers['render-process-gone']({}, { id: 3, getURL: () => `paramount://app/?token=${SECRETS.github}` }, { reason: 'crashed', exitCode: 133 });
    appHandlers['child-process-gone']({}, { type: 'GPU', reason: 'oom', exitCode: 9 });
  } finally { console.error = originalError; }

  const crashes = lines.filter((l) => l.kind === 'crash');
  assert.deepEqual(crashes.map((c) => c.source), ['uncaughtException', 'unhandledRejection', 'render-process-gone', 'child-process-gone']);
  const files = fs.readdirSync(path.join(root, 'crashes'));
  assert.equal(files.length, 4);
  for (const crash of crashes) {
    const file = files.find((f) => f.includes(crash.errorId));
    assert.ok(file, `report file for ${crash.errorId}`);
    const full = path.join(root, 'crashes', file);
    assert.equal(fs.statSync(full).mode & 0o777, 0o600);
    const report = JSON.parse(fs.readFileSync(full, 'utf8'));
    assert.equal(report.errorId, crash.errorId);
    assert.equal(report.runtime.version, '9.9.9');
  }
  const render = JSON.parse(fs.readFileSync(path.join(root, 'crashes', files.find((f) => f.includes('render-process-gone'))), 'utf8'));
  assert.equal(render.context.exitCode, 133);
  assertNoSecret(lines, 'crash log');
  for (const f of files) assertNoSecret(fs.readFileSync(path.join(root, 'crashes', f), 'utf8'), f);
});

test('crash capture without a hive root still logs and never throws', () => {
  const { lines, sink } = memorySink();
  const id = obs.recordCrash({ root: () => { throw new Error('TDZ'); }, sink, runtime: () => { throw new Error('x'); } }, 'uncaughtException', new Error('early'));
  assert.equal(lines[0].errorId, id);
  assert.equal(lines[0].reportPath, null);
});

test('crash reports are capped, oldest dropped first', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'crashes');
  fs.mkdirSync(dir);
  for (let i = 0; i < obs.MAX_CRASH_REPORTS; i++) fs.writeFileSync(path.join(dir, `2000-01-01T00-00-${String(i).padStart(2, '0')}-x.log`), '');
  obs.recordCrash({ root: () => root, sink: null, runtime: () => ({}) }, 'uncaughtException', new Error('new'));
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, obs.MAX_CRASH_REPORTS);
  assert.ok(!files.includes('2000-01-01T00-00-00-x.log'));
});

// ─── (4) diagnostics bundle through the dispatch ────────────────────────────
test('diagnostics.bundle returns logs, crashes, app, OS and redacted config', () => {
  const root = tmpRoot();
  const log = [
    { ts: 1, kind: 'app-start', version: '0.5.5' },
    { ts: 2, kind: 'message', body: `use ${SECRETS.openai}`, botToken: SECRETS.slack },
    { ts: 3, kind: 'hooks', url: `https://x.test/cb?token=${SECRETS.signing}&ok=1` }
  ];
  fs.writeFileSync(path.join(root, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
  fs.mkdirSync(path.join(root, 'crashes'));
  fs.writeFileSync(path.join(root, 'crashes', '2026-10-15T00-00-00-000Z-jim.log'), `agent: jim\nAuthorization: Bearer ${SECRETS.jwt}\n`);
  const config = {
    harnessHome: '/h', notifications: true,
    slackSigningSecret: SECRETS.signing, slackBotToken: SECRETS.slack, groqApiKey: SECRETS.groq,
    webhookTriggers: [{ id: 'w', secret: SECRETS.signing }],
    agentTokenCaps: { jim: 5000000 },
    integrations: [{ id: 'gh', secretRef: 'ref-1', note: `token ${SECRETS.github}` }]
  };
  const audited = [];
  const result = dispatchParamount({ type: 'diagnostics.bundle', logLines: 3 }, deps({
    appendEvent: (e) => audited.push(e),
    diagnostics: ({ logLines, cid }) => obs.buildDiagnostics({
      root, app: { version: '0.5.5' }, os: { platform: 'darwin' }, config, logLines
    }, cid)
  }));
  assert.equal(result.ok, true);
  const d = result.diagnostics;
  assert.equal(d.correlationId, result.event.correlationId);
  assert.equal(d.app.version, '0.5.5');
  assert.equal(d.os.platform, 'darwin');
  assert.equal(d.logTail.length, 3, 'honours logLines');
  assert.deepEqual(d.logTail[2], { raw: 'not json' });
  assert.equal(d.crashes.length, 1);
  assert.equal(d.config.slackSigningSecret, obs.REDACTED);
  assert.equal(d.config.slackBotToken, obs.REDACTED);
  assert.equal(d.config.groqApiKey, obs.REDACTED);
  assert.equal(d.config.webhookTriggers[0].secret, obs.REDACTED);
  assert.equal(d.config.agentTokenCaps, obs.REDACTED, 'object under a token key is withheld');
  assert.equal(d.config.notifications, true);
  assert.equal(d.config.harnessHome, '/h');
  assert.match(d.logTail[0].body, /use \[REDACTED\]/);
  assert.match(d.crashes[0].content, /Bearer|\[REDACTED\]/);
  assertNoSecret(d, 'diagnostics bundle');
  assert.equal(audited.length, 1, 'bundle export is audited');
  assertNoSecret(audited, 'audit event');
});

// ─── (4b) diagnostics.save: the core writes the redacted file; cancel is not "saved" ─
test('diagnostics.save writes the redacted bundle through the save dep and audits the save', async () => {
  const audited = [];
  const writes = [];
  const config = { slackBotToken: SECRETS.slack, notifications: true };
  const result = await dispatchParamount({ type: 'diagnostics.save', name: 'paramount-diagnostics-20261015-070509.json' }, deps({
    appendEvent: (e) => audited.push(e),
    diagnostics: ({ logLines, cid }) => obs.buildDiagnostics({ root: null, app: {}, os: {}, config, logLines }, cid),
    saveDiagnostics: async (file) => { writes.push(file); return { canceled: false, path: `/picked/${file.name}` }; }
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.saved, { canceled: false, path: '/picked/paramount-diagnostics-20261015-070509.json' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'paramount-diagnostics-20261015-070509.json');
  const written = JSON.parse(writes[0].text);
  assert.equal(written.config.slackBotToken, obs.REDACTED);
  assert.equal(written.correlationId, result.event.correlationId);
  assert.ok(writes[0].text.endsWith('\n'));
  assertNoSecret(writes[0].text, 'saved diagnostics file');
  assert.equal(audited.length, 1, 'a real save is audited');
});

test('diagnostics.save reports a canceled dialog as canceled and records nothing', async () => {
  const audited = [];
  const published = [];
  const result = await dispatchParamount({ type: 'diagnostics.save', name: 'paramount-diagnostics.json' }, deps({
    appendEvent: (e) => audited.push(e), publish: (e) => published.push(e),
    diagnostics: ({ cid }) => obs.buildDiagnostics({ root: null, app: {}, os: {}, config: {} }, cid),
    saveDiagnostics: async () => ({ canceled: true })
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.saved, { canceled: true });
  assert.equal(audited.length, 0);
  assert.equal(published.length, 0);
});

test('diagnostics.save turns a failed write into UNCERTAIN_STATE with an errorId', async () => {
  const result = await dispatchParamount({ type: 'diagnostics.save', name: 'paramount-diagnostics.json' }, deps({
    diagnostics: ({ cid }) => obs.buildDiagnostics({ root: null, app: {}, os: {}, config: {} }, cid),
    saveDiagnostics: async () => { throw new Error('EACCES'); }
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNCERTAIN_STATE');
  assert.match(result.errorId, /\S/);
});

test('diagnostics with no hive root reports the gap instead of failing', () => {
  const d = obs.buildDiagnostics({ root: null, app: {}, os: {}, config: {} }, 'cid-1');
  assert.deepEqual(d.logTail, []);
  assert.deepEqual(d.crashes, []);
  assert.equal(d.errors.length, 1);
});

// ─── redaction ──────────────────────────────────────────────────────────────
test('redaction removes secret shapes from text and secret keys from objects', () => {
  const text = [
    `key ${SECRETS.openai}`, SECRETS.slack, SECRETS.github, 'github_pat_11ABCDEFG0abcdefghijklmnop',
    SECRETS.groq, 'AKIAABCDEFGHIJKLMNOP', SECRETS.jwt, 'Authorization: Bearer abcdefghijklmnop',
    `https://h/x?api_key=${SECRETS.signing}&page=2`
  ].join('\n');
  const out = obs.redactText(text);
  assertNoSecret(out, 'text');
  assert.ok(!out.includes('github_pat_11'));
  assert.ok(!out.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.match(out, /api_key=\[REDACTED\]&page=2/);

  const obj = obs.redact({
    password: 'hunter2', nested: { apiKey: 'x', 'x-api-key': 'y', cookie: 'c', privateKey: 'k' },
    tokensCap: 5, hasToken: true, tokenRef: null, name: 'Jim', list: [`s ${SECRETS.slack}`]
  });
  assert.equal(obj.password, obs.REDACTED);
  assert.deepEqual(obj.nested, { apiKey: obs.REDACTED, 'x-api-key': obs.REDACTED, cookie: obs.REDACTED, privateKey: obs.REDACTED });
  assert.equal(obj.tokensCap, 5, 'numbers under token keys are budgets, not secrets');
  assert.equal(obj.hasToken, true);
  assert.equal(obj.tokenRef, null);
  assert.equal(obj.name, 'Jim');
  assert.equal(obj.list[0], 's [REDACTED]');
});

test('redaction covers prefixed env names, JSON keys in any casing and URL userinfo (A1)', () => {
  const cases = [
    ['MD_BROKER_TOKEN=3f9a0c1d2e3f4a5b', 'MD_BROKER_TOKEN=[REDACTED]'],
    ['export ANTHROPIC_API_KEY="abc123def456"', 'export ANTHROPIC_API_KEY="[REDACTED]"'],
    ['X_API_KEY=k1 DB_PASSWORD=hunter2 WEBHOOK_SECRET=s3', 'X_API_KEY=[REDACTED] DB_PASSWORD=[REDACTED] WEBHOOK_SECRET=[REDACTED]'],
    ['{"apiKey":"abc123"}', '{"apiKey":"[REDACTED]"}'],
    ['{"Token": "t0k", "SECRET":"s", "Password" : "p", "AUTHORIZATION":"Bearer x"}',
      '{"Token": "[REDACTED]", "SECRET":"[REDACTED]", "Password" : "[REDACTED]", "AUTHORIZATION":"[REDACTED]"}'],
    ["{'api_key': 'abc'}", "{'api_key': '[REDACTED]'}"],
    ['Authorization: Basic dXNlcg', 'Authorization: [REDACTED]'],
    ['clone https://u:p@h/repo.git', 'clone https://u:[REDACTED]@h/repo.git'],
    ['postgres://admin:s3cr3t@db.local:5432/x', 'postgres://admin:[REDACTED]@db.local:5432/x']
  ];
  for (const [input, want] of cases) assert.equal(obs.redactText(input), want, input);
  // Budgets, flags and harmless neighbours survive.
  for (const keep of ['"maxTokens": 4096', 'hasToken=true', 'tokenRef: null', 'MY_TOKEN_FILE=/tmp/x', 'tokenizer=bpe', 'https://h/path', 'mailto:a@b.c'])
    assert.equal(obs.redactText(keep), keep, keep);
});

test('diagnostics redacts agent-exit tails from crashes/ (A1)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-a1-'));
  fs.mkdirSync(path.join(root, 'crashes'));
  fs.writeFileSync(path.join(root, 'crashes', 'agent-exit-1.log'),
    'env dump\nMD_BROKER_TOKEN=3f9a0c1d2e3f4a5b\nANTHROPIC_API_KEY=abc123\n{"apiKey":"zz9"}\nhttps://u:pw@h\n');
  fs.writeFileSync(path.join(root, 'log.jsonl'), 'not json SECRET=raw-line-secret\n');
  try {
    const d = obs.buildDiagnostics({ root, app: {}, os: {}, config: {} }, 'cid');
    const text = JSON.stringify(d);
    for (const leak of ['3f9a0c1d2e3f4a5b', 'abc123', 'zz9', ':pw@', 'raw-line-secret']) assert.ok(!text.includes(leak), leak);
    assert.match(d.crashes[0].content, /MD_BROKER_TOKEN=\[REDACTED\]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('redaction survives cycles and errors', () => {
  const a = { name: 'a' }; a.self = a;
  assert.equal(obs.redact(a).self, '[CIRCULAR]');
  const e = obs.redact(new Error(`bad ${SECRETS.openai}`));
  assert.equal(e.message, 'bad [REDACTED]');
});

// ─── wiring in the Electron main process ────────────────────────────────────
test('main process routes Paramount IPC and process failures through observability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /installCrashCapture\(crashCapture, process, app\)/);
  assert.doesNotMatch(src, /process\.on\('uncaughtException'/, 'one handler set, in paramountObservability');
  assert.match(src, /ipcMain\.handle\('paramount:snapshot',[^\n]*traced\('paramount\.snapshot'/);
  assert.match(src, /ipcMain\.handle\('paramount:dispatch',[^\n]*traced\('paramount\.dispatch'/);
  assert.match(src, /\}, span\);\n\}\)\);/, 'dispatch receives the traced span');
  assert.match(src, /diagnostics: \(\{ logLines, cid \}\) => buildDiagnostics\(/);
});

test('an op whose answer carries core errors ends with outcome error and their errorIds, not ok', async () => {
  const lines = [];
  const result = await obs.traced('paramount.dispatch', (l) => lines.push(l), {}, () => ({ ok: true, artifacts: { warnings: [{ errorId: 'E-git-1', source: 'git-status', message: 'boom' }] } }));
  assert.equal(result.ok, true);
  const end = lines.find((l) => l.phase === 'end');
  assert.equal(end.outcome, 'error');
  assert.deepEqual(end.errorIds, ['E-git-1']);
  const clean = [];
  await obs.traced('paramount.dispatch', (l) => clean.push(l), {}, () => ({ ok: true, artifacts: { warnings: [] } }));
  assert.equal(clean.find((l) => l.phase === 'end').outcome, 'ok');
});

// ─── (4c) pre-floor diagnostics (NSC-193 repro 2026-11-15, E-mwi8f3qa-979fabff) ─
// A fresh profile in Setup has no harnessHome, so the floor log cannot be written.
// The bundle must still return app, OS and redacted config; floor evidence is listed
// as absent, never borrowed from another floor.
function noFloorDeps(extra = {}) {
  const published = [];
  return { published, deps: deps({
    floorLogAvailable: () => false,
    appendEvent: () => { throw new Error('hive disabled (no harnessHome)'); },
    publish: (e) => published.push(e),
    diagnostics: ({ logLines, cid }) => obs.buildDiagnostics({
      root: null, app: { version: '0.4.6', packaged: true }, os: { platform: 'darwin', arch: 'arm64' },
      config: { harnessHome: null, slackBotToken: SECRETS.slack, notifications: true }, logLines
    }, cid),
    ...extra
  }) };
}

test('diagnostics.bundle works before a floor is chosen', () => {
  const { deps: d, published } = noFloorDeps();
  const result = dispatchParamount({ type: 'diagnostics.bundle' }, d);
  assert.equal(result.ok, true, `pre-floor bundle failed: ${result.code} ${result.message ?? result.error ?? ''}`);
  const b = result.diagnostics;
  assert.equal(b.correlationId, result.event.correlationId);
  assert.equal(b.app.version, '0.4.6');
  assert.equal(b.os.arch, 'arm64');
  assert.equal(b.config.harnessHome, null);
  assert.equal(b.config.slackBotToken, obs.REDACTED);
  assert.deepEqual(b.logTail, []);
  assert.deepEqual(b.crashes, []);
  assert.ok(b.errors.some((e) => /no log or crash reports/.test(e)), 'floor evidence is explicitly absent');
  assertNoSecret(result, 'pre-floor bundle');
  assert.equal(published.length, 1, 'still published to open windows');
});

test('diagnostics.save works before a floor is chosen', async () => {
  const writes = [];
  const { deps: d } = noFloorDeps({ saveDiagnostics: async (file) => { writes.push(file); return { canceled: false, path: `/picked/${file.name}` }; } });
  const result = await dispatchParamount({ type: 'diagnostics.save', name: 'paramount-diagnostics-20261115-193257.json' }, d);
  assert.equal(result.ok, true, `pre-floor save failed: ${result.code} ${result.message ?? ''}`);
  assert.equal(writes.length, 1);
  assertNoSecret(writes, 'pre-floor saved file');
});

test('with a floor, diagnostics are still audited on the floor log', () => {
  const audited = [];
  const result = dispatchParamount({ type: 'diagnostics.bundle' }, deps({
    floorLogAvailable: () => true,
    appendEvent: (e) => audited.push(e),
    diagnostics: ({ logLines, cid }) => obs.buildDiagnostics({ root: tmpRoot(), app: {}, os: {}, config: {}, logLines }, cid)
  }));
  assert.equal(result.ok, true);
  assert.equal(audited.length, 1);
});

test('other commands still fail closed when no floor log exists', () => {
  const { deps: d } = noFloorDeps();
  const result = dispatchParamount({ type: 'account.notify', id: 'desktop', on: true }, d);
  assert.equal(result.ok, false);
  assert.equal(typeof result.errorId, 'string');
});
