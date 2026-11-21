const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateBoard } = require('../src/main/board-validation.cjs');
const now = Date.parse('2026-11-16T06:00:00Z');
function fixture(t, tasks, registry = { agents: { owner: { archived: false } } }) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-validation-'));
 t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }));
 fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(registry));
 return root;
}
const task = { id: 'VRM-1', status: 'doing', assignee: 'owner', updatedAt: '2026-11-16T05:00:00Z', description: 'Show cards. Done when IDs and owners match. Evidence: Playwright runtime.' };
test('fresh board passes without changing any input bytes or modes', t => {
 const root = fixture(t, [task]);
 const before = ['tasks.json','registry.json'].map(f => [f, fs.readFileSync(path.join(root,f)), fs.statSync(path.join(root,f)).mode]);
 const r = validateBoard(root, { now }); assert.equal(r.ok, true);
 assert.ok(r.checks.every(c => c.result === 'pass'));
 for(const [f, bytes, mode] of before) { assert.deepEqual(fs.readFileSync(path.join(root,f)),bytes); assert.equal(fs.statSync(path.join(root,f)).mode,mode); }
});
test('bad JSON, non-array ledger, missing IDs and duplicate IDs fail closed', t => {
 const root=fixture(t,[task,{...task}]); assert.equal(validateBoard(root).ok,false);
 fs.writeFileSync(path.join(root,'tasks.json'),'{'); assert.equal(validateBoard(root).ok,false);
 fs.writeFileSync(path.join(root,'tasks.json'),'{"tasks":{}}'); assert.equal(validateBoard(root).ok,false);
 fs.writeFileSync(path.join(root,'tasks.json'),'{"tasks":[null,{}]}'); assert.equal(validateBoard(root).ok,false);
});
test('archived, missing owners and stale dates warn; no evidence creates acceptance', t => {
 const root=fixture(t,[{...task,updatedAt:'2026-10-01',description:'',assignee:'gone'}]);
 const r=validateBoard(root,{now});assert.equal(r.ok,true);
 for(const name of ['staleness','assignees','description_lint']) assert.equal(r.checks.find(c=>c.name===name).result,'warn');
 assert.match(r.acceptance,/runtime evidence/);
});
test('missing registry fails and does not invent owner liveness', t => {
 const root=fixture(t,[task]);fs.unlinkSync(path.join(root,'registry.json'));
 const r=validateBoard(root,{now});assert.equal(r.ok,false);assert.equal(r.checks.find(c=>c.name==='assignees').result,'skip');
});
test('future/missing timestamp and archived owner are reported', t => {
 const root=fixture(t,[{...task,updatedAt:'2027-01-01'},{...task,id:'VRM-2',updatedAt:null}],{agents:{owner:{archived:true}}});
 const r=validateBoard(root,{now});assert.equal(r.checks.find(c=>c.name==='staleness').items.length,2);assert.equal(r.checks.find(c=>c.name==='assignees').items.length,2);
});
test('installed CLI works from unrelated cwd, has correct error exit codes',t=>{
 const root=fixture(t,[task]);fs.mkdirSync(path.join(root,'bin'));
 const entry=path.join(root,'bin','validate-board.cjs');fs.copyFileSync(require.resolve('../src/main/board-validation.cjs'),entry);
 const run=(args=[])=>spawnSync(process.execPath,[entry,...args],{cwd:os.tmpdir(),encoding:'utf8'});
 assert.equal(run().status,0);assert.equal(JSON.parse(run().stdout).taskCount,1);
 assert.equal(run(['--root',root]).status,0);assert.equal(run(['--wrong']).status,2);
 fs.writeFileSync(path.join(root,'tasks.json'),'bad');assert.equal(run().status,1);
});
test('startup helper installs executable checker, logs fresh state, preserves ledger',t=>{
 const root=fixture(t,[task]);fs.mkdirSync(path.join(root,'bin'));
 const {installAndValidateBoard}=require('../src/main/board-validation.cjs');
 const before=fs.readFileSync(path.join(root,'tasks.json'));const events=[];
 installAndValidateBoard(root,require.resolve('../src/main/board-validation.cjs'),e=>events.push(e));
 assert.equal(events[0].kind,'board-validation');assert.equal(events[0].taskCount,1);
 assert.deepEqual(fs.readFileSync(path.join(root,'tasks.json')),before);
 fs.writeFileSync(path.join(root,'tasks.json'),'{"tasks":[]}');
 installAndValidateBoard(root,require.resolve('../src/main/board-validation.cjs'),e=>events.push(e));
 assert.equal(events[1].taskCount,0);assert.notEqual(events[0].tasksSha256,events[1].tasksSha256);
 const child=spawnSync(process.execPath,[path.join(root,'bin','validate-board.cjs')],{cwd:os.tmpdir(),encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(JSON.parse(child.stdout).taskCount,0);
 installAndValidateBoard(root,path.join(root,'missing'),e=>events.push(e));assert.equal(events[2].error,'VALIDATION_UNAVAILABLE');
});
// NSC-244: optional parent links
const parentCheck = (t, tasks) => validateBoard(fixture(t, tasks), { now });
test('cards without parentId, null parentId and valid parents pass', t => {
 const r = parentCheck(t, [task, { ...task, id: 'VRM-2', parentId: 'VRM-1' }, { ...task, id: 'VRM-3', parentId: null }]);
 assert.equal(r.ok, true); assert.equal(r.checks.find(c => c.name === 'parents').result, 'pass');
});
test('a missing parent warns without failing the board', t => {
 const r = parentCheck(t, [{ ...task, parentId: 'VRM-404' }]);
 const check = r.checks.find(c => c.name === 'parents');
 assert.equal(r.ok, true); assert.equal(check.result, 'warn'); assert.match(check.items[0], /VRM-404 does not exist/);
});
test('self parents, non-string parents and cycles fail', t => {
 for (const tasks of [[{ ...task, parentId: 'VRM-1' }], [{ ...task, parentId: 7 }]]) assert.equal(parentCheck(t, tasks).ok, false);
 const r = parentCheck(t, [{ ...task, parentId: 'VRM-3' }, { ...task, id: 'VRM-2', parentId: 'VRM-1' }, { ...task, id: 'VRM-3', parentId: 'VRM-2' }, { ...task, id: 'VRM-4', parentId: 'VRM-3' }]);
 const check = r.checks.find(c => c.name === 'parents');
 assert.equal(r.ok, false); assert.equal(check.result, 'error'); assert.equal(check.items.length, 1); assert.match(check.items[0], /parent cycle/);
});
