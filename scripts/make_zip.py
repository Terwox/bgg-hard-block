#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Create the byte-reproducible store upload ZIPs from tracked source.

The same allowlist ships to both targets. The Chrome Web Store ZIP is built
with no overrides at all, so its bytes cannot move. The addons.mozilla.org
(AMO) ZIP is the same archive with ``manifest.firefox.json`` substituted for
the ``manifest.json`` member; see ``FIREFOX_SOURCE_OVERRIDES``.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path, PurePosixPath
from zipfile import ZIP_STORED, ZipFile, ZipInfo

FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
FIXED_EXTERNAL_ATTR = (0o100644) << 16

# `git add -N` registers a path whose index entry is the empty blob. That is
# enough for `git ls-files --error-unmatch` to call the path tracked, even
# though neither the index nor any commit holds its content.
EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

# This is intentionally an exact file list. New source or icon files do not ship
# until a reviewer adds them here, and untracked files can never enter the ZIP.
SHIPPED_FILES = (
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "icons/icon-128.png",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon.svg",
    "manifest.json",
    "src/background.js",
    "src/content-core.js",
    "src/content.css",
    "src/content.js",
    "src/onboarding.css",
    "src/onboarding.html",
    "src/onboarding.js",
    "src/options.css",
    "src/options.html",
    "src/options.js",
    "src/page-bridge.js",
    "src/popup.css",
    "src/popup.html",
    "src/popup.js",
)


# Firefox has no background.service_worker and needs browser_specific_settings,
# so the AMO archive carries a different manifest under the same member name.
FIREFOX_SOURCE_OVERRIDES = {"manifest.json": "manifest.firefox.json"}


def verify_tracked(source: Path, overrides: dict[str, str] | None = None) -> None:
    # Override sources are read into the archive exactly like allowlisted files,
    # so they have to clear the same "must be tracked" bar.
    names = list(SHIPPED_FILES)
    if overrides:
        names.extend(sorted(set(overrides.values())))
    subprocess.run(
        ["git", "-C", str(source), "ls-files", "--error-unmatch", "--", *names],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    # An intent-to-add path clears the check above while its content exists
    # only in the working tree, so packaging it would ship bytes that are in no
    # commit and no index. An ordinary modification to a tracked file keeps a
    # real index blob and still passes: both archives are built from the
    # working tree by design, and BUILD.md documents that.
    listing = subprocess.run(
        ["git", "-C", str(source), "ls-files", "-s", "-z", "--", *names],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout
    intent_to_add = []
    for record in listing.split("\0"):
        if not record:
            continue
        metadata, _, name = record.partition("\t")
        fields = metadata.split(" ")
        if len(fields) < 2 or fields[1] != EMPTY_BLOB:
            continue
        path = source / Path(name)
        if path.is_file() and path.stat().st_size > 0:
            intent_to_add.append(name)
    if intent_to_add:
        raise ValueError(
            "these sources are only intent-to-add (git add -N), so their index "
            "entry is the empty blob and the package would ship content that "
            "is not in Git; run `git add` on them: "
            + ", ".join(sorted(intent_to_add))
        )


def make_zip(
    source: Path, target: Path, overrides: dict[str, str] | None = None
) -> None:
    source = source.resolve()
    # An override key that is not a shipped member would be silently ignored by
    # the loop below, producing an archive that quietly lacks the substitution.
    unknown = sorted(set(overrides or {}) - set(SHIPPED_FILES))
    if unknown:
        raise ValueError(f"override keys are not shipped files: {', '.join(unknown)}")
    verify_tracked(source, overrides)
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, "w", compression=ZIP_STORED) as archive:
        for relative_name in sorted(SHIPPED_FILES, key=PurePosixPath):
            source_name = (overrides or {}).get(relative_name, relative_name)
            path = source / Path(source_name)
            if not path.is_file():
                raise FileNotFoundError(f"shipped file is missing: {source_name}")

            info = ZipInfo(filename=relative_name, date_time=FIXED_TIMESTAMP)
            info.compress_type = ZIP_STORED
            info.external_attr = FIXED_EXTERNAL_ATTR
            info.create_system = 3
            archive.writestr(info, path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="repository root")
    parser.add_argument("target", type=Path, help="ZIP file to write")
    parser.add_argument(
        "--firefox",
        action="store_true",
        help="substitute manifest.firefox.json for the manifest.json member",
    )
    args = parser.parse_args()

    make_zip(
        args.source,
        args.target,
        FIREFOX_SOURCE_OVERRIDES if args.firefox else None,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
