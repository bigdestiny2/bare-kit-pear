'use strict'

// A2: tests for the argv parser exported from src/cli.js. Uses node's
// built-in test runner so we keep the zero-deps rule.

const test = require('node:test')
const assert = require('node:assert')

const { parseArgs } = require('../src/cli')

test('parseArgs: empty input → empty positional bag', () => {
  const a = parseArgs([])
  assert.deepStrictEqual(a, { _: [] })
})

test('parseArgs: --key value form', () => {
  const a = parseArgs(['--app', 'MyApp'])
  assert.strictEqual(a.app, 'MyApp')
  assert.deepStrictEqual(a._, [])
})

test('parseArgs: --key=value form', () => {
  const a = parseArgs(['--app=MyApp'])
  assert.strictEqual(a.app, 'MyApp')
  assert.deepStrictEqual(a._, [])
})

test('parseArgs: --key=value preserves embedded "=" chars in value', () => {
  const a = parseArgs(['--env=FOO=bar'])
  assert.strictEqual(a.env, 'FOO=bar')
})

test('parseArgs: bare --flag is true', () => {
  const a = parseArgs(['--force'])
  assert.strictEqual(a.force, true)
})

test('parseArgs: two adjacent bare flags', () => {
  const a = parseArgs(['--force', '--dry-run'])
  assert.strictEqual(a.force, true)
  assert.strictEqual(a.dryRun, true)
})

test('parseArgs: --no-flag sets false', () => {
  const a = parseArgs(['--no-clean'])
  assert.strictEqual(a.clean, false)
})

test('parseArgs: --key <value> where next starts with - is treated as flag', () => {
  // This preserves the invariant "flags don't swallow other flags".
  const a = parseArgs(['--force', '--dry-run'])
  assert.strictEqual(a.force, true)
  assert.strictEqual(a.dryRun, true)
})

test('parseArgs: -h aliases --help via top-level alias table', () => {
  const a = parseArgs(['-h'])
  assert.strictEqual(a.help, true)
})

test('parseArgs: -v aliases --version via top-level alias table', () => {
  const a = parseArgs(['-v'])
  assert.strictEqual(a.version, true)
})

test('parseArgs: command-specific short alias map is honored', () => {
  const a = parseArgs(['-e', 'backend/main.js'], { e: 'entry' })
  assert.strictEqual(a.entry, 'backend/main.js')
})

test('parseArgs: positionals preserved in _', () => {
  const a = parseArgs(['foo', 'bar', 'baz'])
  assert.deepStrictEqual(a._, ['foo', 'bar', 'baz'])
})

test('parseArgs: mixed positional + flags', () => {
  const a = parseArgs(['MyApp', '--force', '--dry-run'])
  assert.deepStrictEqual(a._, ['MyApp'])
  assert.strictEqual(a.force, true)
  assert.strictEqual(a.dryRun, true)
})

test('parseArgs: mixed positional + key=value', () => {
  const a = parseArgs(['MyApp', '--app=Other', '--dry-run'])
  assert.deepStrictEqual(a._, ['MyApp'])
  assert.strictEqual(a.app, 'Other')
  assert.strictEqual(a.dryRun, true)
})

test('parseArgs: -- terminates flag parsing', () => {
  const a = parseArgs(['--force', '--', '--not-a-flag', 'value'])
  assert.strictEqual(a.force, true)
  assert.deepStrictEqual(a._, ['--not-a-flag', 'value'])
})

test('parseArgs: kebab-case flag → camelCase key', () => {
  const a = parseArgs(['--dry-run', '--skip-barekit'])
  assert.strictEqual(a.dryRun, true)
  assert.strictEqual(a.skipBarekit, true)
})

test('parseArgs: --key value with value looking like number stays string', () => {
  const a = parseArgs(['--port', '8080'])
  assert.strictEqual(a.port, '8080') // no coercion
})

test('parseArgs: short form -x=value', () => {
  const a = parseArgs(['-a=Foo'], { a: 'app' })
  assert.strictEqual(a.app, 'Foo')
})

test('parseArgs: trailing flag with no value', () => {
  const a = parseArgs(['--force'])
  assert.strictEqual(a.force, true)
  assert.deepStrictEqual(a._, [])
})

test('parseArgs: positional after flag-with-value is NOT swallowed twice', () => {
  const a = parseArgs(['--app', 'Foo', 'bar'])
  assert.strictEqual(a.app, 'Foo')
  assert.deepStrictEqual(a._, ['bar'])
})

test('parseArgs: bundled short flags each become true', () => {
  const a = parseArgs(['-hv'])
  assert.strictEqual(a.help, true)
  assert.strictEqual(a.version, true)
})
