//  {{APP_NAME}} — SwiftUI entry point.
//
//  Scaffolded by bare-kit-pear init. Edit freely — this is your app.

import SwiftUI

@main
struct {{APP_NAME}}App: App {
    @StateObject private var host = AppHost.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(host)
                .task { await host.boot() }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var host: AppHost

    var body: some View {
        VStack(spacing: 24) {
            Circle()
                .fill(host.isReady ? Color.green : Color.orange)
                .frame(width: 20, height: 20)
            Text(host.bootMessage)
                .font(.headline)
            if host.isReady {
                Text("Peers: \(host.peerCount)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
    }
}
