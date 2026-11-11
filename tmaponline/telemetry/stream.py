"""Reconnectable client for the local tModLoader telemetry JSONL stream."""

from __future__ import annotations

import json
import logging
import socket
import threading
import uuid
from collections.abc import Callable
from typing import Any

from ..backend.store_common import as_json_object


SnapshotHandler = Callable[[dict[str, Any]], None]
ConnectionHandler = Callable[[bool], None]
logger = logging.getLogger(__name__)


class TelemetryStreamClient:
    """Consume compact newline-delimited JSON snapshots from the server mod."""

    def __init__(
        self,
        on_snapshot: SnapshotHandler,
        on_connection_change: ConnectionHandler,
        *,
        host: str = "127.0.0.1",
        port: int = 38762,
    ) -> None:
        self.host = host
        self.port = port
        self._on_snapshot = on_snapshot
        self._on_connection_change = on_connection_change
        self._stop = threading.Event()
        self._socket_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._socket: socket.socket | None = None
        self._thread = threading.Thread(target=self._run, name="terraria-telemetry-stream", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._socket_lock:
            active_socket = self._socket
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                active_socket.close()
            except OSError:
                pass
        if self._thread.is_alive():
            self._thread.join(timeout=2)

    def send_map_ping(self, x: float, y: float, ping_id: str) -> bool:
        """Queue a map ping command for the tModLoader server over the duplex stream."""
        payload = json.dumps(
            {"type": "map_ping", "commandId": ping_id or uuid.uuid4().hex, "x": x, "y": y},
            separators=(",", ":"),
        ) + "\n"
        with self._socket_lock:
            active_socket = self._socket
        if active_socket is None:
            return False
        try:
            with self._send_lock:
                active_socket.sendall(payload.encode("utf-8"))
            return True
        except OSError:
            return False

    def _run(self) -> None:
        connected = False
        retry_delay = 1.0
        while not self._stop.is_set():
            try:
                connection = socket.create_connection((self.host, self.port), timeout=2)
                # The tModLoader side streams continuously. Blocking reads are
                # intentional; stop() shuts down the socket to wake this thread.
                connection.settimeout(None)
                with self._socket_lock:
                    self._socket = connection
                if not connected:
                    connected = True
                    self._on_connection_change(True)
                retry_delay = 1.0

                with connection, connection.makefile("r", encoding="utf-8", newline="\n") as stream:
                    for line in stream:
                        if self._stop.is_set():
                            break
                        if not line.strip():
                            continue
                        try:
                            snapshot = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        snapshot_object = as_json_object(snapshot)
                        if snapshot_object.get("schemaVersion") == 1:
                            try:
                                self._on_snapshot(snapshot_object)
                                snapshot_id = snapshot_object.get("snapshotId")
                                if isinstance(snapshot_id, int) and not isinstance(snapshot_id, bool):
                                    with self._send_lock:
                                        connection.sendall(
                                            (json.dumps({"ackSnapshotId": snapshot_id}) + "\n").encode("utf-8")
                                        )
                            except Exception:
                                logger.exception("Failed to apply tModLoader telemetry snapshot; keeping the stream open.")
                if not self._stop.is_set():
                    raise ConnectionError("telemetry stream closed")
            except (OSError, TimeoutError, ConnectionError):
                pass
            finally:
                with self._socket_lock:
                    self._socket = None
                if connected:
                    connected = False
                    self._on_connection_change(False)

            if not self._stop.is_set():
                self._stop.wait(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)
