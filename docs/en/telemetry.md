# Telemetry and API

Telemetry is game data that the mod sends to the web service automatically. The service receives it, validates it, saves the required history, and provides prepared responses to the browser. Map Ping travels over the same connection from the game to the browser and from the browser to the game.

## Mod data stream

The mod opens a port specified by `server.telemetry_port` on the address in `server.telemetry_host` and waits for a connection. The Python client connects over TCP, a network connection between two programs. After connecting, the mod sends data. Each JSON line contains one record; this format is called JSONL. The `schemaVersion: 1` field identifies the rules used to read the record. Records contain server, world, player, NPC, and map-object state. The Python client retries automatically after a disconnect. It skips malformed lines and continues reading.

Each complete record (a snapshot of the current state) has a `snapshotId`. Once the Python client has read and saved a snapshot, it returns an ACK, a short confirmation that the record was accepted: `{"ackSnapshotId":123}`. A death event has its own `id` because it can happen between snapshots. The mod resends unacknowledged events and removes them from its queue only after an ACK. `storage.death_retention_seconds` sets how long death markers are kept; `0` means they are kept without automatic cleanup.

Players and NPCs send their facing direction from `Player.direction` and `NPC.spriteDirection`, so the browser can flip the sprite correctly. The optional `respawnPending` field indicates that the player is still dead or that their coordinates have not changed since respawning. While it is `true`, the map hides the normal player marker at the old position but keeps the death cross visible.

A payload is the content of one record sent by the mod. For a compatible change, add optional fields: older receivers can ignore them. If the meaning or type of an existing field changes, increment the schema version and teach the receiver to read both old and new versions during the transition. Do not include passwords, tokens, or other secrets in messages.

## HTTP endpoints

HTTP is the usual way for a browser to request a page or data from a server. `GET` reads data, `POST` sends data, and `DELETE` removes specified data. Text after `?` contains query parameters: for example, `x=10&y=20` gives tile coordinates. In this table, `x` and `y` are measured in game tiles.

In the endpoint list, `id` means a player ID, `world` is the world name, `days` is the number of history days, and `since` is a marker used to request only newer changes. A feature flag tells the interface whether a feature is available.

| Endpoint                                                   | Purpose                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/status`                                          | Summary of server state, players, bosses, and history.              |
| `GET /api/world-map`                                       | Metadata and layers, without full pixel chunks.                     |
| `GET /api/world-map?tiles=0`                               | Compatible full map JSON with pixel chunks.                         |
| `GET /api/world-map?since=...`                             | Map update delta.                                                   |
| `GET /api/world-map/tile-info?x=...&y=...`                 | Localized block or wall description.                                |
| `GET /api/world-map/exploration?id=...&world=...`          | Player exploration image.                                           |
| `POST /api/world-map/import-player-map?id=...`             | Import a `.map` from the debug page and merge newly revealed tiles. |
| `POST /api/world-map/export-player-map?id=...`             | Export a `.map` from saved information.                             |
| `DELETE /api/world-map/import-player-map?id=...&world=...` | Clear only the imported part of the map.                            |
| `GET /api/resource-history?days=...`                       | Server resource history.                                            |
| `GET /healthz`                                             | Local check that the HTTP server is reachable.                      |
| `GET /api/site-config`                                     | Interface feature flags.                                            |

Static interface files (CSS, JavaScript, and permanent images) are in `/assets/`. Player, NPC, and boss images are served through separate API addresses from the data directory.

To check an address manually, open it in a browser or send a request from the command line. Start with `/healthz`: a successful response means the HTTP service is running. It does not prove that the mod is connected or that the map has arrived. Check `/api/status` and `/api/world-map` for that.
