#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Full check suite: manifest validity, syntax, Node unit tests, and headless
# browser fixtures. Requires a Chrome or Chromium binary; set CHROME_BIN to
# point at one explicitly.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chrome_bin="${CHROME_BIN:-}"

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

python3 -m json.tool "$repo_dir/manifest.json" >/dev/null

for script in "$repo_dir"/src/*.js; do
  node --check "$script"
done

node "$repo_dir/tests/background.test.js"
node "$repo_dir/tests/manifest-scope.test.js"
python3 "$repo_dir/tests/test_release_tooling.py"

for fixture in dom-filter consent-gate onboarding page-bridge page-bridge-security subscription-linking-disabled ui-deferred-status content-runtime mixed-version-runtime lazy-content-runtime cache-hold content-mutation-performance content-reveal-failure bridge-trust-runtime content-large-thread-performance spa-scope-teardown css-failsafe live-angular-quote; do
  python3 "$repo_dir/scripts/browser_test.py" \
    --chrome "$chrome_bin" \
    "$repo_dir/tests/$fixture.html"
done

# End-to-end consent-gate regression. Unlike the fixtures above, this loads the
# real unpacked extension and drives the genuine onboarding button, so it is the
# only check that can catch a consent path that is broken as a whole.
for mode in "" "--tab-first"; do
  python3 "$repo_dir/tests/consent_gate_e2e.py" --chrome "$chrome_bin" $mode
done

echo "All extension checks passed."
