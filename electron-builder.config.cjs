// electron-builder entry point. Loads electron-builder.yml and fills in the
// Paramount UI extraResources source as an absolute path.
//
// Why not `from: ${env.PARAMOUNT_UI_DIST}` in the yml: electron-builder runs
// path.resolve(projectDir, from) BEFORE expanding macros, so an absolute env
// value becomes <projectDir>//abs/path, which does not exist, and the entry is
// skipped with only a "file source doesn't exist" warning (no UI in the app).
const { buildBuilderConfig } = require('./scripts/paramount-ui-dist.cjs')

module.exports = buildBuilderConfig(__dirname)
