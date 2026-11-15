import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Owner report 2026-11-15: clicking Settings › Setup blanked the whole app. PrereqList selected
// `s.mutedSignInReminders ?? []`; with no muted reminders that is a new array on every read, so
// useSyncExternalStore saw a changed store each time ("getSnapshot should be cached", "Maximum update
// depth exceeded") and React unmounted the app. A useFloor selector must return stored values or constants.
const src = fileURLToPath(new URL('../src', import.meta.url));
const files = (dir) => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : []; });

test('no useFloor selector builds a fresh array or object on each read', () => {
  const fresh = /useFloor\(\(?s\)?\s*=>[^;]*?(\?\?\s*\[\]|\?\?\s*\{\}|\.filter\(|\.map\(|\[\s*\.\.\.|\{\s*\.\.\.|new (Set|Map)\(|Object\.(keys|values|entries)\()/;
  const offenders = files(src).flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, i) => [file, i + 1, line]))
    .filter(([file, , line]) => !file.endsWith('store.tsx') && fresh.test(line))
    .map(([file, n, line]) => `${file.slice(src.length + 1)}:${n}: ${line.trim()}`);
  assert.deepEqual(offenders, []);
});

test('PrereqList reads muted reminders through one shared empty list', () => {
  const prereq = readFileSync(join(src, 'components/app/prereq-list.tsx'), 'utf8');
  assert.match(prereq, /const NO_MUTED_REMINDERS: string\[\] = \[\];/);
  assert.match(prereq, /useFloor\(\(s\) => s\.mutedSignInReminders \?\? NO_MUTED_REMINDERS\)/);
});
