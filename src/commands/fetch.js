'use strict'

/**
 * `bare-kit-pear fetch`
 *
 * Downloads BareKit.xcframework (JavaScriptCore variant, App-Store-compliant)
 * from the holepunchto/bare-kit release archive and extracts it into the
 * project's Frameworks/ directory.
 *
 * Generalized from PearBrowser's scripts/fetch-barekit.js — destination is
 * discovered from config (bare-kit-pear.appName) instead of hardcoded.
 *
 * Supply-chain defense: the downloaded `prebuilds.zip` and the extracted
 * `BareKit.xcframework` are hashed against `src/manifests/barekit-versions.json`
 * before being installed. On mismatch the extracted framework is removed
 * before exit. HTTP redirects are restricted to a short allow-list of
 * hostnames (github.com, objects.githubusercontent.com, codeload.github.com)
 * so a malicious redirect cannot exfiltrate the download to a third party.
 *
 * Options:
 *   --version <tag>    BareKit release tag, e.g. v2.0.2 (default: config)
 *   --app <name>       Override app name (default: config)
 *   --verify-only      Do not download; hash the existing Frameworks/BareKit.xcframework
 *                      and report ok/mismatch against the manifest.
 *   --add-manifest     On unknown version, record computed hashes into the
 *                      manifest and continue. Use only when you have just
 *                      verified the upstream release by hand.
 */

const fs = require('fs')
const https = require('https')
const http = require('http')
const path = require('path')
const os = require('os')
const url = require('url')
const { execSync } = require('child_process')
const { load } = require('../util/config')
const logger = require('../util/log')
const { hashFile, hashXcframework } = require('../util/integrity')

const log = logger.make('fetch')

const MANIFEST_PATH = path.join(__dirname, '..', 'manifests', 'barekit-versions.json')
// GitHub serves release assets through a chain of hostnames. All four are
// GitHub-operated CDN origins; any redirect that escapes this set is
// treated as hostile. Keep the list tight.
const ALLOWED_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'release-assets.githubusercontent.com'
])
const MAX_REDIRECTS = 10

function loadManifest () {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
}

function saveManifest (m) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n')
}

function assertAllowedHost (u) {
  const parsed = new url.URL(u)
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS URL: ${u}`)
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing redirect to untrusted host "${parsed.hostname}".\n` +
      `  Allowed hosts: ${Array.from(ALLOWED_HOSTS).join(', ')}`
    )
  }
}

function download (startUrl, dest) {
  log.info(`Downloading ${startUrl}`)
  log.info(`  → ${dest}`)
  return new Promise((resolve, reject) => {
    let file = fs.createWriteStream(dest)
    let redirects = 0

    const cleanup = () => {
      try { file.close() } catch {}
      try { fs.unlinkSync(dest) } catch {}
    }

    const get = (u) => {
      let parsed
      try {
        parsed = new url.URL(u)
        assertAllowedHost(u)
      } catch (err) {
        cleanup()
        return reject(err)
      }
      const client = parsed.protocol === 'https:' ? https : http
      client.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 ||
            res.statusCode === 303 || res.statusCode === 307 ||
            res.statusCode === 308) {
          res.resume() // drain
          if (++redirects > MAX_REDIRECTS) {
            cleanup()
            return reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${startUrl}`))
          }
          const next = res.headers.location
          if (!next) {
            cleanup()
            return reject(new Error(`HTTP ${res.statusCode} without Location header`))
          }
          // Resolve relative Location against the current URL.
          const resolved = new url.URL(next, u).toString()
          try { file.close() } catch {}
          try { fs.unlinkSync(dest) } catch {}
          file = fs.createWriteStream(dest)
          return get(resolved)
        }
        if (res.statusCode !== 200) {
          cleanup()
          return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`))
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let downloaded = 0
        let lastPct = -1
        res.on('data', (chunk) => {
          downloaded += chunk.length
          if (total > 0) {
            const pct = Math.floor((downloaded / total) * 100)
            if (pct !== lastPct && pct % 10 === 0) {
              log.info(`  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
              lastPct = pct
            }
          }
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', (err) => { cleanup(); reject(err) })
      }).on('error', (err) => { cleanup(); reject(err) })
    }
    get(startUrl)
  })
}

async function runVerifyOnly (cfg) {
  const manifest = loadManifest()
  const entry = manifest.versions[cfg.barekitVersion]
  const dst = path.join(cfg.frameworksDir, 'BareKit.xcframework')
  if (!fs.existsSync(dst)) {
    log.bail(
      `No BareKit.xcframework installed at ${dst}.\n` +
      `  Run \`bare-kit-pear fetch\` (or \`addons\`) first.`
    )
  }
  log.info(`Hashing ${dst}`)
  const actual = await hashXcframework(dst)
  if (!entry) {
    log.warn(
      `Version ${cfg.barekitVersion} is not recorded in barekit-versions.json.\n` +
      `  Installed xcframework hash: ${actual}`
    )
    log.warn('Cannot verify — unknown version. Consider PR-ing the manifest.')
    process.exit(2)
  }
  // The manifest only records the zip hash for bare-kit releases (the
  // extracted xcframework path comes from node_modules for rnbk). So if we
  // have an xcframework hash recorded (optional, see --add-manifest below),
  // check it; otherwise report the computed hash and exit 0.
  const expectedXc = entry['BareKit.xcframework'] && entry['BareKit.xcframework'].sha256
  if (expectedXc) {
    if (actual === expectedXc) {
      log.info(`✓ BareKit.xcframework matches manifest for ${cfg.barekitVersion}`)
      log.info(`  sha256: ${actual}`)
    } else {
      log.error('✗ Installed BareKit.xcframework does NOT match manifest.')
      log.error(`  expected: ${expectedXc}`)
      log.error(`  actual:   ${actual}`)
      process.exit(1)
    }
  } else {
    log.info(`BareKit.xcframework sha256: ${actual}`)
    log.info(`(no xcframework hash recorded for ${cfg.barekitVersion} — only the zip is pinned)`)
  }
}

async function run (args = {}) {
  const cfg = load({
    appName: args.app,
    barekitVersion: args.version
  })

  if (args.verifyOnly || args['verify-only']) {
    return runVerifyOnly(cfg)
  }

  const manifest = loadManifest()
  const entry = manifest.versions[cfg.barekitVersion]
  const addManifest = Boolean(args.addManifest || args['add-manifest'])
  if (!entry && !addManifest) {
    log.bail(
      `Version ${cfg.barekitVersion} not in manifest. ` +
      `Pass --add-manifest to trust and record this version.`
    )
  }

  const downloadUrl = `https://github.com/holepunchto/bare-kit/releases/download/${cfg.barekitVersion}/prebuilds.zip`
  const tmp = path.join(os.tmpdir(), `barekit-${Date.now()}`)

  fs.mkdirSync(tmp, { recursive: true })
  fs.mkdirSync(cfg.frameworksDir, { recursive: true })

  const zipPath = path.join(tmp, 'prebuilds.zip')
  try {
    await download(downloadUrl, zipPath)
  } catch (err) {
    try { execSync(`rm -rf "${tmp}"`) } catch {}
    log.bail(`Download failed: ${err.message}`)
  }

  // Verify the raw zip before we even unpack it.
  const zipSha = await hashFile(zipPath)
  const zipSize = fs.statSync(zipPath).size

  if (entry) {
    const expectedZip = entry['prebuilds.zip']
    if (expectedZip && expectedZip.sha256) {
      if (zipSha !== expectedZip.sha256) {
        try { execSync(`rm -rf "${tmp}"`) } catch {}
        log.error('')
        log.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        log.error('!!  SUPPLY-CHAIN ALERT: prebuilds.zip hash MISMATCH        !!')
        log.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
        log.error(`  version:  ${cfg.barekitVersion}`)
        log.error(`  url:      ${downloadUrl}`)
        log.error(`  expected: ${expectedZip.sha256}`)
        log.error(`  actual:   ${zipSha}`)
        log.error('Aborting. Nothing was installed. Investigate the upstream release before retrying.')
        process.exit(1)
      }
      log.info(`✓ prebuilds.zip sha256 matches manifest (${zipSha.slice(0, 12)}…)`)
    }
  }

  log.info('Unzipping…')
  try {
    execSync(`unzip -q "${zipPath}"`, { cwd: tmp })
  } catch {
    try { execSync(`rm -rf "${tmp}"`) } catch {}
    log.bail('unzip failed — is the unzip tool installed?')
  }

  const srcFramework = path.join(tmp, 'apple-javascriptcore', 'BareKit.xcframework')
  if (!fs.existsSync(srcFramework)) {
    const listing = fs.readdirSync(tmp).join('\n  ')
    try { execSync(`rm -rf "${tmp}"`) } catch {}
    log.bail(
      `Could not find apple-javascriptcore/BareKit.xcframework in archive.\n` +
      `Contents of ${tmp}:\n  ${listing}`
    )
  }

  // Hash the extracted xcframework while it still lives in tmp so a
  // mismatch can abort before anything is moved into Frameworks/.
  const xcSha = await hashXcframework(srcFramework)
  if (entry) {
    const expectedXc = entry['BareKit.xcframework'] && entry['BareKit.xcframework'].sha256
    if (expectedXc && xcSha !== expectedXc) {
      try { execSync(`rm -rf "${tmp}"`) } catch {}
      log.error('')
      log.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
      log.error('!!  SUPPLY-CHAIN ALERT: BareKit.xcframework hash MISMATCH  !!')
      log.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
      log.error(`  version:  ${cfg.barekitVersion}`)
      log.error(`  expected: ${expectedXc}`)
      log.error(`  actual:   ${xcSha}`)
      log.error('Aborting. Nothing was installed.')
      process.exit(1)
    }
  }

  const dst = path.join(cfg.frameworksDir, 'BareKit.xcframework')
  if (fs.existsSync(dst)) {
    log.info('Removing existing BareKit.xcframework')
    execSync(`rm -rf "${dst}"`)
  }
  log.info(`Installing → ${dst}`)
  execSync(`mv "${srcFramework}" "${dst}"`)

  execSync(`rm -rf "${tmp}"`)

  if (!entry && addManifest) {
    // Record what we just verified by-hand ran. We pin both zip + xcframework.
    const today = new Date().toISOString().slice(0, 10)
    manifest.versions[cfg.barekitVersion] = {
      'prebuilds.zip': {
        sha256: zipSha,
        size: zipSize,
        url: downloadUrl,
        added: today
      },
      'BareKit.xcframework': {
        sha256: xcSha,
        added: today
      }
    }
    saveManifest(manifest)
    log.warn(`Recorded hashes for ${cfg.barekitVersion} into barekit-versions.json.`)
    log.warn('  Review the manifest diff and commit it if this version is trusted.')
  } else if (entry) {
    const expectedXc = entry['BareKit.xcframework'] && entry['BareKit.xcframework'].sha256
    if (!expectedXc) {
      // The zip was pinned but the xcframework was not. Print the computed
      // hash so it can be added in a follow-up PR.
      log.info(`BareKit.xcframework sha256: ${xcSha}`)
      log.info('(manifest has no xcframework hash for this version — consider adding it)')
    } else {
      log.info(`✓ BareKit.xcframework sha256 matches manifest (${xcSha.slice(0, 12)}…)`)
    }
  }

  log.info(`✓ BareKit ${cfg.barekitVersion} installed (JSC variant, App Store compliant)`)
  log.info('→ Next: npx bare-kit-pear addons && npx bare-kit-pear bundle')
}

module.exports = { run }
