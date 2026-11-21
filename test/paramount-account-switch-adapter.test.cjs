const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');const load=require('./load-ts.cjs');
const lifecycle=load('src/main/paramount-engine-switch.ts');
const source=process.env.PARAMOUNT_REVIEW_REV ? require('node:child_process').execFileSync('git',['show',process.env.PARAMOUNT_REVIEW_REV+':src/main/index.ts'],{encoding:'utf8'}) : fs.readFileSync(path.join(__dirname,'../src/main/index.ts'),'utf8');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
const factory=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='paramountTeamDeps');
const prop=factory.body.statements.find(ts.isReturnStatement).expression.properties.find(p=>p.name?.getText(ast)==='switchAgent');
const js=ts.transpileModule(`(${prop.initializer.getText(ast)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-switch-adapter-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const old={id:'acct_old',fingerprint:'a'.repeat(64)};const next={id:'acct_next',fingerprint:'b'.repeat(64)};
 const row={id:'god',name:'Paramount',provider:'codex',isGod:true,role:'leader',cwd:root,archived:options.stopped===true};
 let session=options.noSession?undefined:'original-session';let selection=old;let model;let live=!options.stopped;
 const config={godProvider:'codex',godModel:'old-model'};const calls=[];const scopes=[];const starts=[];
 const profiles=[{...old,provider:'codex',label:'Old',home:root,bin:'codex'},{...next,provider:options.same?'codex':'claude',label:'New',home:root,bin:options.same?'codex':'claude'}];
 const diagnostics=[];
 const context={...lifecycle,paramountLog:event=>diagnostics.push(event),diagnostics,join:path.join,statSync:fs.statSync,
 hive:{root:()=>root,enabled:()=>true,registry:()=>({godId:'god',agents:{god:{...row}}}),lastSession:()=>session,
 setAgentProvider:(_id,p)=>{row.provider=p;return {ok:true};},ensureAgent:async(meta,opts)=>{Object.assign(row,meta);session=opts.clearSession?undefined:opts.sessionId??session;},send:()=>{}},
 claimFloor:()=>true,readConfig:()=>({...config}),applyConfigUpdate:patch=>{Object.assign(config,patch);if(options.persistFail&&!options.failed){options.failed=true;throw new Error('config write failed');}},
 ptyManager:{list:()=>live?[{id:'god'}]:[],kill:()=>{calls.push('kill');if(options.cleanupFail&&calls.filter(x=>x==='kill').length>1)return {ok:false,error:'cleanup uncertain'};live=false;return {ok:true};},isCommandAvailable:()=>true,waitForExit:async()=>({exited:false})},
 ptyLaunchIdentity:new Map([['god',{provider:'codex',model:'live-model',launcher:old,home:root}]]),
 ptyToAgent:new Map([['god','god']]),worktreePaths:new Map(),readAgentModels:()=>model?{god:model}:{},readLauncherState:()=>({orchestrator:selection,agents:{}}),currentAccountDiscovery:()=>({profiles}),
 validateLauncher:(pick,p)=>{const a=profiles.find(x=>x.id===pick.id&&x.fingerprint===pick.fingerprint&&x.provider===p);if(!a)throw new Error('stale');return a;},
 engineSignIn:{refresh:async(p,a)=>{calls.push('auth:'+a?.id);return {state:options.authFail?'signed-out':'signed-in'};}},
 buildWorkerLaunch:({requestProvider,requestModel})=>({bin:requestProvider,args:requestModel?[requestModel]:[]}),
 teardownPty:()=>{},restoreArchived:(_id,v)=>row.archived=v,
 saveAgentModelPick:(_root,_id,p,m)=>{model=m?{engine:p,model:m}:undefined;},saveLauncherPick:(_root,scope,p)=>{scopes.push(scope);selection=p;},sender:{send:()=>{}},
 paramountOrchestrators:new Set(),orchestratorStart:{started:(...args)=>starts.push(args)},
 spawnAgentCore:async opts=>{calls.push('spawn');Object.assign(row,opts.hive);session=opts.clearSession?undefined:opts.resumeSessionId??session;live=true;context.spawns.push(opts);if(options.partialThrow&&context.spawns.length===1)throw new Error('partial start');return {ok:true,resumed:opts.resume,seedPrompt:'seed'};},spawns:[]};
 return {setSaved:p=>selection=p,switch:vm.runInNewContext(js,context),context,row,config,calls,scopes,starts,old,next,root,session:()=>session,selection:()=>selection,model:()=>model,target:{provider:options.same?'codex':'claude',model:'new-model',launcher:next}};
}
test('production god switch preserves role and identity, authenticates exact target and starts fresh',async t=>{
 const f=fixture(t);assert.equal((await f.switch('god',f.target)).ok,true);
 assert.equal(f.calls[0],'auth:acct_next');assert.equal(f.row.isGod,true);assert.equal(f.row.id,'god');assert.equal(f.row.name,'Paramount');assert.equal(f.row.cwd,f.root);
 assert.equal(f.context.spawns[0].resume,false);assert.equal(f.context.spawns[0].clearSession,true);assert.equal(f.context.spawns[0].resumeSessionId,undefined);
 assert.equal(f.config.godProvider,'claude');assert.equal(f.config.godModel,'new-model');assert.deepEqual(f.scopes,['orchestrator']);assert.equal(f.starts.length,1);
 const history=JSON.parse(fs.readFileSync(path.join(f.root,'paramount-agent-engine-history.json'))).agents.god[0];assert.equal(history.launcherFingerprint,f.old.fingerprint);assert.equal(history.isGod,true);
});
test('production same-provider switch rollback restores exact account, config, model absence and session',async t=>{
 const f=fixture(t,{same:true,persistFail:true});const r=await f.switch('god',f.target);assert.equal(r.ok,false);assert.equal(r.rollbackError,undefined);
 assert.equal(f.context.spawns.length,2);assert.equal(f.context.spawns[1].resume,true);assert.equal(f.context.spawns[1].resumeSessionId,'original-session');assert.equal(f.context.spawns[1].hive.isGod,true);assert.equal(f.context.spawns[1].args[0],'live-model');
 assert.equal(f.selection().fingerprint,f.old.fingerprint);assert.deepEqual(f.config,{godProvider:'codex',godModel:'old-model'});assert.equal(f.model(),undefined);assert.equal(f.session(),'original-session');
});
test('stopped god rollback restores absent session without starting old process',async t=>{
 const f=fixture(t,{stopped:true,noSession:true,persistFail:true});assert.equal((await f.switch('god',f.target)).ok,false);assert.equal(f.context.spawns.length,1);assert.equal(f.session(),undefined);assert.equal(f.row.isGod,true);assert.equal(f.row.archived,true);
});
test('auth refusal preserves old process and startup state',async t=>{
 const f=fixture(t,{authFail:true});assert.equal((await f.switch('god',f.target)).ok,false);assert.equal(f.calls.includes('kill'),false);assert.equal(f.starts.length,0);assert.equal(f.session(),'original-session');
});
test('partial target start and uncertain cleanup cannot spawn rollback duplicate',async t=>{
 const f=fixture(t,{partialThrow:true,cleanupFail:true});const r=await f.switch('god',f.target);assert.equal(r.ok,false);assert.equal(r.rollbackError,'cleanup uncertain');assert.equal(f.context.spawns.length,1);
});

test('live A with saved B resumes A on failed switch while restoring saved B',async t=>{
 const f=fixture(t,{persistFail:true});const saved={id:'saved-next',fingerprint:'c'.repeat(64)};f.setSaved(saved);
 assert.equal((await f.switch('god',f.target)).ok,false);
 assert.equal(f.context.spawns[1].councilLauncher.id,f.old.id);assert.equal(f.context.spawns[1].councilLauncher.fingerprint,f.old.fingerprint);
 assert.equal(f.context.spawns[1].expectedAccountHome,f.root);assert.equal(f.selection().id,saved.id);
});
test('unknown running identity refuses switch before stopping',async t=>{
 const f=fixture(t);f.context.ptyLaunchIdentity.clear();assert.equal((await f.switch('god',f.target)).ok,false);assert.equal(f.calls.includes('kill'),false);
});

test('current live provider/account/model no-op is refused before auth or stop',async t=>{
 const f=fixture(t,{same:true});const r=await f.switch('god',{provider:'codex',model:'live-model',launcher:f.old});assert.equal(r.ok,false);assert.match(r.error,/already running/);assert.equal(f.calls.length,0);
});
test('default Codex preflight uses per-agent target home and pins it at spawn',async t=>{
 const f=fixture(t,{same:true});let probed;
 f.context.engineSignIn.refresh=async(p,a)=>{probed=a;return {state:'signed-in'};};
 assert.equal((await f.switch('god',{provider:'codex',model:'new-model',launcher:null})).ok,true);
 assert.equal(probed.home,path.join(f.root,'agents','god','.codex'));
 assert.equal(f.context.spawns[0].expectedAccountHome,probed.home);assert.equal(f.context.spawns[0].requireProvisioning,true);
});
test('production spawn records account fingerprint for exact expired-auth attribution',()=>{
 const spawn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='spawnAgentCore');
 const statement=spawn.body.statements.find(n=>n.getText(ast).includes('ptySignInAccount.set'));
 const code=ts.transpileModule(statement.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const account={id:'acct_a',label:'Work',home:'/fixture',bin:'codex',fingerprint:'a'.repeat(64)};const map=new Map();
 vm.runInNewContext(code,{res:{ok:true},account,opts:{id:'pty'},ptySignInAccount:map});
 assert.equal(map.get('pty').fingerprint,account.fingerprint);
 const {signInAccountKey}=load('src/main/engine-signin.ts');assert.equal(signInAccountKey('codex',map.get('pty')),signInAccountKey('codex',account));
});
test('production provisioning catch returns before process creation for a switch',()=>{
 const spawn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='spawnAgentCore');let guarded;
 function visit(n){if(ts.isCatchClause(n)&&n.getText(ast).includes('opts.requireProvisioning'))guarded=n;ts.forEachChild(n,visit);}visit(spawn);
 assert.ok(guarded);const code=ts.transpileModule(`(()=>{${guarded.block.statements.map(n=>n.getText(ast)).join('\n')}return 'continued';})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const result=vm.runInNewContext(code,{opts:{requireProvisioning:true},accountFailure:error=>({ok:false,error})});assert.equal(result.ok,false);assert.match(result.error,/provisioning failed/);
});
test('real model preference store removes an absent old pick on rollback',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'model-rollback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const {saveAgentModelPick,readAgentModels}=load('src/main/paramount-team.ts');saveAgentModelPick(root,'god','claude','new');saveAgentModelPick(root,'god','codex',undefined);assert.equal(readAgentModels(root).god,undefined);
});

test('production preflight and rollback events share identity and omit raw failures', async t=>{
 const f=fixture(t,{same:true,persistFail:true}); await f.switch('god',f.target);
 const events=f.context.diagnostics;
 assert.equal(new Set(events.map(e=>e.cid)).size,1);
 assert.equal(events[0].phase,'preflight');
 assert.ok(events.some(e=>e.phase==='rollback'&&e.outcome==='ok'));
 assert.ok(events.every(e=>e.scope==='orchestrator'||e.phase==='preflight'));
 assert.ok(events.every(e=>!('error' in e)&&!('home' in e)&&!('label' in e)));
});
test('production missing-session refusal is observable and never stops the process', async t=>{
 const f=fixture(t,{noSession:true}); const result=await f.switch('god',f.target);
 assert.equal(result.ok,false);
 assert.ok(f.context.diagnostics.some(e=>e.reason==='session-missing'&&e.outcome==='fail'));
 assert.ok(!f.context.diagnostics.some(e=>e.phase==='stop-current'));
});
