const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const load = require('./load-ts.cjs');
const { createAccountProfileStore, publicAccountProfile } = load('src/main/account-profiles.ts');
const { mergeAccountProfiles, validateLauncher, publicDiscovery, saveLauncherPick, readLauncherState, displayLauncherState } = load('src/main/council-account-launchers.ts');
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-profile-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('two same-provider profiles persist separate owner-only homes and stable renamed identity', t => {
  const root = fixture(t); const store = createAccountProfileStore(root);
  const a = store.create({ provider: 'claude', label: 'Personal' });
  const b = store.create({ provider: 'claude', label: 'Work' });
  assert.notEqual(a.id, b.id); assert.notEqual(a.home, b.home);
  assert.match(a.id, /^acct_[a-f0-9]{24}$/);
  assert.equal(fs.statSync(a.home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'account-profiles.json')).mode & 0o777, 0o600);
  const renamed = store.rename(a.id, 'New label');
  assert.equal(renamed.fingerprint, a.fingerprint); assert.equal(renamed.home, a.home);
  assert.equal(createAccountProfileStore(root).list()[0].label, 'New label');
  assert.equal(publicAccountProfile(a).home, undefined);
  assert.equal(publicAccountProfile(a).bin, undefined);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'account-profiles.json')));
  assert.deepEqual(Object.keys(metadata.profiles[0]).sort(), ['id', 'label', 'provider']);
});
test('rejects credentials, caller paths, unsupported providers and corrupt catalog without overwriting', t => {
  const root = fixture(t); const store = createAccountProfileStore(root);
  for (const input of [{provider:'codex',label:'x',password:'fake'}, {provider:'codex',label:'x',home:'/tmp'}, {provider:'other',label:'x'}]) assert.throws(() => store.create(input));
  const file = path.join(root, 'account-profiles.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => store.create({provider:'codex',label:'x'}), /catalog/);
  assert.equal(fs.readFileSync(file,'utf8'), '{broken');
});
test('refuses symlink catalog and replaced account home', t => {
  const root = fixture(t); const store = createAccountProfileStore(root);
  const p = store.create({provider:'codex',label:'x'});
  fs.rmdirSync(p.home); fs.symlinkSync(root,p.home);
  assert.deepEqual(store.list(), []);
  assert.equal(store.inventory()[0].available, false);
  const file = path.join(root,'account-profiles.json'); fs.renameSync(file,file+'.saved'); fs.symlinkSync(file+'.saved',file);
  assert.throws(() => store.list(), /catalog/);
});
test('managed selection resolves during shell timeout while legacy selection remains guarded', t => {
  const store = createAccountProfileStore(fixture(t)); const p = store.create({provider:'claude',label:'Work'});
  const legacy = {id:'dc',provider:'claude',label:'dc',fingerprint:'a'.repeat(64),unrestricted:false,bin:'claude',args:[],home:'/fixture'};
  const merged = mergeAccountProfiles({status:'timeout',profiles:[legacy],choices:[legacy],message:'Shell unavailable'},[p]);
  assert.equal(merged.status,'timeout');
  assert.equal(validateLauncher({id:p.id,fingerprint:p.fingerprint},'claude',merged).home,p.home);
  assert.throws(() => validateLauncher({id:'dc',fingerprint:legacy.fingerprint},'claude',merged), /Shell unavailable/);
  assert.throws(() => validateLauncher({id:p.id,fingerprint:'b'.repeat(64)},'claude',merged), /changed/);
  assert.throws(() => validateLauncher({id:p.id,fingerprint:p.fingerprint},'codex',merged), /provider/);
  const dto = publicDiscovery(merged); assert.equal(dto.choices[0].home,undefined); assert.equal(dto.choices[1].home,undefined);
});
test('dangling metadata symlink fails closed instead of replacing existing reference', t => {
 const root = fixture(t); const store = createAccountProfileStore(root); const file = path.join(root,'account-profiles.json');
 fs.symlinkSync(path.join(root,'missing'),file);
 assert.throws(() => store.create({provider:'codex',label:'Work'}), /catalog/);
 assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
});
test('registered references survive reload alongside legacy references', t => {
 const root = fixture(t); const p = createAccountProfileStore(path.join(root,'device')).create({provider:'codex',label:'Work'});
 const ext = path.join(root,'council','extensions'); fs.mkdirSync(ext,{recursive:true});
 const managed = {id:p.id,fingerprint:p.fingerprint}; const legacy = {id:'dcx',fingerprint:'a'.repeat(64)};
 fs.writeFileSync(path.join(ext,'account-launchers.json'),JSON.stringify({version:1,orchestrator:managed,agents:{old:legacy}}));
 assert.deepEqual(displayLauncherState(readLauncherState(root)),{version:1,orchestrator:managed,agents:{old:legacy}});
});

test('one missing or replaced home does not hide another valid account or erase metadata', t => {
 const root = fixture(t); const store = createAccountProfileStore(root);
 const a = store.create({provider:'codex',label:'Missing'}); const b = store.create({provider:'codex',label:'Available'});
 fs.rmdirSync(a.home);
 for (const symlink of [false,true]) {
   if (symlink) fs.symlinkSync(root,a.home);
   assert.deepEqual(store.list().map(p=>p.id),[b.id]);
   assert.equal(store.inventory().find(p=>p.id===a.id).available,false);
   assert.equal(store.inventory().length,2);
   const discovery = mergeAccountProfiles({status:'ok',profiles:[],choices:[]},store.list());
   assert.equal(validateLauncher({id:b.id,fingerprint:b.fingerprint},'codex',discovery).id,b.id);
   assert.throws(()=>validateLauncher({id:a.id,fingerprint:a.fingerprint},'codex',discovery),/no longer available/);
 }
});
test('separate store instances refuse a held writer lock without changing metadata', t => {
 const root=fixture(t); const a=createAccountProfileStore(root); const b=createAccountProfileStore(root);
 const p=a.create({provider:'codex',label:'Existing'});
 const file=path.join(root,'account-profiles.json'); const before=fs.readFileSync(file,'utf8');
 fs.mkdirSync(path.join(root,'.catalog-write-lock'));
 assert.throws(()=>b.create({provider:'claude',label:'Blocked'}),/busy/);
 assert.throws(()=>b.rename(p.id,'Blocked'),/busy/);
 assert.equal(fs.readFileSync(file,'utf8'),before); assert.equal(b.list().length,1);
 fs.rmdirSync(path.join(root,'.catalog-write-lock'));
 b.create({provider:'claude',label:'Second'}); assert.equal(a.list().length,2);
});
