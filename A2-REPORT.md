# A2 Report: CLI UX + three commands

Scope: CLI parser, per-command help, `init` dry-run/force semantics,
`bundle` error diagnostics, `doctor --fix`, new `scripts` command, and
parser tests. A3 owned copy/scaffold logic in `init.js` (`copyRecursive`
and placeholder substitution); A4 owns `fetch.js` / `addons.js` / the
integrity manifests and was not touched.

## Files changed

- `src/cli.js` — full rewrite of the argv parser; added per-command help
  dispatch, short aliases, and a `module.exports` so tests can import
  `parseArgs`. The CLI entry guard now only fires when invoked via the
  `bin/bare-kit-pear` shim so tests can `require()` the file safely.
- `src/commands/init.js` — added `--dry-run`, `--force` (selective), and
  `--clean`; exported `usage` and `wantScriptsFor`; surfaced script-
  conflict WARNs with both the existing and would-add values. Did NOT
  touch `copyRecursive` / placeholder subs / `stripTmplSuffix` / the
  rnbk-version check (all A3-owned). The A3 landings merged cleanly:
  A3 added `stripTmplSuffix` and a rnbk-known-good post-scaffold check;
  A2 added the flag plumbing and extended `enumerateTemplateFiles` uses
  the same helper when A3 introduced it.
- `src/commands/bundle.js` — captures bare-pack's stdio so we can
  stream live and also post-process on failure; added four diagnostic
  rules (missing module / bad host / OOM / entry missing); exported
  `usage`; added `BAREKIT_PEAR_DEBUG=1` to echo raw stderr.
- `src/commands/doctor.js` — three-tier exit codes (0 / 1 fixable /
  2 human-required); added `--fix` that rewrites `project.yml` in place
  via regex-only string manipulation (no YAML parser — preserves
  comments, anchors, and indent); exported `usage` and
  `rewriteProjectYml`.
- `src/commands/scripts.js` (NEW) — prints the six npm scripts `init`
  adds, human-readable by default and machine-readable with `--json`.
  Imports the canonical list from `init.js` to keep a single source of
  truth.
- `test/cli-parser.test.js` (NEW) — 21 unit tests for `parseArgs`, using
  `node:test` + `node:assert`. Covers `--key value`, `--key=value`,
  `--flag`, `--no-flag`, `--`, `-h`/`-v` aliases, per-command short
  aliases, bundled shorts, kebab→camel, and positional preservation.
- `package.json` — test script bumped from `test/*.test.js` to
  `test/**/*.test.js` per brief.
- `src/util/log.js`, `src/util/config.js` — not touched. The existing
  `log.info/warn/error/bail` pattern is honored by every new code path
  and no additional helpers were needed.

## CLI UX decisions

1. **Per-command help discovery.** `cli.js` peeks for `--help`/`-h` in
   the rest of argv before parsing command-specific options, and
   routes to the command module's exported `usage` string. This lets
   us short-circuit `bare-kit-pear init --help` without having to
   construct a full `args` object first, and avoids the trap where a
   command's arg parser swallows `--help` as a value.

2. **Short-flag alias table.** `-h`/`-v` are universal; commands can
   expose their own map via `module.exports.aliases = { e: 'entry' }`.
   Bundled shorts (`-hv`) treat every char as a boolean. No command
   currently uses per-command aliases, but the plumbing is there.

3. **`--no-flag` negation.** Included mostly for future flags; no
   command needs it today, but it's the kind of thing you add once
   and forget about.

4. **`--` stops flag parsing.** Useful for passing flag-shaped values
   to a downstream tool.

5. **Parser NEVER coerces types.** A flag value is always a string or
   a boolean. Commands cast when they need to. This avoids the classic
   "parsed `--port 0` as `false`" bug.

6. **`init --force` semantics change.** Was: wipe `ios-native/`
   entirely. Now: overwrite only files the template would write. The
   user's Sources/ additions are preserved unless `--clean` is
   passed. The help text spells this out.

7. **`init --dry-run` output format.** Line-per-file with `[new]` /
   `[overwrite]` tags, then a package.json plan section listing what
   scripts would be added and what would be skipped with both values.
   Nothing is written to disk.

8. **`doctor` three-tier exit codes.** The problem-kind split (fixable
   vs fatal) is decided up front. Fatal always wins — if the addons dir
   is missing and there's also drift, we exit 2 (because `--fix` can't
   help). Only when the ONLY problem is drift do we exit 1.

9. **`doctor --fix` YAML edit strategy.** We find the last
   `- framework: …Frameworks/addons/…xcframework / embed: true` pair
   by regex and splice new entries immediately after it, copying the
   detected indent (with a sensible fallback matching the template).
   Idempotent — rerunning after a fix does nothing because the
   entries are now present. No YAML parser, zero deps.

10. **`scripts --json` is prefix-free.** `log.info` prefixes every
    line with `[bare-kit-pear:scripts]`; that would break shell
    pipelines like `bare-kit-pear scripts --json | jq`. So the JSON
    path writes to stdout directly without the prefix. Human mode
    keeps prefixes on the prose but writes the JSON block raw so the
    user can still copy it.

11. **Bundle diagnostics capture+replay.** Rather than spawn twice
    (once streaming, once captured), we capture both streams on the
    first spawn and write them to stdout/stderr ourselves, then
    post-process the combined text for known patterns. The user sees
    bare-pack's output live; on failure they see an actionable hint
    on top.

## Incidents with A3

None. A3 landed edits to `init.js` after A2 but before A2 re-read the
file; the system surfaced the merge cleanly. A3's additions —
`stripTmplSuffix`, `RNBK_MANIFEST_PATH`, `checkRnbkVersion`, and a
`.tmpl`-suffix hook inside `copyRecursive`/`enumerateTemplateFiles` —
live in separate functions from A2's. The only shared surface is
`enumerateTemplateFiles`, and A3's edit was additive (call
`stripTmplSuffix`). A3 also expanded `module.exports` to include
`checkRnbkVersion`; A2's `usage` and `wantScriptsFor` sit alongside.

The one pitfall narrowly avoided: A3 wrote the rnbk check into the
end of `run()`, not gated behind `--dry-run`. Because A2's dry-run
path returns early before A3's check runs, it's not called during a
dry run — the right behavior (no side effects, no manifest I/O).

## Verification run (all passing at time of report)

- `node bin/bare-kit-pear help` — lists `init / fetch / addons /
  bundle / doctor / scripts / help` and the common options with
  `-v`/`-h` aliases.
- `node bin/bare-kit-pear init --help` — prints the init-specific
  usage block (arguments, flags, behavior paragraph, examples).
- `node bin/bare-kit-pear bundle --help` — prints bundle usage +
  host triples + env hints.
- `node bin/bare-kit-pear doctor --help` — prints doctor usage +
  exit code table.
- `node bin/bare-kit-pear scripts --help` — prints scripts usage.
- `node bin/bare-kit-pear scripts --app Foo --json` — prefix-free
  JSON on stdout suitable for `jq`.
- `node --test test/cli-parser.test.js` — 21/21 pass.
- `npm test` — 41/41 pass (cli-parser + cli-unit + cli-e2e).
- `bare-kit-pear init Smoke --dry-run` in a fresh tmpdir — prints
  15-file plan + package.json edits; no `ios-native/` created.
- `bare-kit-pear init Testapp --force` with a user-added Swift file
  — preserves the user file.
- `bare-kit-pear init Testapp --force --clean` with a user-added
  file — removes it (destructive path).
- `bare-kit-pear init Testapp` with a pre-existing conflicting
  `barekit:bundle` script — prints the WARN with existing + would-add
  values and leaves the script untouched.
- `bare-kit-pear doctor` in a drift-only state — exits 1.
- `bare-kit-pear doctor --fix` in that state — rewrites project.yml,
  exits 0, idempotent on rerun.
- `bare-kit-pear doctor` with missing frameworks — exits 2.

## Known limits / follow-ups (not in scope)

- `doctor --fix` only handles the "addons on disk but not in yml"
  case. The reverse ("yml references addon that isn't on disk") is
  always reported as fatal because the only correct remediation is
  `npx bare-kit-pear addons`, not a yml edit.
- Bundle diagnostics are pattern-based. A bare-pack release that
  reworks its error messages will need the rules bumped. The rules
  live in `DIAGNOSTIC_RULES` at the top of `bundle.js` for easy edit.
- The `scripts` command doesn't actually write to package.json; it
  just prints. That was the explicit brief — users copy by hand.
- Parser accepts `--flag -value` by treating `-value` as a flag (not
  a value). If bare-pack ever wanted a negative number as a string
  value, users need `--flag=-value` or `--flag=--something`.
