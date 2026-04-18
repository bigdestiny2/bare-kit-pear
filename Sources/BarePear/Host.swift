//  Host.swift
//
//  One-call worklet lifecycle: construct with a bundle resource + storage
//  path, await `start()`, own the resulting Worklet + IPC for the object's
//  lifetime, and expose a ready-to-use BarePear.RPC.
//
//  Usage (in your SwiftUI AppHost or equivalent):
//
//      let host = try BarePear.Host(
//          bundleResource: "backend.ios",
//          bundleType: "bundle",
//          storagePath: Self.storagePath(),
//          memoryLimit: 64 * 1024 * 1024
//      )
//      try await host.start()
//      let status = try await host.rpc.request(MyCmd.getStatus.rawValue)

import Foundation

// A5: BareKit ships iOS-only xcframeworks. Package.swift gates the
// dependency to `.when(platforms: [.iOS])`, so on macOS (where the unit
// tests run) `import BareKit` would fail. The `#if os(iOS)` wrapper
// compiles the whole Host class out on non-iOS platforms — acceptable
// because Host's entire job is to spawn a BareKit worklet, which is
// meaningless off-iOS. RPC / WorkletIPC / framing remain cross-platform.
#if os(iOS)

@preconcurrency import BareKit

extension BarePear {
    /// Owns a Bare worklet, its IPC, and the BarePear.RPC actor bound to it.
    ///
    /// The bundle is loaded from the app's main bundle by resource name /
    /// type — matches how xcodegen's `resources:` copies the bare-packed
    /// file into the .app. The worklet runs on BareKit's own thread; we
    /// only hold the references.
    @MainActor
    public final class Host {
        /// Generic JSON RPC actor bound to the worklet's IPC stream.
        /// Register event listeners and fire requests against this.
        public let rpc: BarePear.RPC

        private var worklet: Worklet?
        private var ipc: IPC?
        private let adapter: BareKitAdapter
        private let bundleResource: String
        private let bundleType: String
        private let storagePath: String
        private let memoryLimit: Int
        private let extraArguments: [String]
        private var started = false

        /// Construct a host. Does not start the worklet — call `start()`.
        ///
        /// - Parameters:
        ///   - bundleResource: Resource name of the bare-packed bundle file
        ///     within the app's main bundle (without extension). Matches
        ///     the `resources:` entry in your xcodegen project.yml.
        ///   - bundleType: File extension, default `"bundle"`.
        ///   - storagePath: Absolute path the worklet can use as its
        ///     writable storage directory. Usually an Application Support
        ///     subdirectory. Will be created if absent.
        ///   - memoryLimit: Worklet JS heap limit in bytes. Default 64 MB.
        ///   - extraArguments: Additional argv passed to the worklet after
        ///     `storagePath`. Most apps don't need this.
        public init(
            bundleResource: String,
            bundleType: String = "bundle",
            storagePath: String,
            memoryLimit: Int = 64 * 1024 * 1024,
            extraArguments: [String] = []
        ) {
            self.bundleResource = bundleResource
            self.bundleType = bundleType
            self.storagePath = storagePath
            self.memoryLimit = memoryLimit
            self.extraArguments = extraArguments
            let adapter = BareKitAdapter()
            self.adapter = adapter
            self.rpc = BarePear.RPC(ipc: adapter)
        }

        /// Spawn the worklet and attach the IPC. Idempotent — subsequent
        /// calls are no-ops.
        ///
        /// Call this AFTER registering any event listeners on `rpc`, so
        /// you don't miss early events the worklet emits on boot.
        public func start() async throws {
            guard !started else { return }
            started = true
            await rpc.attach()

            // Ensure storage dir exists — bare-fs will be happier.
            try? FileManager.default.createDirectory(
                atPath: storagePath,
                withIntermediateDirectories: true
            )

            // BareKit.Worklet.Configuration takes `UInt` for memoryLimit.
            let config = Worklet.Configuration(memoryLimit: UInt(max(0, memoryLimit)))
            let wkt = Worklet(configuration: config)
            let arguments = [storagePath] + extraArguments
            wkt.start(
                name: bundleResource,
                ofType: bundleType,
                arguments: arguments
            )
            self.worklet = wkt

            let ipc = IPC(worklet: wkt)
            self.ipc = ipc
            await adapter.attach(to: ipc)
        }

        /// Terminate the worklet and close IPC. Safe to call multiple times.
        public func shutdown() {
            worklet?.terminate()
            worklet = nil
            ipc = nil
            started = false
            let adapter = self.adapter
            let rpc = self.rpc
            Task {
                await rpc.close()
                await adapter.close()
            }
        }
    }
}

#endif // os(iOS)
