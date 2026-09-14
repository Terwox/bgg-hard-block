#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Run one HTML fixture in a headless browser and exit on its explicit result.

Chromium is driven over CDP; Firefox over WebDriver BiDi. Both load the
fixture from the same ``file://`` URL. The plan left room to serve ``tests/``
over loopback HTTP in case Firefox refused the ``<script src="../src/*.js">``
each fixture depends on, but it does not: all 22 fixtures load and publish a
result from ``file://``, and no fixture reads a sibling file with ``fetch``.
Keeping both browsers on ``file://`` means one fixture URL, not two, and no
pref is relaxed to get there.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

import websockets

from bidi import BiDi
from chromium_process import (
    background_process_kwargs,
    stop_process_tree,
    temporary_profile,
    wait_for_debug_port,
)
from firefox_process import child_process_spawn_failed, launch_firefox

# One budget and one poll interval for both browsers, so a slow fixture cannot
# pass under one engine and time out under the other.
FIXTURE_TIMEOUT_SECONDS = 8
POLL_SECONDS = 0.05
TIMEOUT_MESSAGE = (
    f"fixture did not publish a result within {FIXTURE_TIMEOUT_SECONDS} seconds"
)


def open_target(port: int, fixture: Path) -> str:
    url = fixture.resolve().as_uri()
    endpoint = f"http://127.0.0.1:{port}/json/new?{quote(url, safe=':/')}"
    request = Request(endpoint, method="PUT")
    with urlopen(request, timeout=5) as response:
        target = json.load(response)
    return target["webSocketDebuggerUrl"]


async def evaluate(websocket, counter: int, expression: str) -> tuple[int, object]:
    counter += 1
    await websocket.send(
        json.dumps(
            {
                "id": counter,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": expression,
                    "returnByValue": True,
                    "awaitPromise": True,
                },
            }
        )
    )

    while True:
        message = json.loads(await websocket.recv())
        if message.get("id") == counter:
            value = message.get("result", {}).get("result", {}).get("value")
            return counter, value


async def wait_for_result(websocket_url: str) -> tuple[str, str]:
    async with websockets.connect(websocket_url, max_size=2_000_000) as websocket:
        counter = 0
        deadline = asyncio.get_running_loop().time() + FIXTURE_TIMEOUT_SECONDS

        while asyncio.get_running_loop().time() < deadline:
            counter, state = await evaluate(
                websocket,
                counter,
                "document.body?.dataset.status || 'loading'",
            )
            if state in {"pass", "fail"}:
                counter, report = await evaluate(
                    websocket,
                    counter,
                    "document.body?.dataset.report || ''",
                )
                return str(state), str(report)
            await asyncio.sleep(POLL_SECONDS)

    return "timeout", TIMEOUT_MESSAGE


async def wait_for_firefox_result(websocket_url: str, url: str) -> tuple[str, str]:
    client = await BiDi.connect(websocket_url, max_size=2_000_000)
    try:
        # Every fixture is a local `file://` page, so nothing here should ever
        # need a certificate exception; only the end-to-end test, which talks to
        # a self-signed stub over TLS, asks for one.
        await client.new_session(accept_insecure_certs=False)
        context = await client.create_tab()
        await client.navigate(context, url)

        loop = asyncio.get_running_loop()
        deadline = loop.time() + FIXTURE_TIMEOUT_SECONDS
        while loop.time() < deadline:
            state = await client.evaluate(
                context, "document.body?.dataset.status || 'loading'"
            )
            if state in {"pass", "fail"}:
                report = await client.evaluate(
                    context, "document.body?.dataset.report || ''"
                )
                return str(state), str(report)
            await asyncio.sleep(POLL_SECONDS)
    finally:
        await client.close()

    return "timeout", TIMEOUT_MESSAGE


def run_chromium(chrome: str, fixture: Path) -> tuple[str, str]:
    with temporary_profile("bgg-hard-block-test-") as profile_dir:
        process = subprocess.Popen(
            [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--allow-file-access-from-files",
                "--no-first-run",
                "--remote-debugging-port=0",
                f"--user-data-dir={profile_dir}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **background_process_kwargs(),
        )

        try:
            port = wait_for_debug_port(profile_dir, process)
            websocket_url = open_target(port, fixture)
            return asyncio.run(wait_for_result(websocket_url))
        finally:
            stop_process_tree(process)


def run_firefox(firefox: str, fixture: Path) -> tuple[str, str]:
    """Run one fixture under Firefox, relaunching once if the browser miscarried.

    The relaunch is gated on the failed-child-process signature -- a browser
    that never started an extension or content process -- and never on a
    fixture that actually published ``fail``. Anything else is reported as it
    happened, exception and all.
    """
    for attempt in range(2):
        process = None
        failure: BaseException | None = None
        state, report = "timeout", TIMEOUT_MESSAGE
        with temporary_profile("bgg-hard-block-test-") as profile:
            try:
                process, websocket_url = launch_firefox(firefox, profile / "profile")
                state, report = asyncio.run(
                    wait_for_firefox_result(websocket_url, fixture.resolve().as_uri())
                )
            except BaseException as error:  # re-raised below, never swallowed
                failure = error
            finally:
                miscarried = child_process_spawn_failed(process)
                if process is not None:
                    stop_process_tree(process)

        if miscarried and state != "pass" and attempt == 0:
            print(
                f"{fixture.stem}: Firefox failed to spawn a content process; "
                "relaunching once",
                file=sys.stderr,
            )
            continue
        if failure is not None:
            raise failure
        return state, report
    return state, report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "firefox"), default="chromium")
    parser.add_argument("--chrome")
    parser.add_argument("--firefox")
    parser.add_argument(
        "--report",
        action="store_true",
        help="print the fixture's structured report after a successful run",
    )
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()

    if args.browser == "firefox":
        if not args.firefox:
            parser.error("--firefox is required with --browser firefox")
        state, report = run_firefox(args.firefox, args.fixture)
    else:
        if not args.chrome:
            parser.error("--chrome is required")
        state, report = run_chromium(args.chrome, args.fixture)

    if state != "pass":
        print(f"{args.fixture.name}: {state.upper()} {report}")
        return 1

    suffix = f" {report}" if args.report and report else ""
    print(f"{args.fixture.stem}: PASS{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
