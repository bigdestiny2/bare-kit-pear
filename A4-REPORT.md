# A4 — Integrity verification for fetch / addons

## Summary

Added SHA-256 integrity verification against pinned manifests to the two
`bare-kit-pear` commands that write third-party binaries into the signed
iOS app bundle:

- `fetch` — downloads `prebuilds.zip` from the `holepunchto/bare-kit`
  GitHub release and extracts `BareKit.xcframework`. Now hashes the zip
  and the extracted framework against `src/manifests/barekit-versions.json`
  and aborts before install on mismatch. Redirects are restricted to a
  GitHub-operated allow-list.
- `addons` — mirrors the `BareKit.xcframework` plus 17 native addon
  xcframeworks out of `node_modules/react-native-bare-kit/ios/`. Now
  rehashes every mirrored xcframework against
  `src/manifests/rnbk-known-good.json` keyed by the rnbk `package.json`
  version, warns loudly on drift, and prints a paste-ready manifest
  fragment for review.

Both paths now fail closed (fetch) / warn loud (addons) against the case
where a package registry or release asset has been tampered with between
reviews.

## Files changed

| Path | Kind | Purpose |
|---|---|---|
| `src/util/integrity.js` | new | Pure-node SHA-256 helpers: `hashFile`, `hashDirectory`, `hashXcframework`, `verifyFile`. No npm deps. |
| `src/manifests/barekit-versions.json` | new | Pinned hash of `prebuilds.zip` + extracted `BareKit.xcframework` per bare-kit release tag. |
| `src/manifests/rnbk-known-good.json` | new | Pinned directory hashes of 18 xcframeworks per `react-native-bare-kit` version. |
| `src/manifests/README.md` | new | Procedure for adding new bare-kit / rnbk versions and for reacting to mismatch warnings. |
| `src/commands/fetch.js` | modified | Hash zip + framework against manifest. `--add-manifest`, `--verify-only`. Host allow-list for redirects. |
| `src/commands/addons.js` | modified | Hash each mirrored xcframework, warn on mismatch, emit paste-ready manifest fragment, handle unknown rnbk versions. |

No other file was touched. `Sources/**`, `Tests/**`, `templates/**`,
`src/cli.js`, `src/util/log.js`, `src/util/config.js`, `package.json`,
`Package.swift`, `BUILD.md`, and `bin/**` are all untouched.

## Hashes recorded

All hashes are lowercase hex SHA-256. They can be independently verified:
`shasum -a 256 <file>` for the zip; the xcframework hashes come from the
directory serialization documented in `src/util/integrity.js`
(`hashXcframework`).

### `bare-kit` release `v2.0.2`

- `prebuilds.zip` — 314 826 089 bytes
  `b6870633c01be830433b4a86eaee2e9cd4a78ab5d69610923bfb27b8ec73b530`
  cross-checked via `shasum -a 256 /tmp/prebuilds.zip` ↔ our `hashFile`
- `apple-javascriptcore/BareKit.xcframework` (after unzip)
  `ed3a5278c6167744c2f3bee15de3b3689f419759d8a16eb23c94c5c969393ab2`

### `react-native-bare-kit` version `0.13.3`

Source:
`~/Desktop/PearBrowser/node_modules/react-native-bare-kit/package.json`

```
BareKit.xcframework               3cd76b8cbdea60499938cd19797e379cc30ae581bddc86b32eb04c5bc8b6a7d7
addons/
  bare-crypto.1.13.4              43a40b99e4bfec72d3192a858124fd9c9076fe2fcb895fbd33463feec3dcd77f
  bare-dns.2.1.4                  f7d3b28be9112ffe8bb471d703c1cb03acba0d5316600f3f7578720376ba4d87
  bare-fs.4.6.0                   c3f5beb45065544153722e6078414388358d2e908b281db3889e28bd2addb2ab
  bare-inspect.3.1.4              426439ade90fbde5ef25f936462189493a498c2c8d7185384d672379f80caae6
  bare-os.3.8.7                   69be8d8fe1c4f4561a12cc4286f3408d0ea65ac9ce04ae8df70105f391752533
  bare-pipe.4.1.5                 38e2ce038bea92ce8e6ebad8ec8ed966e8ccd04ef9bb2b3224fce56dcd54dafa
  bare-subprocess.5.2.3           7c5b82dd4e80ff39329adfa15e77ad326c0b4be8462db7f61094b25f5d50b78e
  bare-tcp.2.2.7                  1bc70577de1f3551ceaff28efd918039a4c5b4cdd8877fa20f81c3721d133ebe
  bare-type.1.1.0                 ff146bcb60eae9af46ff269caf63b78b7e4342a2bd17f600cc1f55d651c86f58
  bare-url.2.4.0                  2426d739acb48bae1b9abf95ae4cad655307efd28d784ce3dfb2dca92b433ef1
  fs-native-extensions.1.4.5      2324bc1ef8dc1d161c262e4fba4af48530e44df5a33ec48ad083631418befb2e
  quickbit-native.2.4.8           b20f6d42a0092e481b377cafbc9b768144fd0b99e8affc162554c2b8d6ff389f
  rabin-native.2.0.0              8412061a54d3af2aa261ccd46d0bce2a542d1a6d72b55e5f116ce6665c14b378
  rocksdb-native.3.15.0           08eb04bd4f7687d9669812e5f3dc5a86e7def451fcdd74bde240ab9077b7b598
  simdle-native.1.3.9             74291e40bd3267bf9ee51164cf605d69f50c0f5e961f1cef7d13bfc81d1e8cf0
  sodium-native.5.1.0             150fd9093cda28c0d80ae92c291455914e4259a3907f5a0bddc2a935d6db8a4e
  udx-native.1.19.2               4da1d5fc5d3d24a284fb5fc63c7294d27f606687448c82f4e241a8f64aa8ddf9
```

Note that `BareKit.xcframework` from `rnbk 0.13.3`
(`3cd76b8c…`) is a *different* binary from the one in `bare-kit v2.0.2`
(`ed3a5278…`). The two pipelines (`fetch` pulls from the GitHub release;
`addons` mirrors from `node_modules`) emit different builds, so the two
manifests carry different expected hashes for the same named file. This is
correct — operators typically pick one pipeline per project.

## Host allow-list for fetch

Download redirects are restricted to:

- `github.com`
- `objects.githubusercontent.com`
- `codeload.github.com`
- `release-assets.githubusercontent.com`

The spec listed the first three. At the time of implementation, GitHub
actually serves release asset payloads through a 302 chain that ends at
`release-assets.githubusercontent.com`; without it, `fetch v2.0.2`
(explicitly required to keep working unmodified by the spec) immediately
fails the happy path. I added the fourth origin because it is a GitHub-
operated CDN hostname and the strict three-entry list would block the
spec's own "must still work" behaviour. Any redirect outside these four
hosts is rejected with a clear error (verified — a synthetic redirect to
`evil.example.com` gets rejected).

Non-HTTPS redirects are rejected. Maximum 10 redirects per download.

## Verification runs

Every behaviour below was exercised against a live environment:

1. `node -e "console.log(require('src/util/integrity.js'))"` lists the four
   expected exports as `AsyncFunction`s.
2. `bare-kit-pear fetch --verify-only` in an empty tmpdir prints a helpful
   "No BareKit.xcframework installed … Run bare-kit-pear fetch first" and
   exits 1.
3. `bare-kit-pear fetch` (v2.0.2, known version) downloads, verifies the
   zip hash, extracts, verifies the framework hash, and installs. Happy path.
4. `bare-kit-pear fetch --verify-only` against a correct install prints
   "✓ BareKit.xcframework matches manifest for v2.0.2".
5. Replace the installed `BareKit.xcframework` with a different variant
   (the rnbk one). `fetch --verify-only` reports expected / actual and
   exits 1.
6. `bare-kit-pear fetch --version v99.0.0` (unknown) aborts with
   "Version v99.0.0 not in manifest. Pass --add-manifest to trust and
   record this version."
7. `bare-kit-pear fetch --add-manifest` on a seeded unknown version
   downloads, writes the computed zip + xcframework hashes to
   `barekit-versions.json`, and prints a warning to commit the diff.
8. `bare-kit-pear addons` with a clean rnbk install reports
   "✓ all 18 xcframework hashes match manifest (rnbk 0.13.3)".
9. `bare-kit-pear addons` with a seeded manifest mismatch (I replaced one
   sodium-native hash with zeros) prints a WARN block with expected vs
   actual and a paste-ready manifest fragment — exit code stays 0, so a
   rnbk bump never bricks a `doctor` / quick-start run.

## Known limitations

- **Directory hash covers content only.** File mode bits, symlink
  presence, directory nesting structure, and file size are *not*
  independently captured; they only indirectly affect the hash through
  what files show up during the walk. An attacker who can modify a file
  without changing its name or bytes (impossible) would still be caught,
  but one who could add a previously-ignored file type (e.g. device
  node) would not. In practice xcframeworks contain only regular files
  under subdirs like `ios-arm64/` and `ios-arm64_x86_64-simulator/` plus
  an `Info.plist`, so the attack surface is narrow.

- **Symlinks inside xcframeworks are silently skipped.** None of the
  known-good frameworks use them today, but a future upstream change
  that introduces one would produce a silently shorter walk and thus a
  different hash — which is fine (it would trigger a mismatch warning)
  but would be confusing to debug. Spec called for skipping symlinks
  explicitly.

- **The xcframework hash for `bare-kit v2.0.2` embeds a build timestamp
  if any exists inside the Info.plist / archives.** I did not open every
  embedded binary to confirm determinism across machines — the hash is
  derived from the upstream release archive as it arrived at the CDN,
  so mirrors are expected to see the same bytes regardless of the local
  clock. If upstream ever re-packs a release in place (non-atomic
  re-upload), the manifest hash will flag it.

- **`--add-manifest` trusts whatever the user just downloaded.** It is
  *not* a TOFU (trust-on-first-use) per-project pin — it writes into the
  CLI's own committed manifest, which subsequent runs will verify
  against. This is deliberate: the manifest is version-controlled, and
  the flag is meant to be a bootstrap step for a reviewer bumping a
  trusted version, not a bypass for unknown releases. Still, an attacker
  who can MITM the first download on the reviewer's machine will also
  sneak the wrong hash into the PR; in-person / out-of-band verification
  of new releases is recommended in `src/manifests/README.md`.

- **`addons` warns on mismatch, does not abort.** This mirrors the spec
  intent: a stale manifest is expected to be the common failure mode
  (people bump rnbk before the manifest is updated), and a fatal abort
  would break quick-starts for trusted bumps. Attackers who compromise
  the rnbk package get a loud WARN but not a hard stop. If stricter
  enforcement is desired, a future `--strict` flag could bail on
  mismatch; it wasn't requested here.

- **No signature verification, only hash pinning.** We trust the bytes
  that were reviewed when the manifest entry was added. There is no
  GPG / Sigstore signature verification against a publisher key. This
  is strictly TOFU-at-review-time. Stronger guarantees would require
  upstream to publish signed releases we can verify against.

- **`src/cli.js` owns flag parsing; flags are camelized.** My code reads
  both `args.verifyOnly` and `args['verify-only']` to be defensive, even
  though the CLI only ever emits the camelized form. Not a functional
  issue, just belt-and-braces.

- **`fetch --verify-only` uses the CLI's project-configured BareKit
  version (from `package.json[bare-kit-pear].barekitVersion`).** If a
  user installs with one version, then bumps the config without
  re-running `fetch`, `--verify-only` will look up the new version's
  manifest entry and likely flag the installed framework as mismatched.
  This is the intended behaviour — it reflects the actual inconsistency
  between what the config says is installed and what's on disk.

- **No caching of hash results.** Hashing 18 xcframeworks takes ~10 s of
  disk I/O. For `addons` this happens every invocation. If this becomes
  a friction point, a future change could cache by mtime / size, but it
  would add complexity for marginal benefit given how infrequently the
  command runs.
