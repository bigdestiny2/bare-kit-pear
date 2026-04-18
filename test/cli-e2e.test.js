'use strict'

/**
 * CLI end-to-end tests for bare-kit-pear.
 *
 * Runs the real `bin/bare-kit-pear` binary against temp-dir projects and
 * asserts exit codes, filesystem side-effects, and stdout/stderr. No npm
 * deps — just node built-ins.
 *
 * Each test creates an isolated tmpdir (cleaned up in the finally block,
 * even if the assertions throw) to keep parallel test runs independent
 * and to avoid leaking state into the developer's environment.
 */

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..')
const CLI = path.join(REPO_ROOT, 'bin', 'bare-kit-pear')

function mkTempProject (packageJsonExtras = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-e2e-'))
  const pkg = Object.assign(
    { name: 'test-proj', version: '0.1.0' },
    packageJsonExtras
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  return dir
}

function cleanup (dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup; don't fail the test on stuck file handles
  }
}

function runCli (args, opts = {}) {
  return spawnSync('node', [CLI, ...args], Object.assign({
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { BAREKIT_PEAR_NO_COLOR: '1' })
  }, opts))
}

test('help lists every registered subcommand', () => {
  const res = runCli(['help'])
  assert.strictEqual(res.status, 0, `exit should be 0; stderr=${res.stderr}`)
  const out = res.stdout
  // Every command registered in COMMANDS plus top-level help.
  for (const cmd of ['init', 'fetch', 'addons', 'bundle', 'doctor', 'scripts', 'help']) {
    assert.ok(out.includes(cmd), `help output should mention "${cmd}"; got:\n${out}`)
  }
})

test('top-level --version prints the package version', () => {
  const res = runCli(['--version'])
  assert.strictEqual(res.status, 0)
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'))
  assert.strictEqual(res.stdout.trim(), pkg.version)
})

test('unknown command exits non-zero with a helpful message', () => {
  const res = runCli(['definitely-not-a-real-command'])
  assert.notStrictEqual(res.status, 0, 'unknown command should exit non-zero')
  assert.ok(
    res.stderr.toLowerCase().includes('unknown command'),
    `stderr should explain the error; got: ${res.stderr}`
  )
})

test('init scaffolds ios-native/ with the requested app name', () => {
  const dir = mkTempProject()
  try {
    const res = runCli(['init', 'MyCoolApp'], { cwd: dir })
    assert.strictEqual(res.status, 0, `init failed: ${res.stderr || res.stdout}`)

    // Core template artefacts must exist with placeholders substituted.
    assert.ok(
      fs.existsSync(path.join(dir, 'ios-native', 'project.yml')),
      'project.yml should be copied'
    )
    assert.ok(
      fs.existsSync(path.join(dir, 'ios-native', 'MyCoolApp', 'Info.plist')),
      '__APP_NAME__ folder should be renamed to MyCoolApp'
    )

    // project.yml should have {{APP_NAME}} replaced.
    const yml = fs.readFileSync(path.join(dir, 'ios-native', 'project.yml'), 'utf-8')
    assert.ok(yml.includes('MyCoolApp'), 'project.yml should contain the app name')
    assert.ok(!yml.includes('{{APP_NAME}}'), 'project.yml should not still carry the placeholder')

    // package.json should have been updated with bare-kit-pear config +
    // helper scripts.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
    assert.strictEqual(pkg['bare-kit-pear'].appName, 'MyCoolApp')
    assert.ok(pkg.scripts['barekit:fetch'], 'should have added barekit:fetch script')
    assert.ok(pkg.scripts['barekit:bundle'], 'should have added barekit:bundle script')
  } finally {
    cleanup(dir)
  }
})

test('init refuses to overwrite an existing ios-native/ without --force', () => {
  const dir = mkTempProject()
  try {
    // First init — clean slate, should succeed.
    const first = runCli(['init', 'FirstApp'], { cwd: dir })
    assert.strictEqual(first.status, 0, `first init should succeed: ${first.stderr}`)

    // Second init WITHOUT --force — must bail.
    const second = runCli(['init', 'SecondApp'], { cwd: dir })
    assert.notStrictEqual(second.status, 0, 'second init should refuse to overwrite')
    const stderr = second.stderr + second.stdout
    assert.ok(
      /already exists|force|refusing/i.test(stderr),
      `stderr should explain the refusal; got: ${stderr}`
    )
  } finally {
    cleanup(dir)
  }
})

test('init rejects an invalid app name', () => {
  const dir = mkTempProject()
  try {
    // App name that starts with a digit — should be rejected by the validator.
    const res = runCli(['init', '9notvalid'], { cwd: dir })
    assert.notStrictEqual(res.status, 0, 'invalid app name should bail')
    assert.ok(
      !fs.existsSync(path.join(dir, 'ios-native')),
      'ios-native should NOT be created when the name is rejected'
    )
  } finally {
    cleanup(dir)
  }
})

test('init with no app name prints a usage hint and exits non-zero', () => {
  const dir = mkTempProject()
  try {
    const res = runCli(['init'], { cwd: dir })
    assert.notStrictEqual(res.status, 0, 'missing app name should bail')
    const combined = res.stderr + res.stdout
    assert.ok(
      /usage|appname/i.test(combined),
      `should print usage hint; got: ${combined}`
    )
  } finally {
    cleanup(dir)
  }
})

test('doctor in an empty project reports the missing pieces and exits non-zero', () => {
  const dir = mkTempProject()
  try {
    const res = runCli(['doctor'], { cwd: dir })
    assert.notStrictEqual(res.status, 0, 'doctor in empty project should bail')
    const combined = res.stdout + res.stderr
    // Must mention at least one missing artifact by name.
    assert.ok(
      /project\.yml|BareKit\.xcframework|addons/i.test(combined),
      `doctor should list missing artefacts; got:\n${combined}`
    )
  } finally {
    cleanup(dir)
  }
})

test('doctor after init still reports missing frameworks but recognises the project', () => {
  const dir = mkTempProject()
  try {
    const init = runCli(['init', 'DoctorTest'], { cwd: dir })
    assert.strictEqual(init.status, 0, `init should succeed: ${init.stderr}`)

    const doc = runCli(['doctor'], { cwd: dir })
    // Still exits non-zero — frameworks aren't fetched yet.
    assert.notStrictEqual(doc.status, 0)
    const combined = doc.stdout + doc.stderr
    // The project.yml should NOT be listed as missing (init created it).
    // But BareKit.xcframework should be.
    assert.ok(
      /BareKit\.xcframework/i.test(combined),
      `doctor should flag missing BareKit.xcframework; got:\n${combined}`
    )
    assert.ok(
      combined.includes('DoctorTest'),
      `doctor should mention the app name; got:\n${combined}`
    )
  } finally {
    cleanup(dir)
  }
})
