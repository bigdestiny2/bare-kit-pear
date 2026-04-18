//  WorkletIPC.swift
//
//  Abstraction over the bare-kit IPC stream. BarePear.RPC talks to this
//  protocol, letting us swap in a mock for unit tests of the framing /
//  dispatch layers without spawning a real worklet.

import Foundation

extension BarePear {
    /// The minimal IPC surface BarePear.RPC needs. BareKitAdapter provides
    /// the production implementation; tests can supply an in-memory mock.
    ///
    /// All methods are `async` because the production implementation is an
    /// actor (to make listener access thread-safe under strict concurrency).
    /// `AnyObject` is retained so the conforming type is a reference type —
    /// actors satisfy this constraint.
    public protocol WorkletIPC: AnyObject, Sendable {
        /// Write raw framed bytes to the worklet.
        func write(_ bytes: Data) async

        /// Register a listener for incoming bytes from the worklet. Can be
        /// called multiple times; every listener receives every chunk.
        /// The listener is invoked on the implementation's actor — it must
        /// be `@Sendable` and marshal onto the expected queue itself.
        func onData(_ listener: @escaping @Sendable (Data) -> Void) async

        /// Tear down the IPC stream. Idempotent.
        func close() async
    }

    /// An error surfaced from the worklet side of the RPC bridge, or from
    /// the framing/dispatch layer (timeouts, bad frames, etc.).
    public struct RPCError: LocalizedError, Sendable {
        public let message: String
        public var errorDescription: String? { message }
        public init(_ message: String) {
            self.message = message
        }
    }
}
