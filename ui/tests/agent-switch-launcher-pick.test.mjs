import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// NSC-267: switching provider or model without re-picking the launcher failed with INVALID_INPUT
// "Invalid launcher selection." because the switch form was seeded with the team.models launcher,
// which carries a label the core's validateLauncher refuses.
const ui=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(ui,'package.json'));
const {build}=require('esbuild');
const load=async(entry)=>{const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
  const mod={exports:{}};new Function('module','exports','require',result.outputFiles[0].text)(mod,mod.exports,require);return mod.exports;};
const {switchLauncherSeed,canSwitchAgent}=await load(path.join(ui,'src/features/team/agent-switch.ts'));
const {launcherPick,fitLauncher}=await load(path.join(ui,'src/lib/launcher-fit.ts'));
const {validateLauncher}=await load(path.join(ui,'../src/main/council-account-launchers.ts'));
const fp='a'.repeat(64),other='b'.repeat(64);
const saved={id:'dc',fingerprint:fp,label:'Work'},live={id:'dcxm',fingerprint:other,label:'Personal'};
const profile=(p)=>({...p,provider:'claude',unrestricted:false,bin:'claude',args:[],home:'/home'});
const discovery={status:'ok',choices:[],profiles:[profile(saved),profile(live)]};

test('a launcher seeded with a label is dispatched as {id, fingerprint}',()=>{
  assert.throws(()=>validateLauncher(saved,'claude',discovery),/Invalid launcher selection/,'the labelled seed is what the core refused');
  const seed=switchLauncherSeed({engine:'claude',installed:true,accountSelection:'selected',launcher:saved});
  assert.deepEqual(seed,{id:'dc',fingerprint:fp});
  assert.equal(validateLauncher(seed,'claude',discovery).id,'dc');
});

test('the running launcher wins over the saved one and is narrowed the same way',()=>{
  const seed=switchLauncherSeed({engine:'claude',installed:true,accountSelection:'selected',launcher:saved,running:{provider:'claude',accountSelection:'selected',launcher:live}});
  assert.deepEqual(seed,{id:'dcxm',fingerprint:other});
  assert.equal(validateLauncher(seed,'claude',discovery).id,'dcxm');
  assert.equal(switchLauncherSeed({engine:'claude',installed:true,accountSelection:'selected',launcher:saved,running:{provider:'claude',accountSelection:'default'}}),null,'a live provider default stays default');
  assert.equal(switchLauncherSeed({engine:'claude',installed:true,accountSelection:'default'}),null);
  assert.equal(switchLauncherSeed(undefined),null);
});

test('a model-only switch on the seeded launcher is admitted and dispatchable',()=>{
  const account={engine:'claude',installed:true,accountSelection:'selected',launcher:saved};
  const seed=switchLauncherSeed(account);
  assert.equal(canSwitchAgent({role:'agent',currentProvider:'claude',currentModel:'old',model:'new',currentAccount:account,provider:'claude',launcher:seed,chosen:true,
    discovery:{status:'ok',choices:[{id:'dc',fingerprint:fp,provider:'claude',label:'Work',unrestricted:false}]}}),true);
  assert.deepEqual(Object.keys(launcherPick(seed)).sort(),['fingerprint','id']);
});

test('explicit unrestricted consent survives narrowing; nothing else does',()=>{
  assert.deepEqual(launcherPick({...saved,allowUnrestricted:true}),{id:'dc',fingerprint:fp,allowUnrestricted:true});
  assert.deepEqual(launcherPick({...saved,allowUnrestricted:false}),{id:'dc',fingerprint:fp});
  assert.equal(launcherPick(null),null);assert.equal(launcherPick(undefined),null);
  assert.deepEqual(fitLauncher({...saved},'claude',{status:'ok',choices:[{id:'dc',provider:'claude',fingerprint:fp,label:'Work',unrestricted:false}]}),{id:'dc',fingerprint:fp});
});
