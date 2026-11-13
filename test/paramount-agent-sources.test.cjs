'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { discoverAgents, findAgents, toHireManifest, defaultMunderHive, parseToml } = loadTs('src/main/agentSources.ts');
const { dispatchParamount } = loadTs('src/main/paramount.ts');

/** Names that must never be opened, whatever directory they sit in. */
const CREDENTIAL = /(^|[\\/])(auth\.json|\.credentials[^\\/]*|[^\\/]*\.token|\.env(\.[^\\/]*)?|[^\\/]*histor(y|ies)[^\\/]*|[^\\/]*sessions?[^\\/]*)$/i;

test('valid quoted TOML table keys can contain brackets, dots and hash characters', () => {
  const doc = parseToml('[hooks.state."tool[3].ready"]\nenabled = true\n[hooks.state.\'other]#key\'] # comment\nenabled = false\n[profiles.fast]\nmodel = "fixture-model"\n');
  assert.deepEqual(doc.errors, []);
  assert.equal(doc.tables.get('hooks.state.tool[3].ready').enabled, 'true');
  assert.equal(doc.tables.get('hooks.state.other]#key').enabled, 'false');
  assert.equal(doc.tables.get('profiles.fast').model, 'fixture-model');
});

test('mismatched TOML table brackets remain errors without exposing content', () => {
  for (const text of ['[[hooks.state]\nenabled = true', '[hooks.state]]\nenabled = true']) {
    const doc = parseToml(text);
    assert.ok(doc.errors.length > 0);
    assert.doesNotMatch(doc.errors.join('\n'), /enabled|hooks/);
  }
});

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Builds Claude, Codex and Munder setups in a temp dir, good and malformed files side by side. */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-agents-'));
  const claudeHome = path.join(base, 'claude');
  const codexHome = path.join(base, 'codex');
  const munderHive = path.join(base, 'hive');
  const project = path.join(base, 'project');

  write(path.join(claudeHome, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews diffs\nmodel: sonnet\ntools: Read, Grep\n---\nYou review code.\n');
  write(path.join(claudeHome, 'agents', 'plain.md'), '# Just notes\nno frontmatter here\n');
  write(path.join(claudeHome, 'agents', 'open.md'), '---\nname: open\ndescription: never closed\n');
  write(path.join(claudeHome, 'agents', 'nameless.md'), '---\ndescription: |\n  Multi\n  line\n---\nBody.\n');
  write(path.join(claudeHome, 'agents', 'session-notes.md'), '---\nname: leak\n---\nsecret\n');
  write(path.join(claudeHome, 'agents', '.env.md'), 'API_KEY=secret\n');
  write(path.join(claudeHome, '.credentials.json'), '{"token":"secret"}');
  write(path.join(project, '.claude', 'agents', 'local.md'), '---\nname: local\ndescription: Project agent\nmodel: inherit\n---\nProject body.\n');
  write(path.join(project, 'AGENTS.md'), '# Project rules\nBe nice.\n');

  write(path.join(codexHome, 'agents', 'fixer.toml'),
    'name = "fixer"\ndescription = "Fixes bugs"\nmodel = "gpt-5"\ndeveloper_instructions = """\nFix the bug.\n"""\n');
  write(path.join(codexHome, 'agents', 'broken.toml'), 'name = "broken\ndescription = 3\n');
  write(path.join(codexHome, 'agents', 'helper.md'), '---\nname: helper\ndescription: Codex md agent\n---\nHelp.\n');
  write(path.join(codexHome, 'AGENTS.md'), '# Global Codex rules\n');
  write(path.join(codexHome, 'config.toml'),
    'model = "gpt-5"\n[profiles.fast]\nmodel = "gpt-5-mini"\n[profiles.empty]\n[mcp_servers.x.env]\nTOKEN = "secret"\n');
  write(path.join(codexHome, 'auth.json'), '{"OPENAI_API_KEY":"secret"}');
  write(path.join(codexHome, 'history.jsonl'), '{"text":"secret"}\n');
  write(path.join(codexHome, 'sessions', 'a.jsonl'), 'secret\n');
  write(path.join(codexHome, 'agents', 'gh.token'), 'secret');

  write(path.join(munderHive, 'registry.json'), JSON.stringify({
    agents: {
      jim: { name: 'Jim', role: 'Sales', provider: 'claude', capabilities: ['email'] },
      ghost: { role: 'No identity file' },
      '../escape': { name: 'Bad' },
      broken: 'not an object'
    }
  }));
  write(path.join(munderHive, 'agents', 'jim', 'identity.md'), 'You are Jim.\n');
  write(path.join(munderHive, 'agents', 'jim', '.env'), 'SECRET=1\n');

  return { base, project, roots: { claudeHome, codexHome, munderHive } };
}

/** Records every path handed to fs open/read/stat while `fn` runs. */
function spyFs(fn) {
  const opened = [];
  const names = ['readFileSync', 'openSync', 'statSync', 'readdirSync', 'createReadStream'];
  const saved = names.map((n) => fs[n]);
  names.forEach((n, i) => { fs[n] = function (p, ...rest) { opened.push(String(p)); return saved[i].call(this, p, ...rest); }; });
  try { return { result: fn(), opened }; } finally { names.forEach((n, i) => { fs[n] = saved[i]; }); }
}

function byId(discovery, source, id) {
  return discovery.agents.find((a) => a.source === source && a.id === id);
}

test('discovers agents from all three sources with the full profile shape', () => {
  const { roots, project } = fixture();
  const d = discoverAgents(roots, { projectDir: project });
  const reviewer = byId(d, 'claude', 'user:reviewer');
  assert.deepEqual(
    { ...reviewer, warnings: reviewer.warnings.length },
    { source: 'claude', id: 'user:reviewer', name: 'reviewer', description: 'Reviews diffs', model: 'sonnet',
      tools: ['Read', 'Grep'], instructionsPath: path.join(roots.claudeHome, 'agents', 'reviewer.md'), origin: 'user', warnings: 0 });
  assert.equal(byId(d, 'claude', 'project:local').origin, 'project');
  assert.equal(byId(d, 'claude', 'user:nameless').name, 'nameless');
  assert.equal(byId(d, 'claude', 'user:nameless').description, 'Multi\nline');
  assert.equal(byId(d, 'codex', 'user:agents/fixer').model, 'gpt-5');
  assert.equal(byId(d, 'codex', 'user:helper').description, 'Codex md agent');
  assert.equal(byId(d, 'codex', 'user:AGENTS.md').description, 'Global Codex rules');
  assert.equal(byId(d, 'codex', 'project:AGENTS.md').description, 'Project rules');
  assert.equal(byId(d, 'codex', 'user:profile:fast').model, 'gpt-5-mini');
  assert.equal(byId(d, 'codex', 'user:profile:empty').warnings.length, 1);
  assert.equal(byId(d, 'munder', 'jim').description, 'Sales');
  assert.ok(byId(d, 'munder', 'ghost').warnings.some((w) => w.path.endsWith(path.join('ghost', 'identity.md'))));
  for (const agent of d.agents) {
    for (const key of ['source', 'id', 'name', 'description', 'instructionsPath', 'origin']) assert.equal(typeof agent[key], 'string', `${agent.id}.${key}`);
    assert.ok(Array.isArray(agent.warnings));
  }
  // Nothing from config.toml beyond profile models reaches the result.
  assert.doesNotMatch(JSON.stringify(d), /secret/);
});

test('every malformed or refused file is a warning with its path and an errorId', () => {
  const { roots, project } = fixture();
  const d = discoverAgents(roots, { projectDir: project });
  const all = [...d.warnings, ...d.agents.flatMap((a) => a.warnings)];
  for (const w of all) {
    assert.match(w.errorId, /\S/);
    assert.ok(path.isAbsolute(w.path), w.path);
  }
  const at = (...parts) => all.filter((w) => w.path === path.join(...parts));
  assert.equal(at(roots.claudeHome, 'agents', 'plain.md').length, 1);
  assert.match(at(roots.claudeHome, 'agents', 'open.md')[0].message, /not closed/);
  assert.match(at(roots.claudeHome, 'agents', 'session-notes.md')[0].message, /refused/);
  assert.match(at(roots.claudeHome, 'agents', '.env.md')[0].message, /refused/);
  assert.ok(at(roots.codexHome, 'agents', 'broken.toml').length >= 1);
  assert.ok(at(roots.munderHive, 'registry.json').length >= 2, 'unsafe id and non-object entry');
  assert.equal(new Set(all.map((w) => w.errorId)).size, all.length, 'errorIds are unique');
  assert.equal(byId(d, 'claude', 'user:plain'), undefined);
  assert.equal(byId(d, 'claude', 'user:session-notes'), undefined);
});

test('credential, env, session and history files are never opened', () => {
  const { roots, project } = fixture();
  const { result, opened } = spyFs(() => {
    const d = discoverAgents(roots, { projectDir: project });
    const jim = findAgents(roots, { sources: ['munder'] }).found.find((f) => f.agent.id === 'jim');
    toHireManifest(jim, []);
    return d;
  });
  assert.ok(result.agents.length > 0);
  assert.ok(opened.length > 0, 'the spy saw the reads');
  assert.deepEqual(opened.filter((p) => CREDENTIAL.test(p)), []);
  assert.ok(!opened.some((p) => p.includes(`${path.sep}sessions${path.sep}`)), 'sessions dir is never walked');
});

test('missing roots give an empty list and no warnings', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'paramount-agents-empty-'));
  const d = discoverAgents({ claudeHome: path.join(base, 'no'), codexHome: path.join(base, 'nope'), munderHive: path.join(base, 'none') },
    { projectDir: path.join(base, 'missing') });
  assert.deepEqual(d.agents, []);
  assert.deepEqual(d.warnings, []);
  assert.deepEqual(discoverAgents({ claudeHome: base, codexHome: base, munderHive: null }).agents, []);
});

test('sources filter limits the scan', () => {
  const { roots } = fixture();
  const d = discoverAgents(roots, { sources: ['codex'] });
  assert.ok(d.agents.length > 0);
  assert.ok(d.agents.every((a) => a.source === 'codex'));
  assert.deepEqual(d.roots.claude, []);
});

test('a malformed registry.json and Munder config are warnings, not crashes', () => {
  const { roots, base } = fixture();
  fs.writeFileSync(path.join(roots.munderHive, 'registry.json'), '{not json');
  const d = discoverAgents(roots, { sources: ['munder'] });
  assert.deepEqual(d.agents, []);
  assert.match(d.warnings[0].message, /not valid JSON/);
  write(path.join(base, 'appData', 'munder-difflin', 'config.json'), '{bad');
  const resolved = defaultMunderHive(path.join(base, 'appData'));
  assert.equal(resolved.hive, null);
  assert.match(resolved.warning.errorId, /\S/);
  write(path.join(base, 'appData2', 'munder-difflin', 'config.json'), JSON.stringify({ harnessHome: '/h', apiKey: 'secret' }));
  assert.deepEqual(defaultMunderHive(path.join(base, 'appData2')), { hive: path.join('/h', 'hive') });
});

test('an oversized agent file is refused with a warning', () => {
  const { roots } = fixture();
  const big = path.join(roots.claudeHome, 'agents', 'huge.md');
  fs.writeFileSync(big, '---\nname: huge\n---\n' + 'x'.repeat(300 * 1024));
  const d = discoverAgents(roots, { sources: ['claude'] });
  assert.equal(byId(d, 'claude', 'user:huge'), undefined);
  assert.ok(d.warnings.some((w) => w.path === big && /limit/.test(w.message)));
});

// ─── dispatch ───────────────────────────────────────────────────────────────
function deps(roots) {
  const state = { events: [], logs: [], hires: [] };
  return {
    state,
    deps: {
      tasks: () => ({ tasks: [] }), patchTask: () => true, missions: () => [], saveMissions: () => {},
      agents: () => ({}), renameAgent: () => ({ ok: true }), setAgentTokenCap: () => {}, setNotifications: () => {},
      savePreference: () => {}, appendEvent: (e) => state.events.push(e), publish: () => {},
      logStep: (s) => state.logs.push(s),
      agentSources: { roots: () => roots, deliverHire: (m) => state.hires.push(m) }
    }
  };
}

test('agents.discover returns the discovery and logs each warning under its errorId', () => {
  const { roots, project } = fixture();
  const { state, deps: d } = deps(roots);
  const result = dispatchParamount({ type: 'agents.discover', projectDir: project }, d);
  assert.equal(result.ok, true);
  assert.ok(result.discovery.agents.length >= 8);
  const ids = [...result.discovery.warnings, ...result.discovery.agents.flatMap((a) => a.warnings)].map((w) => w.errorId);
  const logged = state.logs.filter((l) => l.kind === 'paramount-agent-source');
  assert.deepEqual(logged.map((l) => l.errorId).sort(), ids.sort());
  assert.ok(logged.every((l) => l.cid === result.event.correlationId && l.path));
  assert.equal(state.hires.length, 0, 'discovery never hires');
});

test('agents.import hands a validated hire manifest to the Add-Agent form', () => {
  const { roots, project } = fixture();
  const { state, deps: d } = deps(roots);
  const claude = dispatchParamount({ type: 'agents.import', source: 'claude', id: 'project:local', projectDir: project }, d);
  assert.equal(claude.ok, true);
  assert.equal(claude.imported.manifest.spec, 'munder-difflin/hire@1');
  assert.equal(claude.imported.manifest.provider, 'claude');
  assert.equal(claude.imported.manifest.goal, 'Project body.');
  assert.equal(claude.imported.manifest.model, undefined);
  assert.ok(claude.imported.adjustments.some((a) => /inherit/.test(a)));
  const munder = dispatchParamount({ type: 'agents.import', source: 'munder', id: 'jim' }, d);
  assert.equal(munder.ok, true);
  assert.equal(munder.imported.manifest.goal, 'You are Jim.');
  const codex = dispatchParamount({ type: 'agents.import', source: 'codex', id: 'user:agents/fixer' }, d);
  assert.equal(codex.ok, true, JSON.stringify(codex));
  assert.equal(codex.imported.manifest.provider, 'codex');
  assert.equal(state.hires.length, 3);
  assert.equal(state.events.length, 3);
});

test('agents.import failures carry an errorId and a code', () => {
  const { roots, project } = fixture();
  const { state, deps: d } = deps(roots);
  const cases = [
    [{ type: 'agents.import', source: 'claude', id: 'user:nope' }, 'NOT_FOUND'],
    [{ type: 'agents.import', source: 'claude', id: 'project:local' }, 'NOT_FOUND'],
    [{ type: 'agents.import', source: 'gemini', id: 'x' }, 'INVALID_INPUT'],
    [{ type: 'agents.import', source: 'claude', id: 'x', token: 'secret' }, 'INVALID_INPUT'],
    [{ type: 'agents.discover', projectDir: 'relative/dir' }, 'INVALID_INPUT'],
    [{ type: 'agents.discover', sources: ['claude', 'bogus'] }, 'INVALID_INPUT'],
    [{ type: 'agents.discover', sources: 'claude' }, 'INVALID_INPUT']
  ];
  for (const [command, code] of cases) {
    const result = dispatchParamount(command, d);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.equal(result.code, code, JSON.stringify(command));
    assert.match(result.errorId, /\S/);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  assert.equal(state.hires.length, 0);
  assert.equal(state.events.length, 0);
  const { agentSources, ...without } = d;
  const unsupported = dispatchParamount({ type: 'agents.discover' }, without);
  assert.equal(unsupported.code, 'UNSUPPORTED');
  assert.ok(project && agentSources);
});

test('archived entries whose folder is gone (finished temps) are skipped without a warning (owner run of ceeb4aaf)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-discover-'));
  try {
    const hive = path.join(root, 'hive');
    fs.mkdirSync(path.join(hive, 'agents', 'pam'), { recursive: true });
    fs.writeFileSync(path.join(hive, 'agents', 'pam', 'identity.md'), '# Pam');
    fs.writeFileSync(path.join(hive, 'registry.json'), JSON.stringify({ godId: null, agents: {
      pam: { name: 'Pam', provider: 'claude' },
      'temp-1': { name: 'Temp 1', provider: 'claude', archived: true },
      ghost: { name: 'Ghost', provider: 'claude' } } }));
    const empty = path.join(root, 'none');
    const r = findAgents({ claudeHome: empty, codexHome: empty, munderHive: hive });
    assert.deepEqual(r.found.map((a) => a.agent.id).sort(), ['ghost', 'pam'], 'the archived temp without a folder is not listed');
    assert.ok(!JSON.stringify(r).includes('temp-1'), 'and not warned about');
    assert.match(JSON.stringify(r.found.find((a) => a.agent.id === 'ghost').agent.warnings), /identity\.md is not readable/, 'a live entry without identity.md is still reported');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
