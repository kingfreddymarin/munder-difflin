const test = require('node:test');
const assert = require('node:assert/strict');
const { observeAccountOperation } = require('./load-ts.cjs')('src/main/account-observability.ts');
test('account events exclude supplied secrets and correlate expired status', async () => {
  const events = [];
  const result = await observeAccountOperation(e => events.push(e), 'sign-in-check', {provider:'claude',accountId:'secret@example.com'}, async () => ({ok:true,status:{state:'expired',fix:'token=secret',accountLabel:'private'}}));
  assert.equal(result.status.state,'expired');
  assert.equal(events.length,2); assert.equal(events[0].cid,events[1].cid);
  assert.equal(events[1].state,'expired');
  assert.doesNotMatch(JSON.stringify(events),/secret|private|@/);
});
test('account errors propagate unchanged while diagnostic failures are isolated', async () => {
 const error = new Error('sensitive provider output');
 assert.throws(() => observeAccountOperation(() => {throw Error('disk');}, 'profile-create', {}, () => {throw error;}), e => e === error);
 const events=[];
 await assert.rejects(observeAccountOperation(e=>events.push(e),'sign-in-check',{},async()=>{throw error;}),e=>e===error);
 assert.deepEqual(events.map(e=>e.outcome),['start','fail']);
 assert.doesNotMatch(JSON.stringify(events),/sensitive/);
 assert.equal(observeAccountOperation(()=>{throw Error('disk');},'profile-rename',{},()=>42),42);
});

test('created profile is attributed to its new opaque ID without copying labels',()=>{
 const identity={provider:'codex'}; const events=[];
 observeAccountOperation(e=>events.push(e),'profile-create',identity,()=>{identity.accountId='acct_'+'a'.repeat(24);return {label:'private'};});
 assert.equal(events[1].accountId,identity.accountId);
 assert.doesNotMatch(JSON.stringify(events),/private/);
});
