#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Build the Chrome Web Store and addons.mozilla.org (AMO) upload packages.
#
# Both ZIPs are byte-reproducible; see BUILD.md. The two checked-in manifests
# must agree on "version" so a single tag names both uploads.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
read_version() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$1"
}
version="$(read_version "$repo_dir/manifest.json")"
firefox_version="$(read_version "$repo_dir/manifest.firefox.json")"
if [[ "$version" != "$firefox_version" ]]; then
  echo "manifest.json version $version does not match manifest.firefox.json version $firefox_version" >&2
  exit 1
fi
artifact_dir="$repo_dir/artifacts"
package_file="$artifact_dir/bgg-hard-block-$version.zip"
firefox_package_file="$artifact_dir/bgg-hard-block-$version-firefox.zip"
python3 "$repo_dir/scripts/make_zip.py" "$repo_dir" "$package_file"
python3 "$repo_dir/scripts/make_zip.py" --firefox "$repo_dir" "$firefox_package_file"
echo "$package_file"
echo "$firefox_package_file"
