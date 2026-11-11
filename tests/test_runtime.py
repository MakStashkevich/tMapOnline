from __future__ import annotations

import socket
import sys
import tempfile
import threading
import time
import unittest
from copy import deepcopy
from pathlib import Path
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tmaponline.config import DEFAULT_CONFIG
from tmaponline.runtime import STOP, run_local


def unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TMapOnlineRuntimeTests(unittest.TestCase):
    def test_serve_runtime_starts_and_stops_without_game_or_network(self) -> None:
        config = deepcopy(DEFAULT_CONFIG)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config["server"]["port"] = unused_port()
            config["server"]["telemetry_port"] = unused_port()
            config["storage"]["data_dir"] = str(root / "data")
            STOP.clear()
            worker = threading.Thread(target=run_local, args=(config,), kwargs={"run_game": False}, daemon=True)
            worker.start()
            try:
                deadline = time.monotonic() + 4
                while time.monotonic() < deadline:
                    try:
                        with urlopen(f"http://127.0.0.1:{config['server']['port']}/healthz", timeout=0.3) as response:
                            if response.status == 200:
                                break
                    except OSError:
                        time.sleep(0.05)
                else:
                    self.fail("tMapOnline serve mode did not start")
            finally:
                STOP.set()
                worker.join(timeout=4)
                STOP.clear()
            self.assertFalse(worker.is_alive(), "tMapOnline serve mode did not stop cleanly")


if __name__ == "__main__":
    unittest.main()
