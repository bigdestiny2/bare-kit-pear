# {{APP_NAME}} — iOS native shell

Scaffolded by [`bare-kit-pear`](https://www.npmjs.com/package/bare-kit-pear).

## Build + run

From the project root (one level up):

```bash
# One-time: download BareKit + mirror addons + bundle backend
npm run ios:setup

# Build for the booted simulator
npm run ios:build

# Install + launch
xcrun simctl install booted \
  "$HOME/Library/Developer/Xcode/DerivedData/{{APP_NAME}}-"*"/Build/Products/Debug-iphonesimulator/{{APP_NAME}}.app"
xcrun simctl launch booted com.{{APP_NAME}}
```

After editing `project.yml`, rerun `cd ios-native && xcodegen generate`.

## What's here

```
ios-native/
├── BUILD.md                 — this file
├── .gitignore               — excludes Frameworks/ (fetched, not committed)
├── project.yml              — xcodegen source of truth
└── {{APP_NAME}}/
    ├── Info.plist
    ├── {{APP_NAME}}.entitlements
    ├── Assets.xcassets/
    ├── LaunchScreen.storyboard
    ├── Frameworks/          — populated by `npm run barekit:fetch` + `barekit:addons`
    └── Sources/
        ├── App/             — SwiftUI @main entry + ContentView
        ├── Bridge/          — AppHost wraps BarePear.Host
        └── RPC/             — Cmd / Evt enums (edit these to match your backend)
```

## Editing the RPC protocol

Your backend and this Swift app must agree on command / event IDs. Edit
`Sources/RPC/Protocol.swift` to match `backend/constants.js` (or wherever
you define them backend-side). The wire format is fixed:

```
[8-char ASCII-hex length][JSON body]

Request  : { "id": int, "cmd": int, "data": any }
Response : { "id": int, "result": any } | { "id": int, "error": string }
Event    : { "event": int, "data": any }
```

`BarePear.RPC` handles framing automatically.

## Troubleshooting

### Worklet aborts at boot

Usually a missing addon. Check:

```bash
npm run barekit:doctor
```

If addons are missing, run `npm run barekit:addons` to re-mirror.

### `BarePear` package not found

Make sure you've run `npm install` in the project root. The template's
`project.yml` references `../node_modules/bare-kit-pear`, which exists
once the npm package is installed.

### Build succeeds but UI shows "Demo mode"

`BareKit.xcframework` isn't linked. Run `npm run barekit:fetch` and
rebuild. The shell compiles without BareKit (useful for UI-only iteration)
but won't actually run the worklet.
