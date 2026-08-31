#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""End-to-end regression test for the consent gate.

Every other browser fixture calls ``filterDom`` directly against a mocked
``chrome`` object, so none of them exercises the path that actually matters to a
user: grant consent on the real onboarding page, load a real discussion URL, and
have the extension end up filtering and recording state. A total functional
failure of that path passed 110 unit tests and 18 fixtures.

This test drives the real extension. It loads the unpacked extension into
headless Chrome, points ``boardgamegeek.com`` and ``api.geekdo.com`` at a local
HTTPS stub with ``--host-resolver-rules``, clicks the genuine "Agree and enable"
button, opens a genuine ``https://boardgamegeek.com/thread/...`` URL, and then
reads ``chrome.storage.local`` from the extension's own context.

The assertions describe the whole user-visible contract:

  1. the consent record is written by the onboarding page,
  2. the content script gets past its consent gate (``RUNNING_ATTRIBUTE`` is
     only set on the last line of the script, so its presence proves the gate
     opened),
  3. the page is revealed rather than left hidden,
  4. a blocked user's post is actually redacted, and
  5. ``bggHardBlockerState`` exists in extension storage.

Usage:  python3 tests/consent_gate_e2e.py --chrome /path/to/chrome
"""

from __future__ import annotations

import argparse
import asyncio
import json
import http.server
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
from urllib.parse import quote
from urllib.request import Request, urlopen

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from chromium_process import (  # noqa: E402
    background_process_kwargs,
    stop_process_tree,
    wait_for_debug_port,
)

BLOCKED_USER_ID = 12345
BLOCKED_USERNAME = "BlockedUser"
ALLOWED_USERNAME = "Here2024"
THREAD_PATH = "/thread/1/article/1"

# The MAIN-world bridge waits 4s for an authorization and the service worker
# gives the whole capture 5s, so the stub page must issue its authenticated
# request promptly. BGG's own Angular app is what does this in production.
DISCUSSION_PAGE = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Fake BGG discussion thread</title>
    <script>
      // Stand-in for BGG's Angular app calling its own API with the signed-in
      // user's credential. background.js observes this request through
      // webRequest and reuses the header for its own API calls.
      fetch("https://api.geekdo.com/api/thread/1", {{
        headers: {{ Authorization: "GeekAuth e2e-test-token" }}
      }}).catch(() => {{}});
    </script>
  </head>
  <body>
    <gg-post id="post-blocked">
      <article class="post">
        <header class="post-header"><a href="/profile/{BLOCKED_USERNAME}">{BLOCKED_USERNAME}</a></header>
        <div class="post-body"><p>Text from the blocked user.</p></div>
      </article>
    </gg-post>
    <gg-post id="post-allowed">
      <article class="post">
        <header class="post-header"><a href="/profile/{ALLOWED_USERNAME}">{ALLOWED_USERNAME}</a></header>
        <div class="post-body"><p>Text that must survive.</p></div>
      </article>
    </gg-post>
  </body>
</html>
"""


class StubHandler(http.server.BaseHTTPRequestHandler):
    """Minimal stand-in for boardgamegeek.com and api.geekdo.com."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # noqa: D102 - silence the test run
        pass

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Accept")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, payload: object) -> None:
        self._send(200, json.dumps(payload).encode(), "application/json")

    def do_OPTIONS(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        self._send(204, b"", "text/plain")

    def do_PUT(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        # Subscription linking issues PUT /api/user/<id>/blocks.
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        host = (self.headers.get("Host") or "").split(":")[0]
        path = self.path.split("?")[0]

        if host == "api.geekdo.com":
            if path == "/api/userblock":
                self._json({"userIds": [BLOCKED_USER_ID]})
            elif path == f"/api/user/{BLOCKED_USER_ID}":
                self._json({"username": BLOCKED_USERNAME})
            elif path == "/api/blocks":
                self._json({"feeds": [], "links": []})
            else:
                self._json({"ok": True})
            return

        self._send(200, DISCUSSION_PAGE.encode(), "text/html; charset=utf-8")


def make_certificate(directory: Path) -> tuple[Path, Path]:
    """Create a self-signed cert covering both stubbed hosts."""
    key = directory / "stub-key.pem"
    cert = directory / "stub-cert.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", "/CN=boardgamegeek.com",
            "-addext", "subjectAltName=DNS:boardgamegeek.com,DNS:api.geekdo.com",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return key, cert


def start_stub_server(key: Path, cert: Path) -> tuple[http.server.ThreadingHTTPServer, int]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert), keyfile=str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def http_json(url: str, method: str = "GET") -> object:
    request = Request(url, method=method)
    with urlopen(request, timeout=10) as response:
        return json.load(response)


class Cdp:
    """Thin CDP wrapper: one websocket per target, evaluate-and-return."""

    def __init__(self, websocket) -> None:
        self._websocket = websocket
        self._counter = 0

    async def evaluate(self, expression: str, timeout: float = 20) -> object:
        self._counter += 1
        message_id = self._counter
        await self._websocket.send(
            json.dumps(
                {
                    "id": message_id,
                    "method": "Runtime.evaluate",
                    "params": {
                        "expression": expression,
                        "returnByValue": True,
                        "awaitPromise": True,
                    },
                }
            )
        )
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            raw = await asyncio.wait_for(self._websocket.recv(), timeout=timeout)
            message = json.loads(raw)
            if message.get("id") != message_id:
                continue
            result = message.get("result", {})
            if "exceptionDetails" in result:
                text = result["exceptionDetails"].get("text", "evaluation failed")
                detail = result["exceptionDetails"].get("exception", {}).get("description")
                raise RuntimeError(detail or text)
            return result.get("result", {}).get("value")
        raise TimeoutError(f"CDP evaluate timed out: {expression[:60]}")


async def find_target(port: int, predicate, timeout: float = 30) -> dict:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        for target in http_json(f"http://127.0.0.1:{port}/json/list"):
            if predicate(target):
                return target
        await asyncio.sleep(0.2)
    raise TimeoutError("no matching CDP target appeared")


async def run(port: int, failures: list[str], report: dict, tab_first: bool) -> None:
    # 1. The extension's onboarding page is opened by background.js on install.
    #    It is also the only context that can read chrome.storage.local for us.
    onboarding = await find_target(
        port,
        lambda t: t.get("url", "").startswith("chrome-extension://")
        and t.get("url", "").endswith("onboarding.html"),
    )
    report["extensionUrl"] = onboarding["url"]

    thread_url = f"https://boardgamegeek.com{THREAD_PATH}"
    new_tab = f"http://127.0.0.1:{port}/json/new?{quote(thread_url, safe=':/')}"

    async with websockets.connect(
        onboarding["webSocketDebuggerUrl"], max_size=8_000_000
    ) as socket:
        extension = Cdp(socket)

        # 1b. Optionally open the discussion tab *before* consent, which is what
        #     a real user has: a BGG tab already sitting open when they agree.
        #     background.js promises to hard-refresh those tabs on the storage
        #     change; the marker below survives only if that refresh never fires.
        pre_opened = None
        if tab_first:
            pre_opened = http_json(new_tab, method="PUT")
            pre_socket = await websockets.connect(
                pre_opened["webSocketDebuggerUrl"], max_size=8_000_000
            )
            pre_page = Cdp(pre_socket)
            await asyncio.sleep(1.5)
            await pre_page.evaluate("window.__preConsentMarker = 'present'; 'ok'")

        # 2. Click the genuine consent button.
        await extension.evaluate(
            "new Promise((resolve) => {"
            "  const agree = document.getElementById('agree');"
            "  if (!agree) { resolve('missing'); return; }"
            "  agree.click();"
            "  setTimeout(() => resolve('clicked'), 500);"
            "})"
        )

        consent = await extension.evaluate(
            "chrome.storage.local.get('bggHardBlockerConsent')"
            ".then((v) => v.bggHardBlockerConsent || null)"
        )
        report["consent"] = consent
        if not (isinstance(consent, dict) and consent.get("granted") is True):
            failures.append("onboarding did not record consent")
            return

        # 3. Reach a discussion page that should now be filtered. Either the
        #    tab opened before consent (refreshed by background.js) or a fresh
        #    navigation after consent.
        if tab_first:
            page_socket = pre_socket
            page = pre_page
            await asyncio.sleep(4)
            marker = await page.evaluate("window.__preConsentMarker || 'cleared'")
            report["preConsentMarker"] = marker
            if marker != "cleared":
                failures.append(
                    "post-consent tab refresh never fired "
                    "(pre-consent page context survived the consent grant)"
                )
        else:
            page_target = http_json(new_tab, method="PUT")
            page_socket = await websockets.connect(
                page_target["webSocketDebuggerUrl"], max_size=8_000_000
            )
            page = Cdp(page_socket)

        try:

            # Give the bridge sync its full budget before judging the outcome.
            state = None
            loop = asyncio.get_running_loop()
            deadline = loop.time() + 25
            while loop.time() < deadline:
                state = await extension.evaluate(
                    "chrome.storage.local.get('bggHardBlockerState')"
                    ".then((v) => v.bggHardBlockerState || null)"
                )
                if state:
                    break
                await asyncio.sleep(0.5)

            dom = await page.evaluate(
                "JSON.stringify({"
                "  running: document.documentElement.hasAttribute('data-bgg-hard-blocker-running'),"
                "  ready: document.documentElement.hasAttribute('data-bgg-hard-blocker-ready'),"
                "  quarantine: document.documentElement.hasAttribute('data-bgg-hard-blocker-quarantine'),"
                "  redacted: document.querySelectorAll('[data-bgg-hard-blocker-redacted]').length,"
                "  blockedPostPresent: Boolean(document.getElementById('post-blocked')),"
                "  allowedPostPresent: Boolean(document.getElementById('post-allowed'))"
                "})"
            )
            dom = json.loads(dom)
            report["dom"] = dom
            report["state"] = state
            report["storage"] = await extension.evaluate(
                "chrome.storage.local.get(null).then((v) => Object.keys(v).sort())"
            )

            # The consent gate returns before the last line of content.js, so
            # RUNNING_ATTRIBUTE can only be set if the gate let the script past.
            if not dom["running"]:
                failures.append(
                    "consent gate refused after consent was granted "
                    "(data-bgg-hard-blocker-running absent)"
                )
            if not dom["ready"]:
                failures.append("page was left hidden (data-bgg-hard-blocker-ready absent)")
            if dom["blockedPostPresent"]:
                failures.append("blocked user's post was not removed")
            if not dom["allowedPostPresent"]:
                failures.append("allowed user's post was removed")
            if not state:
                failures.append("bggHardBlockerState was never written to chrome.storage.local")
        finally:
            await page_socket.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", required=True)
    parser.add_argument("--report", action="store_true")
    parser.add_argument(
        "--tab-first",
        action="store_true",
        help="open the discussion tab before granting consent, exercising the "
        "post-consent tab refresh",
    )
    args = parser.parse_args()

    repo = Path(__file__).resolve().parent.parent
    failures: list[str] = []
    report: dict = {}

    with tempfile.TemporaryDirectory(prefix="bgg-consent-e2e-") as workdir:
        work = Path(workdir)
        key, cert = make_certificate(work)
        server, stub_port = start_stub_server(key, cert)
        profile_dir = work / "profile"
        profile_dir.mkdir()

        resolver_rules = (
            f"MAP boardgamegeek.com 127.0.0.1:{stub_port},"
            f"MAP api.geekdo.com 127.0.0.1:{stub_port}"
        )
        process = subprocess.Popen(
            [
                args.chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--mute-audio",
                "--ignore-certificate-errors",
                f"--host-resolver-rules={resolver_rules}",
                f"--disable-extensions-except={repo}",
                f"--load-extension={repo}",
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
            asyncio.run(run(port, failures, report, args.tab_first))
        except Exception as error:  # noqa: BLE001 - reported as a test failure
            failures.append(f"{type(error).__name__}: {error}")
        finally:
            stop_process_tree(process)
            server.shutdown()
            server.server_close()

    label = "[tab-first]" if args.tab_first else "[consent-first]"
    if failures:
        print(f"consent_gate_e2e{label}: FAIL")
        for failure in failures:
            print(f"  - {failure}")
        print(f"  report: {json.dumps(report, sort_keys=True)}")
        return 1

    suffix = f" {json.dumps(report, sort_keys=True)}" if args.report else ""
    print(f"consent_gate_e2e{label}: PASS{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
