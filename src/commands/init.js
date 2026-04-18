'use strict'

/**
 * `bare-kit-pear init <AppName>`
 *
 * Scaffolds ios-native/ from templates/ios-native/. Substitutes placeholder
 * `__APP_NAME__` (in filenames) and `{{APP_NAME}}` (in file contents) with
 * the provided AppName. Writes the appName back into package.json under
 * the `bare-kit-pear` config key, and adds convenience npm scripts.
 *
 * A2 owns: argv parsing, usage string, error messages, package.json script
 *          handling. Dry-run mode.
 * A3 owns: copyRecursive, placeholder substitution, template layout.
 *
 * Flags:
 *   --force       Overwrite files that exist in the template.
 *                 Preserves user files under Sources/ unless --clean is set.
 *   --clean       With --force: also delete user-added files under Sources/.
 *   --dry-run     Print the plan without touching disk.
 *   --app <name>  Alternative to positional <AppName>.
 */

const fs = require('fs')
const path = require('path')
const { findProjectRoot } = require('../util/config')
const logger = require('../util/log')

const log = logger.make('init')

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates', 'ios-native')
// A3: path to the rnbk-known-good integrity manifest. Used by the
// post-scaffold rnbk version check.
const RNBK_MANIFEST_PATH = path.join(__dirname, '..', 'manifests', 'rnbk-known-good.json')

// A2: per-command usage exported for `bare-kit-pear init --help`.
const usage = `Usage: bare-kit-pear init <AppName> [options]

Scaffold ios-native/ from the bundled template and wire up npm scripts.

Arguments:
  <AppName>            Swift target / Xcode project name.
                       Must be CamelCase letters/digits, starting with a
                       letter. Example: MyApp

Options:
  --force              Overwrite files that exist in the template.
                       Preserves user files under Sources/ by default.
  --clean              With --force: also wipe user-added files under
                       Sources/ (destructive — use with care).
  --dry-run            Print the plan without writing anything to disk.
  --app <name>         Alternative to the positional <AppName> argument.
  -h, --help           Show this message.

Behavior:
  Without --force, init refuses to overwrite an existing ios-native/.
  With --force alone, it will clobber files that exist in the template
  but leave user-added Swift files under Sources/ intact.
  With --force --clean, it behaves like the pre-hardening version and
  blows away the whole tree.

Examples:
  bare-kit-pear init MyApp
  bare-kit-pear init MyApp --dry-run
  bare-kit-pear init MyApp --force
  bare-kit-pear init MyApp --force --clean`

// A3: strip the `.tmpl` suffix from a template filename. Files named
// `foo.md.tmpl` in the template tree are rendered to `foo.md` at scaffold
// time. This lets us ship markdown files that run through `{{APP_NAME}}`
// substitution without their raw form cluttering the repo's rendered
// README previews (GitHub renders every *.md). The `__APP_NAME__` in
// filenames rewrite runs first, then `.tmpl` is stripped — order matters
// only if someone invents a file like `__APP_NAME__.tmpl.md`, which we
// don't have. Exported for enumerateTemplateFiles.
function stripTmplSuffix (name) {
  return name.endsWith('.tmpl') ? name.slice(0, -'.tmpl'.length) : name
}

function copyRecursive (src, dst, appName) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      // A3: placeholder substitution + `.tmpl` stripping in filenames.
      const dstEntry = stripTmplSuffix(entry.replace(/__APP_NAME__/g, appName))
      copyRecursive(path.join(src, entry), path.join(dst, dstEntry), appName)
    }
    return
  }
  // File: substitute placeholders in text content where safe, byte-copy
  // binary files verbatim.
  // A3: `.tmpl` files are always treated as text (the placeholder rewrite
  // is the whole point of the suffix), so strip it off before the ext
  // check so a filename like `foo.md.tmpl` is still read as text.
  const srcName = path.basename(src)
  const effectiveName = stripTmplSuffix(srcName)
  const ext = path.extname(effectiveName).toLowerCase()
  const binaryExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.icns', '.ico'])
  if (binaryExts.has(ext)) {
    fs.copyFileSync(src, dst)
    return
  }
  const content = fs.readFileSync(src, 'utf-8')
  fs.writeFileSync(dst, content.replace(/\{\{APP_NAME\}\}/g, appName))
}

// A2: enumerate every file path the template would produce, mapped to the
// destination (after __APP_NAME__ substitution). Used by both dry-run and
// --force for the "only clobber template files" semantics.
// A3: applies the same `.tmpl` stripping as copyRecursive so the dry-run
// plan / --force selective clean reference the post-render filenames.
function enumerateTemplateFiles (src, dst, appName, out = []) {
  const stat = fs.statSync(src)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(src)) {
      const dstEntry = stripTmplSuffix(entry.replace(/__APP_NAME__/g, appName))
      enumerateTemplateFiles(
        path.join(src, entry),
        path.join(dst, dstEntry),
        appName,
        out
      )
    }
    return out
  }
  out.push({ src, dst })
  return out
}

// A2: `wantScripts` is the canonical set of scripts init adds to the user's
// package.json. Exposed for the `scripts` command; centralized here so
// there's one source of truth.
function wantScriptsFor (appName) {
  return {
    'barekit:fetch': 'bare-kit-pear fetch',
    'barekit:addons': 'bare-kit-pear addons',
    'barekit:bundle': 'bare-kit-pear bundle',
    'barekit:doctor': 'bare-kit-pear doctor',
    'ios:setup': 'npm run barekit:fetch && npm run barekit:addons && npm run barekit:bundle',
    'ios:build': `cd ios-native && xcodegen generate && xcodebuild -project ${appName}.xcodeproj -scheme ${appName} -sdk iphonesimulator -configuration Debug build`
  }
}

// A2: compute what addPackageJsonConfig *would* do, and optionally persist.
// Returns { added, conflicts, pkgPath, nextPkg } — conflicts is the list of
// scripts that exist but disagree with what we would have set.
function planPackageJsonConfig (projectRoot, appName) {
  const pkgPath = path.join(projectRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

  const nextPkg = JSON.parse(JSON.stringify(pkg))
  nextPkg['bare-kit-pear'] = nextPkg['bare-kit-pear'] || {}
  nextPkg['bare-kit-pear'].appName = appName
  nextPkg.scripts = nextPkg.scripts || {}

  const want = wantScriptsFor(appName)
  const added = []
  const conflicts = []
  for (const [k, v] of Object.entries(want)) {
    if (!nextPkg.scripts[k]) {
      nextPkg.scripts[k] = v
      added.push(k)
    } else if (nextPkg.scripts[k] !== v) {
      conflicts.push({ name: k, existing: nextPkg.scripts[k], wouldAdd: v })
    }
    // else: script already equals what we'd set — silent no-op.
  }
  return { added, conflicts, pkgPath, nextPkg }
}

// A2: persists the plan from planPackageJsonConfig, and surfaces conflicts
// as explicit WARNs so the user can reconcile.
function addPackageJsonConfig (projectRoot, appName) {
  const plan = planPackageJsonConfig(projectRoot, appName)
  fs.writeFileSync(plan.pkgPath, JSON.stringify(plan.nextPkg, null, 2) + '\n')

  for (const c of plan.conflicts) {
    log.warn(
      `package.json script "${c.name}" already exists — left untouched.\n` +
      `    existing:   ${c.existing}\n` +
      `    would-add:  ${c.wouldAdd}\n` +
      `  Reconcile by hand if you want bare-kit-pear's default.`
    )
  }
  return plan.added.length
}

// A2: walk the destination tree and collect files that are NOT part of the
// template. Used by --force (default) to preserve user additions under
// Sources/. Everything under Sources/ counts as user-owned; elsewhere we
// only delete template-matched files.
function collectUserSourcesFiles (dst, templateFileSet) {
  const userFiles = []
  const sourcesDir = walkForSources(dst)
  for (const f of sourcesDir) {
    if (!templateFileSet.has(f)) userFiles.push(f)
  }
  return userFiles
}

function walkForSources (root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const d = stack.pop()
    if (!fs.existsSync(d)) continue
    for (const entry of fs.readdirSync(d)) {
      const p = path.join(d, entry)
      const st = fs.lstatSync(p)
      // Only collect files under any directory literally named "Sources".
      // Template layout: ios-native/<AppName>/Sources/**.
      if (st.isDirectory()) {
        stack.push(p)
      } else if (/[\\/]Sources[\\/]/.test(p)) {
        out.push(p)
      }
    }
  }
  return out
}

// A2: delete template-matched files from dst (leaving directories so
// mkdirSync is a no-op). Respects --clean for wiping user Sources/ too.
function selectiveClean (dst, templateFiles, clean) {
  const templatePaths = new Set(templateFiles.map((f) => f.dst))
  // 1. Delete every file that the template would write — these are always
  //    safe to clobber.
  for (const t of templateFiles) {
    if (fs.existsSync(t.dst)) {
      try { fs.unlinkSync(t.dst) } catch {}
    }
  }
  // 2. If --clean, also wipe user-added files under Sources/.
  if (clean) {
    const userFiles = collectUserSourcesFiles(dst, templatePaths)
    for (const f of userFiles) {
      try { fs.unlinkSync(f) } catch {}
    }
  }
}

// A3: ------------------------------------------------------------------
// A3: rnbk version check — runs after the template is scaffolded. Reads
// A3: the installed `react-native-bare-kit` version (if present) and
// A3: compares it to `src/manifests/rnbk-known-good.json`. Emits a single
// A3: log line in one of three shapes:
// A3:
// A3:   - OK    rnbk is installed + the version is covered by the manifest
// A3:   - WARN  rnbk is installed but NOT covered (point user to `addons`
// A3:           which prints a paste-ready manifest fragment on mismatch)
// A3:   - INFO  rnbk not installed yet — neutral next-step reminder
// A3:
// A3: Kept in its own helper so A2's argv / dry-run / force work stays
// A3: isolated from manifest I/O and file-existence checks.
// A3: ------------------------------------------------------------------
function checkRnbkVersion (projectRoot) {
  const rnbkPkgPath = path.join(
    projectRoot, 'node_modules', 'react-native-bare-kit', 'package.json'
  )

  let installedVersion = null
  try {
    if (fs.existsSync(rnbkPkgPath)) {
      const rnbkPkg = JSON.parse(fs.readFileSync(rnbkPkgPath, 'utf-8'))
      if (rnbkPkg && typeof rnbkPkg.version === 'string') {
        installedVersion = rnbkPkg.version
      }
    }
  } catch (err) {
    // A malformed node_modules/react-native-bare-kit/package.json is not
    // a fatal init condition — treat it as "not installed" so the user
    // still gets an install-me hint. BAREKIT_PEAR_DEBUG=1 surfaces the
    // underlying error.
    if (process.env.BAREKIT_PEAR_DEBUG) {
      log.warn(`could not parse ${rnbkPkgPath}: ${err.message}`)
    }
  }

  if (!installedVersion) {
    log.info(
      'react-native-bare-kit is not installed yet — run ' +
      '`npm install --save-dev react-native-bare-kit` before ' +
      '`bare-kit-pear addons`.'
    )
    return { status: 'absent' }
  }

  let manifestVersions = {}
  try {
    const manifest = JSON.parse(fs.readFileSync(RNBK_MANIFEST_PATH, 'utf-8'))
    manifestVersions = (manifest && manifest.versions) || {}
  } catch (err) {
    // A corrupted/missing manifest is a bare-kit-pear bug, not the user's
    // — warn but don't fail init.
    log.warn(
      `could not read rnbk-known-good manifest at ${RNBK_MANIFEST_PATH}` +
      ` (${err.message}) — skipping version check.`
    )
    return { status: 'manifest-unreadable', installedVersion }
  }

  if (Object.prototype.hasOwnProperty.call(manifestVersions, installedVersion)) {
    log.info(
      `✓ react-native-bare-kit ${installedVersion} is in the known-good ` +
      'manifest.'
    )
    return { status: 'ok', installedVersion }
  }

  const known = Object.keys(manifestVersions)
  const knownList = known.length > 0 ? known.join(', ') : '(none)'
  log.warn(
    `react-native-bare-kit ${installedVersion} is NOT in the known-good ` +
    `manifest (covered versions: ${knownList}). Run ` +
    '`npx bare-kit-pear addons` — on drift it prints a paste-ready ' +
    'hash block for src/manifests/rnbk-known-good.json (see ' +
    'src/manifests/README.md for the PR flow).'
  )
  return { status: 'drift', installedVersion, known }
}
// A3: end rnbk version check helper.

async function run (args = {}) {
  const appName = args._[0] || args.app
  if (!appName) {
    log.bail('Usage: bare-kit-pear init <AppName>\n  (run `bare-kit-pear init --help` for details)')
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(appName)) {
    log.bail(`App name "${appName}" invalid — use CamelCase letters/digits, starting with a letter.`)
  }

  const projectRoot = findProjectRoot()
  if (!projectRoot) {
    log.bail('No package.json found — run inside a node project.')
  }

  const dst = path.join(projectRoot, 'ios-native')
  const dryRun = Boolean(args.dryRun)
  const force = Boolean(args.force)
  const clean = Boolean(args.clean)

  if (!fs.existsSync(TEMPLATE_DIR)) {
    log.bail(`Template missing at ${TEMPLATE_DIR}. This is a bare-kit-pear bug.`)
  }

  // Plan the template copy up front — needed for both dry-run and
  // selective --force.
  const plannedFiles = enumerateTemplateFiles(TEMPLATE_DIR, dst, appName)

  if (fs.existsSync(dst) && !force && !dryRun) {
    log.bail(
      `${dst} already exists. Refusing to overwrite.\n` +
      '  Delete it, pass --force to overwrite template files, or\n' +
      '  pass --force --clean to wipe everything (including user Sources/).'
    )
  }

  // ----- Dry-run: print the plan and exit. -----
  if (dryRun) {
    log.info(`(dry-run) Would scaffold ${path.relative(projectRoot, dst)} for app "${appName}"`)
    log.info(`(dry-run) Files that would be written (${plannedFiles.length}):`)
    for (const f of plannedFiles) {
      const rel = path.relative(projectRoot, f.dst)
      const exists = fs.existsSync(f.dst) ? '  [overwrite]' : '  [new]'
      log.info(`  ${exists} ${rel}`)
    }
    if (force && fs.existsSync(dst)) {
      const templatePaths = new Set(plannedFiles.map((f) => f.dst))
      const userFiles = collectUserSourcesFiles(dst, templatePaths)
      if (userFiles.length > 0) {
        if (clean) {
          log.info(`(dry-run) --clean would delete ${userFiles.length} user file(s) under Sources/:`)
          for (const f of userFiles) log.info(`  [delete] ${path.relative(projectRoot, f)}`)
        } else {
          log.info(`(dry-run) --force would preserve ${userFiles.length} user file(s) under Sources/:`)
          for (const f of userFiles) log.info(`  [keep]   ${path.relative(projectRoot, f)}`)
        }
      }
    }

    const plan = planPackageJsonConfig(projectRoot, appName)
    log.info(`(dry-run) package.json edits:`)
    log.info(`  - set bare-kit-pear.appName = "${appName}"`)
    if (plan.added.length > 0) {
      log.info(`  - add ${plan.added.length} npm script(s):`)
      for (const k of plan.added) log.info(`      ${k}`)
    } else {
      log.info(`  - (all npm scripts already present)`)
    }
    if (plan.conflicts.length > 0) {
      log.info(`  - skip ${plan.conflicts.length} conflicting script(s):`)
      for (const c of plan.conflicts) {
        log.info(`      ${c.name}`)
        log.info(`        existing:  ${c.existing}`)
        log.info(`        would-add: ${c.wouldAdd}`)
      }
    }
    log.info('(dry-run) Nothing was written. Re-run without --dry-run to apply.')
    return
  }

  // ----- Real run. -----
  log.info(`Scaffolding ${path.relative(projectRoot, dst)} for app "${appName}"…`)

  if (fs.existsSync(dst) && force) {
    // A2: selective clean — drop files that match the template, preserve
    // user additions under Sources/ (unless --clean).
    selectiveClean(dst, plannedFiles, clean)
    if (clean) {
      log.warn('--clean: removed user-added files under Sources/.')
    } else {
      log.info('--force: overwriting template files only (user Sources/ preserved).')
    }
  }

  copyRecursive(TEMPLATE_DIR, dst, appName)

  const addedScripts = addPackageJsonConfig(projectRoot, appName)
  log.info(`Added ${addedScripts} npm scripts to package.json`)

  // A3: post-scaffold rnbk version check. Advisory only — the outcome is
  // surfaced via log.info (ok / absent) or log.warn (drift). Never fatal.
  checkRnbkVersion(projectRoot)

  log.info(`✓ Init complete.`)
  log.info('Next steps:')
  log.info('  1. npm install --save-dev react-native-bare-kit bare-pack')
  log.info('  2. npm run ios:setup')
  log.info('  3. npm run ios:build')
  log.info(`  4. xcrun simctl install booted <path-to-${appName}.app>`)
  log.info(`  5. xcrun simctl launch booted com.${appName.toLowerCase()}`)
  log.info('')
  log.info('See ios-native/BUILD.md (copied from template) for the full recipe.')
}

// A3: export checkRnbkVersion for future reuse (e.g. `doctor` could call
// the same helper) and for tests.
module.exports = { run, usage, wantScriptsFor, checkRnbkVersion }
