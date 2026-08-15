#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Cross-platform, background-safe Chromium process-tree lifecycle helpers."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import time
from typing import Any

CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
SIGTERM = getattr(signal, "SIGTERM", 15)
SIGKILL = getattr(signal, "SIGKILL", 9)


def background_process_kwargs() -> dict[str, Any]:
    """Return Popen flags that isolate Chromium without showing a Windows UI."""
    if os.name == "nt":
        return {
            "creationflags": (
                CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
            )
        }
    return {"start_new_session": True}


def wait_for_debug_port(
    profile_dir: Path,
    process: subprocess.Popen[bytes],
    timeout: float = 30,
) -> int:
    """Wait until Chromium's DevTools port marker is complete and readable.

    On Windows the marker can briefly exist while Chromium still has it locked,
    and a cold hosted runner can take more than ten seconds to create it. Retry
    transient read and parse failures while continuing to fail immediately if
    Chromium exits.
    """
    marker = profile_dir / "DevToolsActivePort"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Chromium exited early with status {process.returncode}")
        try:
            lines = marker.read_text(encoding="utf-8").splitlines()
            port = int(lines[0])
            if 1 <= port <= 65535:
                return port
        except (OSError, IndexError, ValueError):
            pass
        time.sleep(0.05)
    raise TimeoutError("Chromium did not expose a readable DevTools port")


def stop_process_tree(process: subprocess.Popen[bytes], timeout: float = 3) -> None:
    """Terminate Chromium and descendants, escalating after ``timeout`` seconds."""
    if process.poll() is not None:
        return

    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )
            process.wait(timeout=timeout)
        return

    os.killpg(process.pid, SIGTERM)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, SIGKILL)
        process.wait(timeout=timeout)
