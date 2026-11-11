# tMapOnline server mod

The mod is named `tMapOnline`. It runs inside server-side tModLoader; players do not need to install it separately. The mod sends game data to the web service and delivers Map Ping in both directions.

## What the mod does

The mod does not draw the map or run the website. It reads game data, such as a player's current position, and sends it to the tMapOnline application. The application stores the data and displays it in a browser. Map Ping also works both ways: place a marker in the browser and it appears in the game; place one in the game and it appears in the browser.

## Responsibilities and boundaries

The mod and tMapOnline exchange messages over a TCP connection at `127.0.0.1`. This is the computer's own address; outside machines cannot connect to this port. Each message is a separate line of JSON. The mod is not a web server and does not change browser settings.

Game objects can be read and changed safely only during the game loop, while tModLoader is updating the world. For network work, the mod uses prepared message text rather than accessing the world from another task.

`TMapOnlineSystem` manages mod startup and shutdown. It attaches game event handlers, starts the other parts of the mod, prepares snapshots at regular intervals, receives Map Ping, and closes the connection during shutdown.

| Responsibility                                                                 | Component                                          |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| TCP listener, clients, JSONL, snapshot acknowledgements, and incoming commands | `TelemetryStreamServer`                            |
| NPC and world-entity snapshots                                                 | `WorldEntitySnapshotBuilder`                       |
| Player appearance and mod texture export                                       | `PlayerAppearanceSnapshotBuilder`                  |
| Map scanning and RGB/RGBA tile changes                                         | `WorldMapScanner`, `MapTileDataCapture`            |
| Tile/wall names and localization                                               | `MapTileNameCatalog`                               |
| Detecting revealed areas in a player's map                                     | `PlayerMapChangeRevealer`                          |
| Vanilla victory flags and legacy counters                                      | `BossProgressSnapshotReader`, `BossVictoryTracker` |
| Calamity-specific integration                                                  | `CalamityBossProgressAdapter`                      |

The table describes each class's responsibility. RGB is a pixel's red, green, and blue values. RGBA adds transparency. `CalamityBossProgressAdapter` is only needed for Calamity support; the rest of boss-progress handling does not depend on it.

Class names match the source code. When working with the game world, keep reads and changes to game objects inside the game loop. Network tasks may run separately, but they must use already prepared messages.

## Transport and reliability

- By default, the listener waits only at `127.0.0.1:38762`. Configure it with `server.telemetry_host` and `server.telemetry_port`.
- Snapshots use JSON Lines, schema version `1`. Every line contains `snapshotId`; tMapOnline acknowledges accepted snapshots over the same TCP connection.
- Death events have stable IDs, are resent until acknowledged, and are limited by `storage.death_retention_seconds`.
- The tMapOnline client reconnects after a disconnect. The listener keeps the latest state so a new client receives a current snapshot immediately.
- A web Map Ping is sent as a command with tile coordinates; the mod broadcasts it to connected players in the game. Game Map Pings return as events with tile coordinates.
- Browser display preferences are not sent to the mod. Intervals and ping directions are set in the server startup configuration.

Keep the direction of the connection in mind: the mod opens a port and waits, and the Python service connects to it. After connecting, both sides can send messages: the service sends Map Ping and acknowledgements, while the mod sends snapshots and game events.

See [telemetry.md](telemetry.md) for the schema and endpoints. If a field changes meaning or type, use a new schema version and a compatibility period; do not silently change version 1.

## Build

Run the command from the project root. On macOS, set `TML_ROOT` to the installed tModLoader folder:

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

Replace `/path/to/tModLoader` with the installed game path. The script builds the C# project and writes the finished package to `dist/tMapOnline.tmod`. It uses a separate temporary folder, so it does not change profile settings. The script does not install the mod or touch files belonging to a running server. The build and server must use the same tModLoader version.

For the server to load the mod, copy `.tmod` into the `Mods` folder of its profile and add the mod ID to `Mods/enabled.json`, the list of enabled mods. The mod loads on the next server start. Before restarting, make sure players have left so their game is not interrupted.

## Mod changes

1. Find the relevant event handler in `TMapOnlineSystem`. If it accumulates too much logic, move that logic to a separate class with one clear responsibility.
2. Trace each message end to end: who sends it and who receives it in the Python service.
3. Read the Terraria API on the game loop. Pass prepared messages to network tasks.
4. Give important events a unique ID and resend them until the service confirms receipt.
5. Build the mod with `python3 tools/build-mod.py` for the tModLoader version it will run on.
6. Do not copy `.tmod` into a running server's profile or restart it unless installation and startup were requested separately.

An event handler is code that runs when something happens in the game, such as a block changing. A unique ID lets the service recognize an event it has already accepted, so a resend does not create a duplicate.
