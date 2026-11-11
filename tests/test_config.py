from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tmaponline.config import load_config, page_enabled, site_config_enabled


class TMapOnlineConfigTests(unittest.TestCase):
    def test_defaults_include_modular_pages(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = load_config(Path(temporary) / "config.yaml")
        self.assertTrue(page_enabled(config, "world_map"))
        self.assertTrue(site_config_enabled(config, "world_map", "world_map.coins"))

    def test_user_config_overrides_individual_module(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.yaml"
            config_path.write_text("site:\n  modules:\n    world_map.coins: false\n", encoding="utf-8")
            config = load_config(config_path)
        self.assertFalse(site_config_enabled(config, "world_map", "world_map.coins"))
        self.assertTrue(site_config_enabled(config, "world_map", "world_map.pylons"))


if __name__ == "__main__":
    unittest.main()
