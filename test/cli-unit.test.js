'use strict'

/**
 * Unit tests for `src/util/config.js` and the cli-level argv parser
 * exported from `src/cli.js`.
 *
 * These tests run the functions directly (no subprocess) so they're
 * fast and can assert on exact objects / error messages.
 *
 * Each config test isolates its working directory via `process.chdir`
 * and restores on `t.after` — concurrent tests within node:test run
 * sequentially by default (no `test.concurrent`), so the chdir dance is
 * safe here.
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { load, findProjectRoot } = require(path.join(__dirname, '..', 'src', 'util', 'config'))
const { parseArgs } = require(path.join(__dirname, '..', 'src', 'cli'))

function mkProject (pkgExtras = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-unit-'))
  const pkg = Object.assign({ name: 'demo', version: '0.0.1' }, pkgExtras)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  // fs.realpathSync: on macOS, /tmp is a symlink to /private/tmp. Config's
  // findProjectRoot uses path.resolve which does not follow symlinks, so
  // the test's `process.cwd()` (symlink-resolved) and the computed
  // projectRoot both need to match. Normalise here for consistent asserts.
  return fs.realpathSync(dir)
}

// ---------------------------------------------------------------------------
// config.load — happy paths
// ---------------------------------------------------------------------------

test('config.load resolves sensible defaults from a bare package.json', (t) => {
  const dir = mkProject()
  const prevCwd = process.cwd()
  process.chdir(dir)
  t.after(() => {
    process.chdir(prevCwd)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cfg = load()
  assert.strictEqual(cfg.projectRoot, dir)
  // Default appName comes from capitalize(pkg.name) with non-alphanumeric
  // stripped: "demo" → "Demo".
  assert.strictEqual(cfg.appName, 'Demo')
  assert.strictEqual(cfg.iosNativeDir, 'ios-native')
  assert.strictEqual(cfg.entry, 'backend/index.js')
  assert.strictEqual(cfg.barekitVersion, 'v2.0.2')
  // frameworksDir is absolute and inside the project root.
  assert.ok(path.isAbsolute(cfg.frameworksDir))
  assert.ok(cfg.frameworksDir.startsWith(dir))
  assert.ok(cfg.frameworksDir.includes('Demo'), 'frameworksDir should nest under the app name')
})

test('config.load lets CLI overrides win over package.json', (t) => {
  const dir = mkProject({
    'bare-kit-pear': {
      appName: 'FromPkgJson',
      barekitVersion: 'v9.9.9'
    }
  })
  const prevCwd = process.cwd()
  process.chdir(dir)
  t.after(() => {
    process.chdir(prevCwd)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cfg = load({ appName: 'FromFlag' })
  assert.strictEqual(cfg.appName, 'FromFlag', 'CLI override beats package.json')
  // But keys we didn't override still come from pkg.
  assert.strictEqual(cfg.barekitVersion, 'v9.9.9')
})

test('config.load reads appName from package.json when no override', (t) => {
  const dir = mkProject({
    'bare-kit-pear': { appName: 'PkgJsonName' }
  })
  const prevCwd = process.cwd()
  process.chdir(dir)
  t.after(() => {
    process.chdir(prevCwd)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cfg = load()
  assert.strictEqual(cfg.appName, 'PkgJsonName')
})

test('config.load strips non-alphanumerics from fallback app name', (t) => {
  const dir = mkProject({ name: '@scope/my-cool-app!' })
  const prevCwd = process.cwd()
  process.chdir(dir)
  t.after(() => {
    process.chdir(prevCwd)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const cfg = load()
  // Non-alphanumeric scrubbed, first letter uppercased.
  assert.strictEqual(cfg.appName, 'Scopemycoolapp')
})

// ---------------------------------------------------------------------------
// config.load — error paths
// ---------------------------------------------------------------------------

test('config.load throws when no package.json is in the ancestor chain', (t) => {
  // Create an isolated tmpdir under a known parent that definitely has
  // no package.json above it, then chdir there. macOS `/tmp` resolves to
  // `/private/tmp`, which has no package.json in its ancestry (the real
  // user repo lives elsewhere).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-noroot-'))
  const realDir = fs.realpathSync(dir)
  const prevCwd = process.cwd()
  process.chdir(realDir)
  t.after(() => {
    process.chdir(prevCwd)
    fs.rmSync(realDir, { recursive: true, force: true })
  })

  // Sanity check: walking up from realDir finds no package.json. If there
  // IS one somewhere in the ancestor chain (unlikely on a CI runner but
  // possible on a dev machine where /Users/foo/package.json exists),
  // skip the assertion rather than falsely fail.
  const root = findProjectRoot(realDir)
  if (root !== null) {
    t.skip(`test tmpdir has a package.json in its ancestry (${root}); can't exercise no-root error on this machine`)
    return
  }

  assert.throws(() => load(), /No package\.json found/i)
})

// ---------------------------------------------------------------------------
// cli.parseArgs — argv parser
// ---------------------------------------------------------------------------

test('parseArgs handles bare positionals', () => {
  const args = parseArgs(['foo', 'bar'])
  assert.deepStrictEqual(args._, ['foo', 'bar'])
})

test('parseArgs handles --key value, --key=value, and --flag', () => {
  const a = parseArgs(['--app', 'MyApp', '--version=1.2.3', '--force'])
  assert.strictEqual(a.app, 'MyApp')
  assert.strictEqual(a.version, '1.2.3')
  assert.strictEqual(a.force, true)
})

test('parseArgs camelizes kebab-case keys', () => {
  const a = parseArgs(['--dry-run', '--verify-only'])
  assert.strictEqual(a.dryRun, true)
  assert.strictEqual(a.verifyOnly, true)
})

test('parseArgs supports --no-foo negation', () => {
  const a = parseArgs(['--no-cache'])
  assert.strictEqual(a.cache, false)
})

test('parseArgs resolves top-level short aliases (-h, -v)', () => {
  const h = parseArgs(['-h'])
  assert.strictEqual(h.help, true)
  const v = parseArgs(['-v'])
  assert.strictEqual(v.version, true)
})

test('parseArgs stops flag parsing after --', () => {
  const a = parseArgs(['--flag', '--', '--not-a-flag', 'positional'])
  assert.strictEqual(a.flag, true)
  assert.deepStrictEqual(a._, ['--not-a-flag', 'positional'])
})
