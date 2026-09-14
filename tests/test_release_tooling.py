#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

import collections
import json
import queue
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock
from zipfile import ZIP_STORED, ZipFile

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import bidi  # noqa: E402
import chromium_process  # noqa: E402
import connect_proxy  # noqa: E402
import firefox_process  # noqa: E402
import live_smoke  # noqa: E402
import make_zip  # noqa: E402


def git(root: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", "-C", str(root), *arguments],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def seed_git_repository(root: Path) -> None:
    """Create a throwaway repo whose whole allowlist is committed content."""
    root.mkdir(parents=True)
    subprocess.run(
        ["git", "init", "-q", "-b", "main", str(root)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    git(root, "config", "user.email", "release-tooling@example.invalid")
    git(root, "config", "user.name", "Release Tooling Test")
    git(root, "config", "commit.gpgsign", "false")
    for name in make_zip.SHIPPED_FILES:
        path = root / Path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"placeholder for {name}\n".encode())
    git(root, "add", "--", *make_zip.SHIPPED_FILES)
    git(root, "commit", "-qm", "seed")


class PackageTests(unittest.TestCase):
    def test_package_is_allowlisted_stored_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first.zip"
            second = Path(temporary) / "second.zip"
            make_zip.make_zip(REPO, first)
            make_zip.make_zip(REPO, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), sorted(make_zip.SHIPPED_FILES))
                self.assertTrue(
                    all(item.compress_type == ZIP_STORED for item in archive.infolist())
                )


class FirefoxPackageTests(unittest.TestCase):
    def test_firefox_package_is_stored_deterministic_and_allowlisted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first-firefox.zip"
            second = Path(temporary) / "second-firefox.zip"
            make_zip.make_zip(REPO, first, make_zip.FIREFOX_SOURCE_OVERRIDES)
            make_zip.make_zip(REPO, second, make_zip.FIREFOX_SOURCE_OVERRIDES)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with ZipFile(first) as archive:
                self.assertEqual(archive.namelist(), sorted(make_zip.SHIPPED_FILES))
                self.assertTrue(
                    all(item.compress_type == ZIP_STORED for item in archive.infolist())
                )

    def test_firefox_manifest_member_is_the_firefox_manifest_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            firefox = Path(temporary) / "firefox.zip"
            make_zip.make_zip(REPO, firefox, make_zip.FIREFOX_SOURCE_OVERRIDES)
            with ZipFile(firefox) as archive:
                self.assertEqual(
                    archive.read("manifest.json"),
                    (REPO / "manifest.firefox.json").read_bytes(),
                )

    def test_firefox_archive_differs_from_chrome_only_in_the_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            chrome = Path(temporary) / "chrome.zip"
            firefox = Path(temporary) / "firefox.zip"
            make_zip.make_zip(REPO, chrome)
            make_zip.make_zip(REPO, firefox, make_zip.FIREFOX_SOURCE_OVERRIDES)
            with ZipFile(chrome) as chrome_archive, ZipFile(firefox) as firefox_archive:
                self.assertEqual(
                    chrome_archive.namelist(), firefox_archive.namelist()
                )
                differing = [
                    name
                    for name in chrome_archive.namelist()
                    if chrome_archive.read(name) != firefox_archive.read(name)
                ]
                self.assertEqual(differing, ["manifest.json"])

    def test_override_sources_must_be_git_tracked(self) -> None:
        real_run = make_zip.subprocess.run

        def quiet_run(command, **kwargs):
            # git reports the unmatched pathspec on stderr; the test asserts the
            # rejection, so keep the expected noise out of the suite output.
            return real_run(command, stderr=subprocess.DEVNULL, **kwargs)

        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "untracked-override.zip"
            with mock.patch.object(make_zip.subprocess, "run", quiet_run):
                with self.assertRaises(subprocess.CalledProcessError):
                    make_zip.make_zip(
                        REPO,
                        target,
                        {"manifest.json": "manifest.firefox.untracked.json"},
                    )
            self.assertFalse(target.exists())

    def test_intent_to_add_override_sources_are_refused(self) -> None:
        # `git add -N` satisfies `git ls-files --error-unmatch` while the file's
        # content lives only in the working tree, so packaging it would ship
        # bytes that are in no commit and no index.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            seed_git_repository(root)
            override = root / "manifest.firefox.json"
            override.write_bytes(b'{"manifest_version": 3}\n')
            git(root, "add", "-N", "--", "manifest.firefox.json")
            target = Path(temporary) / "intent-to-add.zip"

            with self.assertRaises(ValueError) as raised:
                make_zip.make_zip(root, target, make_zip.FIREFOX_SOURCE_OVERRIDES)
            self.assertIn("manifest.firefox.json", str(raised.exception))
            self.assertFalse(target.exists())

            git(root, "add", "--", "manifest.firefox.json")
            make_zip.make_zip(root, target, make_zip.FIREFOX_SOURCE_OVERRIDES)
            with ZipFile(target) as archive:
                self.assertEqual(archive.read("manifest.json"), override.read_bytes())

    def test_an_ordinary_modification_to_a_tracked_source_still_packages(self) -> None:
        # The archives are built from the working tree on purpose; only the
        # intent-to-add signature is rejected.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            seed_git_repository(root)
            (root / "src" / "background.js").write_bytes(b"// edited\n")
            target = Path(temporary) / "modified.zip"
            make_zip.make_zip(root, target)
            with ZipFile(target) as archive:
                self.assertEqual(archive.read("src/background.js"), b"// edited\n")

    def test_override_keys_must_be_shipped_files(self) -> None:
        # A key outside SHIPPED_FILES would be silently dropped, shipping an
        # archive without the substitution the caller asked for.
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "unknown-override.zip"
            with self.assertRaises(ValueError) as raised:
                make_zip.make_zip(
                    REPO,
                    target,
                    {"manifest.firefox.json": "manifest.json"},
                )
            self.assertIn("manifest.firefox.json", str(raised.exception))
            self.assertFalse(target.exists())


class ProcessLifecycleTests(unittest.TestCase):
    @mock.patch.object(chromium_process.time, "sleep")
    @mock.patch.object(
        chromium_process.Path,
        "read_text",
        side_effect=[PermissionError("marker is still locked"), "9222\n/devtools/browser/id\n"],
    )
    def test_debug_port_wait_retries_a_locked_marker(
        self, read_text: mock.Mock, sleep: mock.Mock
    ) -> None:
        process = mock.Mock(returncode=None)
        process.poll.return_value = None
        self.assertEqual(
            chromium_process.wait_for_debug_port(Path("profile"), process), 9222
        )
        self.assertEqual(read_text.call_count, 2)
        sleep.assert_called_once_with(0.05)

    def test_debug_port_wait_fails_when_chromium_exits(self) -> None:
        process = mock.Mock(returncode=17)
        process.poll.return_value = 17
        with self.assertRaisesRegex(RuntimeError, "status 17"):
            chromium_process.wait_for_debug_port(Path("profile"), process)

    @mock.patch.object(chromium_process.os, "name", "nt")
    def test_windows_launch_is_hidden_and_uses_a_new_process_group(self) -> None:
        flags = chromium_process.background_process_kwargs()["creationflags"]
        self.assertTrue(flags & chromium_process.CREATE_NO_WINDOW)
        self.assertTrue(flags & chromium_process.CREATE_NEW_PROCESS_GROUP)

    @mock.patch.object(chromium_process.os, "name", "posix")
    def test_posix_launch_starts_a_session(self) -> None:
        self.assertEqual(
            chromium_process.background_process_kwargs(),
            {"start_new_session": True},
        )

    @mock.patch.object(chromium_process.os, "name", "posix")
    @mock.patch.object(chromium_process.os, "killpg", create=True)
    def test_posix_cleanup_escalates_for_a_stuck_tree(self, killpg: mock.Mock) -> None:
        process = mock.Mock(pid=42)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("chrome", 3), 0]
        chromium_process.stop_process_tree(process)
        self.assertEqual(
            killpg.call_args_list,
            [
                mock.call(42, chromium_process.SIGTERM),
                mock.call(42, chromium_process.SIGKILL),
            ],
        )

    @mock.patch.object(chromium_process.os, "name", "nt")
    @mock.patch.object(chromium_process.subprocess, "run")
    def test_windows_cleanup_escalates_for_a_stuck_tree(self, run: mock.Mock) -> None:
        process = mock.Mock(pid=42)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("chrome", 3), 0]
        chromium_process.stop_process_tree(process)
        self.assertEqual(
            run.call_args_list[0].args[0], ["taskkill", "/PID", "42", "/T"]
        )
        self.assertEqual(
            run.call_args_list[1].args[0],
            ["taskkill", "/PID", "42", "/T", "/F"],
        )


class ExtensionDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    BGG_ID = "abcdefghijklmnopabcdefghijklmnop"
    OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba"

    @mock.patch.object(live_smoke, "urlopen")
    def test_reads_devtools_http_target_list(self, urlopen: mock.Mock) -> None:
        urlopen.return_value = BytesIO(
            b'[{"type":"page","url":"about:blank"}]'
        )
        self.assertEqual(
            live_smoke.devtools_targets(9222),
            [{"type": "page", "url": "about:blank"}],
        )
        urlopen.assert_called_once_with(
            "http://127.0.0.1:9222/json/list", timeout=2
        )

    def test_selects_exact_onboarding_target_and_ignores_unrelated_extensions(
        self,
    ) -> None:
        targets = [
            {
                "type": "service_worker",
                "url": f"chrome-extension://{self.OTHER_ID}/src/worker.js",
            },
            {
                "type": "page",
                "url": f"chrome-extension://{self.BGG_ID}/src/onboarding.html",
            },
            {
                "type": "page",
                "url": f"chrome-extension://{self.OTHER_ID}/options.html",
            },
        ]
        self.assertEqual(
            live_smoke.extension_id_from_targets(targets), self.BGG_ID
        )

    def test_prefers_onboarding_target_over_background_worker(self) -> None:
        targets = [
            {
                "type": "service_worker",
                "url": f"chrome-extension://{self.OTHER_ID}/src/background.js",
            },
            {
                "type": "page",
                "url": f"chrome-extension://{self.BGG_ID}/src/onboarding.html",
            },
        ]
        self.assertEqual(
            live_smoke.extension_id_from_targets(targets), self.BGG_ID
        )

    def test_rejects_wrong_target_types_and_ambiguous_best_matches(self) -> None:
        targets = [
            {
                "type": "page",
                "url": f"chrome-extension://{self.BGG_ID}/src/onboarding.html",
            },
            {
                "type": "page",
                "url": f"chrome-extension://{self.OTHER_ID}/src/onboarding.html",
            },
            {
                "type": "page",
                "url": "chrome-extension://third/src/background.js",
            },
        ]
        self.assertIsNone(live_smoke.extension_id_from_targets(targets))

    @mock.patch.object(live_smoke, "devtools_targets")
    async def test_find_extension_id_polls_devtools_targets(self, targets: mock.Mock) -> None:
        targets.side_effect = [
            OSError("DevTools endpoint not ready"),
            [],
            [
                {
                    "type": "service_worker",
                    "url": f"chrome-extension://{self.BGG_ID}/src/background.js",
                }
            ],
        ]
        self.assertEqual(
            await live_smoke.find_extension_id(9222), self.BGG_ID
        )
        self.assertEqual(
            targets.call_args_list,
            [mock.call(9222), mock.call(9222), mock.call(9222)],
        )


class FirefoxProfileTests(unittest.TestCase):
    def test_plain_profile_has_no_proxy_and_no_retired_or_risky_prefs(self) -> None:
        prefs = firefox_process.profile_prefs()
        self.assertFalse([name for name in prefs if name.startswith("network.proxy.")])
        # Removed in Firefox 141 with CDP; writing it would only leave a dead pref.
        self.assertNotIn("remote.active-protocols", prefs)
        # BiDi installs the archive temporarily, so signature enforcement stays on.
        self.assertNotIn("xpinstall.signatures.required", prefs)
        self.assertIs(prefs["toolkit.telemetry.enabled"], False)

    def test_proxy_profile_points_both_schemes_at_the_local_proxy(self) -> None:
        prefs = firefox_process.profile_prefs(4321)
        self.assertEqual(prefs["network.proxy.type"], 1)
        self.assertEqual(prefs["network.proxy.http"], "127.0.0.1")
        self.assertEqual(prefs["network.proxy.http_port"], 4321)
        self.assertEqual(prefs["network.proxy.ssl"], "127.0.0.1")
        self.assertEqual(prefs["network.proxy.ssl_port"], 4321)
        # Without this Firefox bypasses the proxy for loopback and the CONNECT
        # redirection silently stops applying.
        self.assertIs(prefs["network.proxy.allow_hijacking_localhost"], True)
        self.assertEqual(prefs["network.proxy.no_proxies_on"], "")

    def test_user_js_renders_booleans_integers_and_strings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profile = Path(temporary) / "profile"
            written = firefox_process.write_user_js(profile, 4321)
            lines = written.read_text(encoding="utf-8").splitlines()
        self.assertIn('user_pref("app.update.auto", false);', lines)
        self.assertIn('user_pref("network.proxy.http_port", 4321);', lines)
        self.assertIn('user_pref("network.proxy.http", "127.0.0.1");', lines)
        self.assertIn('user_pref("browser.startup.homepage_override.mstone", "ignore");', lines)


class FirefoxEndpointTests(unittest.TestCase):
    def test_drain_stderr_reports_the_bidi_banner_once(self) -> None:
        stream = BytesIO(
            b"*** You are running in headless mode.\n"
            b"WebDriver BiDi listening on ws://127.0.0.1:54196\n"
            b"WebDriver BiDi listening on ws://127.0.0.1:1\n"
        )
        announced: queue.Queue[str] = queue.Queue()
        tail: collections.deque = collections.deque(maxlen=40)
        firefox_process._drain_stderr(stream, announced, tail)
        self.assertEqual(announced.get_nowait(), "127.0.0.1:54196")
        self.assertTrue(announced.empty())
        self.assertEqual(len(tail), 3)

    def test_endpoint_wait_returns_the_announced_host_and_port(self) -> None:
        announced: queue.Queue[str] = queue.Queue()
        announced.put("127.0.0.1:54196")
        process = mock.Mock()
        process.poll.return_value = None
        self.assertEqual(
            firefox_process.wait_for_bidi_endpoint(
                process, announced, collections.deque(), timeout=0.1
            ),
            "127.0.0.1:54196",
        )

    def test_endpoint_wait_reports_an_early_exit_with_the_stderr_tail(self) -> None:
        process = mock.Mock(returncode=9)
        process.poll.return_value = 9
        tail = collections.deque(["Error: no display"])
        with self.assertRaisesRegex(RuntimeError, "status 9.*no display"):
            firefox_process.wait_for_bidi_endpoint(
                process, queue.Queue(), tail, timeout=0.1
            )

    def test_endpoint_wait_times_out_while_firefox_is_still_alive(self) -> None:
        process = mock.Mock()
        process.poll.return_value = None
        with self.assertRaises(TimeoutError):
            firefox_process.wait_for_bidi_endpoint(
                process, queue.Queue(), collections.deque(), timeout=0.1
            )

    def test_a_raising_cleanup_does_not_replace_the_launch_diagnosis(self) -> None:
        """The kill is best-effort; the reason Firefox never came up is not.

        ``stop_process_tree`` raises ``ProcessLookupError`` on POSIX when the
        tree is already gone, and ``TimeoutExpired`` if the post-SIGKILL wait
        elapses. Either one used to escape in place of the real error.
        """
        process = mock.Mock()
        process.stderr = BytesIO(b"")
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            firefox_process.subprocess, "Popen", return_value=process
        ), mock.patch.object(
            firefox_process,
            "wait_for_bidi_endpoint",
            side_effect=RuntimeError("Firefox exited early with status 9: no display"),
        ), mock.patch.object(
            firefox_process, "stop_process_tree", side_effect=ProcessLookupError("gone")
        ) as stop:
            with self.assertRaisesRegex(RuntimeError, "status 9.*no display"):
                firefox_process.launch_firefox(
                    "firefox", Path(temporary) / "profile"
                )
        self.assertTrue(stop.called)


class FakeWebSocket:
    """Replays queued BiDi frames and records what was sent."""

    def __init__(self, frames: list[dict]) -> None:
        self.frames = list(frames)
        self.sent: list[dict] = []
        self.closed = False

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))

    async def recv(self) -> str:
        if not self.frames:
            raise AssertionError("the client read more frames than were queued")
        return json.dumps(self.frames.pop(0))

    async def close(self) -> None:
        self.closed = True


class BiDiDeserializeTests(unittest.TestCase):
    def test_primitives(self) -> None:
        self.assertEqual(bidi.deserialize({"type": "string", "value": "x"}), "x")
        self.assertEqual(bidi.deserialize({"type": "number", "value": 3}), 3)
        self.assertIs(bidi.deserialize({"type": "boolean", "value": True}), True)
        self.assertIsNone(bidi.deserialize({"type": "null"}))
        self.assertIsNone(bidi.deserialize({"type": "undefined"}))

    def test_containers(self) -> None:
        self.assertEqual(
            bidi.deserialize(
                {"type": "array", "value": [{"type": "number", "value": 1}]}
            ),
            [1],
        )
        self.assertEqual(
            bidi.deserialize(
                {"type": "object", "value": [["k", {"type": "string", "value": "v"}]]}
            ),
            {"k": "v"},
        )


class BiDiProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_keeps_events_and_returns_the_matching_result(self) -> None:
        socket = FakeWebSocket(
            [
                {"type": "event", "method": "log.entryAdded", "params": {}},
                {"type": "success", "id": 99, "result": {"stale": True}},
                {"type": "success", "id": 1, "result": {"contexts": []}},
            ]
        )
        client = bidi.BiDi(socket)
        self.assertEqual(await client.send("browsingContext.getTree"), {"contexts": []})
        self.assertEqual(socket.sent[0]["method"], "browsingContext.getTree")
        self.assertEqual(len(client.take_events("log.entryAdded")), 1)
        self.assertEqual(client.take_events("log.entryAdded"), [])

    async def test_send_raises_on_an_error_frame(self) -> None:
        socket = FakeWebSocket(
            [{"type": "error", "id": 1, "error": "no such frame", "message": "gone"}]
        )
        with self.assertRaisesRegex(bidi.BiDiError, "no such frame"):
            await bidi.BiDi(socket).send("script.evaluate")

    async def test_evaluate_raises_the_page_exception(self) -> None:
        socket = FakeWebSocket(
            [
                {
                    "type": "success",
                    "id": 1,
                    "result": {
                        "type": "exception",
                        "exceptionDetails": {"text": "ReferenceError: nope"},
                    },
                }
            ]
        )
        with self.assertRaisesRegex(bidi.ScriptError, "ReferenceError"):
            await bidi.BiDi(socket).evaluate("ctx", "nope")

    async def test_install_extension_asks_for_an_archive_path(self) -> None:
        socket = FakeWebSocket(
            [{"type": "success", "id": 1, "result": {"extension": "an-id"}}]
        )
        client = bidi.BiDi(socket)
        self.assertEqual(
            await client.install_extension(Path("a") / "ext.zip"), "an-id"
        )
        self.assertEqual(
            socket.sent[0]["params"]["extensionData"]["type"], "archivePath"
        )

    async def test_call_function_requests_a_user_activation(self) -> None:
        socket = FakeWebSocket(
            [
                {
                    "type": "success",
                    "id": 1,
                    "result": {
                        "type": "success",
                        "result": {"type": "string", "value": "clicked"},
                    },
                }
            ]
        )
        client = bidi.BiDi(socket)
        self.assertEqual(
            await client.call_function("ctx", "function () {}"), "clicked"
        )
        self.assertIs(socket.sent[0]["params"]["userActivation"], True)


class ConnectProxyTests(unittest.TestCase):
    class _Echo(socketserver.BaseRequestHandler):
        def handle(self) -> None:
            while True:
                data = self.request.recv(4096)
                if not data:
                    return
                self.request.sendall(data.upper())

    def setUp(self) -> None:
        self.stub = socketserver.ThreadingTCPServer(("127.0.0.1", 0), self._Echo)
        self.stub.daemon_threads = True
        threading.Thread(target=self.stub.serve_forever, daemon=True).start()
        self.addCleanup(self.stub.server_close)
        self.addCleanup(self.stub.shutdown)

        self.proxy, self.port = connect_proxy.start_proxy(self.stub.server_address[1])
        self.addCleanup(connect_proxy.shutdown, self.proxy)

    def _client(self) -> socket.socket:
        client = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(client.close)
        client.settimeout(5)
        return client

    def test_connect_tunnels_any_host_to_the_stub(self) -> None:
        client = self._client()
        client.sendall(
            b"CONNECT api.geekdo.com:443 HTTP/1.1\r\nHost: api.geekdo.com:443\r\n\r\n"
        )
        self.assertTrue(client.recv(256).startswith(b"HTTP/1.1 200 Connection Established"))
        client.sendall(b"tunnelled")
        self.assertEqual(client.recv(256), b"TUNNELLED")

    def test_bytes_packed_behind_the_connect_head_still_reach_the_stub(self) -> None:
        # Firefox puts the TLS ClientHello in the same write as the CONNECT
        # head, so the proxy must forward whatever it over-read.
        client = self._client()
        client.sendall(
            b"CONNECT api.geekdo.com:443 HTTP/1.1\r\n"
            b"Host: api.geekdo.com:443\r\n\r\nHELLO"
        )
        # The 200 line and the echoed payload may arrive in one segment or two.
        seen = b""
        while b"HELLO" not in seen.split(b"\r\n\r\n", 1)[-1]:
            chunk = client.recv(256)
            self.assertTrue(chunk, "the tunnel closed before the buffered bytes came back")
            seen += chunk
        self.assertTrue(seen.startswith(b"HTTP/1.1 200 Connection Established"))

    def test_plain_requests_are_refused_rather_than_forwarded(self) -> None:
        client = self._client()
        client.sendall(b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n")
        self.assertTrue(client.recv(256).startswith(b"HTTP/1.1 405 Method Not Allowed"))

    def test_the_proxy_listens_on_loopback_only(self) -> None:
        self.assertEqual(self.proxy.server_address[0], "127.0.0.1")


import contextlib  # noqa: E402
import io  # noqa: E402
import ssl  # noqa: E402

sys.path.insert(0, str(REPO / "tests"))

import consent_gate_e2e  # noqa: E402


class TeardownBarrierTests(unittest.TestCase):
    """The three pieces that kept a *passing* browser run from finishing clean.

    Teardown used to return while Chromium's children still held the profile,
    so ``TemporaryDirectory`` cleanup raised ``PermissionError: [WinError 32]``
    over a green fixture and left a profile behind in ``%TEMP%``; and the TLS
    stub printed a traceback every time a browser dropped a connection.
    """

    def test_the_barrier_returns_as_soon_as_the_tree_is_gone(self) -> None:
        polls: list[set[int]] = []

        def running(candidates: set[int]) -> set[int]:
            polls.append(set(candidates))
            return {7} if len(polls) < 3 else set()

        with (
            mock.patch.object(chromium_process, "_running_pids", side_effect=running),
            mock.patch.object(chromium_process.time, "sleep") as sleep,
        ):
            self.assertEqual(chromium_process.wait_for_tree_exit({7}), set())
        # Three polls, two waits between them, and no waiting after the last.
        self.assertEqual(polls, [{7}, {7}, {7}])
        self.assertEqual(sleep.call_count, 2)

    def test_the_barrier_reports_what_outlasted_it(self) -> None:
        with mock.patch.object(
            chromium_process, "_running_pids", return_value={7}
        ):
            self.assertEqual(
                chromium_process.wait_for_tree_exit({7, 9}, timeout=0), {7}
            )

    def test_taskkill_output_names_only_the_processes_it_killed(self) -> None:
        # The root's line ends in "(child process of PID <this interpreter>)",
        # which is emphatically not part of the tree being waited on.
        self.assertEqual(
            chromium_process._reported_pids(
                b"SUCCESS: The process with PID 22928 (child process of PID 8132)"
                b" has been terminated.\r\n"
                b"SUCCESS: The process with PID 8132 (child process of PID 39704)"
                b" has been terminated.\r\n"
                b'ERROR: The process "99" not found.\r\n'
            ),
            {8132, 22928},
        )
        self.assertEqual(
            chromium_process._reported_pids(
                b"SUCCESS: Sent termination signal to the process with PID 8132.\r\n"
            ),
            {8132},
        )

    @mock.patch.object(chromium_process.os, "name", "nt")
    def test_windows_teardown_is_silent_when_the_tree_exits(self) -> None:
        process = mock.Mock(pid=42)
        process.poll.return_value = None
        process.wait.return_value = 0
        noise = io.StringIO()
        with (
            mock.patch.object(chromium_process, "_taskkill", return_value={99}),
            mock.patch.object(chromium_process, "_running_pids", return_value=set()),
            contextlib.redirect_stderr(noise),
        ):
            self.assertEqual(chromium_process.stop_process_tree(process), set())
        self.assertEqual(noise.getvalue(), "")

    @mock.patch.object(chromium_process.os, "name", "nt")
    def test_windows_teardown_names_the_processes_that_outlived_it(self) -> None:
        process = mock.Mock(pid=42)
        process.poll.return_value = None
        process.wait.return_value = 0
        noise = io.StringIO()
        with (
            mock.patch.object(chromium_process, "_taskkill", return_value={99}),
            mock.patch.object(chromium_process, "_running_pids", return_value={42, 99}),
            contextlib.redirect_stderr(noise),
        ):
            survivors = chromium_process.stop_process_tree(
                process, barrier_timeout=0
            )
        self.assertEqual(survivors, {42, 99})
        self.assertIn("[42, 99]", noise.getvalue())

    def test_profile_cleanup_survives_a_transient_permission_error(self) -> None:
        attempts: list[bool] = []

        def rmtree(path, ignore_errors: bool = False) -> None:
            attempts.append(ignore_errors)
            if len(attempts) < 3:
                raise PermissionError(32, "The process cannot access the file")

        with (
            mock.patch.object(chromium_process.shutil, "rmtree", side_effect=rmtree),
            mock.patch.object(chromium_process.time, "sleep") as sleep,
        ):
            self.assertTrue(chromium_process.remove_profile_tree(Path("profile")))
        # Three ordinary attempts, and never the error-swallowing fallback.
        self.assertEqual(attempts, [False, False, False])
        self.assertEqual(sleep.call_count, 2)

    def test_a_profile_that_stays_locked_is_named_rather_than_leaked_quietly(
        self,
    ) -> None:
        def rmtree(path, ignore_errors: bool = False) -> None:
            if not ignore_errors:
                raise PermissionError(32, "The process cannot access the file")

        with tempfile.TemporaryDirectory() as parent:
            leaked = Path(parent) / "bgg-hard-block-test-locked"
            leaked.mkdir()
            noise = io.StringIO()
            with (
                mock.patch.object(
                    chromium_process.shutil, "rmtree", side_effect=rmtree
                ),
                contextlib.redirect_stderr(noise),
            ):
                self.assertFalse(
                    chromium_process.remove_profile_tree(leaked, timeout=0)
                )
            self.assertIn(str(leaked), noise.getvalue())

    def test_only_the_full_child_spawn_signature_permits_a_relaunch(self) -> None:
        def with_stderr(*lines: str) -> mock.Mock:
            process = mock.Mock()
            process.stderr_tail = list(lines)
            return process

        self.assertTrue(
            firefox_process.child_process_spawn_failed(
                with_stderr(
                    "[Parent 1] WARNING: Failed to launch tab subprocess: "
                    "GeckoChildProcessHost.cpp:822",
                    "[Parent 1] launch failed: -2147024809",
                )
            )
        )
        # A failure that is missing either marker is a real failure.
        self.assertFalse(
            firefox_process.child_process_spawn_failed(
                with_stderr("[Parent 1] WARNING: Failed to launch tab subprocess")
            )
        )
        self.assertFalse(firefox_process.child_process_spawn_failed(with_stderr()))
        self.assertFalse(firefox_process.child_process_spawn_failed(None))


class StubServerNoiseTests(unittest.TestCase):
    """``handle_error`` hides a browser hanging up and nothing else."""

    def _handle(self, error: BaseException) -> str:
        server = object.__new__(consent_gate_e2e.StubServer)
        noise = io.StringIO()
        with contextlib.redirect_stderr(noise), contextlib.redirect_stdout(noise):
            try:
                raise error
            except BaseException:  # noqa: BLE001 - handed to the server as-is
                server.handle_error(None, ("127.0.0.1", 4711))
        return noise.getvalue()

    def test_a_browser_disconnect_prints_nothing(self) -> None:
        for error in (
            ConnectionResetError(10054, "An existing connection was forcibly closed"),
            ConnectionAbortedError(10053, "software caused connection abort"),
            BrokenPipeError(32, "broken pipe"),
            ssl.SSLEOFError("EOF occurred in violation of protocol"),
        ):
            with self.subTest(error=type(error).__name__):
                self.assertEqual(self._handle(error), "")

    def test_anything_else_still_prints_its_traceback(self) -> None:
        noise = self._handle(ValueError("the stub routed a request wrong"))
        self.assertIn("the stub routed a request wrong", noise)
        self.assertIn("Traceback", noise)

    def test_a_certificate_failure_is_not_mistaken_for_a_disconnect(self) -> None:
        self.assertTrue(
            consent_gate_e2e.is_expected_disconnect(
                ssl.SSLError(1, "[SSL: UNEXPECTED_EOF_WHILE_READING] unexpected eof")
            )
        )
        self.assertFalse(
            consent_gate_e2e.is_expected_disconnect(
                ssl.SSLError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")
            )
        )


if __name__ == "__main__":
    unittest.main()
