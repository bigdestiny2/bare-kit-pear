'use strict'

/**
 * `bare-kit-pear bundle`
 *
 * Runs bare-pack to produce the iOS worklet bundle from your backend
 * entry point. Equivalent to:
 *
 *   bare-pack --linked --host ios-arm64 backend/index.js \
 *     -o backend/dist/backend.ios.bundle
 *
 * Options:
 *   --entry <path>    Backend entry point (default: backend/index.js)
 *   --out <path>      Bundle output path (default: backend/dist/backend.ios.bundle)
 *   --host <triple>   Host triple (default: ios-arm64)
 *
 * When bare-pack fails, we pattern-match common errors and print an
 * actionable hint. The raw stderr is shown when BAREKIT_PEAR_DEBUG=1.
 */

// A2: capture bare-pack stderr so we can post-process failures into
// actionable messages, instead of just streaming everything to the
// terminal and exiting non-zero.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { load } = require('../util/config')
const logger = require('../util/log')

const log = logger.make('bundle')

// A2: per-command usage exported for `bare-kit-pear bundle --help`.
const usage = `Usage: bare-kit-pear bundle [options]

Runs bare-pack to produce the iOS worklet bundle from your backend entry.

Options:
  --entry <path>       Backend entry point.
                       Default: from package.json bare-kit-pear.entry,
                       or backend/index.js.
  --out <path>         Bundle output path.
                       Default: backend/dist/backend.ios.bundle.
  --host <triple>      bare-pack host triple.
                       Valid: ios-arm64, ios-arm64-simulator, android-arm64.
                       Default: ios-arm64.
  -h, --help           Show this message.

Environment:
  BAREKIT_PEAR_DEBUG=1   Print raw bare-pack stderr on failure.
  NODE_OPTIONS=--max-old-space-size=4096
                         Raise node heap for large backends.

Examples:
  bare-kit-pear bundle
  bare-kit-pear bundle --entry backend/main.js --host ios-arm64-simulator
  NODE_OPTIONS=--max-old-space-size=4096 bare-kit-pear bundle`

// A2: rules for mapping bare-pack failure signatures to actionable advice.
// Each rule's `match` runs against the combined stdout+stderr capture.
// The first matching rule's `hint` (or hint factory) is printed. Order
// matters — put more specific patterns first.
const DIAGNOSTIC_RULES = [
  {
    name: 'missing-module',
    match: (s) => /Cannot find module ['"]([^'"]+)['"]/i.exec(s),
    hint: (m) => {
      const pkg = m[1]
      return (
        `Missing dependency: \`${pkg}\`.\n` +
        `  Install it: npm install ${pkg}\n` +
        `  (or npm install --save-dev ${pkg} if it's only needed at build time)`
      )
    }
  },
  {
    name: 'heap-oom',
    match: (s) => /JavaScript heap out of memory|FATAL ERROR.*heap/i.exec(s),
    hint: () =>
      'Out of memory while bundling.\n' +
      '  Raise node heap: NODE_OPTIONS=--max-old-space-size=4096 npx bare-kit-pear bundle\n' +
      '  (bump further for very large backends — 8192 is common)'
  },
  {
    name: 'bad-host',
    match: (s) =>
      /(unknown|invalid|unsupported).*host|host triple|Unknown option.*--host|expected.*host/i.exec(s),
    hint: () =>
      'Invalid --host triple.\n' +
      '  Try one of: ios-arm64, ios-arm64-simulator, android-arm64\n' +
      '  bare-kit-pear defaults to ios-arm64.'
  },
  {
    name: 'entry-missing',
    match: (s) => /(ENOENT|no such file|cannot find|could not resolve).*?([^\s'"]+\.[cm]?js)/i.exec(s),
    hint: (m) => {
      const p = m[2]
      return (
        `Entry missing: ${p}.\n` +
        `  Check bare-kit-pear.entry in package.json (default: backend/index.js).\n` +
        `  Create the file or pass --entry <path>.`
      )
    }
  }
]

// A2: run a captured spawn so we can see stderr on failure while still
// streaming the tool's output to the terminal as it runs. We tee stderr
// via spawnSync with 'pipe' and re-emit chunks — but spawnSync is
// synchronous, so the simpler approach is: let bare-pack's normal stdio
// go through on success, and on failure rerun with captured stderr for
// diagnostics. That's one extra spawn only on the unhappy path.
//
// To avoid the double-run cost, we use a single captured run and echo
// output ourselves. Works for both streams.
function runBarePack (cmd, packArgs, cwd) {
  const res = spawnSync(cmd, packArgs, {
    cwd,
    // Capture both streams so we can post-process; echo them live so the
    // user still sees progress.
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8'
  })
  return res
}

async function run (args = {}) {
  const cfg = load({
    entry: args.entry,
    bundleOutput: args.out
  })

  const host = args.host || 'ios-arm64'
  const entry = path.isAbsolute(cfg.entry)
    ? cfg.entry
    : path.join(cfg.projectRoot, cfg.entry)

  if (!fs.existsSync(entry)) {
    log.bail(
      `Entry point not found: ${entry}\n` +
      `  Check bare-kit-pear.entry in package.json, or pass --entry <path>.`
    )
  }

  fs.mkdirSync(path.dirname(cfg.bundleOutput), { recursive: true })

  // Prefer locally-installed bare-pack. Fall back to global.
  const localPack = path.join(cfg.projectRoot, 'node_modules', '.bin', 'bare-pack')
  const cmd = fs.existsSync(localPack) ? localPack : 'bare-pack'
  const packArgs = ['--linked', '--host', host, entry, '-o', cfg.bundleOutput]

  log.info(`${cmd} ${packArgs.join(' ')}`)

  const res = runBarePack(cmd, packArgs, cfg.projectRoot)

  if (res.error) {
    if (res.error.code === 'ENOENT') {
      log.bail(
        'bare-pack not found.\n' +
        '  Install it locally: npm install --save-dev bare-pack\n' +
        '  Or globally: npm install -g bare-pack'
      )
    }
    log.bail(`bare-pack failed: ${res.error.message}`)
  }

  const stdout = res.stdout || ''
  const stderr = res.stderr || ''
  const combined = stdout + '\n' + stderr

  // Stream the captured output through to the user so they don't lose
  // anything. On success this just replays bare-pack's own lines; on
  // failure it's what we'd have shown anyway.
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)

  if (res.status !== 0) {
    // A2: pattern-match the output for known failure modes and upgrade the
    // exit message to something actionable.
    let matched = null
    for (const rule of DIAGNOSTIC_RULES) {
      const m = rule.match(combined)
      if (m) {
        matched = { rule, m }
        break
      }
    }

    log.error('')
    log.error(`bare-pack exited with ${res.status}.`)

    if (matched) {
      const hint = typeof matched.rule.hint === 'function'
        ? matched.rule.hint(matched.m)
        : matched.rule.hint
      log.error('')
      for (const line of hint.split('\n')) log.error(line)
      log.error('')
      if (!process.env.BAREKIT_PEAR_DEBUG) {
        log.error('(rerun with BAREKIT_PEAR_DEBUG=1 to see the full bare-pack stderr)')
      }
    } else {
      log.error('No pattern matched — inspect the bare-pack output above.')
      log.error('(rerun with BAREKIT_PEAR_DEBUG=1 for debug info.)')
    }

    if (process.env.BAREKIT_PEAR_DEBUG) {
      log.error('')
      log.error('--- bare-pack stderr (debug) ---')
      process.stderr.write(stderr)
      log.error('--- end bare-pack stderr ---')
    }

    process.exit(res.status || 1)
  }

  const stats = fs.statSync(cfg.bundleOutput)
  const sizeMb = (stats.size / 1024 / 1024).toFixed(2)
  log.info(`✓ Bundled ${cfg.entry} → ${path.relative(cfg.projectRoot, cfg.bundleOutput)} (${sizeMb} MB)`)
}

module.exports = { run, usage }
