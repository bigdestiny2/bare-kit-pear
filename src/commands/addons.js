'use strict'

/**
 * `bare-kit-pear addons`
 *
 * Mirrors the pre-built native addon xcframeworks (plus the ABI-matched
 * BareKit.xcframework) from node_modules/react-native-bare-kit/ios/ into
 * the project's Frameworks/.
 *
 * Rationale: react-native-bare-kit's postinstall hook runs `bare-link`
 * and ships all the common Bare addons (sodium-native, udx-native,
 * rocksdb-native, …) as pre-built xcframeworks. Instead of cross-
 * compiling those ourselves, we piggyback on rnbk's build output.
 *
 * Supply-chain defense: after mirroring, every xcframework is hashed and
 * compared against `src/manifests/rnbk-known-good.json`. Mismatches are
 * logged as WARNings (not fatal — a stale manifest on a trusted rnbk bump
 * would otherwise brick installs). Unknown rnbk versions emit a prompt to
 * PR the manifest.
 *
 * Generalized from PearBrowser's scripts/fetch-barekit-addons.js.
 *
 * Options:
 *   --app <name>     Override app name (default: config)
 *   --skip-barekit   Only mirror addons, skip BareKit.xcframework overwrite
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const { load } = require('../util/config')
const logger = require('../util/log')
const { hashXcframework } = require('../util/integrity')

const log = logger.make('addons')

const MANIFEST_PATH = path.join(__dirname, '..', 'manifests', 'rnbk-known-good.json')

function loadManifest () {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
}

function addonKey (xcframeworkName) {
  // strip trailing .xcframework
  return xcframeworkName.replace(/\.xcframework$/, '')
}

function readRnbkVersion (projectRoot) {
  const pkgPath = path.join(projectRoot, 'node_modules', 'react-native-bare-kit', 'package.json')
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version
  } catch {
    return null
  }
}

async function run (args = {}) {
  const cfg = load({ appName: args.app })

  const srcRoot = path.join(cfg.projectRoot, 'node_modules', 'react-native-bare-kit', 'ios')
  if (!fs.existsSync(srcRoot)) {
    log.bail(
      `${srcRoot} not found.\n` +
      `  Install react-native-bare-kit first:\n` +
      `    npm install --save-dev react-native-bare-kit\n` +
      `  (bare-kit-pear piggybacks on its pre-built addon xcframeworks.)`
    )
  }

  fs.mkdirSync(cfg.frameworksDir, { recursive: true })

  // BareKit.xcframework — mirror the rnbk-matched runtime so addon ABIs
  // stay consistent. Skip if --skip-barekit (e.g. user ran `fetch` and
  // wants the GitHub-release version instead).
  const srcBarekit = path.join(srcRoot, 'BareKit.xcframework')
  const dstBarekit = path.join(cfg.frameworksDir, 'BareKit.xcframework')
  if (!args.skipBarekit) {
    if (!fs.existsSync(srcBarekit)) {
      log.bail(`${srcBarekit} missing — is react-native-bare-kit installed?`)
    }
    log.info('Mirroring BareKit.xcframework…')
    if (fs.existsSync(dstBarekit)) execSync(`rm -rf "${dstBarekit}"`)
    execSync(`cp -R "${srcBarekit}" "${dstBarekit}"`)
  } else {
    log.info('Skipping BareKit.xcframework (--skip-barekit)')
  }

  // Addons
  const srcAddons = path.join(srcRoot, 'addons')
  const dstAddons = cfg.addonsDir
  if (!fs.existsSync(srcAddons)) {
    log.bail(
      `${srcAddons} missing.\n` +
      `  react-native-bare-kit's postinstall link step may not have run.\n` +
      `  Try: npm rebuild react-native-bare-kit`
    )
  }

  if (fs.existsSync(dstAddons)) execSync(`rm -rf "${dstAddons}"`)
  fs.mkdirSync(dstAddons, { recursive: true })

  const addons = fs.readdirSync(srcAddons).filter((n) => n.endsWith('.xcframework'))
  if (addons.length === 0) {
    log.bail('No addon xcframeworks found in node_modules/react-native-bare-kit/ios/addons/')
  }

  log.info(`Mirroring ${addons.length} addons…`)
  for (const addon of addons) {
    execSync(`cp -R "${path.join(srcAddons, addon)}" "${path.join(dstAddons, addon)}"`)
    process.stdout.write(`  ${addon}\n`)
  }

  // Integrity check against pinned manifest.
  const rnbkVersion = readRnbkVersion(cfg.projectRoot)
  const manifest = loadManifest()
  const versionEntry = rnbkVersion ? manifest.versions[rnbkVersion] : null

  if (!rnbkVersion) {
    log.warn('Could not read react-native-bare-kit version from package.json — skipping integrity check.')
  } else if (!versionEntry) {
    log.warn(`react-native-bare-kit ${rnbkVersion} is not in rnbk-known-good.json.`)
    log.warn('  If this is a trusted bump, please add it to the manifest and open a PR.')
    log.warn('  See src/manifests/README.md for the hashing procedure.')
    // Still print the hashes we'd need to record — saves the reviewer a step.
    const freshHashes = {}
    if (!args.skipBarekit) {
      freshHashes['BareKit.xcframework'] = {
        sha256: await hashXcframework(dstBarekit)
      }
    }
    freshHashes.addons = {}
    for (const addon of addons.slice().sort()) {
      freshHashes.addons[addonKey(addon)] = {
        sha256: await hashXcframework(path.join(dstAddons, addon))
      }
    }
    log.warn(`  Paste-ready entry for ${rnbkVersion}:`)
    const blob = JSON.stringify({ [rnbkVersion]: freshHashes }, null, 2)
    blob.split('\n').forEach((line) => log.warn('    ' + line))
  } else {
    const mismatches = []
    const unknown = []

    if (!args.skipBarekit) {
      const expected = versionEntry['BareKit.xcframework'] && versionEntry['BareKit.xcframework'].sha256
      if (expected) {
        const actual = await hashXcframework(dstBarekit)
        if (actual !== expected) {
          mismatches.push({ name: 'BareKit.xcframework', expected, actual })
        }
      } else {
        unknown.push({ name: 'BareKit.xcframework', actual: await hashXcframework(dstBarekit) })
      }
    }

    const expectedAddons = versionEntry.addons || {}
    for (const addon of addons) {
      const key = addonKey(addon)
      const expected = expectedAddons[key] && expectedAddons[key].sha256
      const actual = await hashXcframework(path.join(dstAddons, addon))
      if (!expected) {
        unknown.push({ name: addon, actual })
      } else if (actual !== expected) {
        mismatches.push({ name: addon, expected, actual })
      }
    }

    if (mismatches.length === 0 && unknown.length === 0) {
      log.info(`✓ all ${addons.length + (args.skipBarekit ? 0 : 1)} xcframework hashes match manifest (rnbk ${rnbkVersion})`)
    }

    if (mismatches.length > 0) {
      log.warn(`Hash mismatch for ${mismatches.length} xcframework(s) against rnbk ${rnbkVersion} manifest:`)
      for (const m of mismatches) {
        log.warn(`  ${m.name}`)
        log.warn(`    expected: ${m.expected}`)
        log.warn(`    actual:   ${m.actual}`)
      }
      log.warn('If you have verified the upstream release, update the manifest:')
      log.warn(`    "${rnbkVersion}": {`)
      for (const m of mismatches) {
        const k = m.name === 'BareKit.xcframework' ? m.name : `addons.${addonKey(m.name)}`
        log.warn(`      "${k}": { "sha256": "${m.actual}" },`)
      }
      log.warn('    }')
      log.warn('See src/manifests/README.md for what to check before trusting this.')
    }

    if (unknown.length > 0) {
      log.warn(`${unknown.length} xcframework(s) not listed in manifest for rnbk ${rnbkVersion}:`)
      for (const u of unknown) {
        log.warn(`  ${u.name}  sha256=${u.actual}`)
      }
      log.warn('  The rnbk version was recognized but these entries are missing.')
      log.warn('  Consider PR-ing them into rnbk-known-good.json after verifying upstream.')
    }
  }

  // Warn if project.yml doesn't reference every addon.
  const projectYml = path.join(cfg.iosNativeAbs, 'project.yml')
  if (fs.existsSync(projectYml)) {
    const yml = fs.readFileSync(projectYml, 'utf-8')
    const missing = addons.filter((a) => !yml.includes(a))
    if (missing.length > 0) {
      log.warn(`These addon versions are NOT referenced in project.yml:`)
      missing.forEach((a) => log.warn(`    - ${a}`))
      log.warn('Add them under `dependencies:` (embed: true) and re-run `xcodegen generate`.')
      log.warn('Or run: npx bare-kit-pear doctor --fix')
    }
  }

  log.info(`✓ ${addons.length} addons mirrored → ${dstAddons}`)
  log.info(`→ Next: cd ${cfg.iosNativeDir} && xcodegen generate`)
}

module.exports = { run }
