#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Terwox
#
# Part of BGG Hard Block. See the LICENSE file at the repository root.
"""A CONNECT-only HTTP proxy that funnels every host at one local TLS stub.

Chrome has ``--host-resolver-rules``; Firefox has nothing equivalent, so the
Firefox end-to-end test redirects ``boardgamegeek.com`` and ``api.geekdo.com``
by pointing the profile's ``network.proxy.*`` prefs at this server. Firefox
opens an HTTPS origin with ``CONNECT host:443``; this answers ``200`` and then
splices the socket onto the stub, which already dispatches on the ``Host``
header of the tunnelled request (``tests/consent_gate_e2e.py``). The stub's
certificate covers both names, and the browser session sets
``acceptInsecureCerts``, so the TLS handshake inside the tunnel succeeds.

Deliberately host-blind: rewriting one host and not another would let a
mis-pointed request reach the real internet from a test.
"""

from __future__ import annotations

import select
import socket
import socketserver
import threading

# The stub answers instantly on loopback; these only bound a wedged socket.
CONNECT_TIMEOUT_SECONDS = 5
PUMP_IDLE_TIMEOUT_SECONDS = 30
CHUNK_BYTES = 65536


class _ConnectHandler(socketserver.BaseRequestHandler):
    """Answer ``CONNECT`` with a tunnel to the stub; refuse everything else."""

    def handle(self) -> None:
        head = self._read_request_head()
        if head is None:
            return
        request_line, pending = head
        if not request_line.upper().startswith(b"CONNECT "):
            # Nothing in this harness proxies plain HTTP. Say so rather than
            # silently forwarding a request the caller did not expect to leave.
            self.request.sendall(
                b"HTTP/1.1 405 Method Not Allowed\r\n"
                b"Allow: CONNECT\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            return

        try:
            upstream = socket.create_connection(
                ("127.0.0.1", self.server.stub_port), timeout=CONNECT_TIMEOUT_SECONDS
            )
        except OSError:
            self.request.sendall(
                b"HTTP/1.1 502 Bad Gateway\r\n"
                b"Content-Length: 0\r\nConnection: close\r\n\r\n"
            )
            return

        try:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            # A client may pack the first tunnelled bytes into the same write as
            # the CONNECT head — Firefox does exactly that with the TLS
            # ClientHello — so anything already buffered goes upstream before
            # the pump starts waiting for more.
            if pending:
                upstream.sendall(pending)
            self._pump(upstream)
        finally:
            upstream.close()

    def _read_request_head(self) -> tuple[bytes, bytes] | None:
        """Read up to the blank line; return the request line and whatever bytes
        were already buffered past the header terminator."""
        self.request.settimeout(CONNECT_TIMEOUT_SECONDS)
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            try:
                chunk = self.request.recv(CHUNK_BYTES)
            except OSError:
                return None
            if not chunk:
                return None
            buffer += chunk
            if len(buffer) > 65536:
                return None
        head, pending = buffer.split(b"\r\n\r\n", 1)
        return head.split(b"\r\n", 1)[0], pending

    def _pump(self, upstream: socket.socket) -> None:
        self.request.settimeout(None)
        upstream.settimeout(None)
        sockets = [self.request, upstream]
        while True:
            try:
                readable, _, errored = select.select(
                    sockets, [], sockets, PUMP_IDLE_TIMEOUT_SECONDS
                )
            except OSError:
                return
            if errored or not readable:
                return
            for source in readable:
                destination = upstream if source is self.request else self.request
                try:
                    data = source.recv(CHUNK_BYTES)
                except OSError:
                    return
                if not data:
                    return
                try:
                    destination.sendall(data)
                except OSError:
                    return


class ConnectProxyServer(socketserver.ThreadingTCPServer):
    """Threaded so the browser can hold several tunnels open at once."""

    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], stub_port: int) -> None:
        self.stub_port = stub_port
        super().__init__(address, _ConnectHandler)


def start_proxy(stub_port: int) -> tuple[ConnectProxyServer, int]:
    """Serve on a free loopback port and return the server and that port."""
    server = ConnectProxyServer(("127.0.0.1", 0), stub_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def shutdown(server: ConnectProxyServer) -> None:
    """Stop accepting and release the listening socket."""
    server.shutdown()
    server.server_close()
