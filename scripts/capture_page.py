#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Capture a local HTML or SVG page at an exact Chrome Web Store asset size."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen

import websockets

from chromium_process import (
    background_process_kwargs,
    stop_process_tree,
    wait_for_debug_port,
)


def open_target(port: int, url: str) -> str:
    endpoint = f"http://127.0.0.1:{port}/json/new?{quote(url, safe=':/?&=#')}"
    with urlopen(Request(endpoint, method="PUT"), timeout=5) as response:
        return json.load(response)["webSocketDebuggerUrl"]


async def command(websocket, counter: int, method: str, params: dict | None = None) -> tuple[int, dict]:
    counter += 1
    await websocket.send(json.dumps({"id": counter, "method": method, "params": params or {}}))
    while True:
        message = json.loads(await websocket.recv())
        if message.get("id") == counter:
            if "error" in message:
                raise RuntimeError(message["error"])
            return counter, message.get("result", {})


async def capture(websocket_url: str, url: str, width: int, height: int) -> bytes:
    async with websockets.connect(websocket_url, max_size=8_000_000) as websocket:
        counter = 0
        counter, _ = await command(
            websocket,
            counter,
            "Emulation.setDeviceMetricsOverride",
            {
                "width": width,
                "height": height,
                "deviceScaleFactor": 1,
                "mobile": False,
            },
        )
        counter, _ = await command(websocket, counter, "Page.enable")
        counter, _ = await command(websocket, counter, "Page.navigate", {"url": url})
        deadline = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < deadline:
            counter, state = await command(
                websocket,
                counter,
                "Runtime.evaluate",
                {"expression": "document.readyState", "returnByValue": True},
            )
            if state.get("result", {}).get("value") == "complete":
                break
            await asyncio.sleep(0.05)
        counter, _ = await command(
            websocket,
            counter,
            "Runtime.evaluate",
            {"expression": "scrollTo(0, 0); true", "returnByValue": True},
        )
        await asyncio.sleep(0.2)
        counter, result = await command(
            websocket,
            counter,
            "Page.captureScreenshot",
            {
                "format": "png",
                "fromSurface": True,
                "captureBeyondViewport": False,
                "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1},
            },
        )
        return base64.b64decode(result["data"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", required=True)
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="bgg-hard-block-capture-") as profile:
        profile_dir = Path(profile)
        process = subprocess.Popen(
            [
                args.chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
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
            websocket_url = open_target(port, "about:blank")
            png = asyncio.run(
                capture(
                    websocket_url,
                    args.source.resolve().as_uri(),
                    args.width,
                    args.height,
                )
            )
        finally:
            stop_process_tree(process)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(png)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
