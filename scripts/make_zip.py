#!/usr/bin/env python3
"""Create a ZIP whose root is the contents of a staging directory."""

from __future__ import annotations

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()

    with ZipFile(args.target, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(args.source.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(args.source))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
