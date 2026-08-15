#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""Verify a BGG same-document route receives the discussion-only filter."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import tempfile

import websockets

from live_smoke import (
    TEST_USERNAME,
    evaluate,
    find_extension_id,
    grant_consent,
    open_target,
    seed_cached_block_list,
)
from chromium_process import (
    background_process_kwargs,
    stop_process_tree,
    wait_for_debug_port,
)


NON_DISCUSSION_URL = "https://boardgamegeek.com/boardgame/13/catan"
DISCUSSION_PATH = "/thread/3306128/article/48018767#48018767"


async def wait_for_document(websocket_url: str) -> dict[str, object]:
    async with websockets.connect(websocket_url, max_size=3_000_000) as websocket:
        counter = 0
        deadline = asyncio.get_running_loop().time() + 15
        latest: dict[str, object] = {}
        while asyncio.get_running_loop().time() < deadline:
            counter, value = await evaluate(
                websocket,
                counter,
                "({ href: location.href, readyState: document.readyState, "
                "timeOrigin: performance.timeOrigin, "
                "running: Boolean(document.documentElement?.hasAttribute('data-bgg-hard-blocker-running')) })",
            )
            latest = value if isinstance(value, dict) else {}
            if (
                str(latest.get("href", "")).startswith("https://boardgamegeek.com/")
                and latest.get("readyState") in {"interactive", "complete"}
            ):
                return latest
            await asyncio.sleep(0.1)
        return latest


async def enter_discussion_and_filter(websocket_url: str) -> dict[str, object]:
    fixture = f"""
      <main id="spa-smoke-fixture">
        <gg-post id="spa-blocked-post">
          <article class="post">
            <header class="post-header"><a href="/profile/{TEST_USERNAME}">{TEST_USERNAME}</a></header>
            <div class="post-body">Blocked direct post</div>
          </article>
        </gg-post>
        <gg-post id="spa-native-placeholder">
          <article class="post">
            <div class="post-body"><span>Blocked User</span><button>Show Anyway</button></div>
          </article>
        </gg-post>
        <gg-post id="spa-allowed-reply">
          <article class="post">
            <header class="post-header"><a href="/profile/AllowedUser">AllowedUser</a></header>
            <div class="post-body">
              <gg-markup-quote id="spa-blocked-quote">
                <div class="c-header"><span class="user-attribution">Test Name<br>@{TEST_USERNAME}</span></div>
                <gg-markup-content>Blocked quotation</gg-markup-content>
              </gg-markup-quote>
              <p id="spa-allowed-text">Allowed reply survives.</p>
            </div>
          </article>
        </gg-post>
      </main>
    """

    async with websockets.connect(websocket_url, max_size=3_000_000) as websocket:
        counter, before = await evaluate(
            websocket,
            0,
            "({ href: location.href, timeOrigin: performance.timeOrigin, "
            "running: Boolean(document.documentElement?.hasAttribute('data-bgg-hard-blocker-running')) })",
        )
        counter, routed_href = await evaluate(
            websocket,
            counter,
            # Freeze any in-flight Cloudflare challenge navigation before the
            # synthetic same-document route. Otherwise a late challenge reload
            # can replace the document while this smoke is testing extension
            # routing rather than BoardGameGeek availability.
            f"window.stop(); history.pushState({{}}, '', {json.dumps(DISCUSSION_PATH)}); location.href",
        )

        deadline = asyncio.get_running_loop().time() + 8
        attached: dict[str, object] = {}
        while asyncio.get_running_loop().time() < deadline:
            counter, value = await evaluate(
                websocket,
                counter,
                "({ running: Boolean(document.documentElement?.hasAttribute('data-bgg-hard-blocker-running')), "
                "ready: Boolean(document.documentElement?.hasAttribute('data-bgg-hard-blocker-ready')), "
                "timeOrigin: performance.timeOrigin })",
            )
            attached = value if isinstance(value, dict) else {}
            if attached.get("running") and attached.get("ready"):
                break
            await asyncio.sleep(0.05)

        counter, _ = await evaluate(
            websocket,
            counter,
            f"document.body.innerHTML = {json.dumps(fixture)}; true",
        )

        filtered: dict[str, object] = {}
        deadline = asyncio.get_running_loop().time() + 4
        while asyncio.get_running_loop().time() < deadline:
            counter, value = await evaluate(
                websocket,
                counter,
                "({ "
                "blockedPostPresent: Boolean(document.getElementById('spa-blocked-post')), "
                "placeholderPresent: Boolean(document.getElementById('spa-native-placeholder')), "
                "blockedQuotePresent: Boolean(document.getElementById('spa-blocked-quote')), "
                "allowedReplyPresent: Boolean(document.getElementById('spa-allowed-reply')), "
                "allowedTextPresent: Boolean(document.getElementById('spa-allowed-text')) })",
            )
            filtered = value if isinstance(value, dict) else {}
            if (
                not filtered.get("blockedPostPresent")
                and not filtered.get("placeholderPresent")
                and not filtered.get("blockedQuotePresent")
                and filtered.get("allowedReplyPresent")
                and filtered.get("allowedTextPresent")
            ):
                break
            await asyncio.sleep(0.05)

    return {
        "before": before,
        "routedHref": routed_href,
        "attached": attached,
        "filtered": filtered,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", required=True)
    parser.add_argument(
        "--extension",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
    )
    args = parser.parse_args()
    extension = args.extension.resolve()

    with tempfile.TemporaryDirectory(prefix="bgg-hard-block-spa-") as profile:
        profile_dir = Path(profile)
        process = subprocess.Popen(
            [
                args.chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--no-first-run",
                "--remote-debugging-port=0",
                f"--user-data-dir={profile_dir}",
                f"--disable-extensions-except={extension}",
                f"--load-extension={extension}",
                "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **background_process_kwargs(),
        )

        try:
            port = wait_for_debug_port(profile_dir, process)
            identifier = asyncio.run(find_extension_id(port))
            extension_ws = open_target(
                port, f"chrome-extension://{identifier}/src/onboarding.html"
            )
            asyncio.run(seed_cached_block_list(extension_ws))
            asyncio.run(grant_consent(extension_ws))
            page_ws = open_target(port, NON_DISCUSSION_URL)
            initial = asyncio.run(wait_for_document(page_ws))
            result = asyncio.run(enter_discussion_and_filter(page_ws))
        finally:
            stop_process_tree(process)

    failures = []
    if initial.get("running") or result["before"].get("running"):
        failures.append("filter attached on the unrelated BGG game page")
    if not str(result["routedHref"]).endswith(DISCUSSION_PATH):
        failures.append("history.pushState did not enter the discussion URL")
    if not result["attached"].get("running") or not result["attached"].get("ready"):
        failures.append("same-document discussion route did not receive the filter")
    if result["attached"].get("timeOrigin") != result["before"].get("timeOrigin"):
        failures.append("test unexpectedly performed a full document navigation")

    filtered = result["filtered"]
    if filtered.get("blockedPostPresent"):
        failures.append("same-document route retained the blocked direct post")
    if filtered.get("placeholderPresent"):
        failures.append("same-document route retained the native placeholder")
    if filtered.get("blockedQuotePresent"):
        failures.append("same-document route retained the blocked quotation")
    if not filtered.get("allowedReplyPresent") or not filtered.get("allowedTextPresent"):
        failures.append("same-document route removed the allowed reply")

    report = {
        "status": "FAIL" if failures else "PASS",
        "failures": failures,
        "initial": initial,
        **result,
    }
    print(json.dumps(report))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
