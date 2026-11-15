const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {createLauncherDiscoveryCache} = loadTs('src/main/council-account-launchers.ts');
test('cold reads do not fall back to synchronous discovery while warmup is pending', async () => {
 let sync = 0, asyncCalls = 0, resolve;
 const result = {status:'ok',choices:[],profiles:[]};
 const cache = createLauncherDiscoveryCache(() => {sync++; return result;}, () => {asyncCalls++; return new Promise(r => {resolve=r;});});
 const warm = cache.warm();
 assert.equal(cache.current().status,'failed');
 assert.equal(sync,0);
 assert.equal(cache.warm(),warm);
 resolve(result); await warm;
 assert.equal(cache.current(),result);
 assert.equal(asyncCalls,1);
});
