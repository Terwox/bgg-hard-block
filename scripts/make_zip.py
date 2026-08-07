#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Create a deterministic ZIP whose root is the contents of a staging directory.

Determinism matters here. The Chrome Web Store has no official reproducible-build
programme, so the only way a reviewer can confirm that the published extension
matches this repository is to rebuild the package themselves and compare hashes.
That only works if two builds of the same source produce byte-identical output.

A default ``ZipFile.write`` does not: it records each file's modification time
and its on-disk permission bits, both of which vary between machines and between
fresh clones. This script therefore normalises three things:

* **Timestamps** are pinned to ``FIXED_TIMESTAMP`` rather than the file's mtime.
* **Permissions** are pinned to 0644, so a contributor's umask cannot change the
  archive.
* **Entry order** is sorted, so filesystem iteration order cannot change it
  either.

The chosen epoch is 1980-01-01, the earliest value the ZIP format can represent.
See BUILD.md for the full verification procedure.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

# The ZIP format stores MS-DOS timestamps, which cannot represent anything before
# 1980-01-01 00:00:00. Using the floor value makes the intent obvious: this is not
# a real build time, it is a deliberately discarded one.
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

# Regular file (0o100000), mode 0644, shifted into the high 16 bits where the ZIP
# spec keeps external attributes for Unix-created archives.
FIXED_EXTERNAL_ATTR = (0o100644) << 16


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="staging directory to archive")
    parser.add_argument("target", type=Path, help="ZIP file to write")
    args = parser.parse_args()

    with ZipFile(args.target, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        # Sorted iteration keeps the central directory in a stable order. Without
        # this, two builds of identical source can differ purely because the
        # filesystem returned entries in a different sequence.
        for path in sorted(args.source.rglob("*")):
            if not path.is_file():
                continue

            # Build the entry metadata by hand rather than letting ZipFile derive
            # it from the file on disk, which is where mtime and umask leak in.
            info = ZipInfo(
                filename=path.relative_to(args.source).as_posix(),
                date_time=FIXED_TIMESTAMP,
            )
            info.compress_type = ZIP_DEFLATED
            info.external_attr = FIXED_EXTERNAL_ATTR
            # 3 == Unix. Pinning it stops a Windows build from producing a
            # different archive than a Linux one for the same source.
            info.create_system = 3

            archive.writestr(info, path.read_bytes())

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
