import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const team = readFileSync(new URL('../src/pages/team.tsx', import.meta.url), 'utf8');
const home = readFileSync(new URL('../src/pages/home.tsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/data/store.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

test('Team uses the shared live refresh lifecycle and pauses it while hidden', () => {
  assert.match(team, /useLiveRefresh\(LIVE_REFRESH_MS\)/);
  assert.match(home, /useLiveRefresh\(LIVE_REFRESH_MS\)/);
  assert.match(store, /document\.visibilityState === 'visible'\) store\.retry\(\)/);
  assert.match(store, /document\.addEventListener\('visibilitychange', tick\)/);
  assert.match(store, /window\.clearInterval\(timer\).*document\.removeEventListener\('visibilitychange', tick\)/s);
  assert.match(app, /const Page = pages\[route\.id\].*<Page \/>/s);
});
