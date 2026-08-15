#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest import mock
from zipfile import ZIP_STORED, ZipFile

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

import chromium_process  # noqa: E402
import live_smoke  # noqa: E402
import make_zip  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
