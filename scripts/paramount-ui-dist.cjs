#!/usr/bin/env node
// Locate the Paramount UI build bundled as extraResources/paramount-ui.
// Default: the sibling app ../paramount/dist next to this checkout, i.e.
// 00-new/apps/paramount/dist from the main checkout 00-new/apps/munder-difflin.
// PARAMOUNT_UI_DIST overrides it (worktrees, CI).
//
//   node scripts/paramount-ui-dist.cjs            print the dir, exit 1 if index.html is missing
//   node scripts/paramount-ui-dist.cjs <cmd...>   run <cmd> with PARAMOUNT_UI_DIST set
//                                                 (electron-builder.yml reads ${env.PARAMOUNT_UI_DIST})
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function resolveParamountUiDist(root, env = process.env) {
  if (env.PARAMOUNT_UI_DIST) return path.resolve(env.PARAMOUNT_UI_DIST)
  return path.resolve(root, '..', 'paramount', 'dist')
}

module.exports = { resolveParamountUiDist }

if (require.main === module) {
  const dist = resolveParamountUiDist(path.join(__dirname, '..'))
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error(`paramount-ui-dist: no Paramount UI build at ${dist}/index.html`)
    console.error("                   run 'npm run build' in 00-new/apps/paramount, or set PARAMOUNT_UI_DIST")
    process.exit(1)
  }
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd) {
    console.log(dist)
    process.exit(0)
  }
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, PARAMOUNT_UI_DIST: dist }
  })
  process.exit(r.status ?? 1)
}
