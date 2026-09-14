#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""The Firefox twin of ``tests/consent_gate_e2e.py``.

Same five contract assertions, same two modes, different browser plumbing:

  * WebDriver BiDi over the pinned ``websockets`` dependency instead of CDP.
    Playwright cannot load a Firefox extension and ``geckodriver`` is another
    unpinned binary, so the harness speaks the protocol directly.
  * ``webExtension.install`` with ``archivePath`` against a Firefox ZIP built
    in-test. The repository tree carries the *Chrome* ``manifest.json``, whose
    ``background.service_worker`` Firefox cannot run, so installing the tree by
    ``path`` would test the wrong extension.
  * A local CONNECT proxy plus ``network.proxy.*`` prefs instead of Chrome's
    ``--host-resolver-rules``. The stub server, its certificate and the
    discussion page are imported from the Chrome test, not forked.
  * The consent button is clicked through ``script.callFunction`` with
    ``userActivation: true``, because the handler now calls
    ``permissions.request``, which Firefox only honours from a user gesture.

Usage:  python3 tests/consent_gate_e2e_firefox.py --firefox /path/to/firefox
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
from pathlib import Path
import sys
import time

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "tests"))

import connect_proxy  # noqa: E402
import make_zip  # noqa: E402
from bidi import BiDi  # noqa: E402
from chromium_process import stop_process_tree, temporary_profile  # noqa: E402
from firefox_process import child_process_spawn_failed, launch_firefox  # noqa: E402

# Imported, never forked: a second copy of the stub would be a second thing to
# keep honest.
from consent_gate_e2e import (  # noqa: E402
    THREAD_PATH,
    make_certificate,
    start_stub_server,
)

ONBOARDING_SUFFIX = "/src/onboarding.html"


async def find_onboarding_context(client: BiDi, timeout: float = 30) -> dict:
    """Wait for the tab background.js opens on install and return its context.

    The Firefox extension UUID is per-profile and unrelated to ``gecko.id``, so
    it is discovered here rather than assumed.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    seen: list[str] = []
    while loop.time() < deadline:
        contexts = await client.get_tree()
        seen = [context.get("url", "") for context in contexts]
        for context in contexts:
            url = context.get("url", "")
            if url.startswith("moz-extension://") and url.endswith(ONBOARDING_SUFFIX):
                return context
        await asyncio.sleep(0.2)
    # The tab is opened by the extension's background page, so "never appeared"
    # has two very different causes: a background page that ran and did not
    # create the tab, and a browser that never started the background page at
    # all. The contexts actually enumerated separate them, and the Firefox
    # stderr the caller attaches to the report names the second one outright.
    raise TimeoutError(
        "the extension's onboarding tab never appeared; "
        f"browsing contexts seen: {seen}"
    )


async def run(
    client: BiDi,
    archive: Path,
    failures: list[str],
    report: dict,
    tab_first: bool,
) -> None:
    await client.new_session()
    report["extensionId"] = await client.install_extension(archive)

    onboarding = await find_onboarding_context(client)
    extension_context = onboarding["context"]
    report["extensionUrl"] = onboarding["url"]

    # Firefox exposes no extraInfoSpec enum namespace; background.js probes for
    # it before asking for `extraHeaders`. Record what this build actually says.
    report["onBeforeSendHeadersOptions"] = await client.evaluate(
        extension_context,
        "JSON.stringify({"
        "  present: Boolean(chrome.webRequest && chrome.webRequest.OnBeforeSendHeadersOptions),"
        "  keys: chrome.webRequest && chrome.webRequest.OnBeforeSendHeadersOptions"
        "    ? Object.keys(chrome.webRequest.OnBeforeSendHeadersOptions) : null"
        "})",
    )

    # background.js swallows a failed `onBeforeSendHeaders.addListener` on
    # purpose: on Chromium the MAIN-world capture is the primary path and the
    # listener is only a second layer. On Firefox the listener *is* the primary
    # path, so that same silence would leave the extension quietly half-working,
    # and every assertion below would still pass. Ask the event object itself.
    #
    # Firefox's WebExtension events expose `hasListener(callback)` and no
    # `hasListeners()`, so this needs both the background realm and the callback
    # by name — background.js registers the top-level `observedAuthorization`.
    # A renamed callback reports itself rather than failing as a missing one.
    report["onBeforeSendHeadersListener"] = await client.evaluate(
        extension_context,
        "(async () => { try {"
        "  const page = await chrome.runtime.getBackgroundPage();"
        "  if (!page) return 'no background page';"
        "  if (typeof page.observedAuthorization !== 'function')"
        "    return 'background.js no longer defines observedAuthorization';"
        "  return page.chrome.webRequest.onBeforeSendHeaders"
        "    .hasListener(page.observedAuthorization) ? 'registered' : 'absent';"
        "} catch (error) { return 'threw: ' + error; } })()",
    )
    if report["onBeforeSendHeadersListener"] != "registered":
        failures.append(
            "webRequest.onBeforeSendHeaders listener is "
            f"{report['onBeforeSendHeadersListener']}: background.js swallowed "
            "the addListener failure, so Firefox's primary "
            "authorization-capture path is not installed "
            f"(options probe: {report['onBeforeSendHeadersOptions']})"
        )

    thread_url = f"https://boardgamegeek.com{THREAD_PATH}"

    # 1b. Optionally open the discussion tab *before* consent, which is what a
    #     real user has: a BGG tab already sitting open when they agree.
    #     background.js promises to hard-refresh those tabs on the storage
    #     change; the marker below survives only if that refresh never fires.
    page_context = None
    if tab_first:
        page_context = await client.create_tab()
        await client.navigate(page_context, thread_url)
        await asyncio.sleep(1.5)
        await client.evaluate(
            page_context, "window.__preConsentMarker = 'present'; 'ok'"
        )

    # 2. Click the genuine consent button, with a user activation so the
    #    permissions.request inside the handler is allowed to resolve.
    report["click"] = await client.call_function(
        extension_context,
        "async function () {"
        "  const agree = document.getElementById('agree');"
        "  if (!agree) return 'missing';"
        "  agree.click();"
        "  await new Promise((resolve) => setTimeout(resolve, 500));"
        "  return document.getElementById('status')?.textContent || 'clicked';"
        "}",
        user_activation=True,
    )

    consent = await client.evaluate(
        extension_context,
        "chrome.storage.local.get('bggHardBlockerConsent')"
        ".then((v) => JSON.stringify(v.bggHardBlockerConsent || null))",
    )
    consent = json.loads(consent) if consent else None
    report["consent"] = consent
    if not (isinstance(consent, dict) and consent.get("granted") is True):
        failures.append("onboarding did not record consent")
        return

    consent_at = time.monotonic()

    # 3. Reach a discussion page that should now be filtered. Either the tab
    #    opened before consent (refreshed by background.js) or a fresh
    #    navigation after consent.
    if tab_first:
        await asyncio.sleep(4)
        marker = await client.evaluate(
            page_context, "window.__preConsentMarker || 'cleared'"
        )
        report["preConsentMarker"] = marker
        if marker != "cleared":
            failures.append(
                "post-consent tab refresh never fired "
                "(pre-consent page context survived the consent grant)"
            )
    else:
        page_context = await client.create_tab()
        await client.navigate(page_context, thread_url)

    # Give the bridge sync its full budget before judging the outcome.
    state = None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 25
    while loop.time() < deadline:
        raw_state = await client.evaluate(
            extension_context,
            "chrome.storage.local.get('bggHardBlockerState')"
            ".then((v) => JSON.stringify(v.bggHardBlockerState || null))",
        )
        state = json.loads(raw_state) if raw_state else None
        if state:
            break
        await asyncio.sleep(0.5)
    report["syncSeconds"] = round(time.monotonic() - consent_at, 2)

    dom = json.loads(
        await client.evaluate(
            page_context,
            "JSON.stringify({"
            "  running: document.documentElement.hasAttribute('data-bgg-hard-blocker-running'),"
            "  ready: document.documentElement.hasAttribute('data-bgg-hard-blocker-ready'),"
            "  quarantine: document.documentElement.hasAttribute('data-bgg-hard-blocker-quarantine'),"
            "  redacted: document.querySelectorAll('[data-bgg-hard-blocker-redacted]').length,"
            "  blockedPostPresent: Boolean(document.getElementById('post-blocked')),"
            "  allowedPostPresent: Boolean(document.getElementById('post-allowed'))"
            "})",
        )
    )
    report["dom"] = dom
    report["state"] = state
    report["storage"] = await client.evaluate(
        extension_context,
        "chrome.storage.local.get(null).then((v) => Object.keys(v).sort())",
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


async def drive(
    websocket_url: str, archive: Path, failures: list[str], report: dict, tab_first: bool
) -> None:
    client = await BiDi.connect(websocket_url)
    try:
        await run(client, archive, failures, report, tab_first)
    finally:
        await client.close()


def attempt(firefox: str, tab_first: bool) -> tuple[list[str], dict, bool]:
    """Run the whole scenario once; also report a miscarried browser startup."""
    failures: list[str] = []
    report: dict = {}
    miscarried = False

    # `stop_process_tree` now waits for the content processes to be gone before
    # this cleanup runs, and the cleanup retries a still-locked profile rather
    # than leaking it unnamed into the OS temp root.
    with temporary_profile("bgg-consent-e2e-firefox-") as work:
        key, cert = make_certificate(work)
        server, stub_port = start_stub_server(key, cert)
        proxy, proxy_port = connect_proxy.start_proxy(stub_port)

        # The AMO archive, not the repository tree: the tree's manifest.json is
        # the Chrome one.
        archive = work / "bgg-hard-block-firefox.zip"
        make_zip.make_zip(REPO, archive, make_zip.FIREFOX_SOURCE_OVERRIDES)

        process = None
        try:
            process, websocket_url = launch_firefox(
                firefox, work / "profile", proxy_port
            )
            asyncio.run(drive(websocket_url, archive, failures, report, tab_first))
        except Exception as error:  # noqa: BLE001 - reported as a test failure
            failures.append(f"{type(error).__name__}: {error}")
        finally:
            # Every shutdown runs, and none of them may replace the diagnosis
            # above: stop_process_tree can raise (ProcessLookupError on POSIX
            # when the tree is already gone, TimeoutExpired after the SIGKILL
            # wait), and a raise here would both skip the proxy/stub teardown
            # and bury the failure the test exists to report.
            if process is not None:
                # Firefox reports a failed child-process spawn on stderr and
                # nowhere else, and such a browser never runs the extension's
                # background page -- which reads from the outside exactly like
                # "the onboarding tab never appeared". Keep that record with
                # the diagnosis instead of discarding it at teardown.
                if failures:
                    report["firefoxStderr"] = list(
                        getattr(process, "stderr_tail", ())
                    )
                # Only a browser that never got as far as an extension context
                # counts as miscarried: `extensionUrl` is written the moment
                # the onboarding tab is found, so anything after that is a real
                # result and must be reported, not relaunched.
                miscarried = (
                    bool(failures)
                    and "extensionUrl" not in report
                    and child_process_spawn_failed(process)
                )
                with contextlib.suppress(Exception):
                    stop_process_tree(process)
            with contextlib.suppress(Exception):
                connect_proxy.shutdown(proxy)
            with contextlib.suppress(Exception):
                server.shutdown()
            with contextlib.suppress(Exception):
                server.server_close()

    return failures, report, miscarried


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", required=True)
    parser.add_argument("--report", action="store_true")
    parser.add_argument(
        "--tab-first",
        action="store_true",
        help="open the discussion tab before granting consent, exercising the "
        "post-consent tab refresh",
    )
    args = parser.parse_args()

    label = "[tab-first]" if args.tab_first else "[consent-first]"

    for index in range(2):
        failures, report, miscarried = attempt(args.firefox, args.tab_first)
        if not miscarried or index == 1:
            break
        # Not a retry of the assertions: this browser failed to spawn a content
        # process, so no extension code ran and there is no verdict to hide.
        print(
            f"consent_gate_e2e_firefox{label}: Firefox failed to spawn a "
            "content process; relaunching once",
            file=sys.stderr,
        )

    if failures:
        print(f"consent_gate_e2e_firefox{label}: FAIL")
        for failure in failures:
            print(f"  - {failure}")
        print(f"  report: {json.dumps(report, sort_keys=True)}")
        return 1

    suffix = f" {json.dumps(report, sort_keys=True)}" if args.report else ""
    print(f"consent_gate_e2e_firefox{label}: PASS{suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
