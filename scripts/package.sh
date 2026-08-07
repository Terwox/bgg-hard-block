#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Build the Chrome Web Store upload package.
#
# The staging directory below is the exact set of files that ship. Anything not
# copied here (tests, scripts, store assets, git metadata) is absent from the
# published extension. Keep that list minimal and obvious: a reviewer should be
# able to read this script and know precisely what lands in a user's browser.
#
# The resulting ZIP is byte-reproducible; see BUILD.md.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$repo_dir/manifest.json")"
artifact_dir="$repo_dir/artifacts"
package_file="$artifact_dir/bgg-hard-block-$version.zip"
staging_dir="$(mktemp -d)"

mkdir -p "$artifact_dir"
cp "$repo_dir/manifest.json" "$staging_dir/"
cp -R "$repo_dir/src" "$repo_dir/icons" "$staging_dir/"
cp "$repo_dir/README.md" "$repo_dir/PRIVACY.md" "$repo_dir/LICENSE" "$staging_dir/"

rm -f "$package_file"
python3 "$repo_dir/scripts/make_zip.py" "$staging_dir" "$package_file"

rm -rf "$staging_dir"
echo "$package_file"
