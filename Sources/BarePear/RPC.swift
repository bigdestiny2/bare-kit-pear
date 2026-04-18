//  RPC.swift
//
//  Length-prefixed JSON RPC actor. Generic over command / event IDs
//  (always Int on the wire — use `rawValue` from your own enums).
//
//  Wire format (must match backend/rpc.js, Kotlin counterpart):
//
//      [8-char ASCII-hex length][JSON payload]
//
//        Request  : { "id": <int>, "cmd": <int>, "data": <any> }
//        Response : { "id": <int>, "result": <any> }
//                 | { "id": <int>, "error":  <string> }
//        Event    : { "event": <int>, "data": <any> }
//
//  NB: `result` (not `ok`), `event` (not `evt`) — matches the canonical
//  bare-kit rpc.js _send() implementation.
//
//  Actor isolation serialises concurrent callers onto a single mailbox,
//  which preserves ordering across async request sites.

import Foundation

extension BarePear {
    public actor RPC {
        private let ipc: WorkletIPC
        private var nextId: Int = 1
        private var pending: [Int: CheckedContinuation<Any?, Error>] = [:]
        private var listeners: [Int: [@Sendable (Any?) -> Void]] = [:]
        private var buffer = Data()
        private var attached = false

        public init(ipc: WorkletIPC) {
            self.ipc = ipc
        }

        /// Start listening for worklet data. Call once after init (Host.start
        /// does this for you).
        public func attach() async {
            guard !attached else { return }
            attached = true
            await ipc.onData { [weak self] chunk in
                guard let self else { return }
                Task { await self.handleIncoming(chunk) }
            }
        }

        /// Close the IPC and cancel every pending request.
        public func close() async {
            for (_, cont) in pending {
                cont.resume(throwing: CancellationError())
            }
            pending.removeAll()
            listeners.removeAll()
            attached = false
            await ipc.close()
        }

        // MARK: - Requests

        /// Send a request and await a response.
        ///
        /// - Parameters:
        ///   - cmd: Integer command ID. Use `YourCmdEnum.something.rawValue`.
        ///   - data: JSON-encodable payload (Dictionary, Array, String, Int,
        ///           Double, Bool, or NSNull). Pass `nil` for no payload.
        ///   - timeoutMs: Time to wait for a response before throwing.
        /// - Returns: The `result` field of the response, type-erased.
        /// - Throws: `RPCError` if the backend returned `{error}`, or on
        ///           timeout / bad JSON.
        public func request(
            _ cmd: Int,
            data: Any? = nil,
            timeoutMs: Int = 30_000
        ) async throws -> Any? {
            let id = nextId
            nextId += 1

            let payload: [String: Any] = [
                "id": id,
                "cmd": cmd,
                "data": data as Any? ?? NSNull()
            ]
            let frame = try encodeFrame(payload)

            return try await withThrowingTaskGroup(of: AnyBox.self) { group in
                group.addTask { [weak self] in
                    let value: Any? = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any?, Error>) in
                        Task { [weak self] in
                            await self?.storePending(id: id, cont: cont)
                            await self?.sendBytes(frame)
                        }
                    }
                    return AnyBox(value)
                }
                group.addTask { [weak self] in
                    try await Task.sleep(nanoseconds: UInt64(timeoutMs) * 1_000_000)
                    let err = RPCError("RPC timeout after \(timeoutMs)ms (cmd=\(cmd))")
                    // Remove the orphaned continuation and resume-throw it, so a
                    // late-arriving response is a no-op instead of crashing on a
                    // leaked continuation slot.
                    await self?.failPending(id: id, error: err)
                    throw err
                }
                defer { group.cancelAll() }
                guard let first = try await group.next() else {
                    throw RPCError("RPC group empty")
                }
                return first.value
            }
        }

        /// Convenience: request + expect a `[String: Any]` result. Returns
        /// an empty dict if the backend returned non-dict or nil.
        public func requestDict(
            _ cmd: Int,
            data: Any? = nil,
            timeoutMs: Int = 30_000
        ) async throws -> [String: Any] {
            let result = try await request(cmd, data: data, timeoutMs: timeoutMs)
            return (result as? [String: Any]) ?? [:]
        }

        private func sendBytes(_ frame: Data) async {
            await ipc.write(frame)
        }

        private func storePending(id: Int, cont: CheckedContinuation<Any?, Error>) {
            pending[id] = cont
        }

        /// Remove the pending entry for `id` (if any) and resume-throw its
        /// continuation. Called from the timeout task so that a late response
        /// arriving after the timeout has no continuation to resume.
        ///
        /// Safe to call on an `id` that has already been resolved — it's a
        /// no-op in that case.
        private func failPending(id: Int, error: Error) {
            if let cont = pending.removeValue(forKey: id) {
                cont.resume(throwing: error)
            }
        }

        /// Test-only introspection: number of outstanding request continuations.
        /// Used by the TimeoutTests suite to verify no continuation leak
        /// remains after a timeout + late-response sequence.
        internal func pendingCount() -> Int {
            pending.count
        }

        // MARK: - Events

        /// Register a listener for a given event ID.
        ///
        /// - Returns: An unsubscribe closure. Call it to stop receiving the event.
        @discardableResult
        public func on(
            _ event: Int,
            listener: @escaping @Sendable (Any?) -> Void
        ) -> @Sendable () -> Void {
            listeners[event, default: []].append(listener)
            let index = (listeners[event]?.count ?? 1) - 1
            return { [weak self] in
                Task { await self?.removeListener(event: event, index: index) }
            }
        }

        private func removeListener(event: Int, index: Int) {
            guard var list = listeners[event], index < list.count else { return }
            list.remove(at: index)
            listeners[event] = list
        }

        // MARK: - Framing

        internal func encodeFrame(_ payload: [String: Any]) throws -> Data {
            let body = try JSONSerialization.data(
                withJSONObject: payload,
                options: [.fragmentsAllowed]
            )
            let hex = String(body.count, radix: 16).padLeft(to: 8, with: "0")
            var frame = Data()
            guard let hexBytes = hex.data(using: .ascii) else {
                throw RPCError("encodeFrame: hex not ASCII-encodable (impossible)")
            }
            frame.append(hexBytes)
            frame.append(body)
            return frame
        }

        private func handleIncoming(_ chunk: Data) {
            buffer.append(chunk)
            while buffer.count >= 8 {
                let lenBytes = buffer.prefix(8)
                guard let lenHex = String(data: lenBytes, encoding: .ascii),
                      let length = Int(lenHex, radix: 16) else {
                    NSLog("[BarePear.RPC] bad frame: length prefix not hex, resetting buffer")
                    buffer.removeAll()
                    return
                }
                guard length > 0, length <= 10_000_000 else {
                    NSLog("[BarePear.RPC] bad frame length \(length); resetting buffer")
                    buffer.removeAll()
                    return
                }
                guard buffer.count >= 8 + length else { return }
                let payload = buffer[8..<(8 + length)]
                buffer.removeSubrange(0..<(8 + length))
                handleMessage(Data(payload))
            }
        }

        private func handleMessage(_ payload: Data) {
            guard let json = try? JSONSerialization.jsonObject(
                with: payload,
                options: [.fragmentsAllowed]
            ) as? [String: Any] else {
                let preview = String(data: payload.prefix(200), encoding: .utf8) ?? "<binary>"
                NSLog("[BarePear.RPC] invalid JSON from worklet (\(payload.count) bytes): \(preview)")
                return
            }
            // Event first: { event: Int, data: Any? }
            if let evtId = json["event"] as? Int {
                let data = json["data"]
                listeners[evtId]?.forEach { $0(data) }
                return
            }
            // Response: { id, result } or { id, error }
            guard let id = json["id"] as? Int,
                  let cont = pending.removeValue(forKey: id) else { return }
            if let errorMsg = json["error"] as? String {
                cont.resume(throwing: RPCError(errorMsg))
            } else {
                cont.resume(returning: json["result"])
            }
        }
    }
}

// MARK: - Internal helpers

/// Wraps a type-erased `Any?` so it can cross the `TaskGroup` boundary
/// without triggering non-sendable diagnostics under strict concurrency.
/// Contents are produced by the actor's own framing layer, which only
/// ever hands us JSON-decoded values.
internal struct AnyBox: @unchecked Sendable {
    let value: Any?
    init(_ value: Any?) { self.value = value }
}

internal extension String {
    func padLeft(to width: Int, with pad: Character) -> String {
        if count >= width { return self }
        return String(repeating: pad, count: width - count) + self
    }
}
