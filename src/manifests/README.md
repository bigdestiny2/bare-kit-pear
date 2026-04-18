# Integrity manifests

Pinned SHA-256 hashes for every binary this CLI touches: the
`prebuilds.zip` that `fetch` downloads from `holepunchto/bare-kit`, and
the `BareKit.xcframework` + 17 addon xcframeworks that `addons` mirrors
out of `node_modules/react-native-bare-kit/ios/`.

## Why

Both paths are supply-chain targets. A compromised GitHub release asset
or tampered npm package would otherwise land unverified inside a signed
iOS app. These manifests let `fetch`/`addons` compare what was just
written to disk against hashes recorded here, and fail/warn on drift.

- `barekit-versions.json` — hash of `prebuilds.zip` per bare-kit tag.
- `rnbk-known-good.json` — directory hashes of every xcframework shipped
  by a given `react-native-bare-kit` version.

Hashes come from `src/util/integrity.js`. For files: plain SHA-256. For
xcframeworks: SHA-256 over a deterministic walk (sorted entries,
symlinks and `.DS_Store` skipped, per-file hashes concatenated with null
separators). Stable across macOS/Linux.

## Adding a new bare-kit version

1. Identify the release tag, e.g. `v2.1.0`.
2. Download and hash the zip:
   ```
   curl -L -o /tmp/prebuilds.zip \
     https://github.com/holepunchto/bare-kit/releases/download/v2.1.0/prebuilds.zip
   shasum -a 256 /tmp/prebuilds.zip
   wc -c /tmp/prebuilds.zip
   rm /tmp/prebuilds.zip
   ```
3. Add an entry under `versions` in `barekit-versions.json` with the
   `sha256`, `size`, `url`, and today's date. Open a PR.
4. Alternative: run `npx bare-kit-pear fetch --version v2.1.0 --add-manifest`
   in a dev checkout — that writes the entry for you. Still commit the diff.

## Adding a new react-native-bare-kit version

1. `npm install --save-dev react-native-bare-kit@<new>` in a dev project.
2. Read the `version` from `node_modules/react-native-bare-kit/package.json`.
3. Easy route: run `bare-kit-pear addons` in the dev project. It prints a
   paste-ready JSON block with every new xcframework hash when the
   version isn't in the manifest.
4. Add a new top-level key under `versions` in `rnbk-known-good.json`.
   The addon key is the xcframework name without `.xcframework`
   (e.g. `sodium-native.5.1.0`). PR the change.

## What to do when `addons` (or `doctor`) warns about a hash mismatch

1. **Do not** update the manifest reflexively. A warning means the bytes on
   disk do not match what was reviewed the last time this version was
   trusted. That could be a legitimate upstream re-release, or it could be
   a compromised package in your `node_modules`.
2. Diff your installed copy against a fresh install from a trusted network:
   reinstall `react-native-bare-kit` into a clean throwaway directory from
   a trusted machine and compare hashes.
3. If they match each other but not the manifest, check whether the rnbk
   version was re-published (compare the tarball on `npmjs.com`'s own page
   and any release notes). If upstream genuinely re-released without a
   version bump, update the manifest with the new hash and note the reason
   in the PR.
4. If they differ, your local copy is tampered — wipe `node_modules` and
   reinstall from a clean registry/mirror before doing anything else.

`fetch` treats mismatches as fatal (downloaded bytes are removed before
exit). `addons` only warns, because a stale manifest will otherwise break
installs the first time anyone bumps rnbk — but the warning is loud and
includes a paste-ready manifest fragment.
