const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const {observeAccountOperation}=require('./load-ts.cjs')('src/main/account-observability.ts');
const source=fs.readFileSync(path.join(__dirname,'../src/main/index.ts'),'utf8');
const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
function handler(name,context){
 let callback;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='ipcMain.handle'&&n.arguments[0]?.text===name)callback=n.arguments[1];ts.forEachChild(n,visit);}visit(ast);
 assert.ok(callback,'production IPC handler exists');
 const js=ts.transpileModule('('+callback.getText(ast)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 return vm.runInNewContext(js,{observeAccountOperation,...context});
}
test('production sign-in refresh logs allowlisted auth state without provider output',async()=>{
 const events=[];const h=handler('engine-signin:refresh',{paramountLog:e=>events.push(e),signInAccount:()=>({id:'acct_'+'b'.repeat(24)}),engineSignIn:{refresh:async()=>({state:'expired',fix:'secret provider output'})},broadcastParamountInvalidation:()=>{}});
 const r=await h({}, {provider:'claude',accountId:'acct_'+'b'.repeat(24)});
 assert.equal(r.status.state,'expired');assert.deepEqual(events.map(e=>e.outcome),['start','ok']);assert.equal(events[1].state,'expired');assert.doesNotMatch(JSON.stringify(events),/secret/);
});
test('production sign-in start records refusal without spawning or exposing input',()=>{
 const events=[];const h=handler('engine-signin:start',{paramountLog:e=>events.push(e),signInAccount:()=>null});
 const r=h({}, {provider:'codex',accountId:'email@example.com',accountFingerprint:'secret'});
 assert.equal(r.ok,false);assert.deepEqual(events.map(e=>e.outcome),['start','fail']);assert.doesNotMatch(JSON.stringify(events),/email|secret|@/);
});
