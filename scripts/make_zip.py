#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Create the byte-reproducible Chrome Web Store ZIP from tracked source."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path, PurePosixPath
from zipfile import ZIP_STORED, ZipFile, ZipInfo

FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
FIXED_EXTERNAL_ATTR = (0o100644) << 16

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


def verify_tracked(source: Path) -> None:
    subprocess.run(
        ["git", "-C", str(source), "ls-files", "--error-unmatch", "--", *SHIPPED_FILES],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def make_zip(source: Path, target: Path) -> None:
    source = source.resolve()
    verify_tracked(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, "w", compression=ZIP_STORED) as archive:
        for relative_name in sorted(SHIPPED_FILES, key=PurePosixPath):
            path = source / Path(relative_name)
            if not path.is_file():
                raise FileNotFoundError(f"shipped file is missing: {relative_name}")

            info = ZipInfo(filename=relative_name, date_time=FIXED_TIMESTAMP)
            info.compress_type = ZIP_STORED
            info.external_attr = FIXED_EXTERNAL_ATTR
            info.create_system = 3
            archive.writestr(info, path.read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="repository root")
    parser.add_argument("target", type=Path, help="ZIP file to write")
    args = parser.parse_args()

    make_zip(args.source, args.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
