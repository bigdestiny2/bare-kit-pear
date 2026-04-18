'use strict'

/**
 * bare-kit-pear CLI entry point.
 *
 * Usage:
 *   bare-kit-pear <command> [options]
 *
 * Commands:
 *   init <AppName>         Scaffold ios-native/ from the template
 *   fetch                  Download BareKit.xcframework
 *   addons                 Mirror addon xcframeworks from react-native-bare-kit
 *   bundle                 bare-pack the backend for iOS
 *   doctor                 Diagnose project.yml ↔ Frameworks drift
 *   scripts                Print the npm scripts `init` would add
 *   help                   Show this message
 *
 * Common options:
 *   --app <name>           Override app name
 *   -v, --version          Print version
 *   -h, --help             Show help (top-level or per-command)
 */

// A2: argv parser extended to support --key=value, short aliases (-h/-v),
// and per-command --help routing. Parser is exported for tests.

const fs = require('fs')
const path = require('path')

const COMMANDS = {
  init:    () => require('./commands/init'),
  fetch:   () => require('./commands/fetch'),
  addons:  () => require('./commands/addons'),
  bundle:  () => require('./commands/bundle'),
  doctor:  () => require('./commands/doctor'),
  scripts: () => require('./commands/scripts')
}

// A2: short/long flag alias table. Extended by commands via their own
// surface; top-level aliases live here.
const TOP_LEVEL_ALIASES = {
  h: 'help',
  v: 'version'
}

/**
 * Parse argv into a positional+flag bag.
 *
 * Supported forms:
 *   --key value   → { key: "value" }
 *   --key=value   → { key: "value" }
 *   --flag        → { flag: true }
 *   --no-flag     → { flag: false }
 *   -h            → { help: true } (via alias map)
 *   foo bar       → { _: ["foo", "bar"] }
 *   --            → stop flag parsing, remaining tokens go to `_`
 *
 * Values are NOT coerced — callers receive strings or booleans.
 * Flag names are camelized: --dry-run → dryRun.
 */
function parseArgs (argv, aliases = {}) {
  const args = { _: [] }
  let stopFlags = false

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]

    if (stopFlags) {
      args._.push(tok)
      continue
    }
    if (tok === '--') {
      stopFlags = true
      continue
    }

    if (tok.startsWith('--')) {
      // Long form: --key, --key=value, --no-key
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      let key
      let val
      if (eq !== -1) {
        key = body.slice(0, eq)
        val = body.slice(eq + 1)
      } else {
        key = body
        val = undefined
      }

      // --no-foo → foo=false (only when no explicit value was given)
      let negate = false
      if (val === undefined && key.startsWith('no-')) {
        key = key.slice(3)
        negate = true
      }

      const camelKey = camelize(key)
      if (val !== undefined) {
        args[camelKey] = val
      } else if (negate) {
        args[camelKey] = false
      } else {
        // Peek ahead — if the next token is a value (not a flag and not `--`),
        // consume it. Otherwise it's a bare boolean flag.
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('-') && next !== '--') {
          args[camelKey] = next
          i++
        } else {
          args[camelKey] = true
        }
      }
      continue
    }

    if (tok.startsWith('-') && tok.length > 1) {
      // Short form: -h, -v, -h=foo, -habc (bundled → each char is a flag)
      const body = tok.slice(1)
      const eq = body.indexOf('=')
      let shortPart
      let val
      if (eq !== -1) {
        shortPart = body.slice(0, eq)
        val = body.slice(eq + 1)
      } else {
        shortPart = body
        val = undefined
      }

      if (shortPart.length === 1) {
        const full = aliases[shortPart] || TOP_LEVEL_ALIASES[shortPart] || shortPart
        const camelKey = camelize(full)
        if (val !== undefined) {
          args[camelKey] = val
        } else {
          const next = argv[i + 1]
          if (next !== undefined && !next.startsWith('-') && next !== '--') {
            args[camelKey] = next
            i++
          } else {
            args[camelKey] = true
          }
        }
      } else {
        // Bundled short flags (e.g. -hv): treat each char as a bool flag.
        // The final char may take a value when -xVALUE is a longstanding
        // short-flag idiom, but we keep it simple: bundled shorts are bool.
        for (const c of shortPart) {
          const full = aliases[c] || TOP_LEVEL_ALIASES[c] || c
          args[camelize(full)] = true
        }
        if (val !== undefined) {
          const lastChar = shortPart[shortPart.length - 1]
          const full = aliases[lastChar] || TOP_LEVEL_ALIASES[lastChar] || lastChar
          args[camelize(full)] = val
        }
      }
      continue
    }

    args._.push(tok)
  }
  return args
}

function camelize (s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function readPackageJson () {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
}

function printTopLevelHelp () {
  const pkg = readPackageJson()
  console.log(`bare-kit-pear v${pkg.version}`)
  console.log('')
  console.log('The easiest path from a Bare backend to a native iOS app.')
  console.log('')
  console.log('Usage:')
  console.log('  bare-kit-pear <command> [options]')
  console.log('')
  console.log('Commands:')
  console.log('  init <AppName>    Scaffold ios-native/ from the template')
  console.log('  fetch             Download BareKit.xcframework from the GitHub release')
  console.log('  addons            Mirror addon xcframeworks from react-native-bare-kit')
  console.log('  bundle            bare-pack the backend for iOS')
  console.log('  doctor            Diagnose project state and addon drift')
  console.log('  scripts           Print the npm scripts `init` would add')
  console.log('  help              Show this message')
  console.log('')
  console.log('Common options:')
  console.log('  --app <name>      Override app name (default: from package.json)')
  console.log('  -v, --version     Print version')
  console.log('  -h, --help        Show this message (or per-command help)')
  console.log('')
  console.log('Per-command help:')
  console.log('  bare-kit-pear <command> --help')
  console.log('')
  console.log('See BUILD.md for the full recipe.')
}

// A2: print a command's own `usage` export if it has one, otherwise fall
// back to the top-level help.
function printCommandHelp (command) {
  const loader = COMMANDS[command]
  if (!loader) {
    console.error(`Unknown command: ${command}`)
    console.error('Run `bare-kit-pear help` for usage.')
    process.exit(1)
  }
  const mod = loader()
  if (typeof mod.usage === 'string') {
    console.log(mod.usage)
    return
  }
  if (typeof mod.help === 'function') {
    mod.help()
    return
  }
  // Command forgot to export usage — give the user something.
  console.log(`bare-kit-pear ${command} [options]`)
  console.log('')
  console.log('(no detailed usage exported for this command — see BUILD.md)')
}

async function main () {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const rest = argv.slice(1)

  // Top-level help / version — handle before dispatch so `--help`/`-h`
  // with no command still works.
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printTopLevelHelp()
    return
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(readPackageJson().version)
    return
  }

  const loader = COMMANDS[command]
  if (!loader) {
    console.error(`Unknown command: ${command}`)
    console.error('Run `bare-kit-pear help` for usage.')
    process.exit(1)
  }

  // A2: detect a bare --help/-h on a known command and route to command help.
  // We peek at `rest` before parsing because `parseArgs` without command-
  // specific aliases could miscategorize, but `--help` is universal.
  const wantsHelp = rest.some((t) => t === '--help' || t === '-h')
  if (wantsHelp) {
    printCommandHelp(command)
    return
  }

  const mod = loader()
  const args = parseArgs(rest, mod.aliases || {})
  try {
    await mod.run(args)
  } catch (err) {
    console.error(`[bare-kit-pear:${command}] ${err.message || err}`)
    if (process.env.BAREKIT_PEAR_DEBUG) console.error(err.stack)
    process.exit(1)
  }
}

// A2: only run main() when invoked via the bin shim. Tests load this file
// as a library (via `require('../src/cli')`) and must not trigger the CLI.
// The bin shim sets `require.main.filename` to `bin/bare-kit-pear`; any
// other entry point (tests, direct `require`) leaves it pointing elsewhere.
function isCliEntry () {
  if (!require.main) return false
  const entry = require.main.filename || ''
  return /(^|[\\/])bare-kit-pear$/.test(entry) || /(^|[\\/])cli\.js$/.test(entry)
}

if (isCliEntry()) {
  main()
}

module.exports = { parseArgs, main, printTopLevelHelp, printCommandHelp }
