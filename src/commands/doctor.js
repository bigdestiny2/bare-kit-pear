'use strict'

/**
 * `bare-kit-pear doctor`
 *
 * Sanity-checks the project state. Verifies:
 *   1. ios-native/project.yml exists
 *   2. Frameworks/BareKit.xcframework exists
 *   3. Every *.xcframework under Frameworks/addons/ is referenced in project.yml
 *   4. Every addon referenced in project.yml actually exists on disk
 *   5. The bundle output exists (warning, not error)
 *
 * Exit codes (A2):
 *   0  ✓ everything in order
 *   1  problems exist that `doctor --fix` knows how to repair
 *      (e.g. addon dir drift — rerun with --fix)
 *   2  human-required: missing Frameworks dir, missing BareKit.xcframework,
 *      addons referenced in project.yml but missing from disk, no project.yml
 *
 * `--fix` inserts addon references into project.yml under the target's
 * `dependencies:` block. YAML is edited as plain text — no dependency
 * on a YAML parser. We preserve comments, anchors, and indentation by
 * only inserting new lines at the end of the existing addon group.
 */

// A2: --fix implementation lives here. Strategy documented in
// `rewriteProjectYml` — regex-based, no YAML parser.

const fs = require('fs')
const path = require('path')
const { load } = require('../util/config')
const logger = require('../util/log')

const log = logger.make('doctor')

// A2: per-command usage.
const usage = `Usage: bare-kit-pear doctor [options]

Sanity-checks the project state and addon drift between project.yml and
Frameworks/addons/.

Options:
  --fix                Insert addons on disk that are missing from
                       project.yml (preserves YAML formatting/comments).
                       Does NOT resolve the reverse (refs without disk
                       files) — those always require human review.
  --app <name>         Override app name (default: from package.json).
  -h, --help           Show this message.

Exit codes:
  0    ✓ everything in order
  1    problems exist that --fix can handle (rerun with --fix)
  2    human-required (missing Frameworks/, no project.yml, etc.)

Examples:
  bare-kit-pear doctor          # report only
  bare-kit-pear doctor --fix    # report + repair addon references`

// A2: figure out the indentation used by existing `- framework: …` lines
// under `dependencies:` so new entries match. Returns { indent, embedIndent }
// where `indent` is the leading whitespace before `- framework:` and
// `embedIndent` is the leading whitespace before `embed: true`.
// Defaults match the template if we can't detect (4-space + 8-space).
function detectAddonIndent (yml) {
  const m = /^(\s+)-\s+framework:\s+[^\n]*Frameworks\/addons\/[^\n]+\n(\s+)embed:\s*true/m.exec(yml)
  if (m) return { indent: m[1], embedIndent: m[2] }
  // Fall back to any `- framework:` line indent (non-addon).
  const fm = /^(\s+)-\s+framework:\s+/m.exec(yml)
  if (fm) return { indent: fm[1], embedIndent: fm[1] + '  ' }
  return { indent: '      ', embedIndent: '        ' }
}

// A2: return the char-index in yml where we should insert the new lines,
// or -1 if we can't safely locate the addon block tail.
//
// Strategy: find the LAST `- framework: …Frameworks/addons/…` line (with
// its `embed: true` continuation), and splice new entries immediately
// after that line's `embed: true`. This preserves every existing anchor,
// comment and adjacent entry.
function findAddonBlockTail (yml) {
  const re = /^(\s+)-\s+framework:\s+[^\n]*Frameworks\/addons\/[^\n]+\n(\s+)embed:\s*true[^\n]*$/gm
  let last = null
  let m
  while ((m = re.exec(yml)) !== null) {
    last = m
  }
  if (!last) return -1
  // index of the char right after the matched `embed: true` line.
  return last.index + last[0].length
}

// A2: build the text to splice in for a set of missing addons. We use the
// app-name-scoped path the template uses: <AppName>/Frameworks/addons/.
function buildAddonLines (missing, indent, embedIndent, appName) {
  return missing.map((name) => (
    `\n${indent}- framework: ${appName}/Frameworks/addons/${name}\n` +
    `${embedIndent}embed: true`
  )).join('')
}

// A2: edit project.yml by splicing the missing addon entries at the tail
// of the existing addon block. Returns { yml, count, reason? } where
// `reason` is set when we bail out without editing.
function rewriteProjectYml (yml, missing, appName) {
  if (missing.length === 0) return { yml, count: 0 }
  const tailIdx = findAddonBlockTail(yml)
  if (tailIdx < 0) {
    return { yml, count: 0, reason: 'could not locate existing addon block in project.yml' }
  }
  const { indent, embedIndent } = detectAddonIndent(yml)
  const insertion = buildAddonLines(missing, indent, embedIndent, appName)
  const next = yml.slice(0, tailIdx) + insertion + yml.slice(tailIdx)
  return { yml: next, count: missing.length }
}

function run (args = {}) {
  const cfg = load({ appName: args.app })
  const fix = Boolean(args.fix)

  // A2: three buckets:
  //   fatal        → exit 2 (human-required; --fix can't help)
  //   fixable      → exit 1 without --fix; resolved by --fix
  //   warnings     → advisory
  const fatal = []
  const fixable = []
  const warnings = []

  // 1. project.yml
  const projectYml = path.join(cfg.iosNativeAbs, 'project.yml')
  if (!fs.existsSync(projectYml)) {
    fatal.push(`Missing ${path.relative(cfg.projectRoot, projectYml)} — run: npx bare-kit-pear init ${cfg.appName}`)
  }

  // 2. BareKit.xcframework
  const barekit = path.join(cfg.frameworksDir, 'BareKit.xcframework')
  if (!fs.existsSync(barekit)) {
    fatal.push(`Missing ${path.relative(cfg.projectRoot, barekit)} — run: npx bare-kit-pear fetch`)
  }

  // 3 + 4. Addon drift
  let onDisk = []
  if (fs.existsSync(cfg.addonsDir)) {
    onDisk = fs.readdirSync(cfg.addonsDir).filter((n) => n.endsWith('.xcframework'))
  } else {
    fatal.push(`Missing ${path.relative(cfg.projectRoot, cfg.addonsDir)} — run: npx bare-kit-pear addons`)
  }

  let missingFromYml = []
  let missingFromDisk = []
  if (fs.existsSync(projectYml) && onDisk.length > 0) {
    const yml = fs.readFileSync(projectYml, 'utf-8')
    missingFromYml = onDisk.filter((a) => !yml.includes(a))
    // Look for referenced addons that don't exist on disk — always fatal.
    const addonRefRe = /Frameworks\/addons\/([^\s]+\.xcframework)/g
    const referenced = new Set()
    let m
    while ((m = addonRefRe.exec(yml)) !== null) referenced.add(m[1])
    missingFromDisk = [...referenced].filter((a) => !onDisk.includes(a))
  }

  if (missingFromYml.length > 0) {
    fixable.push({
      kind: 'missingFromYml',
      items: missingFromYml,
      message:
        `${missingFromYml.length} addon(s) on disk are NOT referenced in project.yml:\n` +
        missingFromYml.map((a) => `    - ${a}`).join('\n') +
        `\n  ${fix ? 'Inserting now…' : 'Rerun with --fix to insert them, or add by hand under `dependencies:`.'}`
    })
  }

  if (missingFromDisk.length > 0) {
    fatal.push(
      `${missingFromDisk.length} addon(s) referenced in project.yml but missing from disk:\n` +
      missingFromDisk.map((a) => `    - ${a}`).join('\n') +
      `\n  Run: npx bare-kit-pear addons`
    )
  }

  // 5. Bundle output (advisory only — user might not have bundled yet)
  if (!fs.existsSync(cfg.bundleOutput)) {
    warnings.push(
      `No bundle at ${path.relative(cfg.projectRoot, cfg.bundleOutput)} — ` +
      `run: npx bare-kit-pear bundle`
    )
  }

  // Report
  log.info(`Project: ${cfg.projectRoot}`)
  log.info(`App name: ${cfg.appName}`)
  log.info(`Frameworks: ${path.relative(cfg.projectRoot, cfg.frameworksDir)}`)
  log.info(`Addons on disk: ${onDisk.length}`)
  log.info(`BareKit version (config): ${cfg.barekitVersion}`)

  if (warnings.length > 0) {
    console.log('')
    warnings.forEach((w) => log.warn(w))
  }

  // A2: apply --fix for the fixable set. We only touch the file when the
  // YAML write succeeds end-to-end. On any surprise, we fall through to
  // exit 1 with the unfixed message.
  let applied = 0
  if (fix && missingFromYml.length > 0 && fs.existsSync(projectYml)) {
    const beforeYml = fs.readFileSync(projectYml, 'utf-8')
    const result = rewriteProjectYml(beforeYml, missingFromYml, cfg.appName)
    if (result.count > 0) {
      fs.writeFileSync(projectYml, result.yml)
      applied = result.count
      log.info(`✓ --fix: inserted ${applied} addon reference(s) into ${path.relative(cfg.projectRoot, projectYml)}`)
      log.info('  Rerun `xcodegen generate` to regenerate the .xcodeproj.')
    } else if (result.reason) {
      // Leave the fixable entry in place so the exit code reflects the
      // unresolved state.
      log.warn(`--fix did not modify project.yml: ${result.reason}`)
    }
  }

  // Emit errors (fatal + any fixable left standing).
  if (fatal.length > 0) {
    console.log('')
    fatal.forEach((p) => log.error(p))
  }
  if (fixable.length > 0 && applied === 0) {
    console.log('')
    fixable.forEach((p) => log.error(p.message))
  }

  // A2: compute exit code.
  //   fatal present        → 2
  //   fixable present and not applied → 1
  //   else                 → 0
  if (fatal.length > 0) {
    log.bail(
      `${fatal.length} problem(s) require human attention (exit 2).`,
      2
    )
  }
  if (fixable.length > 0 && applied === 0) {
    log.bail(
      `${fixable.length} problem(s) found. Rerun with --fix to repair (exit 1).`,
      1
    )
  }

  log.info('✓ Doctor says: everything in order.')
}

module.exports = { run, usage, rewriteProjectYml }
