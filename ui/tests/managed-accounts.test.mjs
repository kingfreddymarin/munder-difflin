import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ui, 'package.json'));
const { build } = require('esbuild');
const result = await build({ entryPoints: [path.join(ui, 'src/features/settings/managed-accounts.tsx')], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', plugins: [{ name: 'inert-ui-bindings', setup(b) {
  b.onResolve({ filter: /^@\// }, a => ({ path: a.path, namespace: 'inert' }));
  b.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: 'export const useDispatch=()=>{};export const useTeamApi=()=>{};export const EngineSignInActions=()=>null;' }));
} }] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, mod, mod.exports);
const { ManagedAccountsController, accountSignInProps } = mod.exports;
const account = { id:'opaque-a', fingerprint:'fp-a', provider:'claude', label:'Work', source:'managed', unrestricted:false, available:true };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return {promise,resolve}; };
test('create dispatches only provider and trimmed user label, reloads full catalog and notifies selectors', async () => {
  const commands=[]; let changed=0; let accounts=[];
  const c=new ManagedAccountsController({models:async()=>({accounts}),dispatch:async command=>{commands.push(command);accounts=[account];return true;},changed:()=>changed++});
  await c.load(); assert.equal(c.getSnapshot().supported,true);
  assert.equal(await c.save({type:'accounts.create',provider:'claude',label:'  Work  '}),true);
  assert.deepEqual(commands,[{type:'accounts.create',provider:'claude',label:'Work'}]);
  assert.deepEqual(c.getSnapshot().accounts,[account]);assert.equal(changed,1);
});
test('rename routes exact immutable ID and keeps unavailable profiles visible',async()=>{
  const commands=[];const unavailable={...account,available:false};
  const c=new ManagedAccountsController({models:async()=>({accounts:[unavailable]}),dispatch:async x=>{commands.push(x);return true;},changed:()=>{}});
  await c.save({type:'accounts.rename',id:account.id,label:'Personal'});
  assert.deepEqual(commands,[{type:'accounts.rename',id:account.id,label:'Personal'}]);assert.deepEqual(c.getSnapshot().accounts,[unavailable]);
});
test('sign-in props scope provider, ID and fingerprint, and disable unavailable profiles',()=>{
  for(const provider of ['claude','codex']) {
    assert.deepEqual(accountSignInProps({...account,provider}),{provider,accountId:'opaque-a',accountFingerprint:'fp-a',accountLabel:'Work',state:'unknown',accountSelection:'selected',cliAvailable:true});
  }
  assert.equal(accountSignInProps({...account,available:false}).accountSelection,'unavailable');assert.equal(accountSignInProps({...account,available:false}).cliAvailable,false);
});
test('stale catalog responses and unmounted requests cannot replace current profiles',async()=>{
  const a=deferred(),b=deferred();let n=0;
  const c=new ManagedAccountsController({models:()=>++n===1?a.promise:b.promise,dispatch:async()=>true,changed:()=>{}});
  const first=c.load(),second=c.load();b.resolve({accounts:[account]});await second;a.resolve({accounts:[]});await first;assert.deepEqual(c.getSnapshot().accounts,[account]);
  const pending=deferred();const d=new ManagedAccountsController({models:()=>pending.promise,dispatch:async()=>true,changed:()=>{}});const request=d.load();d.stop();pending.resolve({accounts:[account]});await request;assert.deepEqual(d.getSnapshot().accounts,[]);
});
test('blank labels, failed writes, unsupported backend and duplicate submissions remain explicit',async()=>{
  const pending=deferred();let calls=0;let changes=0;
  const c=new ManagedAccountsController({models:async()=>({}),dispatch:()=>{calls++;return pending.promise;},changed:()=>changes++});await c.load();assert.equal(c.getSnapshot().supported,false);
  assert.equal(await c.save({type:'accounts.create',provider:'codex',label:' '}),false);assert.equal(calls,0);
  const saving=c.save({type:'accounts.create',provider:'codex',label:'Work'});assert.equal(await c.save({type:'accounts.create',provider:'codex',label:'Work'}),false);pending.resolve(false);assert.equal(await saving,false);assert.equal(calls,1);assert.equal(changes,0);assert.match(c.getSnapshot().error,/failed/);assert.equal(c.getSnapshot().busy,false);
});
test('render wiring keys identity by fingerprint and refreshes selector controllers without remounting drafts',()=>{
  const source=fs.readFileSync(path.join(ui,'src/features/settings/managed-accounts.tsx'),'utf8');assert.match(source,/key=\{`\$\{account.id\}:\$\{account.fingerprint\}`\}/);assert.match(source,/Labels are names you choose, not verified email/);assert.doesNotMatch(source,/type="password"/);
  const settings=fs.readFileSync(path.join(ui,'src/pages/settings.tsx'),'utf8');assert.equal((settings.match(/LauncherSettings refreshToken=\{accountsRevision\}/g)||[]).length,4);
  const launcher=fs.readFileSync(path.join(ui,'src/features/team/launcher-select.tsx'),'utf8');assert.match(launcher,/if \(api && refreshToken\) void controller.load\(\)/);
});
test('sample provider refuses real account mutations instead of reporting fake success',async()=>{
  const bundled=await build({entryPoints:[path.join(ui,'src/data/mock-provider.ts')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});
  const sample={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(require,sample,sample.exports);
  const provider=sample.exports.createMockProvider();
  for(const command of [{type:'accounts.create',provider:'claude',label:'Work'},{type:'accounts.rename',id:'opaque-a',label:'Personal'}]) await assert.rejects(provider.dispatch(command),/require the desktop core/);
  assert.equal((await provider.teamModels()).accounts,undefined);
});
test('successful creation with failed catalog refresh reports saved state without encouraging duplicate creation',async()=>{
  let calls=0;const c=new ManagedAccountsController({models:async()=>{throw new Error('offline');},dispatch:async()=>{calls++;return true;},changed:()=>{}});
  assert.equal(await c.save({type:'accounts.create',provider:'claude',label:'Work'}),true);assert.equal(calls,1);assert.match(c.getSnapshot().error,/was saved.*could not refresh/);
});
