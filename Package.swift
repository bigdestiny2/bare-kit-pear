// swift-tools-version:5.9
//
// BarePear — ergonomic Swift wrapper for bare-kit-swift.
//
// Consume from an xcodegen project.yml either by local path (when the
// consumer has bare-kit-pear in node_modules):
//
//     packages:
//       BarePear:
//         path: ../node_modules/bare-kit-pear
//
// … or by git URL once this repo is published:
//
//     packages:
//       BarePear:
//         url: https://github.com/YOUR_ORG/bare-kit-pear
//         branch: main
//
// See BUILD.md for the full recipe.
//
// Platforms:
//   - iOS 16: production target.
//   - macOS 14: available so `swift test` can run the framing / RPC unit
//     tests on CI (macOS GitHub runner) without an iOS simulator. The
//     BareKit product is gated to iOS only via `.when(platforms:)`, and
//     Host.swift + BareKitAdapter.swift compile out on non-iOS platforms
//     (they wrap their bodies in `#if os(iOS)`). RPC framing, WorkletIPC,
//     and the BarePear namespace remain cross-platform and testable on
//     macOS.

import PackageDescription

let package = Package(
    name: "BarePear",
    platforms: [
        .iOS(.v16),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "BarePear",
            targets: ["BarePear"]
        )
    ],
    dependencies: [
        .package(
            url: "https://github.com/holepunchto/bare-kit-swift",
            branch: "main"
        )
    ],
    targets: [
        .target(
            name: "BarePear",
            dependencies: [
                .product(
                    name: "BareKit",
                    package: "bare-kit-swift",
                    condition: .when(platforms: [.iOS])
                )
            ],
            path: "Sources/BarePear",
            swiftSettings: [
                // A5: run the target under complete strict concurrency.
                // A1 already did the structural work (actors, Sendable,
                // @preconcurrency on BareKit imports). This just enables
                // the check — any new violations get surfaced at build.
                .enableUpcomingFeature("StrictConcurrency")
            ]
        ),
        .testTarget(
            name: "BarePearTests",
            dependencies: ["BarePear"],
            path: "Tests/BarePearTests"
        )
    ]
)
