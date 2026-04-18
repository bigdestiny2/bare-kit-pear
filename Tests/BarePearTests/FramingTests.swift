//  FramingTests.swift
//
//  Exhaustive coverage of BarePear.RPC's 8-char ASCII-hex length framing
//  layer. Exercises the encode side via `encodeFrame(_:)` and the decode
//  side via `handleIncoming(_:)` routed through a MockIPC so we can assert
//  both happy-path delivery and defensive resets without spawning a real
//  BareKit worklet.
//
//  These tests also exercise the TimeoutTests scenario: when a request
//  times out, the pending continuation slot is freed and a subsequent
//  late response is silently dropped (previously leaked; see RPC.swift
//  `failPending(id:error:)` and A5-REPORT).

import XCTest
@testable import BarePear

final class FramingTests: XCTestCase {

    // MARK: - MockIPC (framing-test-local)
    //
    // Kept separate from RPCTests.MockIPC because XCTest test-case types
    // are not module-shared (they're file-scoped nested types). Copying
    // the shape is cheaper than refactoring a shared helper, and it keeps
    // each test file independently compilable.
    actor MockIPC: BarePear.WorkletIPC {
        private(set) var outgoing = Data()
        private var listeners: [@Sendable (Data) -> Void] = []

        func write(_ bytes: Data) async { outgoing.append(bytes) }
        func onData(_ listener: @escaping @Sendable (Data) -> Void) async { listeners.append(listener) }
        func close() async { listeners.removeAll() }

        func outgoingSnapshot() -> Data { outgoing }

        /// Deliver raw bytes (already length-prefixed) to listeners.
        func deliverFrame(_ frame: Data) {
            for listener in listeners { listener(frame) }
        }

        /// Deliver arbitrary raw bytes (possibly a partial frame) — used
        /// by the split-across-chunks and junk-prefix tests.
        func deliverRaw(_ bytes: Data) {
            for listener in listeners { listener(bytes) }
        }
    }

    // MARK: - Helpers

    /// Build a length-prefixed frame from a UTF-8 body string. Used to
    /// hand-craft test frames without going through RPC's encoder.
    static func frameString(_ body: String) -> Data {
        let bodyData = body.data(using: .utf8)!
        let hex = String(format: "%08x", bodyData.count)
        var frame = Data()
        frame.append(hex.data(using: .ascii)!)
        frame.append(bodyData)
        return frame
    }

    static func frameJSON(_ json: [String: Any]) throws -> Data {
        let body = try JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed])
        let hex = String(format: "%08x", body.count)
        var frame = Data()
        frame.append(hex.data(using: .ascii)!)
        frame.append(body)
        return frame
    }

    // MARK: - Encode side

    func testEmptyBodyFramed() async throws {
        // We can't call RPC.encodeFrame directly because `request(...)`
        // always includes id/cmd/data keys, i.e. body is never empty. So
        // instead we exercise the hand-built frame path and confirm a
        // zero-length frame is representable and round-trips via the
        // decoder without tripping the "length == 0" reject path.
        //
        // Note: handleIncoming rejects length == 0 (see "guard length > 0"
        // in RPC.swift). We assert that behaviour here: a `00000000` frame
        // resets the buffer (defensive) and does NOT deliver.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let zeroFrame = Data("00000000".utf8)
        await ipc.deliverRaw(zeroFrame)

        // Give the incoming task time to process.
        try await Task.sleep(nanoseconds: 30_000_000)

        // No crash, no listeners fired. Buffer was reset — we can confirm
        // by sending a valid frame afterwards and making sure it delivers.
        let sink = FrameSink()
        await rpc.on(42) { payload in
            Task { await sink.record(payload) }
        }
        let validFrame = try Self.frameJSON(["event": 42, "data": "after-reset"])
        await ipc.deliverFrame(validFrame)
        try await Task.sleep(nanoseconds: 30_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first as? String, "after-reset")
    }

    func testOneByteBodyFramed() async throws {
        // A body of exactly 1 byte → prefix "00000001".
        // Since RPC rejects non-JSON-object messages in handleMessage,
        // a single-byte fragment like "1" (which IS a valid JSON fragment
        // via .fragmentsAllowed, but not a dict) will be silently dropped
        // — no event, no response resolution, but no crash either.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let oneByteFrame = Self.frameString("1")
        XCTAssertEqual(oneByteFrame.count, 9, "8-char prefix + 1-byte body")
        let prefix = String(data: oneByteFrame.prefix(8), encoding: .ascii)
        XCTAssertEqual(prefix, "00000001")

        await ipc.deliverRaw(oneByteFrame)
        try await Task.sleep(nanoseconds: 30_000_000)
        // No assertion on listeners — the point is no crash.
    }

    func testLargeBodyFramed() async throws {
        // A 1,000,000-byte JSON body → prefix "000f4240" (decimal 1,000,000).
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        // Build a JSON body that's exactly 1,000,000 bytes. Let the
        // padding field absorb the difference.
        let targetBody = 1_000_000
        // `{"event":1,"data":"<padding>"}` with minimal keys: overhead is
        // 21 bytes. So padding = targetBody - 21.
        let overhead = 21
        let paddingLen = targetBody - overhead
        let padding = String(repeating: "x", count: paddingLen)
        let body = "{\"event\":1,\"data\":\"\(padding)\"}"
        XCTAssertEqual(body.utf8.count, targetBody)

        let hex = String(format: "%08x", targetBody)
        XCTAssertEqual(hex, "000f4240", "1,000,000-byte prefix in 8-char hex")

        let sink = FrameSink()
        await rpc.on(1) { payload in
            Task { await sink.record(payload) }
        }

        var frame = Data()
        frame.append(hex.data(using: .ascii)!)
        frame.append(body.data(using: .utf8)!)
        await ipc.deliverRaw(frame)
        try await Task.sleep(nanoseconds: 100_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 1, "large body should deliver once")
        XCTAssertEqual((received.first as? String)?.count, paddingLen)
    }

    func testBodyOverMaxRejected() async throws {
        // Length prefix `00989681` is hex for 10,000,001 — one byte over
        // the 10 MB cap in handleIncoming. We inject the prefix only (no
        // body bytes) — the length check fires on the prefix alone and
        // resets the buffer before any body read.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let overMaxPrefix = Data("00989681".utf8)
        await ipc.deliverRaw(overMaxPrefix)
        try await Task.sleep(nanoseconds: 30_000_000)

        // Buffer should be reset — verify by sending a good frame and
        // asserting delivery.
        let sink = FrameSink()
        await rpc.on(99) { payload in
            Task { await sink.record(payload) }
        }
        let okFrame = try Self.frameJSON(["event": 99, "data": "post-cap-reset"])
        await ipc.deliverFrame(okFrame)
        try await Task.sleep(nanoseconds: 30_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first as? String, "post-cap-reset")
    }

    func testNonHexPrefixRejected() async throws {
        // `ZZZZZZZZ{}` — 8 non-hex bytes followed by a minimal JSON body.
        // The hex parse in handleIncoming fails, buffer is reset.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let junkFrame = Data("ZZZZZZZZ{}".utf8)
        await ipc.deliverRaw(junkFrame)
        try await Task.sleep(nanoseconds: 30_000_000)

        // Confirm buffer was reset by sending a good frame.
        let sink = FrameSink()
        await rpc.on(7) { payload in
            Task { await sink.record(payload) }
        }
        let okFrame = try Self.frameJSON(["event": 7, "data": "after-junk"])
        await ipc.deliverFrame(okFrame)
        try await Task.sleep(nanoseconds: 30_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 1)
        XCTAssertEqual(received.first as? String, "after-junk")
    }

    func testSplitAcrossChunks() async throws {
        // One logical frame arriving as three separate writes. The decode
        // loop should buffer bytes, wait until the full length is
        // available, and deliver exactly once.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let sink = FrameSink()
        await rpc.on(55) { payload in
            Task { await sink.record(payload) }
        }

        let fullFrame = try Self.frameJSON(["event": 55, "data": "hello-split"])
        XCTAssertGreaterThan(fullFrame.count, 8)

        // Split into chunks: 4 bytes of prefix, 4 more bytes (rest of
        // prefix + first body byte), then the rest.
        let chunk1 = fullFrame.prefix(4)
        let chunk2 = fullFrame[4..<9]
        let chunk3 = fullFrame[9..<fullFrame.count]

        await ipc.deliverRaw(Data(chunk1))
        try await Task.sleep(nanoseconds: 20_000_000)
        var mid = await sink.values
        XCTAssertEqual(mid.count, 0, "no delivery after partial prefix")

        await ipc.deliverRaw(Data(chunk2))
        try await Task.sleep(nanoseconds: 20_000_000)
        mid = await sink.values
        XCTAssertEqual(mid.count, 0, "no delivery with only 1 body byte")

        await ipc.deliverRaw(Data(chunk3))
        try await Task.sleep(nanoseconds: 50_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 1, "exactly one delivery after all chunks arrive")
        XCTAssertEqual(received.first as? String, "hello-split")
    }

    func testMultipleFramesInOneChunk() async throws {
        // Two frames concatenated in a single write. Both should fire, in
        // order, on the same listener.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        let sink = FrameSink()
        await rpc.on(101) { payload in
            Task { await sink.record(payload) }
        }

        let f1 = try Self.frameJSON(["event": 101, "data": "first"])
        let f2 = try Self.frameJSON(["event": 101, "data": "second"])
        var combined = Data()
        combined.append(f1)
        combined.append(f2)

        await ipc.deliverRaw(combined)
        try await Task.sleep(nanoseconds: 80_000_000)

        let received = await sink.values
        XCTAssertEqual(received.count, 2, "both frames should deliver")
        XCTAssertEqual(received.first as? String, "first")
        XCTAssertEqual(received.last as? String, "second")
    }

    // MARK: - Timeout / continuation leak (A1 report item 5)

    func testTimeoutFreesPendingAndLateResponseIsDropped() async throws {
        // Regression test for A1 report §5: a request that times out MUST
        // remove its entry from `pending`, so a late-arriving response is
        // silently dropped rather than crashing on a double-resume of an
        // already-awaiting continuation.
        let ipc = MockIPC()
        let rpc = BarePear.RPC(ipc: ipc)
        await rpc.attach()

        // Fire a request with a short timeout; do NOT simulate any response.
        let task = Task<Error?, Never> {
            do {
                _ = try await rpc.request(1, data: NSNull(), timeoutMs: 50)
                return nil
            } catch {
                return error
            }
        }

        let caught = await task.value
        guard let err = caught as? BarePear.RPCError else {
            XCTFail("Expected RPCError, got \(String(describing: caught))")
            return
        }
        XCTAssertTrue(err.message.contains("timeout"), "error message should mention timeout; got: \(err.message)")

        // After the timeout fires, pending should be empty.
        // Small wait to let `failPending` complete — the timeout task's
        // `await self?.failPending` happens just before it throws.
        try await Task.sleep(nanoseconds: 30_000_000)
        var count = await rpc.pendingCount()
        XCTAssertEqual(count, 0, "pending continuation slot should be freed after timeout")

        // Wait longer and simulate the late response for id=1 anyway.
        // With the fix, the pending map has no entry for id=1, so the
        // response is silently dropped. Without the fix, the continuation
        // would still be parked and double-resume would crash — or the
        // response would try to `cont.resume` on a captured already-resumed
        // continuation, which is a runtime fatal.
        try await Task.sleep(nanoseconds: 100_000_000)
        let lateFrame = try Self.frameJSON(["id": 1, "result": ["late": true]])
        await ipc.deliverFrame(lateFrame)
        try await Task.sleep(nanoseconds: 50_000_000)

        count = await rpc.pendingCount()
        XCTAssertEqual(count, 0, "late response should not repopulate pending")
    }
}

// MARK: - Sink actor for frame-delivery assertions

/// Actor-isolated collector for payloads delivered to an event listener.
/// Using an actor keeps the `@Sendable` listener closure race-free under
/// strict concurrency without needing locks or XCTestExpectation fences.
actor FrameSink {
    private(set) var values: [Any?] = []
    func record(_ value: Any?) { values.append(value) }
}
