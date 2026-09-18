#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Launch a throwaway headless Chrome with this extension loaded unpacked and a
# CDP port open, so the *extension's own contexts* (background service worker,
# onboarding/options/popup pages) can be inspected and driven programmatically.
#
# Why this exists: chrome.storage.local lives in the extension's context, not
# the page's, so a page-level content-script test cannot see consent state,
# block lists, or written status. Browser-extension relays cannot reach
# chrome-extension:// pages either — Chrome forbids one extension from scripting
# another's pages. CDP has no such restriction.
#
#   ./scripts/ext-repro.sh start   # launch, print CDP targets
#   ./scripts/ext-repro.sh stop    # kill it and remove the temp profile
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
port="${EXT_REPRO_PORT:-9333}"
profile="${EXT_REPRO_PROFILE:-/tmp/bgghb-repro-profile}"
chrome_bin="${CHROME_BIN:-$HOME/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome}"

case "${1:-start}" in
  start)
    [[ -x "$chrome_bin" ]] || { echo "Set CHROME_BIN to a Chrome/Chromium binary." >&2; exit 1; }
    rm -rf "$profile"; mkdir -p "$profile"
    nohup "$chrome_bin" --headless=new --remote-debugging-port="$port" \
      --user-data-dir="$profile" \
      --disable-features=DisableDisableExtensionsExceptCommandLineSwitch \
      --disable-extensions-except="$repo_dir" --load-extension="$repo_dir" \
      --no-first-run --no-default-browser-check --mute-audio \
      about:blank >"$profile/chrome.log" 2>&1 &
    for _ in $(seq 1 30); do
      sleep 1
      if curl -sf --max-time 2 "http://127.0.0.1:$port/json/version" >/dev/null; then break; fi
    done
    echo "CDP on http://127.0.0.1:$port  (profile: $profile)"
    curl -s "http://127.0.0.1:$port/json/list" \
      | python3 -c 'import sys,json;[print(f"{t[\"type\"]:16} {t.get(\"url\",\"\")[:90]}") for t in json.load(sys.stdin)]'
    ;;
  stop)
    pkill -f -- "--remote-debugging-port=$port" || true
    rm -rf "$profile"
    echo "stopped; profile removed"
    ;;
  *) echo "usage: $0 [start|stop]" >&2; exit 2 ;;
esac
