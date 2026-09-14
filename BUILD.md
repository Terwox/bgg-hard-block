# Building and verifying BGG Hard Block

This extension ships to two stores: the Chrome Web Store and
addons.mozilla.org (AMO). Neither runs a reproducible-build or
source-verification programme. Google reviews submissions, but it does not
publish a mapping from a published extension back to a public repository, and it
gives users no built-in way to check one. Mozilla signs every add-on and requires
a source upload when code is minified or obfuscated — which does not apply here,
because there is no build step — but it publishes no repository mapping either.

So "trust me, the source is on GitHub" is not, by itself, verifiable. This
document describes what the project does instead.

## The short version

**There is no build step.** The files in `src/` are the files that run in your
browser — no bundler, no minifier, no transpiler, no source maps to reconcile.
Packaging is a copy and a ZIP. That means you can compare the extension your
browser actually installed against this repository directly, without trusting
any toolchain in between.

The Chrome and Firefox packages carry the same `src/` and `icons/` contents. The
Firefox package differs only by the manifest file: its `manifest.json` member is
a byte copy of the repository's `manifest.firefox.json`.

## 1. Build the package

```bash
./scripts/package.sh
```

This writes two archives and prints both paths:

| Archive | Upload target | Source of its `manifest.json` member |
| --- | --- | --- |
| `artifacts/bgg-hard-block-<version>.zip` | Chrome Web Store | `manifest.json` |
| `artifacts/bgg-hard-block-<version>-firefox.zip` | addons.mozilla.org (AMO) | `manifest.firefox.json` |

`scripts/package.sh` refuses to build if the two checked-in manifests disagree on
`version`, so a single tag names both uploads. Apart from that one member, the
two archives contain identical files.

`scripts/make_zip.py` contains the explicit `SHIPPED_FILES` allowlist and first
requires every listed path to be tracked by Git, and rejects a path that is only
intent-to-add (`git add -N`), whose index entry is the empty blob rather than
real content. Untracked files and tracked files absent from that allowlist
cannot enter the package. Tests, build scripts, and store screenshots stay out
of the package.

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

## 3. Compare against what the browser installed

This is the step that actually verifies the published extension, and it does not
require trusting the author at all.

### Chrome

Chrome unpacks every installed extension to disk in readable form. Find it:

| OS | Path |
| --- | --- |
| Linux | `~/.config/google-chrome/Default/Extensions/hkbnpeohgacliadddhjoddiickjnlnfl/` |
| macOS | `~/Library/Application Support/Google/Chrome/Default/Extensions/hkbnpeohgacliadddhjoddiickjnlnfl/` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\hkbnpeohgacliadddhjoddiickjnlnfl\` |

Inside is one directory per installed version. Diff its `src/` against this
repository at the matching tag:

```bash
git checkout v0.4.2
diff -ru src "<extensions-path>/0.4.2_0/src"
diff -u manifest.json "<extensions-path>/0.4.2_0/manifest.json"
```

Expected differences, all added by Chrome rather than by the author:

- a `key` field in `manifest.json` — Chrome inserts the extension's public key
- a `_metadata/` directory containing `computed_hashes.json` and `verified_contents.json`
- `differential_fingerprint`
- on some builds, a `_locales/` directory

Everything under `src/` should be identical. If a line of JavaScript differs
from this repository, that is worth reporting loudly.

### Firefox

Firefox does not unpack an installed add-on. It keeps the AMO-signed XPI, which
is an ordinary ZIP:

| OS | Path |
| --- | --- |
| Linux | `~/.mozilla/firefox/<profile>/extensions/bgg-hard-block@terwox.github.io.xpi` |
| macOS | `~/Library/Application Support/Firefox/Profiles/<profile>/extensions/bgg-hard-block@terwox.github.io.xpi` |
| Windows | `%APPDATA%\Mozilla\Firefox\Profiles\<profile>\extensions\bgg-hard-block@terwox.github.io.xpi` |

`about:support` → **Profile Directory** → **Open Directory** shows which
`<profile>` is in use.

Unzip it and diff against this repository at the matching tag:

```bash
git checkout vX.Y.Z
mkdir -p /tmp/bgg-xpi
unzip -q "<profile>/extensions/bgg-hard-block@terwox.github.io.xpi" -d /tmp/bgg-xpi
diff -ru src /tmp/bgg-xpi/src
diff -u manifest.firefox.json /tmp/bgg-xpi/manifest.json
```

The second diff compares against `manifest.firefox.json`, not `manifest.json`:
the Firefox package ships the Gecko manifest under the `manifest.json` name.

Expected differences, all added by AMO's signing step rather than by the author:

- a `META-INF/` directory holding the signature, typically `manifest.mf`,
  `mozilla.sf`, and `mozilla.rsa`
- possibly different ZIP compression or entry ordering, because signing repacks
  the archive — so compare file contents, not archive bytes, and do not expect
  the XPI's SHA-256 to match the uploaded ZIP's

**Expected; verify after the first release.** No AMO-signed build of this
extension exists yet, so the exact delta has not been observed. Please report a
difference outside that list — and also report an item on the list that does not
actually appear, so this section can be corrected against a real signed XPI.

Everything under `src/` should be identical here too.

## 4. Read the code

The point of the previous three steps is to establish that the code in this
repository is the code you are running. Once you accept that, the privacy
claims become checkable by reading, and the places worth reading are short:

| Question | Where to look |
| --- | --- |
| Does it phone home? | `src/background.js`, `fetchApi` and `assertAllowedApiRequest` — the worker constructs and validates every request |
| What happens to my auth header? | `src/background.js`, `observedAuthorization` and `runBridgeSession`, with `src/page-bridge.js` as a private fallback — ephemeral and never stored or sent to content |
| What gets stored? | `PRIVACY.md` has the complete map; writes are in `src/onboarding.js`, `src/options.js`, and `src/background.js`; `src/content.js` can report only bounded page counters to the worker |
| Does it act before I consent? | `src/content.js` consent gate and `src/background.js`, `runBridgeSession` |
| Where can it run at all? | `manifest.json` and `manifest.firefox.json`, `content_scripts[].matches`, and `isDiscussionUrl` in `src/background.js` |

Version 0.4.2 has no declarative MAIN-world or settings bridge. The manifest
declares only the isolated content filter. After current consent is verified,
`background.js` observes the existing Geekdo authorization header through a
read-only browser request event restricted to BGG-initiated API requests and an
active, supported tab/document. Consent is read for each candidate event so a
cold worker cannot miss the page's startup request burst. The document-bound
`src/page-bridge.js` capture
remains as a private fallback. `src/background.js` performs all authenticated API
work and returns only validated public usernames/status to the isolated script.
No page-writable data bridge participates in persistence.

## Releasing (maintainer)

1. Bump `version` in `manifest.json` **and** `manifest.firefox.json`.
   `scripts/package.sh` refuses to build if the two disagree.
2. Update the disclosure-version ladder in its five modules —
   `src/background.js`, `src/content.js`, `src/popup.js`, `src/options.js`, and
   `src/onboarding.js` — **only if the privacy disclosure text itself changed**.
   The current disclosure is `2026-09-03`. Bumping it forces every existing user
   back through the consent screen, so don't do it for ordinary fixes.
3. Create and activate a virtual environment, then install the hash-locked
   contributor dependency:

   ```bash
   python3 -m venv ../bgg-hard-block-venv
   source ../bgg-hard-block-venv/bin/activate
   python3 -m pip install --require-hashes -r requirements-dev.txt
   ```
4. `./scripts/test.sh`
5. `./scripts/package.sh` — this writes both the Chrome ZIP and the Firefox ZIP.
   Record both SHA-256s.
6. Tag `vX.Y.Z`, push the tag, and attach **both** ZIPs plus their SHA-256s to
   the GitHub release.
7. Upload `artifacts/bgg-hard-block-<version>.zip` to the Chrome Web Store.
8. Before the first AMO upload, confirm that
   `browser_specific_settings.gecko.id` in `manifest.firefox.json` reads
   `bgg-hard-block@terwox.github.io`. That identifier is immutable once AMO has
   accepted it; a mistake there cannot be corrected later without orphaning every
   installed copy.
9. Upload `artifacts/bgg-hard-block-<version>-firefox.zip` at the AMO Developer
   Hub on the **listed** channel, **Firefox desktop only** — the manifest omits
   `gecko_android`, so do not opt into Android. Fill the listing fields from
   [STORE_LISTING_FIREFOX.md](STORE_LISTING_FIREFOX.md) and paste that file's
   **Reviewer notes** section into the reviewer-notes field. No source upload is
   required: nothing is minified, bundled, or transpiled.
10. Expect the `Authorization`-header observation to draw a manual review. Do
    not announce Firefox availability until the listing is approved.

`web-ext sign --channel=listed` can automate step 9 later. It needs an AMO API
key and secret from the Developer Hub; those belong in the central secrets store,
never in this repository and never in CI configuration checked in here.

Uploading a package that differs from the tagged artifact defeats the whole
mechanism above. Build once, ship those exact files to every destination.
