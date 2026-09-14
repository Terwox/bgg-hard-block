#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""A minimal WebDriver BiDi client, the Firefox counterpart of ``Cdp``.

Same shape as ``tests/consent_gate_e2e.py``'s ``Cdp``: one websocket, one
command in flight, read until the matching ``id`` comes back. Events that
arrive in between are kept rather than dropped, because a BiDi peer emits them
unsolicited once anything is subscribed.

Only the handful of commands the Firefox harness needs is wrapped. Anything
else goes through :meth:`BiDi.send`.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Iterable

import websockets


class BiDiError(RuntimeError):
    """A BiDi command answered with ``type: "error"``."""


class ScriptError(RuntimeError):
    """A script command answered with ``type: "exception"``."""


def deserialize(value: Any) -> Any:
    """Turn a BiDi ``RemoteValue`` back into a plain Python value.

    Anything without a value (a node, a function, a window handle) comes back
    as its type name, which is enough for assertions that only ever ask for
    JSON-shaped data.
    """
    if not isinstance(value, dict):
        return value
    kind = value.get("type")
    if kind in {"undefined", "null"}:
        return None
    if kind in {"string", "boolean", "bigint"}:
        return value.get("value")
    if kind == "number":
        number = value.get("value")
        # Infinity/-Infinity/NaN arrive as those literal strings.
        return number if isinstance(number, (int, float)) else str(number)
    if kind == "array" or kind == "set":
        return [deserialize(item) for item in value.get("value", [])]
    if kind == "object" or kind == "map":
        entries = value.get("value")
        if entries is None:
            return {}
        result: dict[Any, Any] = {}
        for key, item in entries:
            result[deserialize(key) if isinstance(key, dict) else key] = deserialize(item)
        return result
    return value.get("value", kind)


class BiDi:
    """Thin BiDi wrapper: one websocket, send-and-await, events collected."""

    def __init__(self, websocket) -> None:
        self._websocket = websocket
        self._counter = 0
        self.events: list[dict] = []

    @classmethod
    async def connect(cls, url: str, max_size: int = 8_000_000) -> "BiDi":
        """Open the session websocket. The caller owns :meth:`close`."""
        websocket = await websockets.connect(url, max_size=max_size)
        return cls(websocket)

    async def close(self) -> None:
        await self._websocket.close()

    async def send(self, method: str, params: dict | None = None, timeout: float = 30) -> dict:
        self._counter += 1
        message_id = self._counter
        await self._websocket.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            remaining = deadline - asyncio.get_running_loop().time()
            try:
                raw = await asyncio.wait_for(
                    self._websocket.recv(), timeout=max(remaining, 0.1)
                )
            except TimeoutError:
                # `asyncio.wait_for` raises a bare TimeoutError with no message,
                # and letting it escape discards the one fact that identifies
                # the stall: which command was outstanding. Fall out of the loop
                # so the named error below is the one the caller sees.
                break
            message = json.loads(raw)
            if message.get("type") == "event":
                self.events.append(message)
                continue
            if message.get("id") != message_id:
                continue
            if message.get("type") == "error":
                raise BiDiError(
                    f"{method}: {message.get('error')}: {message.get('message')}"
                )
            return message.get("result", {})
        raise TimeoutError(f"BiDi command timed out: {method}")

    def take_events(self, name: str) -> list[dict]:
        """Remove and return the collected events with this method name."""
        kept = [event for event in self.events if event.get("method") == name]
        self.events = [event for event in self.events if event.get("method") != name]
        return kept

    # -- session ---------------------------------------------------------

    async def new_session(self, accept_insecure_certs: bool = True) -> dict:
        """Start the session. ``acceptInsecureCerts`` replaces Chrome's
        ``--ignore-certificate-errors`` for the self-signed stub."""
        return await self.send(
            "session.new",
            {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": accept_insecure_certs}}},
        )

    async def subscribe(self, events: Iterable[str]) -> dict:
        return await self.send("session.subscribe", {"events": list(events)})

    # -- web extensions --------------------------------------------------

    async def install_extension(self, archive_path: Path) -> str:
        """Temporarily install a packed extension and return its id.

        ``archivePath`` (Firefox 137+) is the only form used in anger here: the
        repository tree carries the Chrome ``manifest.json``, so installing it
        by ``path`` would load the wrong manifest entirely.
        """
        result = await self.send(
            "webExtension.install",
            {"extensionData": {"type": "archivePath", "path": str(archive_path)}},
            timeout=60,
        )
        return result["extension"]

    # -- browsing contexts -----------------------------------------------

    async def get_tree(self) -> list[dict]:
        return (await self.send("browsingContext.getTree", {})).get("contexts", [])

    async def create_tab(self) -> str:
        result = await self.send("browsingContext.create", {"type": "tab"})
        return result["context"]

    async def navigate(
        self, context: str, url: str, wait: str = "complete", timeout: float = 30
    ) -> dict:
        return await self.send(
            "browsingContext.navigate",
            {"context": context, "url": url, "wait": wait},
            timeout=timeout,
        )

    # -- script ----------------------------------------------------------

    @staticmethod
    def _unwrap(result: dict) -> Any:
        if result.get("type") == "exception":
            details = result.get("exceptionDetails", {})
            text = details.get("text") or "script raised"
            raise ScriptError(str(deserialize(details.get("exception")) or text))
        return deserialize(result.get("result"))

    async def evaluate(
        self,
        context: str,
        expression: str,
        await_promise: bool = True,
        timeout: float = 30,
    ) -> Any:
        result = await self.send(
            "script.evaluate",
            {
                "expression": expression,
                "target": {"context": context},
                "awaitPromise": await_promise,
                "resultOwnership": "none",
            },
            timeout=timeout,
        )
        return self._unwrap(result)

    async def call_function(
        self,
        context: str,
        function_declaration: str,
        args: Iterable[Any] = (),
        await_promise: bool = True,
        user_activation: bool = True,
        timeout: float = 30,
    ) -> Any:
        """Call a function in the page. ``userActivation`` is what makes
        ``permissions.request`` inside a click handler legal."""
        result = await self.send(
            "script.callFunction",
            {
                "functionDeclaration": function_declaration,
                "arguments": [{"type": "string", "value": str(value)} for value in args],
                "target": {"context": context},
                "awaitPromise": await_promise,
                "userActivation": user_activation,
                "resultOwnership": "none",
            },
            timeout=timeout,
        )
        return self._unwrap(result)
