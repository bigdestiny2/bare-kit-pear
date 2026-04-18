# bare-kit-pear

**The easiest path from a Bare backend to a native iOS app.**

`bare-kit-pear` is an opinionated iOS SDK for [Bare](https://github.com/holepunchto/bare) apps. It bundles together the three pieces every Bare-on-iOS project ends up rebuilding from scratch:

1. A CLI (`bare-kit-pear`) that scaffolds an Xcode project, downloads `BareKit.xcframework`, and mirrors the 17 pre-built native addon xcframeworks that Bare backends depend on.
2. A Swift package (`BarePear`) that wraps Holepunch's `bare-kit-swift` with a production-tested worklet host and a length-prefixed JSON RPC actor.
3. A project template (`templates/ios-native/`) — a golden-path xcodegen config and minimal SwiftUI app you can build on.

Result: `npx bare-kit-pear init MyApp && cd MyApp && npm run ios` produces a working native iOS build in one pass, ~10 MB debug IPA, no React Native, App-Store-compliant (JavaScriptCore, no JIT).

---

## Status

| Area | Status |
|---|---|
| CLI (`init`, `fetch`, `addons`, `bundle`, `doctor`) | ⏳ in progress |
| Swift package `BarePear` (`Host`, `RPC`, `BareKitAdapter`) | ⏳ in progress |
| `templates/ios-native/` (xcodegen + SwiftUI minimal app) | ⏳ in progress |
| iOS simulator smoke test | ⏳ pending |
| Android | ❌ out of scope for v0 |

The recipe was extracted from [PearBrowser](../PearBrowser/ios-native/BUILD.md), which boots end-to-end on iPhone 17 Pro simulator with all 17 addons linked (sodium-native, udx-native, rocksdb-native, …).

---

## Install

```bash
npm install --save-dev bare-kit-pear
```

You also need:

- **macOS 14+** with **Xcode 15.3+**
- **XcodeGen**: `brew install xcodegen`
- **Node.js 20+**

---

## Quick start

In an existing Bare project (one that already has a `backend/index.js` running on Node):

```bash
# 1. Scaffold ios-native/
npx bare-kit-pear init MyApp

# 2. Fetch BareKit.xcframework (JSC variant, App-Store-compliant)
npx bare-kit-pear fetch

# 3. Mirror the 17 pre-built addon xcframeworks
npx bare-kit-pear addons

# 4. Bundle your backend for iOS
npx bare-kit-pear bundle

# 5. Generate Xcode project + build
cd ios-native && xcodegen generate
xcodebuild -project MyApp.xcodeproj -scheme MyApp -sdk iphonesimulator build

# 6. Install + launch on booted simulator
xcrun simctl install booted \
  "$HOME/Library/Developer/Xcode/DerivedData/MyApp-*/Build/Products/Debug-iphonesimulator/MyApp.app"
xcrun simctl launch booted com.myapp
```

Steps 1–4 are idempotent — rerun `fetch`/`addons`/`bundle` any time `BareKit` or your backend changes.

---

## How it works — the recipe

The short version: **don't cross-compile addons**. Piggyback on [`react-native-bare-kit`](https://www.npmjs.com/package/react-native-bare-kit), whose postinstall hook already runs `bare-link` and ships the 17 most common Bare addons as pre-built xcframeworks in `node_modules/react-native-bare-kit/ios/addons/`. `bare-kit-pear addons` mirrors those into your `ios-native/<App>/Frameworks/addons/`, and the template `project.yml` lists each one as an embedded framework dependency.

At runtime, `bare-kit` resolves `require('sodium-native')` etc. through `bare_addon_load_dynamic`, which finds the addon inside `<App>.app/Frameworks/`.

The full pipeline:

```
┌─────────────────────────────────────────────────────────────┐
│  Your project                                               │
│  ├── backend/index.js         ← your Bare backend           │
│  ├── package.json              ← lists react-native-bare-kit│
│  │                               as a devDependency         │
│  └── ios-native/               ← scaffolded by `init`       │
│      ├── project.yml                                        │
│      └── MyApp/                                             │
│          ├── Sources/                                       │
│          │   ├── App/         ← SwiftUI entry (yours)       │
│          │   └── Bridge/      ← BarePear.Host usage (yours) │
│          └── Frameworks/                                    │
│              ├── BareKit.xcframework      ← `fetch`         │
│              └── addons/*.xcframework     ← `addons`        │
└─────────────────────────────────────────────────────────────┘
         │                       │                   │
         │ bundle                │ fetch             │ addons
         ▼                       ▼                   ▼
  bare-pack --linked       github.com/        node_modules/
  --host ios-arm64         holepunchto/       react-native-
  backend/index.js         bare-kit           bare-kit/ios/
    -o backend/dist/       releases/          addons/
    backend.ios.bundle     prebuilds.zip      *.xcframework
```

The Swift package `BarePear` sits on top of `bare-kit-swift` (Holepunch's Swift overlay). It gives you:

- `BarePear.Host` — opens the bundle, spawns the worklet, wires the IPC stream. One call.
- `BarePear.RPC` — actor-based length-prefixed JSON RPC, 8-char ASCII hex framing (matches `bare-kit`'s `rpc.js`). Request/response with timeouts, event dispatch.
- `BarePear.BareKitAdapter` — glues BareKit's `IPC` AsyncSequence to `BarePear.RPC`.

You define your own `Cmd` / `Evt` enums (the command IDs your backend understands) and call `rpc.request(MyCmd.loadData.rawValue, data: [...])`.

---

## CLI commands

| Command | What it does |
|---|---|
| `bare-kit-pear init <AppName>` | Copy `templates/ios-native/` into `./ios-native/`, substitute `{{APP_NAME}}` with the provided name, add `barekit:*` scripts to your `package.json`. |
| `bare-kit-pear fetch [--version v2.0.2]` | Download `prebuilds.zip` from the `holepunchto/bare-kit` GitHub release and extract `apple-javascriptcore/BareKit.xcframework` to `ios-native/<App>/Frameworks/`. |
| `bare-kit-pear addons` | `cp -R` every `.xcframework` from `node_modules/react-native-bare-kit/ios/addons/` into `ios-native/<App>/Frameworks/addons/`. Warns if any are missing from `project.yml`. |
| `bare-kit-pear bundle [--entry backend/index.js]` | Runs `bare-pack --linked --host ios-arm64 <entry> -o backend/dist/backend.ios.bundle`. |
| `bare-kit-pear doctor` | Verifies `project.yml` addon refs match `Frameworks/addons/` contents. Exit 1 on drift. |

All commands read config from the nearest `package.json` (the `bare-kit-pear` key) if present — e.g. the target app name, custom entry path, frameworks directory. Everything has sensible defaults.

---

## Swift package surface

```swift
import BarePear

// 1. Create a host bound to your packed backend bundle (by resource name).
let host = try BarePear.Host(
    bundleResource: "backend.ios",
    bundleType: "bundle",
    storagePath: Self.storagePath(),
    memoryLimit: 64 * 1024 * 1024
)

// 2. Wait for your app's ready event.
await host.rpc.on(MyEvt.ready.rawValue) { payload in
    // …
}

// 3. Send requests.
let status = try await host.rpc.request(MyCmd.getStatus.rawValue)
```

The `Host` keeps the worklet alive for the lifetime of the object; call `host.shutdown()` to terminate cleanly. It compiles without `BareKit` linked (demo mode) — useful for UI-only iteration in previews.

Wire format (documented so you can implement matching clients in other languages):

```
[8-char ASCII-hex length][JSON payload]

  Request  : { "id": <int>, "cmd": <int>, "data": <any> }
  Response : { "id": <int>, "result": <any> }  |  { "id": <int>, "error": <string> }
  Event    : { "event": <int>, "data": <any> }
```

Kotlin `PearRpc.kt`, Node `rpc.js`, and TypeScript `rpc.ts` implementations all use the same framing — it's worth preserving this format in your backend `rpc.js`.

---

## Project layout after `init`

```
ios-native/
├── .gitignore             # excludes Frameworks/ (fetched, not committed)
├── project.yml            # xcodegen config
└── MyApp/
    ├── Info.plist
    ├── MyApp.entitlements
    ├── Assets.xcassets/
    ├── LaunchScreen.storyboard
    ├── Frameworks/        # .gitignored — populated by fetch/addons
    └── Sources/
        ├── App/
        │   └── MyAppApp.swift      # SwiftUI @main entry
        ├── Bridge/
        │   └── AppHost.swift       # your BarePear.Host usage
        └── RPC/
            └── Protocol.swift      # your Cmd / Evt enums
```

---

## Limitations & scope (v0)

- **iOS only.** Android has a different story (no dynamic xcframework loading; we'd wrap `bare-kit`'s `.aar`). Out of scope until v0 ships.
- **JavaScriptCore variant only.** The V8 variant has JIT and gets App-Store-rejected. `fetch` always pulls the JSC build.
- **Addon set is whatever `react-native-bare-kit` ships.** At time of writing that's 17 addons covering the Hypercore/Hyperswarm stack. Adding a custom C/C++ addon means running `bare-link` yourself — out of scope for v0.
- **Minimum iOS: 16.0.** Required by `bare-kit-swift`.

---

## Upgrading

```bash
# Bump bare-kit-pear itself
npm update bare-kit-pear

# Bump BareKit runtime (edit version, rerun fetch)
BAREKIT_VERSION=v2.1.0 npx bare-kit-pear fetch

# Bump addon set (npm update rn-bare-kit, then re-mirror)
npm update react-native-bare-kit
npx bare-kit-pear addons
npx bare-kit-pear doctor  # warns if project.yml needs new refs
```

When `doctor` flags missing refs in `project.yml`, add them under `dependencies:` with `embed: true` and rerun `xcodegen generate`.

---

## References

- `holepunchto/bare`: <https://github.com/holepunchto/bare>
- `holepunchto/bare-kit`: <https://github.com/holepunchto/bare-kit>
- `holepunchto/bare-kit-swift`: <https://github.com/holepunchto/bare-kit-swift>
- `holepunchto/bare-ios` (runtime source, not directly used here): <https://github.com/holepunchto/bare-ios>
- Extracted from PearBrowser — see `~/Desktop/PearBrowser/ios-native/BUILD.md`

## License

MIT.
