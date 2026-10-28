#!/usr/bin/env python3
"""Build the mod into an isolated profile so a running server's .tmod stays untouched."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> int:
    project = Path(__file__).resolve().parents[1] / "tmodloader" / "TerrariaTunnelTelemetry"
    default_tml = Path.home() / "Library/Application Support/Steam/steamapps/common/tModLoader"
    tml_root = Path(os.environ.get("TML_ROOT", str(default_tml))).expanduser().resolve()
    if not (tml_root / "tModLoader.dll").is_file() or not (tml_root / "tMLMod.targets").is_file():
        print(f"tModLoader install not found at {tml_root}; set TML_ROOT.", file=sys.stderr)
        return 2
    env = dict(os.environ)
    env.setdefault("DOTNET_ROLL_FORWARD", "Major")
    with tempfile.TemporaryDirectory(prefix="terraria-viewer-mod-profile-") as isolated_home:
        env["HOME"] = isolated_home
        command = ["dotnet", "build", str(project / "TerrariaTunnelTelemetry.csproj"), f"-p:TmlRoot={tml_root}"]
        result = subprocess.run(command, cwd=project, env=env)
        if result.returncode:
            return result.returncode
        packages = list(Path(isolated_home).rglob("TerrariaTunnelTelemetry.tmod"))
        if len(packages) != 1:
            print(f"Expected one packaged mod in isolated profile, found {len(packages)}.", file=sys.stderr)
            return 1
        destination = project.parents[1] / "dist" / packages[0].name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(packages[0], destination)
        print(f"Built isolated mod package: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
