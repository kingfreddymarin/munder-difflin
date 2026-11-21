import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const ts = require('typescript');

const sourceUrl = new URL('../src/features/files/file-viewer.tsx', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');

// Transpile TSX → CJS. React, lucide-react, marked and the app aliases are stubbed.
const { outputText: js } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.React,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2020,
  },
});

const stubReact = {
  createElement: () => null,
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: null,
};
const stubLucide = new Proxy({}, { get: (_, k) => k });
const stubMarked = {
  marked: { setOptions: () => {}, parse: (s) => `<p>${s}</p>` },
};

function loadModule() {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, (id) => {
    if (id === 'react') return stubReact;
    if (id === 'lucide-react') return stubLucide;
    if (id === 'marked') return stubMarked;
    // App aliases return empty stubs so imports don't throw
    return new Proxy({}, { get: (_, k) => k });
  });
  return mod.exports;
}

const { bytes, isMarkdown, isTextFile, MAX_EDIT_BYTES } = loadModule();

// ─── bytes() ─────────────────────────────────────────────────────────────────

test('bytes: formats bytes under 1 KB', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(1023), '1023 B');
});

test('bytes: formats kilobytes', () => {
  assert.equal(bytes(1024), '1.0 KB');
  assert.equal(bytes(2048), '2.0 KB');
  assert.equal(bytes(1536), '1.5 KB');
});

test('bytes: formats megabytes', () => {
  assert.equal(bytes(1048576), '1.0 MB');
  assert.equal(bytes(2621440), '2.5 MB');
});

// ─── isMarkdown() ────────────────────────────────────────────────────────────

test('isMarkdown: recognises .md and .mdx', () => {
  assert.ok(isMarkdown('README.md'));
  assert.ok(isMarkdown('guide.MDX'));
  assert.ok(isMarkdown('notes.MD'));
});

test('isMarkdown: rejects non-Markdown extensions', () => {
  assert.ok(!isMarkdown('index.ts'));
  assert.ok(!isMarkdown('styles.css'));
  assert.ok(!isMarkdown('package.json'));
  assert.ok(!isMarkdown(''));
});

// ─── isTextFile() ────────────────────────────────────────────────────────────

test('isTextFile: accepts common text extensions', () => {
  for (const name of ['index.ts', 'app.tsx', 'notes.md', 'config.json', 'script.sh', 'styles.css', 'README.txt']) {
    assert.ok(isTextFile(name), `expected ${name} to be text`);
  }
});

test('isTextFile: accepts extensionless files', () => {
  assert.ok(isTextFile('Makefile'));
  assert.ok(isTextFile('Dockerfile'));
});

test('isTextFile: rejects binary extensions', () => {
  assert.ok(!isTextFile('photo.png'));
  assert.ok(!isTextFile('archive.zip'));
  assert.ok(!isTextFile('binary.exe'));
  assert.ok(!isTextFile('font.woff2'));
});

// ─── MAX_EDIT_BYTES ──────────────────────────────────────────────────────────

test('MAX_EDIT_BYTES is 2 MB', () => {
  assert.equal(MAX_EDIT_BYTES, 2 * 1024 * 1024);
});

// ─── Entry sorting (re-implemented here to mirror component logic) ────────────

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

test('sortEntries: directories come before files', () => {
  const entries = [
    { name: 'zebra.ts', isDir: false, size: 0, mtime: 0 },
    { name: 'alpha', isDir: true, size: 0, mtime: 0 },
  ];
  const sorted = sortEntries(entries);
  assert.equal(sorted[0].name, 'alpha');
  assert.equal(sorted[1].name, 'zebra.ts');
});

test('sortEntries: files are sorted numerically by name', () => {
  const entries = [
    { name: 'file10.txt', isDir: false, size: 0, mtime: 0 },
    { name: 'file2.txt', isDir: false, size: 0, mtime: 0 },
    { name: 'file1.txt', isDir: false, size: 0, mtime: 0 },
  ];
  const sorted = sortEntries(entries);
  assert.equal(sorted[0].name, 'file1.txt');
  assert.equal(sorted[1].name, 'file2.txt');
  assert.equal(sorted[2].name, 'file10.txt');
});

test('sortEntries: case-insensitive within same type', () => {
  const entries = [
    { name: 'Z.ts', isDir: false, size: 0, mtime: 0 },
    { name: 'a.ts', isDir: false, size: 0, mtime: 0 },
  ];
  const sorted = sortEntries(entries);
  assert.equal(sorted[0].name, 'a.ts');
});
