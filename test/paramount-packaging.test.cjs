// Paramount packaging: the bundled UI must come from the sibling app
// 00-new/apps/paramount/dist when packaging from the main checkout
// 00-new/apps/munder-difflin (review finding 2), overridable by PARAMOUNT_UI_DIST.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const yaml = require('js-yaml')

const ROOT = path.join(__dirname, '..')
// node_modules is shared with the main checkout, so its real parent is that checkout.
const MAIN = path.dirname(fs.realpathSync(path.join(ROOT, 'node_modules')))
const { resolveParamountUiDist } = require('../scripts/paramount-ui-dist.cjs')

test('default UI dist from the main checkout is 00-new/apps/paramount/dist', () => {
  const dist = resolveParamountUiDist(MAIN, {})
  assert.ok(dist.endsWith(path.join('00-new', 'apps', 'paramount', 'dist')), dist)
  assert.strictEqual(dist, path.resolve(MAIN, '..', 'paramount', 'dist'))
})

test('PARAMOUNT_UI_DIST overrides the default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ui-'))
  assert.strictEqual(resolveParamountUiDist(MAIN, { PARAMOUNT_UI_DIST: dir }), dir)
  assert.strictEqual(resolveParamountUiDist(MAIN, { PARAMOUNT_UI_DIST: '' }), path.resolve(MAIN, '..', 'paramount', 'dist'))
})

test('resolver CLI fails clearly when index.html is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ui-'))
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'paramount-ui-dist.cjs')], {
    env: { ...process.env, PARAMOUNT_UI_DIST: dir },
    encoding: 'utf8'
  })
  assert.notStrictEqual(r.status, 0)
  assert.match(r.stderr, /index\.html/)
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'paramount-ui-dist.cjs')], {
    env: { ...process.env, PARAMOUNT_UI_DIST: dir },
    encoding: 'utf8'
  })
  assert.strictEqual(ok.status, 0, ok.stderr)
  assert.strictEqual(ok.stdout.trim(), dir)
})

test('build-dmg.sh fails clearly when index.html is missing', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ui-'))
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'build-dmg.sh')], {
    env: { ...process.env, PARAMOUNT_UI_DIST: dir },
    encoding: 'utf8'
  })
  assert.notStrictEqual(r.status, 0)
  assert.match(r.stderr, new RegExp(`${dir}/index\\.html`))
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'scripts', 'build-dmg.sh'), 'utf8'), /\.\.\/\.\.\/paramount/)
})

test('electron-builder bundles the resolved UI dist and names the DMG Paramount-<version>-<arch>.dmg', () => {
  const cfg = yaml.load(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'))
  const ui = cfg.extraResources.find((r) => r.to === 'paramount-ui')
  assert.strictEqual(ui.from, 'PARAMOUNT_UI_DIST')
  assert.strictEqual(cfg.dmg.artifactName, 'Paramount-${version}-${arch}.dmg')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.strictEqual(pkg.name, 'paramount')
  assert.strictEqual(pkg.productName, 'Paramount')
  // Every electron-builder entry point sets PARAMOUNT_UI_DIST through the resolver.
  for (const name of ['dist', 'dist:mac', 'dist:win', 'dist:linux']) {
    assert.match(pkg.scripts[name], /node scripts\/paramount-ui-dist\.cjs electron-builder --config electron-builder\.config\.cjs/, name)
  }
})

// electron-builder resolves extraResources `from` against the project dir before
// expanding ${env.X}, so an absolute env path became <root>//abs and was skipped:
// the packaged app had no Resources/paramount-ui. The JS config must hand it an
// absolute dir that exists.
test('builder config bundles the resolved UI dist as an absolute, existing dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-ui-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>')
  const { buildBuilderConfig } = require('../scripts/paramount-ui-dist.cjs')
  const cfg = buildBuilderConfig(ROOT, { PARAMOUNT_UI_DIST: dir })
  const ui = cfg.extraResources.find((r) => r.to === 'paramount-ui')
  assert.strictEqual(ui.from, dir)
  assert.ok(path.isAbsolute(ui.from) && !ui.from.includes('${'), ui.from)
  // electron-builder's own join (fileMatcher.getFileMatchers) must land on the dir.
  assert.strictEqual(path.resolve(ROOT, ui.from), dir)
  assert.throws(() => buildBuilderConfig(ROOT, { PARAMOUNT_UI_DIST: os.tmpdir() + '/pm-ui-missing' }), /index\.html/)
})

// Slow (~1 min, needs out/ from `npm run build`): PARAMOUNT_PACK_TEST=1 to run.
test('--dir build puts paramount-ui/index.html in the .app', { skip: process.platform !== 'darwin' || !process.env.PARAMOUNT_PACK_TEST }, () => {
  const ui = resolveParamountUiDist(ROOT)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-pack-'))
  const r = spawnSync('npx', ['electron-builder', '--mac', '--dir', `--${process.arch}`,
    '--config', 'electron-builder.config.cjs', `-c.directories.output=${out}`], {
    cwd: ROOT,
    env: { ...process.env, PARAMOUNT_UI_DIST: ui, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    encoding: 'utf8'
  })
  assert.strictEqual(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /file source doesn't exist/)
  const app = fs.readdirSync(out).map((d) => path.join(out, d, 'Paramount.app')).find((p) => fs.existsSync(p))
  assert.ok(app, `no Paramount.app under ${out}`)
  assert.ok(fs.existsSync(path.join(app, 'Contents', 'Resources', 'paramount-ui', 'index.html')))
  fs.rmSync(out, { recursive: true, force: true })
})
