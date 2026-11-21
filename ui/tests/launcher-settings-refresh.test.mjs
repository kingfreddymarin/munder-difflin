import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ui, 'package.json'));
const { build } = require('esbuild');
const result = await build({ entryPoints: [path.join(ui, 'src/features/team/launcher-select.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', plugins: [{ name: 'inert-react-bindings', setup(b) {
  b.onResolve({ filter: /^@\/data\/store$|^@\/components\/app\/error-notice$/ }, a => ({ path: a.path, namespace: 'inert' }));
  b.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: 'export const useDispatch=()=>{};export const useTeamApi=()=>{};export const ErrorNotice=()=>null;' }));
  b.onResolve({ filter: /^@\// }, a => ({ path: path.join(ui, 'src', a.path.slice(2) + '.ts') }));
} }] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports);
const { LauncherSettingsController, savedOrchestratorLauncher } = mod.exports;
const pick = id => ({ id, fingerprint: id });
const models = (status = 'ok', saved = 'a') => ({ launchers: { status, choices: status === 'ok' ? ['a','b'].map(id => ({...pick(id),provider:'claude'})) : [] }, launcherState: { temps: pick(saved) } });
const flush = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; };
function fixture(overrides = {}) {
  let data = models('failed'); let calls=0; let refreshes=0; const timers = new Map(); let next=0; const delays=[];
  const controller = new LauncherSettingsController({models:async()=>{calls++;return data;},persisted:m=>m.launcherState.temps,refresh:async()=>{refreshes++;return true;},save:async()=>true,schedule:(fn,ms)=>{delays.push(ms);timers.set(++next,fn);return next;},cancel:id=>timers.delete(id),...overrides});
  return {controller,timers,delays,set:data2=>{data=data2;},calls:()=>calls,refreshes:()=>refreshes,tick:async()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();await flush();}};
}
test('pending discovery becomes ready on a bounded model check without explicit refresh',async()=>{
  const f=fixture();f.controller.start();await flush();assert.equal(f.controller.getSnapshot().models.launchers.status,'failed');f.set(models());await f.tick();assert.equal(f.controller.getSnapshot().models.launchers.status,'ok');assert.equal(f.refreshes(),0);assert.equal(f.timers.size,0);f.controller.stop();
});
test('automatic completion and manual refresh preserve a dirty choice',async()=>{
  const f=fixture();f.controller.start();await flush();f.controller.edit(pick('b'));f.set(models());await f.tick();assert.deepEqual(f.controller.getSnapshot().value,pick('b'));await f.controller.refresh();assert.deepEqual(f.controller.getSnapshot().value,pick('b'));assert.equal(f.controller.getSnapshot().selectionEdited,true);f.controller.stop();
});
test('an edit during an initial slow response survives',async()=>{
  const d=deferred();const f=fixture({models:()=>d.promise});f.controller.start();f.controller.edit(pick('b'));d.resolve(models());await flush();assert.deepEqual(f.controller.getSnapshot().value,pick('b'));f.controller.stop();
});
test('obsolete response cannot overwrite a newer response',async()=>{
  const a=deferred(),b=deferred();let calls=0;const f=fixture({models:()=>++calls===1?a.promise:b.promise});f.controller.start();const latest=f.controller.load();b.resolve(models('ok','b'));await latest;a.resolve(models('ok','a'));await flush();assert.deepEqual(f.controller.getSnapshot().value,pick('b'));f.controller.stop();
});
test('unmount cancels polling and ignores the old target response',async()=>{
  const f=fixture();f.controller.start();await flush();assert.equal(f.timers.size,1);f.controller.stop();assert.equal(f.timers.size,0);const d=deferred();const old=fixture({models:()=>d.promise});old.controller.start();old.controller.stop();d.resolve(models());await flush();assert.equal(old.controller.getSnapshot().models,null);assert.equal(old.timers.size,0);
});
test('failed discovery stops after six timed checks and manual refresh restarts the budget',async()=>{
  const f=fixture();f.controller.start();await flush();for(let i=0;i<6;i++)await f.tick();assert.equal(f.calls(),7);assert.equal(f.timers.size,0);assert.equal(f.controller.getSnapshot().retryExhausted,true);assert.deepEqual(f.delays,[1000,2000,4000,8000,16000,30000]);await f.controller.refresh();assert.equal(f.controller.getSnapshot().retryExhausted,false);assert.equal(f.timers.size,1);f.controller.stop();
});
test('save acknowledgement preserves a newer edit and failed save keeps draft',async()=>{
  const d=deferred();const f=fixture({save:()=>d.promise});f.set(models());f.controller.start();await flush();f.controller.edit(pick('b'));const pending=f.controller.save();f.controller.edit(null);d.resolve(true);await pending;assert.equal(f.controller.getSnapshot().value,null);assert.equal(f.controller.getSnapshot().selectionEdited,true);assert.equal(f.controller.getSnapshot().saved,false);f.controller.stop();const failed=fixture({save:async()=>false});failed.set(models());failed.controller.start();await flush();failed.controller.edit(pick('b'));await failed.controller.save();assert.deepEqual(failed.controller.getSnapshot().value,pick('b'));assert.equal(failed.controller.getSnapshot().selectionEdited,true);failed.controller.stop();
});
test('missing fingerprint remains an explicit dirty draft after discovery changes',async()=>{
  const f=fixture();f.controller.start();await flush();f.controller.edit({id:'gone',fingerprint:'old'});f.set(models());await f.tick();assert.deepEqual(f.controller.getSnapshot().value,{id:'gone',fingerprint:'old'});assert.equal(f.controller.getSnapshot().selectionEdited,true);f.controller.stop();
});

test('a pristine orchestrator saved account remains unavailable when it disappears',async()=>{
  const saved=pick('a');
  const available={...models(),orchestratorProvider:'claude',launcherState:{orchestrator:saved}};
  const gone={...available,launchers:{status:'ok',choices:[]}};
  assert.deepEqual(savedOrchestratorLauncher(gone),saved);
  assert.deepEqual(savedOrchestratorLauncher({...gone,launchers:{status:'failed',choices:[]}}),saved);
  assert.equal(savedOrchestratorLauncher({...available,orchestratorProvider:'codex'}),null,'known provider mismatch retains existing behavior');
  const f=fixture({persisted:savedOrchestratorLauncher});f.set(available);f.controller.start();await flush();f.set(gone);await f.controller.refresh();assert.deepEqual(f.controller.getSnapshot().value,saved);assert.equal(f.controller.getSnapshot().selectionEdited,false);f.controller.stop();
});
