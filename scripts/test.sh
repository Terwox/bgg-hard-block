#!/usr/bin/env bash
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

for fixture in dom-filter page-bridge content-runtime cache-hold; do
  python3 "$repo_dir/scripts/browser_test.py" \
    --chrome "$chrome_bin" \
    "$repo_dir/tests/$fixture.html"
done

echo "All extension checks passed."
