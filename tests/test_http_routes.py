from __future__ import annotations

import sys
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terraria_viewer.backend.http import start_dashboard
from terraria_viewer.backend.store import StatusStore


class ViewerRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.store = StatusStore(
            events_file=root / "events.json", history_file=root / "history.json",
            players_file=root / "players.json", metrics_file=root / "metrics.json",
            avatars_dir=root / "avatars", movements_dir=root / "movements",
            boss_cache_dir=root / "boss", exploration_dir=root / "exploration",
            npc_sprites_dir=root / "npcs", npc_textures_dir=root / "textures", map_sprites_dir=root / "map",
        )
        self.server = start_dashboard(self.store, 0, {"pages": {"world_map": {"enabled": True}}, "modules": {"world_map.coins": False}}, "127.0.0.1")
        self.base = "http://127.0.0.1:%s" % self.server.server_port

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.temporary.cleanup()

    def test_debug_map_and_module_assets_load(self) -> None:
        checks = [
            ("/healthz", b"ok"),
            ("/api/site-config", b"world_map.coins"),
            ("/world-map", b"/assets/world-map.css"),
            ("/world-map/debug", b"/assets/world-map.js"),
            ("/assets/app-shell.js", "Карта мира".encode("utf-8")),
            ("/assets/world-map.js", b"world_map.debug"),
        ]
        for path, expected in checks:
            with self.subTest(path=path), urlopen(self.base + path, timeout=3) as response:
                self.assertEqual(response.status, 200)
                self.assertIn(expected, response.read())

    def test_disabled_page_returns_404(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server = start_dashboard(self.store, 0, {"pages": {"world_map": {"enabled": False}}}, "127.0.0.1")
        self.base = "http://127.0.0.1:%s" % self.server.server_port
        with self.assertRaises(HTTPError) as error:
            urlopen(self.base + "/world-map/debug", timeout=3)
        self.assertEqual(error.exception.code, 404)

    def test_wiki_cache_serves_cached_boss_image(self) -> None:
        image_url = "https://terraria.wiki.gg/images/King_Slime.gif?1becd1"
        digest = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
        self.store.boss_cache_directory.mkdir(parents=True, exist_ok=True)
        (self.store.boss_cache_directory / f"{digest}.body").write_bytes(b"GIF89a test image")
        (self.store.boss_cache_directory / f"{digest}.json").write_text(
            json.dumps({"stored_at": __import__("time").time(), "content_type": "image/gif"}),
            encoding="utf-8",
        )
        from urllib.parse import quote

        with urlopen(self.base + "/api/wiki-cache?url=" + quote(image_url, safe=""), timeout=3) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "image/gif")
            self.assertEqual(response.read(), b"GIF89a test image")


if __name__ == "__main__":
    unittest.main()
