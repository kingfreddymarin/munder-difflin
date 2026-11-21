'use strict';
// Read-only, dependency-free board checks. No semantic acceptance or task-state writes.
const { readFileSync, copyFileSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

function validateBoard(root, { now = Date.now(), staleHours = 48 } = {}) {
  const start = performance.now();
  const checks = [];
  const report = { ok: true, boardRoot: resolve(root), tasksFile: 'tasks.json', checks };
  const add = (name, result, items = []) => { checks.push({ name, result, items }); if (result === 'error') report.ok = false; };
  const finish = () => ({ ...report, elapsed_ms: Math.round((performance.now() - start) * 100) / 100 });
  let ledger, raw;
  try {
    raw = readFileSync(join(root, 'tasks.json'));
    report.tasksSha256 = createHash('sha256').update(raw).digest('hex');
    ledger = JSON.parse(raw.toString('utf8'));
    if (!ledger || !Array.isArray(ledger.tasks)) throw new Error('Expected an object with a tasks array');
    add('json_valid', 'pass');
  } catch (e) { add('json_valid', 'error', [e.code || e.message]); return finish(); }
  let agents;
  try {
    const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
    if (!registry.agents || typeof registry.agents !== 'object' || Array.isArray(registry.agents)) throw new Error('Expected registry.agents object');
    agents = registry.agents;
    add('registry_valid', 'pass');
  } catch (e) { add('registry_valid', 'error', [e.code || e.message]); }
  const ids = new Set(), duplicates = [], malformed = [], stale = [], owners = [], descriptions = [];
  const statuses = new Set(['todo', 'doing', 'blocked', 'done', 'review', 'backlog']);
  for (const [index, task] of ledger.tasks.entries()) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id.trim()) {
      malformed.push(`entry ${index}: missing string id`); continue;
    }
    if (ids.has(task.id)) duplicates.push(task.id);
    ids.add(task.id);
    if (!statuses.has(task.status)) malformed.push(`${task.id}: unknown status`);
    if (task.status === 'doing') {
      const updated = typeof task.updatedAt === 'string' ? Date.parse(task.updatedAt) : NaN;
      if (!Number.isFinite(updated)) stale.push(`${task.id}: missing/invalid updatedAt`);
      else if (updated > now) stale.push(`${task.id}: future updatedAt`);
      else if (now - updated > staleHours * 3600000) stale.push(`${task.id}: older than ${staleHours}h`);
      if (agents && (!Object.hasOwn(agents, task.assignee) || !agents[task.assignee] || agents[task.assignee].archived === true)) owners.push(`${task.id}: missing/unknown/archived assignee`);
    }
    if (task.status === 'doing' || task.status === 'todo') {
      const text = typeof task.description === 'string' ? task.description : '';
      const missing = [];
      if (!text.trim()) missing.push('goal');
      if (!/\b(done|pass|complete|valid|succeeds|accepted) when\b/i.test(text)) missing.push('done condition');
      if (!/evidence:|artifact:|\brun\s|\bbuild\s|\.(json|log|md)\b|screenshot|https?:\/\//i.test(text)) missing.push('evidence pointer');
      if (missing.length) descriptions.push(`${task.id}: missing ${missing.join(', ')}`);
    }
  }
  // Optional parent links (parentId): a missing parent warns (it may have been deleted); a malformed link, a self-parent or a cycle fails.
  const parentOf = new Map(), badParents = [], missingParents = [];
  for (const task of ledger.tasks) {
    if (!task || typeof task !== 'object' || typeof task.id !== 'string' || parentOf.has(task.id) || task.parentId == null || task.parentId === '') continue;
    if (typeof task.parentId !== 'string') badParents.push(`${task.id}: parentId is not a card id`);
    else if (task.parentId === task.id) badParents.push(`${task.id}: is its own parent`);
    else if (!ids.has(task.parentId)) missingParents.push(`${task.id}: parent ${task.parentId} does not exist`);
    else parentOf.set(task.id, task.parentId);
  }
  const inCycle = new Set();
  for (const start of parentOf.keys()) {
    const path = [];
    for (let at = start; parentOf.has(at) && !inCycle.has(at); at = parentOf.get(at)) {
      const loop = path.indexOf(at);
      if (loop >= 0) { const cycle = path.slice(loop); cycle.forEach((id) => inCycle.add(id)); badParents.push(`parent cycle: ${[...cycle, at].join(' -> ')}`); break; }
      path.push(at);
    }
  }
  add('task_shape', malformed.length ? 'error' : 'pass', malformed);
  add('parents', badParents.length ? 'error' : missingParents.length ? 'warn' : 'pass', [...badParents, ...missingParents]);
  add('unique_ids', duplicates.length ? 'error' : 'pass', duplicates);
  add('staleness', stale.length ? 'warn' : 'pass', stale);
  add('assignees', agents ? (owners.length ? 'warn' : 'pass') : 'skip', owners);
  add('description_lint', descriptions.length ? 'warn' : 'pass', descriptions);
  report.taskCount = ledger.tasks.length;
  report.acceptance = 'Lint and consistency only; runtime evidence is required for completion.';
  return finish();
}

function installAndValidateBoard(root, assetPath, appendLog) {
  try {
    copyFileSync(assetPath, join(root, 'bin', 'validate-board.cjs'));
    const report = validateBoard(root);
    appendLog({ kind: 'board-validation', ...report });
    return report;
  } catch {
    const failure = { kind: 'board-validation', ok: false, error: 'VALIDATION_UNAVAILABLE' };
    appendLog(failure);
    return failure;
  }
}

function cli(argv) {
  // The installed copy lives in <floor>/hive/bin; explicit --root supports Studio-root use.
  if (argv.length && (argv.length !== 2 || argv[0] !== '--root')) {
    process.stderr.write('Usage: node validate-board.cjs [--root <hive-directory>]\n'); return 2;
  }
  const root = argv.length ? resolve(argv[1]) : resolve(dirname(__filename), '..');
  const report = validateBoard(root);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.ok ? 0 : 1;
}
module.exports = { validateBoard, installAndValidateBoard, cli };
if (require.main === module) process.exitCode = cli(process.argv.slice(2));
