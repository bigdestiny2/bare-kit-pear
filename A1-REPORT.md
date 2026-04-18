# A1 Report — BarePear Swift Source Hardening

Scope: correctness + strict-concurrency fixes for the 5 Swift sources in
`Sources/BarePear/` plus `Tests/BarePearTests/RPCTests.swift`. Nothing else
was touched. `swift package dump-package` still succeeds after the edits.

## Upstream BareKit signatures (revision `ef26bbd`)

Source: `~/Library/Developer/Xcode/DerivedData/Smoke-dageoauoidfwlgeilttdzuorzqki/SourcePackages/checkouts/bare-kit-swift/Sources/BareKit/`.

### `Worklet` (struct, value type)

```swift
public struct Worklet {
    public struct Configuration {
        // memoryLimit is UInt — NOT Int.
        public init(memoryLimit: UInt = 0, assets: String? = nil)
    }

    public init(configuration: Configuration = Configuration())

    public func start(filename: String, source: Data,   arguments: [String] = [])
    public func start(filename: String, source: String, encoding: String.Encoding, arguments: [String] = [])
    public func start(name: String, ofType type: String, arguments: [String] = [])
    public func start(name: String, ofType type: String, inBundle bundle: Bundle, arguments: [String] = [])
    public func start(name: String, ofType type: String, inDirectory subpath: String, arguments: [String] = [])
    public func start(name: String, ofType type: String, inDirectory subpath: String, inBundle bundle: Bundle, arguments: [String] = [])

    public func suspend(linger: Int32 = 0)
    public func resume()
    public func terminate()

    public func push(data: Data, queue: OperationQueue) async throws -> Data?
    public func push(data: Data)                        async throws -> Data?
    public func push(data: String, encoding: String.Encoding, queue: OperationQueue) async throws -> String?
    public func push(data: String, encoding: String.Encoding)                        async throws -> String?
}
```

### `IPC` (struct, AsyncSequence<Data>)

```swift
public struct IPC: AsyncSequence {
    public typealias Element = Data

    public init(worklet: Worklet)

    public func read()  async throws -> Data?
    public func write(data: Data) async throws   // <-- async throws
    public func close()

    public struct AsyncIterator: AsyncIteratorProtocol { /* ... */ }
    public func makeAsyncIterator() -> AsyncIterator
}
```

Neither `Worklet` nor `IPC` is annotated `Sendable`. They contain `let`
references to Obj-C classes (`BareWorklet`, `BareIPC`), so the compiler
will NOT infer Sendable for them under strict concurrency. Both call
sites (`Host.swift`, `BareKitAdapter.swift`) now use
`@preconcurrency import BareKit` to suppress those diagnostics until
upstream adds annotations.

## Changes

All line numbers refer to the final file state.

1. **`WorkletIPC.swift` — protocol methods made `async`; added `Sendable`
   conformance.** Needed so the production impl can be an actor. The
   protocol now reads:
   ```swift
   public protocol WorkletIPC: AnyObject, Sendable {
       func write(_ bytes: Data) async
       func onData(_ listener: @escaping @Sendable (Data) -> Void) async
       func close() async
   }
   ```
   Also marked `RPCError: Sendable`.

2. **`BareKitAdapter.swift` — converted `final class` → `actor`.** This is
   the core data-race fix. `listeners` was previously appended from
   `onData(_:)` on any thread and iterated from `@MainActor deliver(_:)`
   — an actual race under complete strict-concurrency. Now both paths
   are actor-isolated. Removed the separate `WriteSerializer` actor
   because the adapter's own actor isolation already serialises writes:
   `write(_:)` does `await ipc.write(data:)` directly.
   Added `@preconcurrency import BareKit`.

3. **`BareKitAdapter.attach(to:)` — read loop uses `Task` (inherits actor
   isolation) instead of `Task.detached`,** and binds the `ipc` value
   into the capture list explicitly (`[weak self, ipc]`) so each loop
   iteration reads from a captured local instead of re-entering the
   actor for `self.ipc`. The `deliver(_:)` method is now plain
   actor-isolated (no `@MainActor` hop), which removes the listener
   race entirely.

4. **`RPC.swift::attach()` — now `async`.** Because `WorkletIPC.onData`
   is async, `attach()` calls `await ipc.onData(...)`. Same for
   `close()`, which now calls `await ipc.close()`. The listener closure
   passed to `onData` is `@Sendable` and just schedules
   `Task { await self.handleIncoming(chunk) }` — actor hop is safe
   because `self` (the RPC actor) is Sendable.

5. **`RPC.swift::sendBytes(_:)` — now `async`,** wraps `await ipc.write(frame)`.

6. **`RPC.swift::close()` — resets `attached = false`.** Previous code
   set the flag once and never cleared it, so `close()`-then-`attach()`
   would be a no-op. Minor bug surfaced while touching the file.

7. **`RPC.swift::request(_:...)` — `TaskGroup` return type changed from
   `Any?` to `AnyBox`.** `Any?` is not Sendable, so under strict
   concurrency `try await group.next()` across the group boundary
   would error out. The new `internal struct AnyBox: @unchecked Sendable`
   carries the type-erased JSON result through the group; callers
   immediately unwrap `first.value` and return the `Any?`. This keeps
   the public `request(...) async throws -> Any?` signature stable.

8. **`RPC.swift::listeners` typed `[Int: [@Sendable (Any?) -> Void]]`.**
   Stored closures must be Sendable because they're appended from the
   actor and invoked from the actor; strict-concurrency-clean.

9. **`RPC.swift::on(_:listener:)` — listener now `@escaping @Sendable`,
   return closure explicitly `@Sendable () -> Void`.** Unsubscribe
   handle is captured by external code (UIs, template AppHost) and
   schedules a Task back into the actor, so it must be Sendable.

10. **`Host.swift::start()` — `Worklet.Configuration(memoryLimit: UInt(...))`.**
    Upstream signature takes `UInt`; we store `memoryLimit: Int` on
    `Host` for API ergonomics, so the conversion happens at the call
    site. Clamped with `max(0, memoryLimit)` to be defensive.

11. **`Host.swift::start()` — `await adapter.attach(to: ipc)`.** The
    adapter is an actor now, so `attach(to:)` requires await.

12. **`Host.swift::shutdown()` — also closes the adapter.** Previously
    only `rpc.close()` ran asynchronously; the adapter kept its read
    task alive and held the IPC reference. Now:
    ```swift
    Task {
        await rpc.close()
        await adapter.close()
    }
    ```
    The local re-binding (`let adapter = self.adapter; let rpc = self.rpc`)
    keeps the `Task` closure off `@MainActor self`, which avoids a
    capture warning.

13. **`Host.swift` — added `@preconcurrency import BareKit`.** Needed so
    passing `IPC` into `adapter.attach(to:)` (crossing into the adapter
    actor) doesn't trip strict-concurrency diagnostics on
    upstream-un-annotated types.

14. **`RPCTests.swift::MockIPC` — converted to `actor`.** Mirrors the
    adapter refactor. Test methods now `await` each IPC call; the
    `outgoing` buffer is read via a new `outgoingSnapshot()` helper
    (can't read `self.outgoing` across actor isolation from the test
    body). Listener storage is typed `[@Sendable (Data) -> Void]`.

15. **`RPCTests.swift::simulateIncoming(_:)` — parameter typed
    `[String: any Sendable]`** so the closures that carry it across
    actor hops type-check under strict concurrency.

16. **`RPCTests.swift::testUnsubscribeStopsDelivery` — replaces `var count`
    capture with an `actor Counter`.** The previous test captured a local
    `var count` in an `@Sendable` closure, which is a strict-concurrency
    error. Counting via an actor is race-free and Sendable-clean.

## API shape changes for downstream agents

- `BarePear.WorkletIPC` protocol methods are now `async` (`write`,
  `onData`, `close`). Any custom conforming type (e.g. alternative
  adapters in templates or tests) must update to match. Existing call
  sites inside BarePear (`RPC.attach`/`close`/`sendBytes`,
  `Host.start`/`shutdown`) have been updated.
- `BarePear.RPC.attach()` and `BarePear.RPC.close()` are now `async`.
  `Host.start()` already awaited `rpc.attach()`, and template
  `AppHost.boot()` already uses `await host.start()` — no surface
  change visible to template authors.
- `BarePear.RPC.on(_:listener:)` now requires `@Sendable` listeners and
  returns a `@Sendable () -> Void` unsubscribe handle. The template's
  `AppHost.swift` closures are already Sendable-compatible (weak `self`
  to an AnyObject, no mutable-local captures) — verified below.
- `BarePear.BareKitAdapter` is now an `actor` (was a `final class`).
  External code should not have been constructing this directly except
  via `BarePear.Host`; no public-API regression for typical consumers.

## Template `AppHost.swift` public-API check

Reviewed `templates/ios-native/__APP_NAME__/Sources/Bridge/AppHost.swift`
(read-only). Every call in it resolves against the new public surface:

| Template call                                                         | Resolves to                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `BarePear.Host(bundleResource:, bundleType:, storagePath:, memoryLimit:)` | `public init(bundleResource: String, bundleType: String = "bundle", storagePath: String, memoryLimit: Int = 64 * 1024 * 1024, extraArguments: [String] = [])` |
| `host.rpc`                                                            | `public let rpc: BarePear.RPC`                                 |
| `await host.rpc.on(Evt.ready.rawValue) { [weak self] payload in ... }` | `public func on(_:listener:) -> @Sendable () -> Void` with `@Sendable` listener; template closures are Sendable-safe |
| `try await host.start()`                                              | `public func start() async throws`                             |
| `host.shutdown()`                                                     | `public func shutdown()`                                       |

No public-API gap found. Template should compile once the other agents
finalise the `Evt` enum it references.

## Outstanding issues (outside my scope)

1. **Template `AppHost.swift` references an `Evt` enum** (`Evt.ready`,
   `Evt.peerCount`, `Evt.error`) that is not defined anywhere in
   `~/Desktop/bare-kit-pear/templates/` that I can see.
   The consuming app must supply this enum — consider shipping an
   example `Evt.swift` in the template or documenting the expected
   shape (`enum Evt: Int { case ready = 100; case peerCount = 101; case error = 102 }`)
   in the template's `BUILD.md`. Not my file to touch.

2. **`BareKit` upstream has no `Sendable` annotations** on `Worklet` or
   `IPC`. We've worked around this with `@preconcurrency import BareKit`.
   Upstream patch would be a cleaner long-term fix — consider filing
   `holepunchto/bare-kit-swift` an issue requesting Sendable conformance
   (both types have only a single Obj-C class reference as storage, so
   `@unchecked Sendable` would be correct).

3. **`XCTestExpectation` is pre-Swift-6 Sendable-friendly only via its
   NSObject lineage.** `testEventListenerReceivesPayload` captures an
   expectation in a `@Sendable` listener. On Xcode versions older than
   the iOS 18 SDK this will warn; on newer SDKs it's formally Sendable.
   Not worth a workaround but noted.

4. **Package.swift does not set `SWIFT_STRICT_CONCURRENCY`.** Under the
   default (`minimal` on 5.9, `targeted` on 5.10+), my fixes are
   mostly upgrades from warning-clean to error-clean. To actually
   exercise `complete`, add
   `swiftSettings: [.enableUpcomingFeature("StrictConcurrency")]` to
   the `.target`. Left unchanged because Package.swift is out of scope.

5. **`RPC.request` task-group timeout does not cancel the pending
   continuation slot.** If the sleep task wins, the pending entry in
   `self.pending[id]` stays there forever, leaking the continuation
   and causing the response (if it arrives late) to be silently
   dropped. A belt-and-braces fix would be to remove the entry on
   timeout and additionally resume-throw the orphan. This bug exists
   in the PearBrowser original too; leaving the behaviour unchanged
   since it is out of my ticket and may break other assumptions.

6. **`Host.shutdown()` fires a trailing `Task` to close rpc/adapter but
   returns immediately.** If the caller tears down the app right after,
   the Task may be cancelled before `ipc.close()` runs. Acceptable
   because the BareKit worklet has already been `terminate()`-d
   synchronously, but worth documenting. A true `async shutdown()`
   would be cleaner; held off on changing the signature to preserve
   public API.

## Files changed

- `~/Desktop/bare-kit-pear/Sources/BarePear/WorkletIPC.swift`
- `~/Desktop/bare-kit-pear/Sources/BarePear/RPC.swift`
- `~/Desktop/bare-kit-pear/Sources/BarePear/BareKitAdapter.swift`
- `~/Desktop/bare-kit-pear/Sources/BarePear/Host.swift`
- `~/Desktop/bare-kit-pear/Tests/BarePearTests/RPCTests.swift`

## Files not changed

- `~/Desktop/bare-kit-pear/Sources/BarePear/BarePear.swift`
  — namespace enum already correct.
