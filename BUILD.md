# Building and verifying BGG Hard Block

There is no official reproducible-build or source-verification programme for the
Chrome Web Store. Google reviews submissions, but it does not publish a mapping
from a published extension back to a public repository, and it gives users no
built-in way to check one. (Mozilla's add-on store does require source
submission when code is minified or obfuscated; Chrome has no equivalent.)

So "trust me, the source is on GitHub" is not, by itself, verifiable. This
document describes what the project does instead.

## The short version

**There is no build step.** The files in `src/` are the files that run in your
browser — no bundler, no minifier, no transpiler, no source maps to reconcile.
Packaging is a copy and a ZIP. That means you can compare the extension Chrome
actually installed against this repository directly, without trusting any
toolchain in between.

## 1. Build the package

```bash
./scripts/package.sh
```

This writes `artifacts/bgg-hard-block-<version>.zip` and prints its path.
`scripts/make_zip.py` contains the explicit `SHIPPED_FILES` allowlist and first
requires every listed path to be tracked by Git. Untracked files and tracked
files absent from that allowlist cannot enter the package. Tests, build scripts,
and store screenshots stay out of the package.

## 2. Confirm the build is reproducible

The ZIP is deterministic: two builds of the same commit produce byte-identical
archives, on any machine, regardless of when you clone or what your umask is.
`scripts/make_zip.py` writes uncompressed `ZIP_STORED` entries and pins their
timestamps, permission bits, creator system, and sorted entry order. The
repository also normalizes text files to LF line endings through
`.gitattributes`.

Check it yourself:

```bash
./scripts/package.sh
sha256sum artifacts/bgg-hard-block-*.zip
rm artifacts/bgg-hard-block-*.zip
./scripts/package.sh
sha256sum artifacts/bgg-hard-block-*.zip
```

Both hashes must match. If they don't, that's a bug — please report it, because
it breaks everything below.

Continuous integration (CI) independently builds the allowlisted ZIP on
`windows-2025` and `ubuntu-24.04`, then compares the archive bytes. It uses
Python 3.12.10 and Node.js 24.19.0; every GitHub Action is pinned by full commit
SHA. The test job installs `requirements-dev.txt` with `--require-hashes`.

Each tagged release records its expected SHA-256 in the release notes.

## 3. Compare against what Chrome installed

This is the step that actually verifies the published extension, and it does not
require trusting the author at all.

Chrome unpacks every installed extension to disk in readable form. Find it:

| OS | Path |
| --- | --- |
| Linux | `~/.config/google-chrome/Default/Extensions/hkbnpeohgacliadddhjoddiickjnlnfl/` |
| macOS | `~/Library/Application Support/Google/Chrome/Default/Extensions/hkbnpeohgacliadddhjoddiickjnlnfl/` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\hkbnpeohgacliadddhjoddiickjnlnfl\` |

Inside is one directory per installed version. Diff its `src/` against this
repository at the matching tag:

```bash
git checkout v0.4.0
diff -ru src "<extensions-path>/0.4.0_0/src"
diff -u manifest.json "<extensions-path>/0.4.0_0/manifest.json"
```

Expected differences, all added by Chrome rather than by the author:

- a `key` field in `manifest.json` — Chrome inserts the extension's public key
- a `_metadata/` directory containing `computed_hashes.json` and `verified_contents.json`
- `differential_fingerprint`
- on some builds, a `_locales/` directory

Everything under `src/` should be identical. If a line of JavaScript differs
from this repository, that is worth reporting loudly.

## 4. Read the code

The point of the previous three steps is to establish that the code in this
repository is the code you are running. Once you accept that, the privacy
claims become checkable by reading, and the places worth reading are short:

| Question | Where to look |
| --- | --- |
| Does it phone home? | `src/background.js`, `fetchApi` and `assertAllowedApiRequest` — the worker constructs and validates every request |
| What happens to my auth header? | `src/page-bridge.js`, `captureAuthorization`, and `src/background.js`, `runBridgeSession` — private, ephemeral, and never stored or sent to content |
| What gets stored? | `PRIVACY.md` has the complete map; writes are in `src/onboarding.js`, `src/options.js`, and `src/background.js`; `src/content.js` can report only bounded page counters to the worker |
| Does it act before I consent? | `src/content.js` consent gate and `src/background.js`, `runBridgeSession` |
| Where can it run at all? | `manifest.json`, `content_scripts[].matches`, and `isDiscussionUrl` in `src/background.js` |

Version 0.4.0 has no declarative MAIN-world or settings bridge. The manifest
declares only the isolated content filter. That script requests a
document-bound MAIN-world injection from `background.js`; the background worker
validates the active sender and checks current consent and options before and
after the injection. `src/page-bridge.js` returns only the captured authorization
value through `chrome.scripting.executeScript`; `src/background.js` performs all
authenticated API work and returns only validated public usernames/status to the
isolated script. No page-writable data bridge participates in persistence.

## Releasing (maintainer)

1. Bump `version` in `manifest.json`.
2. Update the disclosure-version ladder in its five modules —
   `src/background.js`, `src/content.js`, `src/popup.js`, `src/options.js`, and
   `src/onboarding.js` — **only if the privacy disclosure text itself changed**.
   The current disclosure is `2026-08-15`. Bumping it forces every existing user
   back through the consent screen, so don't do it for ordinary fixes.
3. Create and activate a virtual environment, then install the hash-locked
   contributor dependency:

   ```bash
   python3 -m venv ../bgg-hard-block-venv
   source ../bgg-hard-block-venv/bin/activate
   python3 -m pip install --require-hashes -r requirements-dev.txt
   ```
4. `./scripts/test.sh`
5. `./scripts/package.sh`
6. Tag `vX.Y.Z`, push the tag, and attach the ZIP plus its SHA-256 to the
   GitHub release.
7. Upload the same ZIP to the Chrome Web Store.

Uploading a package that differs from the tagged artifact defeats the whole
mechanism above. Build once, ship that file to both places.
