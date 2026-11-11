# Configuration and web sections

This document explains the server settings. YAML is a text format that uses indentation: spaces show which group a setting belongs to. Server configuration defines which data to collect and which features to enable. It is shared by all visitors. Each browser stores its zoom and layer visibility separately in `localStorage`.

The file is read by `tmaponline/config.py`, which validates settings before startup. If a setting is omitted, tMapOnline uses its default. Restart the service after editing the file, or it will keep using the old values.

```yaml
site:
  world_map:
    route_history_days: 7 # Route history period in days (1–365)
  pages:
    world_map: { enabled: true }
  sections:
    world: true
    players: true
    bosses: true
    server: true
    activity: true
  modules:
    world_map.exploration: true
    world_map.entities: true
```

This example shows the `site` group, which controls the web map and sections. The file also has `storage` and `telemetry` groups. The value after a setting's colon is its value: `true` enables it and `false` disables it. The number `7` means the map requests the most recent seven days of routes. Keep the indentation; it determines which group owns each setting.

When “Route history” is enabled in a player's card, the map automatically requests saved points for the period in `site.world_map.route_history_days`. Set a number from 1 to 365.

The next settings control history retention and update intervals. Telemetry is information that the mod automatically sends to the service while the game is running.

```yaml
storage:
  death_retention_seconds: 3600 # 0 — keep deaths indefinitely
  event_retention_seconds: 2592000 # 30 days; 0 — no time limit
  event_max_entries: 5000 # Maximum number of events
telemetry:
  player_position_interval_ticks: 6 # Player positions, 6 ticks ≈ 100 ms
  entity_interval_ticks: 6 # NPCs, bosses, coins, and pylons
  map_capture_interval_ticks: 30 # Colored map data around players
  map_tile_update_interval_ticks: 1 # Changed tiles and walls, including explosions
  map_pings_from_players_to_web: true # Show player pings on the map
  map_pings_from_web_to_players: true # Send web map pings to players
  initial_world_scan_enabled: true # Full world scan when tMapOnline starts
  world_scan_interval_ticks: 1 # Pause between scanner chunks
  browser_live_poll_interval_ms: 50 # Lightweight live data polling interval
  browser_overview_poll_interval_ms: 250 # Live updates while viewing the whole map
  browser_map_poll_interval_ms: 5000 # Map update interval
  browser_debug_poll_interval_ms: 1000 # Map interval while debug settings are open
```

The retention period also applies to deaths that are already stored. For each death event, the mod sends a stable ID and waits for an acknowledgement from the Python service. If the connection drops, the event remains queued and is sent again.

The event log is cleaned automatically at startup and after every new entry. Entries older than `storage.event_retention_seconds` are removed first; then only the newest `storage.event_max_entries` entries remain. A value of `0` disables time-based cleanup, but the count limit still applies.

Some intervals use game ticks. A tick is one game step; at 60 ticks per second, six ticks take about 100 milliseconds. tMapOnline passes these values to the mod. Browser intervals are in milliseconds; 1000 ms is one second. The browser loads the large map separately and gets positions, objects, and small block changes through `/api/world-map/live`. It does not need to download the entire map repeatedly.

All available settings and defaults are listed in `config.example.yaml`. The active file is passed with `--config`, for example: `tmaponline --config config.local.yaml serve`.

| Key                                           | Purpose                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `site.pages.world_map.enabled`                | Enables the tMapOnline web map.                                                                                               |
| `site.sections.*`                             | Enables data sections: world, players, bosses, server, and activity. Each section requests data when opened.                  |
| `site.modules.world_map.*`                    | Enables individual map layers: exploration, routes, players, entities, coins, pylons, spawn point, tooltips, and diagnostics. |
| `storage.death_retention_seconds`             | How long death markers are kept, in seconds. `0` disables automatic cleanup. Default: 3600.                                   |
| `storage.event_retention_seconds`             | Event-log retention in seconds. `0` disables time-based cleanup. Default: 2592000 (30 days).                                  |
| `storage.event_max_entries`                   | Maximum number of recent log entries. Default: 5000.                                                                          |
| `telemetry.player_position_interval_ticks`    | Player-position interval in game ticks. The local server uses `1`.                                                            |
| `telemetry.entity_interval_ticks`             | NPC, boss, coin, and pylon interval in game ticks. The local server uses `1`.                                                 |
| `telemetry.map_capture_interval_ticks`        | How often colored map data around players is captured.                                                                        |
| `telemetry.initial_world_scan_enabled`        | Enables the initial full world scan. Disable it to check map updates from player movement and tile changes.                   |
| `telemetry.world_scan_interval_ticks`         | How often the world scanner processes chunks.                                                                                 |
| `telemetry.map_tile_update_interval_ticks`    | Interval for changed tiles and walls. Hooks track mining, placement, and explosions.                                          |
| `telemetry.map_pings_from_players_to_web`     | Sends player pings to the web map.                                                                                            |
| `telemetry.map_pings_from_web_to_players`     | Sends web map pings to server players.                                                                                        |
| `telemetry.browser_live_poll_interval_ms`     | Lightweight browser polling interval. Default: 50 ms for smooth marker movement.                                              |
| `telemetry.browser_overview_poll_interval_ms` | Live polling interval at distant zoom. Markers move in steps instead of frame-by-frame. Default: 250 ms.                      |
| `telemetry.browser_map_poll_interval_ms`      | Browser interval for fetching map chunks. Current value: 5000 ms.                                                             |
| `telemetry.browser_debug_poll_interval_ms`    | Map update interval while debug settings are open. Current value: 1000 ms.                                                    |

If a page is disabled, its address returns `404`, meaning the page is unavailable. A disabled section disappears from the menu and does not load data. A disabled layer is not drawn. To add a layer, set its default, register it in `tmaponline/web/src/core/modules.ts`, and document it here. Browser preferences are not written to this YAML file.

## Building the interface

Editable web interface files are in `tmaponline/web/src`: behavior is written in TypeScript, and appearance is defined by SCSS inside `styles`. To build the interface, run:

```sh
npm ci
npm run format
npm run check:web
```

The build creates minified ES modules and CSS in `tmaponline/web/assets`; Python serves these files in production without Node.js. The map, players, bosses, server, and activity sections remain separate dynamic chunks with their own CSS files.

`npm ci` installs the exact tool versions recorded in the lock file. `npm run format` formats the source according to project conventions. `npm run check:web` checks the web code and builds the interface. Output goes to `tmaponline/web/assets`; these files are generated, so edit files in `src` or resources in `static` instead.
