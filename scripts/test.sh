#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Full check suite: manifest validity, syntax, Node unit tests, and headless
# browser fixtures. Requires a Chrome or Chromium binary; set CHROME_BIN to
# point at one explicitly. Firefox is optional locally: set FIREFOX_BIN, or
# have firefox on PATH, to add the addons.mozilla.org (AMO) build's checks.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chrome_bin="${CHROME_BIN:-}"
firefox_bin="${FIREFOX_BIN:-}"

if [[ -z "$chrome_bin" ]]; then
  for candidate in \
    google-chrome \
    google-chrome-stable \
    chromium \
    chromium-browser \
    "$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome_bin="$(command -v "$candidate")"
      break
    elif [[ -x "$candidate" ]]; then
      chrome_bin="$candidate"
      break
    fi
  done
fi

if [[ -z "$chrome_bin" ]]; then
  echo "Chrome/Chromium not found. Set CHROME_BIN to run browser tests." >&2
  exit 1
fi

if [[ -z "$firefox_bin" ]]; then
  for candidate in \
    firefox \
    firefox-esr \
    "/c/Program Files/Mozilla Firefox/firefox.exe" \
    "/usr/bin/firefox" \
    "/usr/lib/firefox/firefox" \
    "/opt/firefox/firefox" \
    "/Applications/Firefox.app/Contents/MacOS/firefox"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      firefox_bin="$(command -v "$candidate")"
      break
    elif [[ -x "$candidate" ]]; then
      firefox_bin="$candidate"
      break
    fi
  done
fi

# Firefox is not a hard requirement locally, so a Chrome-only contributor still
# gets a green run. CI sets FIREFOX_BIN explicitly and therefore never skips.
if [[ -z "$firefox_bin" ]]; then
  echo "Firefox not found. Set FIREFOX_BIN to also run the Firefox checks; skipping them." >&2
fi

python3 -m json.tool "$repo_dir/manifest.json" >/dev/null
python3 -m json.tool "$repo_dir/manifest.firefox.json" >/dev/null

for script in "$repo_dir"/src/*.js; do
  node --check "$script"
done

node "$repo_dir/tests/background.test.js"
node "$repo_dir/tests/background-firefox.test.js"
node "$repo_dir/tests/manifest-scope.test.js"
node "$repo_dir/tests/manifest-firefox-scope.test.js"
node "$repo_dir/tests/page-bridge-scope.test.js"
python3 "$repo_dir/tests/test_release_tooling.py"

# tests/fixtures.txt is the single list, shared with the Firefox loop
# below and with the Firefox job in .github/workflows/ci.yml.
while read -r fixture <&3; do
  case "$fixture" in ''|'#'*) continue ;; esac
  python3 "$repo_dir/scripts/browser_test.py" \
    --chrome "$chrome_bin" \
    "$repo_dir/tests/$fixture.html"
done 3< "$repo_dir/tests/fixtures.txt"

# End-to-end consent-gate regression. Unlike the fixtures above, this loads the
# real unpacked extension and drives the genuine onboarding button, so it is the
# only check that can catch a consent path that is broken as a whole.
for mode in "" "--tab-first"; do
  python3 "$repo_dir/tests/consent_gate_e2e.py" --chrome "$chrome_bin" $mode
done

if [[ -n "$firefox_bin" ]]; then
  while read -r fixture <&3; do
    case "$fixture" in ''|'#'*) continue ;; esac
    python3 "$repo_dir/scripts/browser_test.py" \
      --browser firefox \
      --firefox "$firefox_bin" \
      "$repo_dir/tests/$fixture.html"
  done 3< "$repo_dir/tests/fixtures.txt"

  for mode in "" "--tab-first"; do
    python3 "$repo_dir/tests/consent_gate_e2e_firefox.py" --firefox "$firefox_bin" $mode
  done
fi

echo "All extension checks passed."
