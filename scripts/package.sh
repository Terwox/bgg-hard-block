#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Build the Chrome Web Store upload package.
#
# The resulting ZIP is byte-reproducible; see BUILD.md.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$repo_dir/manifest.json")"
artifact_dir="$repo_dir/artifacts"
package_file="$artifact_dir/bgg-hard-block-$version.zip"
python3 "$repo_dir/scripts/make_zip.py" "$repo_dir" "$package_file"
echo "$package_file"
