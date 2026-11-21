const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { codexExecutionArgs: apply, validExecutionPolicy } = loadTs('src/shared/executionPolicy.ts');
test('explicit full access replaces restored workspace/never flags without losing resume/model', () => {
 assert.deepEqual(apply(['resume','session','-a','never','-s','workspace-write','--model','example'], 'full-ask'), ['-a','on-request','-s','danger-full-access','resume','session','--model','example']);
});
test('all explicit choices apply sandbox and approval independently', () => {
 for (const scope of ['workspace','full']) for (const mode of ['ask','auto']) {
  assert.deepEqual(apply(['--full-auto','--sandbox=read-only','--ask-for-approval=untrusted'], `${scope}-${mode}`), ['-a',mode==='ask'?'on-request':'never','-s',scope==='full'?'danger-full-access':'workspace-write']);
 }
});
test('inherit, invalid policy, remote connections preserve existing arguments', () => {
 const args=['-a','never','-s','workspace-write'];
 assert.strictEqual(apply(args,'inherit'),args);
 assert.strictEqual(apply(args,'invalid'),args);
 assert.deepEqual(apply(['--remote','ws://localhost:1234',...args],'full-auto'),['--remote','ws://localhost:1234',...args]);
 assert.equal(validExecutionPolicy('full-auto'),true);
 assert.equal(validExecutionPolicy('full-access'),false);
});
test('prompt after separator is not interpreted as flags', () => {
 assert.deepEqual(apply(['--','-s','a prompt'],'workspace-ask'), ['-a','on-request','-s','workspace-write','--','-s','a prompt']);
});

test('stale config overrides cannot contradict the selected posture', () => {
 assert.deepEqual(apply(['-c','approval_policy="never"','--config=sandbox_mode="read-only"','-c','model="example"'],'full-ask'), ['-a','on-request','-s','danger-full-access','-c','model="example"']);
});

test('local launch avoids daemon unless opted in with inherited permissions', () => {
 const { useCodexRemoteControl } = loadTs('src/shared/executionPolicy.ts');
 assert.equal(useCodexRemoteControl(undefined, undefined),false);
 assert.equal(useCodexRemoteControl(false,'inherit'),false);
 assert.equal(useCodexRemoteControl(true,'inherit'),true);
 assert.equal(useCodexRemoteControl(true,'full-auto'),false);
 assert.equal(useCodexRemoteControl(true,'workspace-ask'),false);
});
