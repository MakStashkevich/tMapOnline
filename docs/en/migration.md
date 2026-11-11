# Updating tMapOnline

This document explains how to update the web map, Python service (backend), and `tMapOnline` server mod. An update replaces the software, but should not erase the saved world, player history, or boss progress.

## Project components

- The Python package and command are named `tmaponline`.
- On macOS, a LaunchAgent is a system service that can run `tmaponline` from the project's virtual environment when you sign in.
- The server mod source and its ID are named `tMapOnline`.
- The new build artifact is `tMapOnline.tmod`.

After changing source code, build a new package and install it in the tModLoader profile. A profile is a separate tModLoader installation with its own mods and worlds. Before replacing the mod, make sure players have disconnected and back up the world and enabled-mod list.

## User data

By default, web map and mod data are stored in `~/Library/Application Support/tMapOnline`. The `~` symbol means the current user's home folder. This directory contains world data, player history, image caches, and `boss-victories.json`, which stores boss victory progress. Do not delete it during an update. If you change `storage.data_dir`, move the files to the new location first and confirm that the application can read them.

## Install and run the updated version

Run commands from the project root. A Python environment is a separate folder for tMapOnline libraries, so they do not mix with other programs on the computer.

1. Create or activate the environment and install the package from the current directory: `python3 -m pip install -e .`. The `-e` flag tells Python to use the source files in place, so code changes do not require another package build.
2. Start the map with `tmaponline --config config.local.yaml serve` or `tmaponline --config config.local.yaml run`. `--config` selects the settings file. `serve` starts only the web service; `run` also starts the game server if one is configured.
3. Build the mod for the installed tModLoader version: `TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py`.
4. Check `dist/tMapOnline.tmod` in a test profile or a copy of the world. This is the finished mod file. Building only creates it; it does not install it in the server profile.
5. Before replacing the mod, make sure players have left. Save a copy of the world, the old `.tmod`, and the enabled-mod list.
6. Copy `tMapOnline.tmod` to the server profile, enable the mod, and restart the server at a safe time when no players are online.
7. Open `/healthz` to check whether the service responds, `/api/site-config` to see which features are enabled, and `/api/status` to see server state. Then check the map, fresh game data, and Map Ping in both directions.

## Rollback

If the new build does not start, stop it normally and restore the previous `.tmod`, enabled-mod list, and service build. A rollback returns to a saved working version. Do not delete the tMapOnline data directory.
