'use strict'

/**
 * `bare-kit-pear scripts`
 *
 * Prints the npm scripts that `init` would add to package.json. Useful
 * for users who scaffolded by hand or want to wire things up without
 * running `init` (e.g. monorepos where ios-native/ already exists but
 * the root package.json needs these helpers).
 *
 * The canonical script list lives in commands/init.js (`wantScriptsFor`).
 * This command imports it so both stay in lockstep.
 *
 * Options:
 *   --app <name>    App name used in ios:build (default: from config, else "App")
 *   --json          Print only the JSON fragment (no human-readable prose)
 */

// A2: new command — surfaces `wantScriptsFor` from init.js so users who
// skipped `init` can still wire their package.json.

const { wantScriptsFor } = require('./init')
const { findProjectRoot } = require('../util/config')
const fs = require('fs')
const path = require('path')
const logger = require('../util/log')

const log = logger.make('scripts')

// A2: per-command usage.
const usage = `Usage: bare-kit-pear scripts [options]

Print the npm scripts that \`init\` would add to package.json. For users
who bypassed \`init\` and want to wire the commands up by hand.

Options:
  --app <name>         App name used in ios:build (default: detected from
                       package.json bare-kit-pear.appName, falling back to
                       "App").
  --json               Print only the JSON fragment (machine-readable).
  -h, --help           Show this message.

Examples:
  bare-kit-pear scripts
  bare-kit-pear scripts --app MyApp
  bare-kit-pear scripts --json > /tmp/scripts.json`

// A2: walk up to find a package.json for the default app name. If no
// package.json is found we don't bail — the user might be using --json to
// bootstrap one.
function detectAppName () {
  const root = findProjectRoot()
  if (!root) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
    const fromKey = pkg['bare-kit-pear'] && pkg['bare-kit-pear'].appName
    if (fromKey) return fromKey
    // Fall back to the same derivation config.js would use, without
    // actually importing load() (which throws when no pkg).
    if (pkg.name) {
      const camelish = pkg.name.replace(/[^A-Za-z0-9]/g, '')
      if (camelish) return camelish.charAt(0).toUpperCase() + camelish.slice(1)
    }
  } catch {}
  return null
}

function run (args = {}) {
  const appName = args.app || detectAppName() || 'App'
  const scripts = wantScriptsFor(appName)

  if (args.json) {
    // Print only the scripts object — no log prefixes, nothing else.
    process.stdout.write(JSON.stringify(scripts, null, 2) + '\n')
    return
  }

  log.info(`App name: ${appName}`)
  log.info('')
  log.info('Add these to your package.json "scripts":')
  log.info('')
  // A2: print the JSON block without the log prefix so the user can copy
  // verbatim. Indent 2 spaces under the prose.
  const json = JSON.stringify(scripts, null, 2)
  for (const line of json.split('\n')) {
    process.stdout.write('  ' + line + '\n')
  }
  log.info('')
  log.info('After adding, you can run:')
  log.info('  npm run ios:setup     # fetch + addons + bundle')
  log.info('  npm run ios:build     # xcodegen + xcodebuild')
  log.info('')
  log.info('Override the app name: bare-kit-pear scripts --app MyApp')
  log.info('Just the JSON:         bare-kit-pear scripts --json')
}

module.exports = { run, usage }
