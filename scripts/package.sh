#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$repo_dir/manifest.json")"
artifact_dir="$repo_dir/artifacts"
package_file="$artifact_dir/bgg-hard-block-$version.zip"
staging_dir="$(mktemp -d)"

mkdir -p "$artifact_dir"
cp "$repo_dir/manifest.json" "$staging_dir/"
cp -R "$repo_dir/src" "$repo_dir/icons" "$staging_dir/"
cp "$repo_dir/README.md" "$repo_dir/PRIVACY.md" "$staging_dir/"

rm -f "$package_file"
python3 "$repo_dir/scripts/make_zip.py" "$staging_dir" "$package_file"

rm -rf "$staging_dir"
echo "$package_file"
