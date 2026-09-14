# Contributing to BGG Hard Block

Thanks for taking a look. This is a small extension with a deliberately narrow
scope, so the most useful contributions are usually bug reports with a concrete
BGG URL, and small selector fixes when BGG changes its markup.

## Ground rules

BGG Hard Block is licensed under **GPL-3.0-or-later**. By contributing, you agree
that your contribution is licensed under the same terms. You retain copyright to
your own work; there is no CLA and no copyright assignment.

## Scope

The extension is intentionally limited. Changes that widen any of the following
will usually be declined, because each one weakens the privacy story that makes
the extension auditable:

- **New permissions.** The extension requests only `scripting` and `storage`,
  plus host access for `boardgamegeek.com` and `api.geekdo.com`. Adding `tabs`,
  `webNavigation`, or `<all_urls>` is out of scope.
- **New network destinations.** The extension talks only to
  `boardgamegeek.com` and `api.geekdo.com`. No analytics, no telemetry, no
  error reporting service, no developer-controlled server.
- **Remote code.** Everything that runs must be in the repository. No CDN
  imports, no `eval`, no dynamically fetched scripts.
- **Build steps that obscure the source.** There is deliberately no bundler,
  minifier, or transpiler; the files in `src/` are the files that ship. See
  [BUILD.md](BUILD.md) for why this matters.
- **Deleting user data at BGG.** Subscription linking is one-way by design: the
  extension may add a subscription block, never remove one.

Feature ideas that stay inside those lines are welcome. Open an issue first for
anything larger than a selector fix, so you don't spend time on something that
turns out to be out of scope.

## Development setup

The extension itself has no runtime dependencies or build step. To contribute,
install the hash-locked browser-test dependency:

```bash
python3 -m venv ../bgg-hard-block-venv
source ../bgg-hard-block-venv/bin/activate
python3 -m pip install --require-hashes -r requirements-dev.txt
```

Then load the extension.

In Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked**, and select the repository folder
4. Accept the disclosure on the onboarding page that opens

In Firefox 153 or newer:

1. Build the Firefox archive with `./scripts/package.sh` (on Windows, without
   bash: `python scripts/make_zip.py . artifacts/bgg-hard-block-<version>-firefox.zip --firefox`)
2. Open `about:debugging#/runtime/this-firefox`
3. **Load Temporary Add-on**, and pick
   `artifacts/bgg-hard-block-<version>-firefox.zip`; the file picker accepts a
   `.zip` or `.xpi` archive as well as a manifest
4. Accept the disclosure and grant site access when Firefox asks for it
5. The add-on disappears when Firefox restarts; load it again

The repository folder cannot be loaded directly in Firefox: Firefox always reads
`manifest.json` from the add-on root, and the checked-in `manifest.json` is the
Chrome one, which declares a background service worker Firefox does not support.
`manifest.firefox.json` is swapped in under the `manifest.json` name only inside
the Firefox package.

Chrome does not always reload the service worker when you edit files. If
behavior looks stale, press the reload icon on the extension card and hard-reload
the BGG tab. Firefox has its own **Reload** button on the `about:debugging` card;
its background event page logs to the Browser Console (Ctrl+Shift+J).

## Tests

```bash
./scripts/test.sh
```

The suite needs a Chrome or Chromium binary — it drives real DOM APIs rather
than mocking them, because most of the risk in this extension is in whether the
selectors match BGG's actual markup. Set `CHROME_BIN` if the script can't find
one automatically.

The Firefox steps need Firefox 153 or newer. Set `FIREFOX_BIN` if the script
can't find one; without it those steps are skipped and the rest of the suite
still runs.

`scripts/test.sh` runs, in order:

1. `manifest.json` JSON validity
2. `node --check` on every file in `src/`
3. the Node unit tests: `tests/background.test.js`,
   `tests/background-firefox.test.js`, `tests/manifest-scope.test.js`,
   `tests/manifest-firefox-scope.test.js`, `tests/page-bridge-scope.test.js`
4. the Python release-tooling tests, `tests/test_release_tooling.py`
5. the headless-browser fixtures in `tests/*.html`, under Chrome
6. `tests/consent_gate_e2e.py`, once plain and once with `--tab-first`
7. with a Firefox binary only: the same `tests/*.html` fixtures again under
   Firefox, then `tests/consent_gate_e2e_firefox.py` plain and with
   `--tab-first`

There is also an optional networked smoke test against a live BGG thread:

```bash
python3 scripts/live_smoke.py --chrome /path/to/chrome
```

Use Chromium or Chrome for Testing; current branded Chrome builds ignore the
unpacked-extension command-line flag. The test uses a disposable signed-out
profile and is not part of CI. It is deliberately Chromium-only; Firefox
coverage runs through `tests/consent_gate_e2e_firefox.py` and
`scripts/browser_test.py --browser firefox` instead.

## Adding a test

When you fix a selector, add the markup shape you fixed it against to the
relevant fixture in `tests/`. The fixtures are plain HTML files that mirror
BGG's real DOM. That is what stops the same regression from coming back the next
time BGG ships a frontend change.

## Style

- No runtime dependencies in the shipped extension. Keep contributor tools
  minimal and hash-locked in `requirements-dev.txt`.
- `"use strict"` at the top of each IIFE.
- Comments explain **why**, not what. If a selector or delay looks arbitrary,
  say what BGG behavior forced it.
- Keep the SPDX header at the top of each file.

## Reporting a BGG markup break

The most valuable bug report includes:

- the BGG URL where it happened (a public thread is ideal)
- what should have been hidden but wasn't, or vice versa
- your browser and its version, plus the extension version — `chrome://extensions`
  in Chrome, `about:support` and `about:addons` in Firefox
- if you can get it, the outer HTML of the post that was handled wrong

Do not paste your BGG session cookie, `GeekAuth` header, or password into an
issue. None of those are needed to diagnose a selector problem.

## Security issues

Please don't open a public issue for a security problem. See
[SECURITY.md](SECURITY.md).
