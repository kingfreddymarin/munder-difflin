import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ui=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(ui,'package.json'));
const {build}=require('esbuild');
const result=await build({entryPoints:[path.join(ui,'src/features/team/agent-switch.ts')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
const mod={exports:{}};new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {canSwitchAgent}=mod.exports;
const a={id:'a',fingerprint:'fp-a'},b={id:'b',fingerprint:'fp-b'};
const input={role:'paramount',currentProvider:'claude',currentAccount:{accountSelection:'selected',launcher:a},provider:'claude',launcher:b,chosen:true,discovery:{status:'ok',choices:[{...a,provider:'claude'},{...b,provider:'claude'},{id:'c',fingerprint:'fp-c',provider:'codex'}]}};
test('Paramount and persistent agents can explicitly switch accounts within same provider',()=>{
  for(const role of ['paramount','lead','agent']) assert.equal(canSwitchAgent({...input,role}),true);
  assert.equal(canSwitchAgent({...input,chosen:false}),false); assert.equal(canSwitchAgent({...input,launcher:a}),false);
  assert.equal(canSwitchAgent({...input,launcher:null}),true,'explicit provider default selectable even with named accounts');
});
test('provider-default no-op refused, default to named account allowed, cross-provider default allowed',()=>{
  assert.equal(canSwitchAgent({...input,currentAccount:{accountSelection:'default'},launcher:null}),false);
  assert.equal(canSwitchAgent({...input,currentAccount:{accountSelection:'default'},launcher:b}),true);
  assert.equal(canSwitchAgent({...input,provider:'codex',launcher:null}),true);
});
test('stale identities, wrong providers and incomplete discovery cannot start a switch',()=>{
  assert.equal(canSwitchAgent({...input,launcher:{...b,fingerprint:'old'}}),false);assert.equal(canSwitchAgent({...input,provider:'codex',launcher:b}),false);
  for(const status of ['timeout','failed']) assert.equal(canSwitchAgent({...input,discovery:{...input.discovery,status}}),false);
  assert.equal(canSwitchAgent({...input,discovery:undefined}),false);
  assert.equal(canSwitchAgent({...input,role:'ephemeral'}),false);assert.equal(canSwitchAgent({...input,role:'watcher'}),false);
});
test('unavailable current selection requires explicit choice, never automatic reset to default',()=>{
  for(const accountSelection of ['stale','unavailable']) {
    assert.equal(canSwitchAgent({...input,currentAccount:{accountSelection},launcher:null,chosen:false}),false);
    assert.equal(canSwitchAgent({...input,currentAccount:{accountSelection},launcher:null}),true);
  }
});
test('unknown live account refuses switching and a different model is a real explicit transition',()=>{
  assert.equal(canSwitchAgent({...input,currentAccount:{accountSelection:'unknown'},provider:'codex',launcher:null}),false);
  assert.equal(canSwitchAgent({...input,launcher:a,currentModel:'old-model',model:'new-model'}),true);
  assert.equal(canSwitchAgent({...input,launcher:a,currentModel:'same-model',model:'same-model'}),false);
});
test('exact available managed target survives shell discovery failure; stale, unavailable and legacy choices remain refused',()=>{
  const managed={...b,provider:'claude',label:'Work',source:'managed',available:true,unrestricted:false};
  for(const status of ['timeout','failed']) {
    const degraded={...input,discovery:{status,choices:[]},accounts:[managed]};
    assert.equal(canSwitchAgent(degraded),true);
    for(const patch of [{fingerprint:'old'},{id:'other'},{provider:'codex'},{available:false},{source:'legacy'}]) assert.equal(canSwitchAgent({...degraded,accounts:[{...managed,...patch}]}),false);
    assert.equal(canSwitchAgent({...degraded,launcher:null}),false);
    assert.equal(canSwitchAgent({...degraded,accounts:[]}),false);
  }
});
test('live undefined model remains provider default even when next-start preference is saved',()=>{
  const {currentSwitchModel}=mod.exports;
  const account={engine:'claude',model:'saved-next-start',accountSelection:'selected',launcher:a,running:{provider:'claude',accountSelection:'selected',launcher:a}};
  assert.equal(currentSwitchModel(account),undefined);
  assert.equal(currentSwitchModel({...account,running:undefined}),'saved-next-start');
  assert.equal(currentSwitchModel({...account,running:{...account.running,model:'actual-live'}}),'actual-live');
  assert.equal(canSwitchAgent({...input,launcher:a,currentModel:currentSwitchModel(account),model:''}),false);
  assert.equal(canSwitchAgent({...input,launcher:a,currentModel:currentSwitchModel(account),model:'saved-next-start'}),true);
});
