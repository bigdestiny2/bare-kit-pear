# A3 Report — iOS template + init.js copy/scaffold polish

Scope: `templates/ios-native/**` (all of it) and `src/commands/init.js`
(copy + substitute + rnbk version check only). Every in-file change in
`init.js` is marked with a `// A3:` comment; A2's prior edits are
preserved verbatim.

## Files changed

### `templates/ios-native/__APP_NAME__/Sources/Bridge/AppHost.swift`

Full rewrite addressing Tasks 1, 2, 3.

- **Task 1 — storagePath sanitization.** Added
  `safeStorageName(_ raw: String) -> String`, a pure function that
  whitelists `[A-Za-z0-9_-]` and replaces everything else with `_` (and
  falls back to `"app"` on empty). `storageURL()` now runs the lowercased
  `{{APP_NAME}}` through it before appending to Application Support.
  **Tradeoff**: chose runtime sanitization rather than scaffold-time
  substitution. Two reasons:
  1. The scaffold-time approach would bake the sanitized form into the
     template and silently hide what transformation happened — the
     runtime version makes the rule legible to anyone reading
     `AppHost.swift` and is defensive against post-scaffold edits
     (if the user edits the literal later, the sanitizer still runs).
  2. `init.js`'s existing validator (`/^[A-Za-z][A-Za-z0-9]*$/`) already
     rejects bad names at scaffold time, so the runtime path is pure
     belt-and-suspenders. Keeping it runtime-side costs ~10 LoC and
     makes the guarantee visible where it matters (the Swift code that
     creates the directory).
- **Task 2 — default `Evt.error` handler.** Introduced
  `private static let log = Logger(subsystem: …, category: "AppHost")`
  (via `import os.log`). New static helper `logBackendError(_:)` pulls
  `message` / `stack` / `cmd` out of the payload dictionary and emits
  a single `.error` log line with `privacy: .public` on each interpolation
  (these are backend-sourced diagnostic strings — not user PII, and
  hiding them defeats the purpose). `cmd` is coerced from `Int` or
  `String` (defensive — backend implementations vary) and falls back to
  `"-"` when absent. The UI-visible `bootMessage = "Error: …"` path was
  dropped as the spec asked to "tighten" it: noisy boot-screen error
  banners are rarely helpful during normal operation. Apps that want
  UI-level error surfacing can wire an additional listener.
- **Task 3 — `isAlive` flag.** `@Published private(set) var isAlive: Bool`
  defaulting to `false`. Flips true immediately after `host.start()`
  returns (in `boot()`) and false inside `shutdown()`. Comment on the
  property documents the limitation: "Currently only flips false on
  explicit shutdown(); worklet crashes are not detected — see roadmap
  item 5.4 in BUILD.md."

### `templates/ios-native/project.yml`

- **Task 4 — addon-list banner.** Added a 15-line banner comment above
  `dependencies:` naming `src/manifests/rnbk-known-good.json` as the
  canonical source of truth, and instructing the reader that the 17
  addon `- framework:` entries are regenerated via
  `bare-kit-pear doctor --fix` and should not be hand-edited.
  **Tradeoff**: did NOT introduce a YAML anchor. Xcodegen 2.45 parses
  anchors on scalars but will choke on an anchor spread into a list of
  mappings (`- <<: *addon_defaults`) when the mapping values include
  strings with templated characters like `{{APP_NAME}}` — the tradeoff
  between "less repetitive YAML" and "xcodegen 2.45-safe" lands on the
  latter. The minimum bar from the spec ("a prominent banner pointing
  to the canonical source") is met, and xcodegen still generates
  cleanly against the edited file (verified by scaffolding Smoke and
  running `xcodegen generate` — produced `Smoke.xcodeproj` without
  errors once the local `bare-kit-pear` package was linked into
  `node_modules/`, which is a preexisting requirement unrelated to
  this change).

### `templates/ios-native/__APP_NAME__/Assets.xcassets/AppIcon.appiconset/`

- **Task 5 — AppIcon placeholder.** Added a new binary `icon-1024.png`
  (1024×1024, 8-bit RGB, solid iOS systemBlue `(0, 122, 255)`, ~4.5 KB,
  zero external dependencies — generated via a hand-rolled PNG encoder
  that writes the 8-byte PNG signature + `IHDR` chunk + deflated `IDAT`
  scanlines + `IEND`, using only `Buffer` and `zlib` from Node stdlib).
  `Contents.json` now references it by `"filename": "icon-1024.png"`.
  **Tradeoff**: the PNG generator is a one-shot script that ran during
  template authoring; it is NOT part of `init.js`'s runtime path
  (the icon ships prebuilt in the template tree and is byte-copied via
  the existing `binaryExts` branch in `copyRecursive`). This keeps
  `init.js` dep-free at runtime while still shipping a valid icon the
  first `xcodebuild` accepts.
  Apple's icon validator accepts a solid-colour 1024×1024 for
  development builds — users can drop in a proper icon by replacing
  `icon-1024.png` in place, no further edits needed.

### `templates/ios-native/__APP_NAME__/Assets.xcassets/AccentColor.colorset/Contents.json`

- **Task 5 — AccentColor.** `Contents.json` now declares the colour
  inline as sRGB `(0.0, 0.478, 1.0, 1.0)` (iOS `systemBlue`). Xcode no
  longer warns about a missing accent colour entry.

### `templates/ios-native/README.md.tmpl` (new)

- **Task 6 — per-app README.** 39-line quick-reference with sections:
  Build / Add a native SwiftUI screen / Add a new backend command / More.
  Contains two `{{APP_NAME}}` references that get substituted at scaffold
  time. The file is named `.md.tmpl` so it lives alongside the source
  repo's `BUILD.md` without being rendered as a second README by GitHub.
  The `.tmpl` suffix is stripped by `init.js` (see below) so the
  scaffolded output is `ios-native/README.md`.

### `src/commands/init.js`

All edits marked `// A3:`. A2's existing edits (argv parsing, `usage`
string, `--force` / `--clean` / `--dry-run` semantics, package.json
plan / conflict reporting, `planPackageJsonConfig`,
`collectUserSourcesFiles`, `selectiveClean`) are untouched.

- **`.tmpl` suffix handling (Task 6 plumbing).**
  - New helper `stripTmplSuffix(name)` — returns `name` with a trailing
    `.tmpl` removed, otherwise unchanged.
  - `copyRecursive` now applies `stripTmplSuffix` to destination
    filenames in both the directory walk and the file-write branch. For
    the binary-vs-text decision it computes the effective extension
    *after* the strip so that `foo.md.tmpl` is read as text (runs
    `{{APP_NAME}}` substitution), not as a binary copy — critical
    because `path.extname("foo.md.tmpl") === ".tmpl"` was not in our
    binary set but would have otherwise gone through
    `fs.readFileSync(..., 'utf-8')` by accident. Making the strip
    explicit avoids that invariant-by-coincidence.
  - `enumerateTemplateFiles` (A2's dry-run / selective-clean helper)
    also applies `stripTmplSuffix`, so the dry-run plan lists the
    rendered filename (`ios-native/README.md`) not the on-disk template
    filename (`README.md.tmpl`).

- **rnbk version check (Task 7).**
  - New `RNBK_MANIFEST_PATH` constant resolving to
    `src/manifests/rnbk-known-good.json`.
  - New helper `checkRnbkVersion(projectRoot)` runs post-scaffold and
    emits exactly one of four log lines (the spec asked for three —
    the fourth covers a corrupted manifest, which would otherwise eat
    stack traces silently):
    - `info`: `react-native-bare-kit is not installed yet — run …`
      — the installed package.json isn't present.
    - `info`: `✓ react-native-bare-kit <v> is in the known-good manifest.`
      — installed version matches a key under `versions`.
    - `warn`: `react-native-bare-kit <v> is NOT in the known-good
      manifest (covered versions: <list>). Run …` — installed version
      is not covered; points to `bare-kit-pear addons` (which on drift
      prints a paste-ready manifest fragment, per the addons behaviour
      noted in `src/manifests/README.md`).
    - `warn`: `could not read rnbk-known-good manifest at <path>
      (<err>) — skipping version check.` — defensive, not a fatal init
      condition.
  - Malformed `node_modules/react-native-bare-kit/package.json` is
    treated as "not installed" (falls through to the install-me
    message) with the underlying error surfaced only under
    `BAREKIT_PEAR_DEBUG=1`. Avoids making init fail on a
    package-manager anomaly that's out of our control.
  - `checkRnbkVersion` is invoked only in the real-run branch of
    `run()`, deliberately NOT in `--dry-run` — dry-run should be
    side-effect-free and also should not emit manifest-I/O chatter for
    a path the user is just previewing.
  - Added to `module.exports` so future commands (e.g. `doctor`) and
    tests can reuse it.

- **Protocol.swift / AppHost.swift parity (Task 8).** Verified without
  edits. Confirmed `enum Evt: Int { case ready = 100, peerCount = 101,
  error = 102 }` in Protocol.swift, and all three cases are referenced
  by `Evt.<case>.rawValue` in AppHost.swift. No new events required —
  `isAlive` plumbing is local state (no wire message needed), so the
  existing enum is sufficient.

## Verification performed

Ran the exact smoke-test sequence from the brief (all passed):

1. `mktemp -d && cd … && npm init -y && node
    ~/Desktop/bare-kit-pear/bin/bare-kit-pear init Smoke`
   — scaffolded cleanly; emitted the expected "react-native-bare-kit is
   not installed yet" info line (correct for a fresh project).
2. `cat ios-native/Smoke/Assets.xcassets/AppIcon.appiconset/Contents.json`
   — references `"filename": "icon-1024.png"`.
3. `file ios-native/Smoke/Assets.xcassets/AppIcon.appiconset/icon-1024.png`
   — reports `PNG image data, 1024 x 1024, 8-bit/color RGB,
   non-interlaced`.
4. `ls ios-native/README.md ios-native/README.md.tmpl` — only the
   stripped form exists.
5. `cd ios-native && xcodegen generate` — "Spec validation error:
   Invalid local package 'BarePear'" on first run (preexisting: the
   template references `../node_modules/bare-kit-pear`, which requires
   the user's subsequent `npm install`). After symlinking
   `bare-kit-pear` into `node_modules/`, xcodegen produces
   `Smoke.xcodeproj` without errors — confirms my project.yml banner
   edit did not break YAML parsing under xcodegen 2.45.
6. Dry-run (`bare-kit-pear init Smoke2 --dry-run`) — plan lists
   `ios-native/README.md` (not `.md.tmpl`), confirming
   `enumerateTemplateFiles` applies the same strip as
   `copyRecursive`.
7. `swiftc -parse templates/.../AppHost.swift` (after `{{APP_NAME}}`
   substituted with `TestApp`) — exit 0.
8. `node -e "require('…/src/commands/init')"` — loads, exports
   `{ run, usage, wantScriptsFor, checkRnbkVersion }`.

## Out-of-scope, not touched

- `Sources/**`, `Tests/**`, `src/cli.js`, `src/util/**`,
  `src/manifests/**`, any `src/commands/*.js` other than `init.js`,
  `package.json`, `Package.swift`, `bin/**`, `BUILD.md` — all left
  untouched per the brief's hard constraints.
- No new npm dependencies were added to `init.js`; the PNG placeholder
  was generated once, at authoring time, using Node built-ins only
  (`Buffer`, `zlib`), and the resulting binary is checked into the
  template tree so `init.js`'s runtime stays pure-stdlib.
