//  RPCTests.swift
//
//  Framing + dispatch tests for BarePear.RPC, using an in-memory
//  WorkletIPC mock. Doesn't exercise the BareKit adapter; those require
//  a live worklet and run in integration tests.

import XCTest
@testable import BarePear

final class RPCTests: XCTestCase {
    // MARK: - Helpers

    /// Encode a `[String: Any]` payload into our length-prefixed JSON
    /// frame. Built in the test body (non-actor) so callers can freely
    /// use `NSNull()`, mixed-type dicts, etc. without worrying about
    /// Sendable conformance.
    static func frame(_ json: [String: Any]) throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed])
        let hex = String(format: "%08x", body.count)
        var frame = Data()
        frame.append(hex.data(using: .ascii)!)
        frame.append(body)
        return frame
    }

    // MARK: - MockIPC

    /// An actor — matches the WorkletIPC contract: all methods async,
    /// listener storage is actor-isolated, no data races even when the
    /// test drives it from multiple tasks.
    actor MockIPC: BarePear.WorkletIPC {
        private(set) var outgoing = Data()
        private var listeners: [@Sendable (Data) -> Void] = []

        func write(_ bytes: Data) async { outgoing.append(bytes) }
        func onData(_ listener: @escaping @Sendable (Data) -> Void) async { listeners.append(listener) }
        func close() async { listeners.removeAll() }

        /// Read the accumulated outgoing bytes (actor-isolated snapshot).
        func outgoingSnapshot() -> Data { outgoing }

        /// Deliver a raw frame (already length-prefixed) to every registered
        /// listener, as if it had arrived from the worklet.
        func deliverFrame(_ frame: Data) {
            for listener in listeners { listener(frame) }
        }
    }

    // MARK: - Framing

    func testEncodeFrameProducesHexPrefix() async throws {
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        Task {
            try? await rpc.request(42, data: ["hello": "world"])
        }
        // Give the send a moment
        try await Task.sleep(nanoseconds: 50_000_000)

        let outgoing = await ipc.outgoingSnapshot()
        XCTAssertGreaterThan(outgoing.count, 8, "Should have at least a hex prefix + body")
        let hex = String(data: outgoing.prefix(8), encoding: .ascii) ?? ""
        XCTAssertEqual(hex.count, 8)
        XCTAssertNotNil(Int(hex, radix: 16))
    }

    // MARK: - Request / response

    func testRequestResolvesOnMatchingId() async throws {
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let task = Task { try await rpc.request(1) }
        try await Task.sleep(nanoseconds: 20_000_000)

        await ipc.deliverFrame(try Self.frame(["id": 1, "result": ["ok": true]]))
        let result = try await task.value
        let dict = result as? [String: Any]
        XCTAssertEqual(dict?["ok"] as? Bool, true)
    }

    func testRequestThrowsOnErrorResponse() async throws {
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let task = Task { try await rpc.request(1) }
        try await Task.sleep(nanoseconds: 20_000_000)

        await ipc.deliverFrame(try Self.frame(["id": 1, "error": "boom"]))
        do {
            _ = try await task.value
            XCTFail("Should have thrown")
        } catch let err as BarePear.RPCError {
            XCTAssertEqual(err.message, "boom")
        }
    }

    // MARK: - Events

    func testEventListenerReceivesPayload() async throws {
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let expectation = XCTestExpectation(description: "event fires")
        await rpc.on(100) { payload in
            if let dict = payload as? [String: Any], dict["stage"] as? String == "ready" {
                expectation.fulfill()
            }
        }

        await ipc.deliverFrame(try Self.frame(["event": 100, "data": ["stage": "ready"]]))
        await fulfillment(of: [expectation], timeout: 1.0)
    }

    func testUnsubscribeStopsDelivery() async throws {
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        // Count deliveries on an actor so the @Sendable listener closure
        // stays race-free under strict concurrency.
        let counter = Counter()
        let unsubscribe = await rpc.on(200) { _ in
            Task { await counter.increment() }
        }

        let frame200 = try Self.frame(["event": 200, "data": NSNull()])
        await ipc.deliverFrame(frame200)
        try await Task.sleep(nanoseconds: 30_000_000)

        unsubscribe()
        // Give the unsubscribe Task time to apply before the next emission.
        try await Task.sleep(nanoseconds: 30_000_000)

        await ipc.deliverFrame(frame200)
        try await Task.sleep(nanoseconds: 30_000_000)

        let count = await counter.value
        XCTAssertEqual(count, 1, "listener should only fire before unsubscribe")
    }

    /// Simple actor wrapper for race-free integer counting in tests.
    actor Counter {
        private(set) var value: Int = 0
        func increment() { value += 1 }
    }
}
