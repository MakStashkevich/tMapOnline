from __future__ import annotations

import argparse
import sys

from .config import load_config
from .runtime import run_local


def main() -> int:
    parser = argparse.ArgumentParser(prog="terraria-viewer", description="Local Terraria world viewer and telemetry service")
    parser.add_argument("--config", default="config.yaml", help="YAML configuration file")
    parser.add_argument("command", nargs="?", choices=("run", "serve"), default="run", help="run game + viewer, or viewer only")
    args = parser.parse_args()
    try:
        return run_local(load_config(args.config), run_game=args.command == "run")
    except (OSError, ValueError, RuntimeError) as error:
        print(f"terraria-viewer: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
