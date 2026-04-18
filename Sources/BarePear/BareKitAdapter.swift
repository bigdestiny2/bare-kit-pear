//  BareKitAdapter.swift
//
//  Bridges BareKit's IPC (an AsyncSequence<Data>) to BarePear.WorkletIPC.
//  Owns a background read task that fans incoming chunks out to every
//  registered listener, and serialises writes through the actor itself
//  so framed messages stay intact across concurrent RPC callers.

import Foundation

// A5: See Host.swift for the rationale — BareKit is iOS-only; we gate the
// adapter to iOS so `swift test` can run the cross-platform framing tests
// on the macOS CI runner without pulling BareKit in.
#if os(iOS)

@preconcurrency import BareKit

extension BarePear {
    /// Production implementation of `WorkletIPC` backed by bare-kit's `IPC`.
    ///
    /// Implemented as an `actor` so that `listeners` (mutated from
    /// `onData(_:)` and iterated when bytes arrive) is race-free under
    /// `SWIFT_STRICT_CONCURRENCY: complete`.
    public actor BareKitAdapter: WorkletIPC {
        private var listeners: [@Sendable (Data) -> Void] = []
        private var readTask: Task<Void, Never>?
        private var ipc: IPC?

        public init() {}

        /// Attach this adapter to a live BareKit IPC instance and start
        /// pumping incoming bytes to registered listeners.
        public func attach(to ipc: IPC) {
            self.ipc = ipc
            readTask?.cancel()
            readTask = Task { [weak self, ipc] in
                do {
                    for try await chunk in ipc {
                        guard let self else { return }
                        await self.deliver(chunk)
                        if Task.isCancelled { break }
                    }
                } catch {
                    NSLog("[BarePear.BareKitAdapter] read loop ended: \(error)")
                }
            }
        }

        private func deliver(_ data: Data) {
            for listener in listeners {
                listener(data)
            }
        }

        // MARK: - WorkletIPC

        public func write(_ bytes: Data) async {
            guard let ipc else { return }
            do {
                try await ipc.write(data: bytes)
            } catch {
                NSLog("[BarePear.BareKitAdapter] write failed: \(error)")
            }
        }

        public func onData(_ listener: @escaping @Sendable (Data) -> Void) async {
            listeners.append(listener)
        }

        public func close() async {
            listeners.removeAll()
            readTask?.cancel()
            readTask = nil
            ipc?.close()
            ipc = nil
        }
    }
}

#endif // os(iOS)
