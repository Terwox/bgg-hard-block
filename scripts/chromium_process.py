#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Cross-platform, background-safe Chromium process-tree lifecycle helpers."""

from __future__ import annotations

import contextlib
import csv
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable, Iterator

CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
SIGTERM = getattr(signal, "SIGTERM", 15)
SIGKILL = getattr(signal, "SIGKILL", 9)

# How long teardown waits for the *whole* tree to be gone, not just the parent
# `taskkill` was pointed at. Chromium's renderer and network processes keep the
# profile's SQLite files (`DataSharingDB`) open a little past the parent's exit,
# and Firefox does the same with `startupCache.8.little`; deleting the profile
# before they are gone is the `PermissionError: [WinError 32]` that used to fail
# an otherwise passing fixture.
TREE_EXIT_TIMEOUT = 10.0
TREE_POLL_SECONDS = 0.1

# A profile directory that is still locked when the barrier gives up gets a
# bounded second chance here rather than an immediate `ignore_cleanup_errors`.
PROFILE_CLEANUP_TIMEOUT = 5.0
PROFILE_CLEANUP_POLL_SECONDS = 0.25


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


def _taskkill(pid: int, force: bool) -> set[int]:
    """Kill ``pid``'s tree and return the PIDs ``taskkill`` says it signalled.

    ``taskkill /T`` already walks the tree and prints one line per process it
    reached, so its own stdout is the process list -- no second enumerator is
    needed. That matters on Windows 11, where ``wmic`` is no longer installed by
    default and a ``Get-CimInstance`` call would mean spawning PowerShell on
    every teardown; ``tasklist`` alone cannot do it, because it reports no
    parent PIDs. A parent's death does not reparent its children on Windows, so
    a list captured at kill time stays the right list to wait on.
    """
    command = ["taskkill", "/PID", str(pid), "/T"]
    if force:
        command.append("/F")
    result = subprocess.run(
        command,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    return _reported_pids(result.stdout)


def _reported_pids(stdout: object) -> set[int]:
    """Parse ``SUCCESS: ... PID <n> ...`` lines out of ``taskkill``'s stdout."""
    if isinstance(stdout, bytes):
        text = stdout.decode("utf-8", "replace")
    elif isinstance(stdout, str):
        text = stdout
    else:
        return set()

    pids: set[int] = set()
    for line in text.splitlines():
        if "SUCCESS" not in line:
            continue
        # Only the *first* PID on the line, which is the process taskkill
        # actually signalled. The trailing "(child process of PID <n>)" names
        # that process's parent, and for the root of the tree that parent is
        # this interpreter -- which is very much still running, and which an
        # earlier draft of this parser waited ten futile seconds for.
        words = line.replace("(", " ").replace(")", " ").split()
        for index, word in enumerate(words[:-1]):
            if word == "PID" and words[index + 1].rstrip(".").isdigit():
                pids.add(int(words[index + 1].rstrip(".")))
                break
    return pids


def _running_pids(candidates: set[int]) -> set[int]:
    """Return the subset of ``candidates`` that ``tasklist`` still reports."""
    if not candidates:
        return set()
    try:
        result = subprocess.run(
            ["tasklist", "/FO", "CSV", "/NH"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError:
        # Without a usable `tasklist` there is nothing to wait on; degrade to
        # the old unverified teardown rather than block for the full budget.
        return set()

    stdout = result.stdout
    if isinstance(stdout, bytes):
        text = stdout.decode("utf-8", "replace")
    elif isinstance(stdout, str):
        text = stdout
    else:
        return set()

    running: set[int] = set()
    # The memory column is quoted and contains commas, so this is CSV, not split.
    for row in csv.reader(text.splitlines()):
        if len(row) < 2 or not row[1].isdigit():
            continue
        pid = int(row[1])
        if pid in candidates:
            running.add(pid)
    return running


def wait_for_tree_exit(
    pids: Iterable[int],
    timeout: float = TREE_EXIT_TIMEOUT,
    interval: float = TREE_POLL_SECONDS,
) -> set[int]:
    """Block until none of ``pids`` is running; return whoever outlasted it."""
    remaining = {int(pid) for pid in pids}
    deadline = time.monotonic() + timeout
    while remaining:
        remaining = _running_pids(remaining)
        if not remaining or time.monotonic() >= deadline:
            break
        time.sleep(interval)
    return remaining


def wait_for_group_exit(
    pgid: int,
    timeout: float = TREE_EXIT_TIMEOUT,
    interval: float = TREE_POLL_SECONDS,
) -> bool:
    """POSIX counterpart: block until process group ``pgid`` is empty."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            # Signal 0 probes the whole group without touching it. Deliberately
            # not `os.killpg`, which callers mock to assert what teardown sent.
            os.kill(-pgid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            # No way to probe (including a non-POSIX host under test): report
            # the group as gone rather than burn the whole budget on a guess.
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def stop_process_tree(
    process: subprocess.Popen[bytes],
    timeout: float = 3,
    barrier_timeout: float = TREE_EXIT_TIMEOUT,
) -> set[int]:
    """Terminate the browser's whole tree and wait, bounded, for it to be gone.

    Returns the PIDs still alive when the barrier expired -- empty on the
    normal path. A non-empty return is also announced on stderr, because the
    caller is usually a ``finally`` block that must not raise over the test
    result it is tearing down.
    """
    if process.poll() is not None:
        return set()

    if os.name == "nt":
        tree = {process.pid} | _taskkill(process.pid, force=False)
        try:
            process.wait(timeout=timeout)
            survivors = wait_for_tree_exit(tree, barrier_timeout)
        except subprocess.TimeoutExpired:
            survivors = tree
        if survivors:
            tree |= _taskkill(process.pid, force=True)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=timeout)
            survivors = wait_for_tree_exit(tree, barrier_timeout)
        if survivors:
            print(
                "warning: browser processes outlived teardown after "
                f"{barrier_timeout:g}s: {sorted(survivors)}",
                file=sys.stderr,
            )
        return survivors

    os.killpg(process.pid, SIGTERM)
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, SIGKILL)
        process.wait(timeout=timeout)
    if not wait_for_group_exit(process.pid, barrier_timeout):
        print(
            "warning: browser process group "
            f"{process.pid} outlived teardown after {barrier_timeout:g}s",
            file=sys.stderr,
        )
        return {process.pid}
    return set()


def remove_profile_tree(
    path: Path,
    timeout: float = PROFILE_CLEANUP_TIMEOUT,
    interval: float = PROFILE_CLEANUP_POLL_SECONDS,
) -> bool:
    """Delete a browser profile, retrying while Windows still holds a file.

    Returns whether the directory is gone. A leak is printed, never silent: an
    unnamed leftover profile in ``%TEMP%`` is how these accumulate unnoticed.
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            shutil.rmtree(path)
            return True
        except FileNotFoundError:
            return True
        except PermissionError:
            if time.monotonic() >= deadline:
                break
            time.sleep(interval)

    shutil.rmtree(path, ignore_errors=True)
    if Path(path).exists():
        print(
            f"warning: leaked browser profile directory {path} "
            f"(still locked after {timeout:g}s)",
            file=sys.stderr,
        )
        return False
    return True


@contextlib.contextmanager
def temporary_profile(
    prefix: str, timeout: float = PROFILE_CLEANUP_TIMEOUT
) -> Iterator[Path]:
    """``TemporaryDirectory`` whose cleanup tolerates a browser still exiting."""
    directory = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        yield directory
    finally:
        remove_profile_tree(directory, timeout)
