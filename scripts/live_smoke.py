#!/usr/bin/env python3
"""Load the unpacked extension in temporary Chromium and filter a live BGG thread."""

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


THREAD_URL = (
    "https://boardgamegeek.com/thread/3746507/"
    "someone-who-refuses-to-learn-or-teach-their-own-ga"
)
TEST_USERNAME = "Heavenraiser"


def wait_for_file(path: Path, process: subprocess.Popen[bytes], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Chromium exited early with status {process.returncode}")
        if path.exists():
            return
        time.sleep(0.05)
    raise TimeoutError(f"Timed out waiting for {path}")


def debug_port(profile_dir: Path, process: subprocess.Popen[bytes]) -> int:
    marker = profile_dir / "DevToolsActivePort"
    wait_for_file(marker, process)
    return int(marker.read_text(encoding="utf-8").splitlines()[0])


def open_target(port: int, url: str) -> str:
    endpoint = f"http://127.0.0.1:{port}/json/new?{quote(url, safe=':/?&=#')}"
    with urlopen(Request(endpoint, method="PUT"), timeout=5) as response:
        return json.load(response)["webSocketDebuggerUrl"]


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
            exception = message.get("result", {}).get("exceptionDetails")
            if exception:
                description = exception.get("exception", {}).get("description")
                raise RuntimeError(
                    description or exception.get("text", "Runtime evaluation failed")
                )
            return counter, message.get("result", {}).get("result", {}).get("value")


async def seed_cached_block_list(websocket_url: str) -> None:
    async with websockets.connect(websocket_url, max_size=2_000_000) as websocket:
        counter = 0
        deadline = asyncio.get_running_loop().time() + 5
        context = {}
        while asyncio.get_running_loop().time() < deadline:
            counter, context = await evaluate(
                websocket,
                counter,
                "({ href: location.href, hasStorage: Boolean(globalThis.chrome?.storage?.local) })",
            )
            if context.get("hasStorage"):
                break
            await asyncio.sleep(0.05)

        if not context.get("hasStorage"):
            raise RuntimeError(f"Extension storage API unavailable at {context.get('href')}")

        expression = f"""
          chrome.storage.local.set({{
            bggHardBlockerState: {{
              usernames: [{json.dumps(TEST_USERNAME)}],
              status: {{ lastSync: '2026-08-04T00:00:00.000Z' }}
            }}
          }}).then(() => true)
        """
        _, result = await evaluate(websocket, counter, expression)
        if result is not True:
            raise RuntimeError("Could not seed the extension block-list cache")


async def find_extension_id(port: int) -> str:
    websocket_url = open_target(port, "chrome://extensions/")
    expression = """
      (() => {
        const manager = document.querySelector('extensions-manager');
        const list = manager?.shadowRoot?.querySelector('extensions-item-list');
        const items = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])];
        return items.map((item) => ({
          id: item.getAttribute('id') || item.data?.id || '',
          name: item.shadowRoot?.querySelector('#name')?.textContent?.trim() || item.data?.name || ''
        }));
      })()
    """

    async with websockets.connect(websocket_url, max_size=2_000_000) as websocket:
        counter = 0
        deadline = asyncio.get_running_loop().time() + 10
        while asyncio.get_running_loop().time() < deadline:
            counter, items = await evaluate(websocket, counter, expression)
            for item in items or []:
                if item.get("name") == "BGG Hard Block" and item.get("id"):
                    return item["id"]
            await asyncio.sleep(0.1)

    raise TimeoutError("Could not find BGG Hard Block on chrome://extensions")


async def wait_for_filtered_thread(websocket_url: str) -> dict[str, object]:
    expression = f"""
      (() => {{
        const username = {json.dumps(TEST_USERNAME.lower())};
        const posts = [...document.querySelectorAll('gg-post')];
        const postAuthors = posts.map((post) => {{
          const href = post.querySelector(':scope > article.post > .post-header a[href*="/profile/"]')?.getAttribute('href') || '';
          const match = href.match(/\\/profile\\/([^?#/]+)/i);
          return match ? decodeURIComponent(match[1]).trim().toLowerCase() : '';
        }});
        const quoteAuthors = [...document.querySelectorAll('gg-markup-quote')].map((quote) => {{
          const text = quote.querySelector('.c-header .user-attribution')?.textContent || '';
          const match = text.match(/@([^@\\r\\n]+?)\\s*$/);
          return match ? match[1].trim().toLowerCase() : '';
        }});
        return {{
          ready: document.documentElement.hasAttribute('data-bgg-hard-blocker-ready'),
          title: document.title,
          postCount: document.querySelectorAll('article.post').length,
          matchingPosts: postAuthors.filter((author) => author === username).length,
          matchingQuotes: quoteAuthors.filter((author) => author === username).length,
          nativePlaceholders: [...document.querySelectorAll('article.post')].filter((post) => /Blocked User/i.test(post.textContent || '')).length
        }};
      }})()
    """

    async with websockets.connect(websocket_url, max_size=3_000_000) as websocket:
        counter = 0
        deadline = asyncio.get_running_loop().time() + 12
        latest: dict[str, object] = {}
        while asyncio.get_running_loop().time() < deadline:
            counter, value = await evaluate(websocket, counter, expression)
            latest = value if isinstance(value, dict) else {}
            if latest.get("ready") and int(latest.get("postCount", 0)) >= 5:
                return latest
            await asyncio.sleep(0.2)
        return latest


async def run_observed_markup_fallback(websocket_url: str) -> dict[str, object]:
    fixture = f"""
      <main id="extension-smoke-fixture">
        <gg-post id="smoke-blocked-post">
          <article class="post">
            <header class="post-header"><a href="/profile/{TEST_USERNAME}">{TEST_USERNAME}</a></header>
            <div class="post-body">Blocked direct post</div>
          </article>
        </gg-post>
        <gg-post id="smoke-native-placeholder">
          <article class="post">
            <div class="post-body"><span>Blocked User</span><button>Show Anyway</button></div>
          </article>
        </gg-post>
        <gg-post id="smoke-allowed-reply">
          <article class="post">
            <header class="post-header"><a href="/profile/AllowedUser">AllowedUser</a></header>
            <div class="post-body">
              <gg-markup-quote id="smoke-blocked-quote">
                <div class="c-header"><span class="user-attribution">Test Name<br>@{TEST_USERNAME}</span></div>
                <gg-markup-content>Blocked quotation</gg-markup-content>
              </gg-markup-quote>
              <p id="smoke-allowed-text">Allowed reply survives.</p>
            </div>
          </article>
        </gg-post>
      </main>
    """

    async with websockets.connect(websocket_url, max_size=3_000_000) as websocket:
        counter, _ = await evaluate(
            websocket,
            0,
            f"window.stop(); document.body.innerHTML = {json.dumps(fixture)}; true",
        )
        deadline = asyncio.get_running_loop().time() + 3
        latest: dict[str, object] = {}
        while asyncio.get_running_loop().time() < deadline:
            counter, latest = await evaluate(
                websocket,
                counter,
                """
                  ({
                    blockedPostPresent: Boolean(document.getElementById('smoke-blocked-post')),
                    placeholderPresent: Boolean(document.getElementById('smoke-native-placeholder')),
                    blockedQuotePresent: Boolean(document.getElementById('smoke-blocked-quote')),
                    allowedReplyPresent: Boolean(document.getElementById('smoke-allowed-reply')),
                    allowedTextPresent: Boolean(document.getElementById('smoke-allowed-text'))
                  })
                """,
            )
            if (
                not latest.get("blockedPostPresent")
                and not latest.get("placeholderPresent")
                and not latest.get("blockedQuotePresent")
                and latest.get("allowedReplyPresent")
                and latest.get("allowedTextPresent")
            ):
                await asyncio.sleep(0.15)
                return latest
            await asyncio.sleep(0.05)
        return latest


async def read_extension_status(websocket_url: str) -> dict[str, object]:
    async with websockets.connect(websocket_url, max_size=2_000_000) as websocket:
        _, value = await evaluate(
            websocket,
            0,
            "chrome.storage.local.get('bggHardBlockerState')"
            ".then((x) => x.bggHardBlockerState?.status || {})",
        )
        return value if isinstance(value, dict) else {}


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
    parser.add_argument(
        "--extension",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
    )
    args = parser.parse_args()
    extension = args.extension.resolve()

    with tempfile.TemporaryDirectory(prefix="bgg-hard-block-live-") as profile:
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
            start_new_session=True,
        )

        try:
            port = debug_port(profile_dir, process)
            identifier = asyncio.run(find_extension_id(port))
            extension_ws = open_target(
                port, f"chrome-extension://{identifier}/src/popup.html"
            )
            asyncio.run(seed_cached_block_list(extension_ws))
            thread_ws = open_target(port, THREAD_URL)
            page = asyncio.run(wait_for_filtered_thread(thread_ws))
            mode = "live"
            fallback: dict[str, object] = {}
            if int(page.get("postCount", 0)) < 5:
                mode = "observed-markup-fallback"
                fallback = asyncio.run(run_observed_markup_fallback(thread_ws))
            status = asyncio.run(read_extension_status(extension_ws))
        finally:
            stop_process_group(process)

    failures = []
    if not page.get("ready"):
        failures.append("extension did not reveal the forum page")
    if mode == "live":
        if page.get("matchingPosts") != 0:
            failures.append("seeded blocked user's direct posts remain")
        if page.get("matchingQuotes") != 0:
            failures.append("seeded blocked user's quotations remain")
    else:
        if fallback.get("blockedPostPresent"):
            failures.append("fixture blocked post remains")
        if fallback.get("placeholderPresent"):
            failures.append("fixture native placeholder remains")
        if fallback.get("blockedQuotePresent"):
            failures.append("fixture blocked quotation remains")
        if not fallback.get("allowedReplyPresent") or not fallback.get("allowedTextPresent"):
            failures.append("fixture allowed reply was removed")
    if int(status.get("hiddenPosts", 0)) < 1:
        failures.append("extension did not report removing a live post")
    if int(status.get("hiddenQuotes", 0)) < 1:
        failures.append("extension did not report removing a live quotation")

    if failures:
        print(
            json.dumps(
                {
                    "status": "FAIL",
                    "mode": mode,
                    "failures": failures,
                    "page": page,
                    "fallback": fallback,
                    "extension": status,
                }
            )
        )
        return 1

    print(
        json.dumps(
            {
                "status": "PASS",
                "mode": mode,
                "postCount": page["postCount"],
                "removedPosts": status["hiddenPosts"],
                "removedQuotes": status["hiddenQuotes"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
