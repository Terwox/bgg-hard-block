#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Run one HTML fixture in headless Chromium and exit on its explicit result."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

import websockets


def wait_for_debug_port(profile_dir: Path, process: subprocess.Popen[bytes]) -> int:
    marker = profile_dir / "DevToolsActivePort"
    deadline = time.monotonic() + 10

    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Chromium exited early with status {process.returncode}")
        if marker.exists():
            return int(marker.read_text(encoding="utf-8").splitlines()[0])
        time.sleep(0.05)

    raise TimeoutError("Chromium did not expose a DevTools port")


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
        deadline = asyncio.get_running_loop().time() + 8

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
            await asyncio.sleep(0.05)

    return "timeout", "fixture did not publish a result within 8 seconds"


def stop_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return

    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=3)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", required=True)
    parser.add_argument("fixture", type=Path)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="bgg-hard-block-test-") as profile:
        profile_dir = Path(profile)
        process = subprocess.Popen(
            [
                args.chrome,
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
            start_new_session=True,
        )

        try:
            port = wait_for_debug_port(profile_dir, process)
            websocket_url = open_target(port, args.fixture)
            state, report = asyncio.run(wait_for_result(websocket_url))
        finally:
            stop_process_group(process)

    if state != "pass":
        print(f"{args.fixture.name}: {state.upper()} {report}")
        return 1

    print(f"{args.fixture.stem}: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
