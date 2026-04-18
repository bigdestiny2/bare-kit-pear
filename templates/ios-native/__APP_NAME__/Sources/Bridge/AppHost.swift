//  {{APP_NAME}} — AppHost.swift
//
//  Thin wrapper around BarePear.Host. Publishes boot state for the UI
//  and exposes the RPC actor so screens can call backend commands.
//
//  Customise the event listeners + storage path for your app. The
//  @Published fields are intentionally minimal — add more as your
//  backend emits more events.

import Foundation
import SwiftUI
import os.log
import BarePear

@MainActor
final class AppHost: ObservableObject {
    static let shared = AppHost()

    @Published private(set) var isReady: Bool = false
    @Published private(set) var peerCount: Int = 0
    @Published private(set) var bootMessage: String = "Starting…"
    @Published private(set) var bootStage: String = "init"

    /// True once the worklet has been started and has not been shut down.
    ///
    /// Currently only flips false on explicit `shutdown()`; worklet crashes
    /// are not detected — see roadmap item 5.4 in BUILD.md.
    @Published private(set) var isAlive: Bool = false

    private var host: BarePear.Host?

    // `nonisolated` so the error-event listener (a `@Sendable` closure
    // that's not MainActor-isolated) can write to the log without an
    // isolation violation. `Logger` is Sendable, and the subsystem string
    // is computed once at class init from a Sendable source.
    nonisolated private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.{{APP_NAME}}",
        category: "AppHost"
    )

    private init() {}

    var rpc: BarePear.RPC? { host?.rpc }

    func boot() async {
        guard host == nil else { return }
        bootMessage = "Booting worklet…"

        do {
            // BarePear.Host.init is not throwing; only .start() is.
            let host = BarePear.Host(
                bundleResource: "backend.ios",
                bundleType: "bundle",
                storagePath: Self.storageURL().path,
                memoryLimit: 64 * 1024 * 1024
            )
            self.host = host

            // Wire listeners BEFORE start so we don't miss early events.
            await host.rpc.on(Evt.ready.rawValue) { [weak self] payload in
                Task { @MainActor in
                    self?.isReady = true
                    self?.bootMessage = "Connected"
                    self?.bootStage = "ready"
                }
            }
            await host.rpc.on(Evt.peerCount.rawValue) { [weak self] payload in
                if let dict = payload as? [String: Any], let n = dict["peerCount"] as? Int {
                    Task { @MainActor in self?.peerCount = n }
                }
            }
            await host.rpc.on(Evt.error.rawValue) { payload in
                // Default handler: route to os_log at .error level. Include
                // the full payload (message, stack if present, and the cmd
                // id when the error is tied to a request).
                Self.logBackendError(payload)
            }

            try await host.start()
            isAlive = true
            bootStage = "waiting-ready"
            bootMessage = "Waiting for ready event…"
        } catch {
            bootMessage = "Boot failed: \(error.localizedDescription)"
            bootStage = "error"
            Self.log.error("Boot failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func shutdown() {
        host?.shutdown()
        host = nil
        isAlive = false
    }

    // MARK: - Error logging

    /// `nonisolated` because it only reads the payload parameter + the
    /// `Sendable` static Logger. Called from the `@Sendable` rpc.on
    /// listener closure, which is not MainActor-isolated.
    private nonisolated static func logBackendError(_ payload: Any?) {
        let dict = payload as? [String: Any] ?? [:]
        let msg = (dict["message"] as? String) ?? "unknown"
        let stack = (dict["stack"] as? String) ?? ""
        // `cmd` is conventional when the error is tied to a request id the
        // backend is answering; not all error events carry one.
        let cmd: String
        if let c = dict["cmd"] as? Int { cmd = String(c) }
        else if let c = dict["cmd"] as? String { cmd = c }
        else { cmd = "-" }

        if stack.isEmpty {
            log.error("backend error cmd=\(cmd, privacy: .public) message=\(msg, privacy: .public)")
        } else {
            log.error("backend error cmd=\(cmd, privacy: .public) message=\(msg, privacy: .public) stack=\(stack, privacy: .public)")
        }
    }

    // MARK: - Paths

    private static func storageURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let name = safeStorageName("{{APP_NAME}}".lowercased())
        let dir = base.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Whitelist characters safe for a directory component on iOS; replace
    /// anything else with `_`. Defensive: an app name that somehow contained
    /// a path separator, control char, or unicode category we don't expect
    /// would otherwise end up creating nested directories or, worse,
    /// escaping the Application Support container.
    private static func safeStorageName(_ raw: String) -> String {
        var out = ""
        for c in raw {
            if c.isLetter || c.isNumber || c == "_" || c == "-" {
                out.append(c)
            } else {
                out.append("_")
            }
        }
        return out.isEmpty ? "app" : out
    }
}
