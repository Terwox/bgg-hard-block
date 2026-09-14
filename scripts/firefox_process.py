#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Launch headless Firefox with a throwaway profile and find its BiDi endpoint.

Firefox writes no ``DevToolsActivePort`` marker, so the counterpart of
``chromium_process.wait_for_debug_port`` is a stderr scrape for the line
``WebDriver BiDi listening on ws://127.0.0.1:<port>``. The process-tree and
hidden-window helpers are the Chromium ones, imported rather than copied.
"""

from __future__ import annotations

import collections
import contextlib
from pathlib import Path
import queue
import subprocess
import threading

from chromium_process import background_process_kwargs, stop_process_tree

BIDI_BANNER = "WebDriver BiDi listening on ws://"

# A Firefox that starts, announces BiDi, and then cannot spawn a content
# process logs this pair and nothing else: the parent stays up, so no exit
# status says anything, and every browsing context the caller wanted is simply
# never created. Under CPU contention -- 22 fixture launches back to back --
# Windows fails the child `CreateProcess` with 0x800700E9 (-2147024809, "no
# process is on the other end of the pipe"). The two markers are checked
# separately because Gecko does not guarantee them on one line.
CHILD_SPAWN_MARKERS = ("Failed to launch", "-2147024809")

# Pref names and values only; the file is written as `user_pref(...)` lines.
#
# `remote.active-protocols` is deliberately absent: it was removed in Firefox
# 141 when CDP support ended and BiDi became the only protocol
# (firefox-source-docs.mozilla.org/remote/Prefs.html). Setting it now would
# only leave a dead pref in the profile.
#
# `xpinstall.signatures.required` is also deliberately absent. BiDi installs
# the archive temporarily, which needs no signature.
BASE_PREFS: dict[str, object] = {
    "browser.shell.checkDefaultBrowser": False,
    "app.update.auto": False,
    "app.update.enabled": False,
    "datareporting.policy.dataSubmissionEnabled": False,
    "toolkit.telemetry.enabled": False,
    "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
}


def _quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _format_pref(name: str, value: object) -> str:
    if isinstance(value, bool):
        rendered = "true" if value else "false"
    elif isinstance(value, int):
        rendered = str(value)
    else:
        rendered = _quote(str(value))
    return f"user_pref({_quote(name)}, {rendered});"


def profile_prefs(proxy_port: int | None = None) -> dict[str, object]:
    """Return the prefs for a test profile, optionally routed through a proxy."""
    prefs = dict(BASE_PREFS)
    if proxy_port is None:
        return prefs
    # Manual proxy for both HTTP and HTTPS. The stub is on loopback and the
    # hijacking pref is what stops Firefox from bypassing the proxy for it.
    prefs.update(
        {
            "network.proxy.type": 1,
            "network.proxy.http": "127.0.0.1",
            "network.proxy.http_port": proxy_port,
            "network.proxy.ssl": "127.0.0.1",
            "network.proxy.ssl_port": proxy_port,
            "network.proxy.allow_hijacking_localhost": True,
            "network.proxy.no_proxies_on": "",
        }
    )
    return prefs


def write_user_js(profile_dir: Path, proxy_port: int | None = None) -> Path:
    """Create ``profile_dir`` and write its ``user.js``; return that path."""
    profile_dir.mkdir(parents=True, exist_ok=True)
    target = profile_dir / "user.js"
    prefs = profile_prefs(proxy_port)
    target.write_text(
        "".join(f"{_format_pref(name, value)}\n" for name, value in prefs.items()),
        encoding="utf-8",
    )
    return target


def _drain_stderr(
    stream, banner_queue: "queue.Queue[str]", tail: collections.deque
) -> None:
    """Keep stderr moving forever, announcing the BiDi banner once."""
    announced = False
    for raw in iter(stream.readline, b""):
        line = raw.decode("utf-8", "replace").rstrip()
        tail.append(line)
        if not announced and BIDI_BANNER in line:
            announced = True
            banner_queue.put(line.split(BIDI_BANNER, 1)[1].strip().rstrip("/"))
    stream.close()


def wait_for_bidi_endpoint(
    process: subprocess.Popen[bytes],
    banner_queue: "queue.Queue[str]",
    tail: collections.deque,
    timeout: float = 60,
) -> str:
    """Return ``host:port`` from the BiDi banner, or explain why it never came."""
    try:
        return banner_queue.get(timeout=timeout)
    except queue.Empty:
        pass
    if process.poll() is not None:
        raise RuntimeError(
            f"Firefox exited early with status {process.returncode}: "
            + " | ".join(tail)
        )
    raise TimeoutError("Firefox did not announce a WebDriver BiDi endpoint")


def child_process_spawn_failed(process: subprocess.Popen[bytes] | None) -> bool:
    """Whether Firefox's stderr carries the failed-child-process signature.

    This is a browser startup failure, not a product failure, and it is the one
    shape the harness is allowed to relaunch over: no extension code ever ran,
    so there is no assertion result to paper over.
    """
    tail = getattr(process, "stderr_tail", ()) if process is not None else ()
    lines = list(tail)
    return all(any(marker in line for line in lines) for marker in CHILD_SPAWN_MARKERS)


def launch_firefox(
    binary: str,
    profile_dir: Path,
    proxy_port: int | None = None,
    timeout: float = 60,
) -> tuple[subprocess.Popen[bytes], str]:
    """Start headless Firefox and return the process and its BiDi websocket URL.

    ``--no-remote --new-instance`` keep this out of any Firefox the developer
    already has open, and ``--remote-debugging-port 0`` asks for a free port.
    ``--remote-allow-system-access`` is required from Firefox 155: without it
    BiDi ``script.evaluate`` in a ``moz-extension://`` context (where the e2e
    reads extension storage) is refused with "System access is required".
    Firefox 153 and 154 accept the flag and did not need it.
    """
    write_user_js(profile_dir, proxy_port)
    process = subprocess.Popen(
        [
            binary,
            "--headless",
            "--no-remote",
            "--new-instance",
            "--remote-allow-system-access",
            "--profile",
            str(profile_dir),
            "--remote-debugging-port",
            "0",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        **background_process_kwargs(),
    )

    banner_queue: "queue.Queue[str]" = queue.Queue()
    tail: collections.deque = collections.deque(maxlen=200)
    threading.Thread(
        target=_drain_stderr,
        args=(process.stderr, banner_queue, tail),
        daemon=True,
    ).start()

    try:
        host_port = wait_for_bidi_endpoint(process, banner_queue, tail, timeout)
    except BaseException:
        # A best-effort kill must never replace the launch diagnosis:
        # stop_process_tree can raise ProcessLookupError (POSIX, tree already
        # gone) or TimeoutExpired (post-SIGKILL wait), and either would hide
        # the RuntimeError that says why Firefox never came up.
        with contextlib.suppress(Exception):
            stop_process_tree(process)
        raise
    # A Firefox that starts and *then* fails to spawn child processes
    # announces that here and nowhere else, and the browser it leaves
    # behind never runs an extension background page. Keep the tail on the
    # process the caller already holds, so a later diagnosis can quote it
    # without this module's other caller changing how it unpacks the pair.
    process.stderr_tail = tail
    return process, f"ws://{host_port}/session"
