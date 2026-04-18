'use strict'

/**
 * Discover bare-kit-pear config for the current project.
 *
 * Resolution order:
 *   1. CLI flags passed by the command (highest priority)
 *   2. `bare-kit-pear` key in the nearest package.json
 *   3. Defaults derived from the project layout
 *
 * Shape of the package.json key:
 *
 *   "bare-kit-pear": {
 *     "appName": "MyApp",          // Swift target / Xcode project name
 *     "iosNativeDir": "ios-native", // where init writes the project
 *     "entry": "backend/index.js",  // what bundle packs
 *     "bundleOutput": "backend/dist/backend.ios.bundle",
 *     "barekitVersion": "v2.0.2"
 *   }
 */

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  iosNativeDir: 'ios-native',
  entry: 'backend/index.js',
  bundleOutput: 'backend/dist/backend.ios.bundle',
  barekitVersion: 'v2.0.2'
}

function findProjectRoot (startDir = process.cwd()) {
  let dir = path.resolve(startDir)
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function capitalize (s) {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Load the project config, merging in defaults and overrides.
 *
 * @param {object} [overrides] — from CLI flags; keys win over package.json
 * @returns {{
 *   projectRoot: string,
 *   appName: string,
 *   iosNativeDir: string,
 *   frameworksDir: string,          // absolute
 *   addonsDir: string,              // absolute
 *   entry: string,
 *   bundleOutput: string,           // absolute
 *   barekitVersion: string
 * }}
 */
function load (overrides = {}) {
  const projectRoot = overrides.projectRoot || findProjectRoot()
  if (!projectRoot) {
    throw new Error(
      'No package.json found walking up from ' + process.cwd() +
      '. Run this inside a node project.'
    )
  }

  const pkgPath = path.join(projectRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const fromPkg = pkg['bare-kit-pear'] || {}

  const appName = overrides.appName
    || fromPkg.appName
    || capitalize((pkg.name || 'App').replace(/[^A-Za-z0-9]/g, ''))
  const iosNativeDir = overrides.iosNativeDir || fromPkg.iosNativeDir || DEFAULTS.iosNativeDir
  const entry = overrides.entry || fromPkg.entry || DEFAULTS.entry
  const bundleOutput = overrides.bundleOutput || fromPkg.bundleOutput || DEFAULTS.bundleOutput
  const barekitVersion = overrides.barekitVersion
    || process.env.BAREKIT_VERSION
    || fromPkg.barekitVersion
    || DEFAULTS.barekitVersion

  const iosNativeAbs = path.join(projectRoot, iosNativeDir)
  const frameworksDir = path.join(iosNativeAbs, appName, 'Frameworks')
  const addonsDir = path.join(frameworksDir, 'addons')
  const bundleOutputAbs = path.isAbsolute(bundleOutput)
    ? bundleOutput
    : path.join(projectRoot, bundleOutput)

  return {
    projectRoot,
    appName,
    iosNativeDir,
    iosNativeAbs,
    frameworksDir,
    addonsDir,
    entry,
    bundleOutput: bundleOutputAbs,
    barekitVersion
  }
}

module.exports = { load, findProjectRoot }
