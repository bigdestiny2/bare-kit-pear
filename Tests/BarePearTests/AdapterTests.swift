//  AdapterTests.swift
//
//  Thin cover for BareKitAdapter. Gated to iOS because the adapter's whole
//  raison d'être is bridging BareKit.IPC (an iOS-only upstream type) to
//  BarePear.WorkletIPC — on macOS there's no IPC to bridge.
//
//  See A5-REPORT.md for the Option A / Option B tradeoff on deeper
//  adapter coverage. Short version: BareKit.IPC is a `public struct` with
//  only `init(worklet:)`, so the only clean paths to unit-test it are:
//    (A) add a `BarePearAdapterInput` protocol BareKit.IPC conforms to,
//        letting the adapter be tested against a mock. Touches the SDK's
//        public surface / BareKitAdapter, both out of A5 scope.
//    (B) skip deep coverage, ship a smoke test proving the type is
//        constructible and closable.
//  We ship Option B here. The gap is tracked in A5-REPORT.

#if os(iOS)

import XCTest
@testable import BarePear

final class AdapterTests: XCTestCase {

    /// Proves `BareKitAdapter` is reachable, constructible on iOS, and
    /// that `close()` is safe to call without an attached IPC (the
    /// documented no-op shape). Everything beyond this requires a live
    /// BareKit.Worklet — exercised by integration tests, not this file.
    func testAdapterSmokeOnly() async {
        let adapter = BarePear.BareKitAdapter()
        // Close before any attach — must not crash; must leave the
        // adapter in a usable "I have nothing to do" state.
        await adapter.close()
    }
}

#endif // os(iOS)
