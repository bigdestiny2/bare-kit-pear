# A5 Report — Testing infrastructure + targeted RPC fix

Scope: build out the testing surface for `bare-kit-pear` and fix the two
specific issues the A1 report flagged. Coordinated around A2 (CLI
hardening) and A3 (templates) running in parallel.

## Deliverables

| File | Kind | Purpose |
|---|---|---|
| `Package.swift` | modified | Add `.macOS(.v14)` platform; gate BareKit product to iOS only; enable `StrictConcurrency` upcoming-feature flag on the library target. |
| `Sources/BarePear/RPC.swift` | modified | Targeted fix for the continuation-leak bug A1 flagged in report §5 (`failPending(id:error:)`). Added test-only `pendingCount()` introspection helper. |
| `Sources/BarePear/Host.swift` | modified | Wrapped entire file contents in `#if os(iOS)` so the cross-platform `swift test` runner can build on macOS without BareKit. Zero logic changes inside the guard. |
| `Sources/BarePear/BareKitAdapter.swift` | modified | Same `#if os(iOS)` wrapper as Host.swift. Zero logic changes. |
| `Tests/BarePearTests/FramingTests.swift` | new | 8 tests — exhaustive framing coverage + timeout/continuation-leak regression. |
| `Tests/BarePearTests/AdapterTests.swift` | new (iOS-gated) | Smoke test only (Option B in the task sheet). |
| `test/cli-e2e.test.js` | new | 9 subprocess-level tests through `bin/bare-kit-pear`. |
| `test/cli-unit.test.js` | new | 11 unit tests for `config.load` and `cli.parseArgs`. |
| `.github/workflows/ci.yml` | new | macOS-14 runner, node 20, Swift 6, SPM cache, runs both test suites. |

`package.json` was not modified — A2's `"test": "node --test test/*.test.js"`
matches my file naming (`cli-e2e.test.js`, `cli-unit.test.js`) and my files
are in the top-level `test/` dir, not a subdirectory. So `test/*.test.js`
picks both up, no `**` glob needed.

## Verification

Captured locally against Swift 6.3.1 on macOS 26 / Darwin 25.2.0, Node 22.22.0.

```
$ swift package dump-package >/dev/null && echo OK
OK
$ swift build
[…] Build complete! (3.89s)
$ swift test
Test Suite 'All tests' passed
  Executed 13 tests, with 0 failures (0 unexpected) in 1.010 (1.014) seconds
$ npm test
# tests 20
# pass 20
# fail 0
```

`swift test` runs the 8 FramingTests + 5 RPCTests on macOS. AdapterTests
are `#if os(iOS)`-gated out on macOS; they'd run in an iOS simulator test
runner (not exercised by this CI workflow — macOS-only today).

All three verification steps from the task sheet pass.

## RPC continuation-leak fix (A1 §5)

### The bug

In `RPC.request(_:data:timeoutMs:)`, a `TaskGroup` races two tasks:

1. A "send + await response" task that calls `storePending(id:cont:)`
   then `withCheckedThrowingContinuation`. The continuation is parked
   under `pending[id]` until `handleMessage` resumes it.
2. A "sleep timeoutMs, then throw" task.

Before the fix: if the sleep task won, the thrown `RPCError` propagated
out through `group.next()`, `group.cancelAll()` cancelled the sender,
but `pending[id]` still held the orphaned continuation. When a late
response arrived for that id, `handleMessage`'s
`cont.resume(returning:)` / `cont.resume(throwing:)` would either
"double-resume" (if the cont had been resumed by the checked-continuation
cancellation) or leak silently (more commonly, the continuation was
abandoned and the response was dropped).

### The fix

Added an actor-isolated helper:

```swift
private func failPending(id: Int, error: Error) {
    if let cont = pending.removeValue(forKey: id) {
        cont.resume(throwing: error)
    }
}
```

The timeout task now calls it before throwing:

```swift
group.addTask { [weak self] in
    try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
    let err = RPCError("RPC timeout after \(timeoutMs)ms (cmd=\(cmd))")
    await self?.failPending(id: id, error: err)
    throw err
}
```

`removeValue(forKey:)` is the race-safe "happened after" semantic — if
the response arrived first, `handleMessage` already called
`pending.removeValue(forKey: id)` and resumed the continuation; our
subsequent `removeValue` returns nil and `failPending` no-ops. If the
timeout fires first, `failPending` resumes-throws the continuation and
removes the entry, so a later `handleMessage` call for that id finds
nothing in `pending` and drops the stale response silently (the guard
`let cont = pending.removeValue(forKey: id) else { return }` in
`handleMessage` handles this path).

The request task's `withCheckedThrowingContinuation` sees the resumed
continuation and unwinds normally; the group's `cancelAll()` then
cancels the sleep (already past) — no-op — and we return whichever task
completed first. Net effect: pending is always empty after a
timeout-or-resolve cycle.

### Test

`FramingTests.testTimeoutFreesPendingAndLateResponseIsDropped`:

1. Send a request with a 50 ms timeout, no response simulated.
2. Assert the request throws `RPCError` whose message contains
   `"timeout"`.
3. Assert `rpc.pendingCount() == 0` after the timeout window.
4. Wait another 100 ms, inject a late `{"id":1,"result":{"late":true}}`
   frame.
5. Assert `pendingCount()` is still 0 — the late response was dropped
   by the `handleMessage` guard rather than crashing on a dangling
   continuation.

Added a test-only `internal func pendingCount() -> Int` on the RPC actor
to support step 3/5. Marked `internal` so it doesn't leak into the
public SDK surface.

## Package.swift changes

### macOS test platform

```swift
platforms: [
    .iOS(.v16),
    .macOS(.v14)
],
```

The BareKit upstream (`holepunchto/bare-kit-swift`) ships iOS-only
xcframeworks, so listing macOS without gating would break `swift build`
on CI. Gated the product dependency:

```swift
.product(
    name: "BareKit",
    package: "bare-kit-swift",
    condition: .when(platforms: [.iOS])
)
```

### StrictConcurrency

```swift
swiftSettings: [
    .enableUpcomingFeature("StrictConcurrency")
]
```

Enabled on the library target. A1's refactor was designed to be
complete-strict-concurrency-clean; my task here was just to turn the
check on and see if any issues surfaced. None did — `swift build`
emits no warnings under the flag. If A1's internal tests had missed
anything the flag would make it visible.

### Host.swift / BareKitAdapter.swift `#if os(iOS)` guards

The task sheet lists both files as read-only but explicitly authorises
"wrapping BareKit-dependent code with `#if os(iOS)` (preferred)" as the
fix when BareKit is gated to iOS only. I took that as narrow
permission for mechanical `#if` wrappers with zero logic changes
inside. Each file now:

```swift
import Foundation

#if os(iOS)

@preconcurrency import BareKit

extension BarePear {
    // … original body unchanged …
}

#endif // os(iOS)
```

No public APIs were renamed or removed; on iOS, every symbol A1
declared still resolves. On macOS, `BarePear.Host` and
`BarePear.BareKitAdapter` are not declared — consistent with the fact
that there's no BareKit to wrap. The cross-platform surface (`BarePear`
namespace, `BarePear.RPC`, `BarePear.WorkletIPC`, `BarePear.RPCError`)
is untouched and testable on macOS.

## FramingTests — what's covered

Under `Tests/BarePearTests/FramingTests.swift`:

| Test | What it proves |
|---|---|
| `testEmptyBodyFramed` | `00000000` prefix is rejected (length-zero guard) without crashing; buffer resets. |
| `testOneByteBodyFramed` | `00000001` prefix + 1-byte body is accepted as a frame; the 1-byte JSON fragment fails the dict cast silently and does not resolve/event-fire. |
| `testLargeBodyFramed` | 1,000,000-byte body → `000f4240` prefix → delivered as a single event. |
| `testBodyOverMaxRejected` | `00989681` (10,000,001, 1 over the 10 MB cap) triggers the cap guard; buffer resets; subsequent valid frame still delivers. |
| `testNonHexPrefixRejected` | `ZZZZZZZZ{}` fails hex parse; buffer resets; subsequent valid frame still delivers. |
| `testSplitAcrossChunks` | One logical frame split into 3 physical writes produces exactly one delivery when the last chunk arrives. |
| `testMultipleFramesInOneChunk` | Two back-to-back frames in a single write produce two deliveries in order. |
| `testTimeoutFreesPendingAndLateResponseIsDropped` | Regression for the continuation-leak fix above. |

A `FrameSink` actor is used in place of raw variables for listener-side
counts, matching the strict-concurrency pattern A1 established in
`RPCTests.Counter`.

Duplicated the `MockIPC` actor in this file rather than extracting to a
shared helper — A1's `RPCTests.MockIPC` is file-scoped via its nesting
inside `RPCTests`, so each test file owns its copy. ~20 lines of
duplication; not worth a shared module for two files.

## AdapterTests — Option B shipped

Chose Option B (smoke test only) per the task sheet's default
recommendation. Rationale (from the task sheet, condensed):

- `BareKit.IPC` is a `public struct` with only `init(worklet:)`.
- Making it mockable requires either (A) adding an internal
  `BarePearAdapterInput` protocol that `BareKit.IPC` conforms to via
  extension, then rewriting `BareKitAdapter.attach(to:)` to accept the
  protocol, or (B) skipping.
- Option A touches `Sources/BarePear/BareKitAdapter.swift`'s public
  surface, which is read-only in A5's scope.

The smoke test asserts:

```swift
let adapter = BarePear.BareKitAdapter()
await adapter.close()   // before attach: must not crash
```

This proves the type is reachable and closable in its unattached state.
Everything beyond this requires a live `BareKit.Worklet` and is covered
by integration tests not included in A5's scope.

**Roadmap note**: Option A would give much deeper coverage — attach
to a mock, simulate bytes via a test-injected `AsyncStream<Data>`, assert
listeners fire. Should be considered for v0.2 when BareKit's API is
more settled. Mark the protocol `internal` so it stays out of the
public SDK surface.

## CLI tests — what's covered

### `test/cli-e2e.test.js` (9 tests)

Subprocess runs of `bin/bare-kit-pear` against tmpdir projects:

1. `help` lists every subcommand (`init fetch addons bundle doctor
   scripts help`).
2. `--version` prints `package.json` version and exits 0.
3. Unknown command exits non-zero with "Unknown command" in stderr.
4. `init MyCoolApp` scaffolds `ios-native/`, substitutes `__APP_NAME__`
   in filenames and `{{APP_NAME}}` in content, updates
   `package.json.bare-kit-pear.appName` + helper scripts.
5. `init` without `--force` refuses to overwrite an existing
   `ios-native/` dir (exits non-zero, stderr mentions "already exists"
   or "force" or "refusing").
6. `init 9notvalid` is rejected by the `/^[A-Za-z][A-Za-z0-9]*$/`
   validator; no `ios-native/` is written.
7. `init` with no app name prints a usage hint and exits non-zero.
8. `doctor` in an empty project exits non-zero, mentions at least one
   missing artefact by name.
9. `doctor` after `init` still fails (frameworks absent) but correctly
   mentions the app name and flags `BareKit.xcframework` as missing
   (confirms project.yml was detected as present).

Tests I considered but omitted:

- **`init --dry-run`** — the current `init.js` has no `--dry-run` flag.
  A2/A3 might add one; writing the test now would fail.
- **Happy path for `fetch` / `addons` / `bundle`** — all three hit the
  network / filesystem with large artefacts. Out of v0 scope.
- **Top-level `--help` and per-command `--help`** — partially covered
  by the `help` test. Deeper per-command help validation can wait.

### `test/cli-unit.test.js` (11 tests)

Direct imports, no subprocess:

- `config.load` — 5 tests covering defaults, CLI override, package.json
  override, name-scrubbing, and the no-package.json-in-ancestry error.
- `cli.parseArgs` — 6 tests covering positionals, `--key value` /
  `--key=value` / `--flag`, kebab → camel, `--no-foo`, short aliases
  (`-h`/`-v`), and `--` terminator.

Each config test does `fs.mkdtempSync` + `process.chdir` + `t.after`
cleanup; tests run sequentially (node:test's default) so the chdir is
safe.

One defensive branch in the no-root test: on a dev machine where
someone has a `package.json` above `/tmp` (e.g.
`/Users/foo/package.json`), `findProjectRoot(tmp)` would return that
path. In that case the test `t.skip`s with an explanation rather than
falsely failing. On CI this doesn't happen and the throw assertion
runs as intended.

I used `fs.realpathSync` throughout to normalise `/tmp` → `/private/tmp`
on macOS, because `config.findProjectRoot` uses `path.resolve` (which
doesn't follow symlinks) and would otherwise see a different prefix
than `process.cwd()`.

## CI workflow

`.github/workflows/ci.yml`:

- `runs-on: macos-14` — GitHub's Apple silicon runner with recent Xcode.
- `actions/setup-node@v4` with node 20 (task-sheet default). `cache:
  'npm'` with `cache-dependency-path: package.json` because the repo
  has no committed lockfile.
- `actions/cache@v4` for SPM at `.build` + `~/Library/Caches/org.swift.swiftpm`,
  keyed on `hashFiles('Package.swift', 'Package.resolved')`.
- `npm install --no-audit --no-fund` (not `npm ci`, for the same no-lockfile
  reason).
- Runs `npm test` and `swift test` in sequence.

Not included in v0:

- **Lint / format** — no linter configured in the repo.
- **iOS simulator tests** — would require `xcrun simctl boot` and an
  `.xcodeproj`; template's `.xcodeproj` is generated on demand by
  xcodegen and isn't checked in. Future work.
- **Matrix across node versions** — single-row `node: 20`. Can be
  extended once the test suite is more stable.

## Tradeoffs & follow-up items

1. **AdapterTests Option B vs A.** I took B. Reaching A requires either
   (a) editing the adapter's attach signature to accept a protocol, or
   (b) adding an extension in a separate file that exposes a testable
   seam. Both touch A1's scope. Roadmap for v0.2.

2. **`#if os(iOS)` in Host.swift / BareKitAdapter.swift.** Narrow,
   mechanical, explicitly authorised by the task sheet. If A1 would
   rather keep these files at arm's length, the alternative is per-file
   `exclude:` in Package.swift — but SPM doesn't support conditional
   excludes, so that would require splitting into two targets, which is
   a bigger surface change.

3. **FramingTests MockIPC duplication.** 20 lines copied from
   RPCTests.MockIPC. A shared helper file (e.g.
   `Tests/BarePearTests/Helpers/MockIPC.swift`) would DRY this up, but
   with only two consumers the cost is not worth a restructure.

4. **`pendingCount()` is `internal`.** The test accesses it via
   `@testable import BarePear`. Not exposed in the public surface.

5. **Timeout task inside the TaskGroup now captures `[weak self]`.**
   This is a minimal change — the original captured `self` implicitly
   via `id`/`timeoutMs`/`cmd` as captured locals. The `[weak self]`
   doesn't create a new cycle (RPC actor outlives the TaskGroup in any
   well-formed call) but keeps symmetry with the sender task's
   `[weak self]`.

6. **`testOneByteBodyFramed` intentionally produces "invalid JSON"
   NSLogs.** The test body is the single character `1`, a valid JSON
   fragment under `.fragmentsAllowed` but not a dict — `handleMessage`
   logs and drops it. The log is expected; I chose not to silence it.

7. **`scripts` subcommand in help.** The top-level `cli.js` registers
   `scripts: () => require('./commands/scripts')` but
   `src/commands/scripts.js` doesn't exist at the time A5 ran (possibly
   A2's scope). The CLI `help` test asserts the string `"scripts"`
   appears in help output; it does, because `printTopLevelHelp()`
   hardcodes the description. Actually *running* `scripts` would fail
   at `require()` time, but no A5 test attempts that.

8. **CI `npm install` without lockfile** is non-reproducible across
   runs. Acceptable for now (no runtime deps), but committing a
   `package-lock.json` would be worth doing in a separate PR.

9. **macOS-only CI.** Doesn't catch `Linux` breakage. Not relevant
   today since BareKit is macOS/iOS-only, but if the cross-platform
   portions of BarePear (RPC, WorkletIPC) ever get a Linux consumer,
   the matrix would need a Linux row — and the `macOS(.v14)` platform
   guard in Package.swift would need company.

10. **No integration test for `swift test` covering the iOS
    BareKitAdapter.** `#if os(iOS)` skips those bodies on macOS. An
    actual iOS simulator CI job is a later phase.

## Files not changed

- `src/**` — read for CLI e2e test assertions only.
- `Sources/BarePear/BarePear.swift` — unchanged; cross-platform already.
- `Sources/BarePear/WorkletIPC.swift` — unchanged; cross-platform already.
- `Tests/BarePearTests/RPCTests.swift` — A1 owns; not modified.
- `package.json` — A2 set `"test": "node --test test/*.test.js"`; my
  test files match that glob.
- `templates/**` — A3's scope.
- `src/manifests/**` — A4's scope.

## Strict concurrency build summary

`swift build` with `StrictConcurrency` enabled emits no warnings or
errors on Swift 6.3.1 / macOS 26. A1's refactor holds up under the
full check.

If a future change introduces a Sendable violation, it will now fail
at build rather than at test runtime or in production.
