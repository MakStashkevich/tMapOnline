# tMapOnline architecture

This document explains how tMapOnline is put together and how game data reaches the map in a browser. The Python service receives and stores data. It serves that data to the web map through an API, while the server mod collects it inside tModLoader.

The flow is: Terraria provides information to the mod, the mod sends it to the service, the service prepares a response, and the browser turns that response into a map and markers. Neither the browser nor the Python service reads Terraria's process memory directly.

In short, the mod reads the game, the Python service receives the data, and the browser displays it. An API is a set of addresses used by the browser and service to exchange data. A snapshot records the game state at a particular moment. A cache keeps prepared data so it does not have to be generated again.

## Projects and boundaries

```text
tMapOnline/                       # web map, backend, and mod project
├── tmaponline/                  # Python package and owned tModLoader mod
│   ├── backend/                 # requests, responses, and web asset serving
│   ├── telemetry/               # connection to the game mod
│   ├── sprite_renderer/         # game textures and prepared PNG sprites
│   ├── web/
│   │   ├── src/                 # editable interface and map source
│   │   ├── assets/              # build output
│   │   ├── static/              # source images, fonts, and interface files
│   │   └── world-map/           # web map entry page
│   ├── tmodloader/
│   │   └── tMapOnline/          # C# game server mod source
│   ├── config.py                # YAML loading, validation, and defaults
│   └── runtime.py               # service and game process lifecycle
├── docs/                        # project documentation
├── tests/                       # automated Python and web checks
├── tools/                       # web and mod build commands
├── config.example.yaml
├── package.json
└── pyproject.toml
```

`backend/http.py` handles browser requests and selects a response. `backend/store.py` gives the other parts of the program one shared way to work with data without knowing which files hold it. Responsibilities in `backend/services/` are grouped by topic: `player_history` stores player history, `movement` handles movement, `live_telemetry` handles current game data, `monitoring` handles server status, and `world_map` handles the map.

Shared formats and constants live in `store_common.py`. The store is split into small parts that provide specific features instead of one enormous class. Locks prevent two tasks from changing the same data at once. A cache reuses recently prepared results.

In JSONL, each message occupies one line. The service validates each line and converts it into a model from `models/telemetry.py`, a structure with known fields. This makes the data easier to use and errors easier to find. At the input and output boundaries, data is converted to the formats expected by the browser and other clients.

Update intervals are set in `config.yaml`, so fast-moving markers and the large map are not sent at the same rate. tModLoader sends positions, entities, and colored map data separately. Between messages, the mod keeps the latest value for each category.

The first `/api/world-map` request returns metadata—the world size and descriptions of available layers—without pixel chunks. A chunk is a rectangular piece of a finished image. A complete JSON response with all chunks can be requested explicitly with `?tiles=0`, for example when exporting.

The browser draws only objects within the visible part of the map. It creates an HTML element with a sprite for each visible player or object. When the map moves or its scale changes, the browser recalculates which markers should remain on screen. This affects display only; it does not create or remove NPCs in the game.

The map image is divided into pyramid levels: distant views use small overview tiles, and zooming in uses more detailed ones. The server serves PNG tiles up to 256 × 256 pixels and assembles each response only from chunks intersecting the requested area. A cache keeps finished PNGs so they do not need to be assembled again. It is limited by entry count and a total size of 32 MiB. `/debug` shows cache hits, evictions, and image preparation time.

A canvas is a browser surface for drawing images. No more than 16 map tiles and 4 MiB of decoded images are active at a time. The map and exploration mask use separate canvases, so updating the mask does not require downloading the base images again. When the detail level changes, the old image remains visible until the new one arrives. Tiles outside the viewport are not added to the DOM. The complete dataset is read only for an explicit export.

Current positions, deaths, coins, and block changes arrive through `/api/world-map/live`. SSE (Server-Sent Events) keeps an HTTP connection open so the server can deliver new messages without a separate request for every object. The server sends data near the visible area with a small margin, and the browser renews the subscription after a significant map movement. Coin markers are requested only at high zoom.

When a block changes, the server stores the updated data. The browser refreshes only the image tile containing that block. If the same coordinate changes several times before the next update, only its latest state is used. Other tiles are refreshed when the user reaches them. `/debug` helps inspect snapshot frequency and age, response size, and image preparation time.

`telemetry/stream.py` accepts newline-delimited JSON snapshots. The mod collects server state and sends it to localhost. The web client never accesses the game process directly; it reads the shared API.

### Sprite rendering

`sprite_renderer/xnb_texture.py` checks XNB headers and reads their `Texture2D` RGBA data. Compressed XNB files are expanded by `sprite_renderer/lzx.py`, including 32 KiB frames; no external LZX package or Java runtime is required. `PlayerSpriteRenderer`, `NpcSpriteRenderer`, and `MapItemSpriteRenderer` compose player avatars, NPC/boss portraits, and item icons. Pillow is used only at the PNG read/write boundary; `StatusStore` owns caching and image URLs. The tModLoader mod is written in C#.

To match in-game markers, the implementation is checked against decompiled code from the same Terraria/tModLoader version. The death cross comes from the game resource `Content/Images/MapDeath.xnb`; `Main.DrawPlayerDeathMarker` draws it at `Player.lastDeathPostion`, centered and scaled to the map. tMapOnline therefore uses the original sprite without an added shadow or artificial outline. Decompiled code is a developer reference; it is not included in this repository and is not required to run the project.

### tModLoader composition and services

The telemetry stream sends snapshots at a configurable interval in game ticks. Deaths are captured through `Player.KillMe`, get a unique ID, and remain in the mod's queue until the Python service confirms a successful write. Python applies a configurable TTL to stored markers. Player and NPC directions are sent separately from their positions so the UI can reproduce the game's horizontal sprite flip.

`TMapOnlineSystem` is the lifecycle/composition root: it attaches game hooks, creates services, and assembles JSON snapshots while preserving the existing JSONL/API contract. Details are delegated to objects with limited responsibilities:

The composition root creates and connects the other objects. A service is a helper responsible for one part of the work. A hook is a point where the game calls mod code in response to an event, such as a world change.

- `TelemetryStreamServer` owns the TCP listener, clients, JSONL, snapshot acknowledgements, and incoming commands.
- `WorldMapScanner` scans a small base-map chunk each game tick, prepares the palette, and reports progress.
- `PlayerMapChangeRevealer` builds the revealed area around a player and limits repeated region capture.
- `MapTileDataCapture` serializes block and wall IDs and compresses the area.
- `MapTileNameCatalog` resolves localized block and wall names and sends them with the data over time.
- `PlayerAppearanceSnapshotBuilder` collects player appearance and exports the required textures.
- `WorldEntitySnapshotBuilder` collects pylon, NPC/boss, and dropped-coin markers.
- `BossProgressSnapshotReader` reads vanilla progression flags only.
- `CalamityBossProgressAdapter` separately queries the optional Calamity mod and its saved flags.
- `BossVictoryTracker` stores repeat victories in `ApplicationData/tMapOnline/boss-victories.json`.

Services receive only the state they need. Reads and changes to `Main`, `Player`, `NPC`, tiles, the palette, and the map happen synchronously on the game thread. The background transport receives serialized, immutable JSONL strings rather than live game objects. `Main.dedServ` is not overridden to initialize the map.

## Web interface structure

`web/world-map/index.html` is the only entry point for the tMapOnline web map. `/` and `/world-map` open the same map; the old monitoring screen is disabled. Interface, map, section, and style sources are in `web/src`. `npm run build` compiles and minifies TypeScript into ES modules and SCSS into CSS in `web/assets`. In production, Python serves these files and does not require Node.js.

`src/app-shell.ts` contains `TMapOnlineApplication`: it loads section data on demand and opens it in a pixel dialog. The map fills the screen immediately. `MapActionMenu` builds the vertical categories and adjacent submenu; `PixelModal` handles closing, Escape, and keyboard focus. Players and routes are configured in the players dialog and update map layers immediately. `MapZoomControls` connects pixel zoom buttons and the whole-world view to the map controller. Sections in `src/sections/{world,players,bosses,server,activity}.ts` load dynamically when their menu item is opened; their styles are loaded lazily too.

Map categories contain player and route controls, world data and boss victories, server status, and activity; diagnostics are also available at `/debug`. Sections can be enabled in `site.sections`. The backend serves them through the compact `/api/section-data?section=...` endpoint. Boss progress includes active bosses, vanilla victory flags, a compatible repeat-victory counter, and optional Calamity status. The full `/api/status` endpoint remains for compatibility and is not the source for modal data. Map updates continue while a modal is open.

The UI uses native ES modules without a frontend runtime or component library. The loading boundary is explicit: the shell handles menus and dialogs, each section's SCSS handles its pixel styling, and `mount(root)` requests and renders its data. esbuild and Sass run during development or packaging. Analytics, player history, and logs are not loaded until the user opens the corresponding dialog.

### TypeScript objects and responsibilities

`src/map/world-map.ts` remains the map page's composition root: it activates configurable features, connects data lifecycle to display, and updates the map layer. Separate objects handle isolated mechanisms:

- `MapSnapshotCache` — IndexedDB and restoration of saved state.
- `MapChunkCodec` — decoding and composing base chunks and updates.
- `MapPyramidLayerRenderer` — detail-level selection, visible PNG tile loading, cancellation of stale HTTP requests after a viewport change, and prioritization near the zoom point; without an active point, it loads the viewport center first.
- `MapExplorationMask` — combines imported maps and routes into a revealed-area mask.
- `MapImageExporter` — exports the pixel map as PNG with the exploration mask applied when enabled.
- `MapViewportController` — zoom, panning, gestures, and viewport events; it passes the world coordinate under the zoom point to the renderer so those tiles load first.
- `MapZoomControls` — zoom buttons and return to whole-world scale.
- `MapEntityLayer` — player, NPC/boss, coin, pylon, and spawn markers; offscreen coordinates do not create DOM sprites or animation loops.
- `MapTooltipController` — hover delay, block-information cache, and tooltip card.
- `MapPlayerPathService` — player-history normalization, route cache, and splitting exploration into segments around teleports.
- `MapRouteLayer` — SVG routes and current-position markers.
- `MapDiagnosticsPanel` — scanner state and diagnostic panel.

Add new map functionality to a separate object with one clear role and explicit dependencies through its constructor or connections. Do not move chunk codecs, IndexedDB lifecycle, gesture handling, or marker markup back into `world-map.ts`. Split remaining large map workflows as the corresponding features change; avoid thin wrapper classes without their own state or behavior.

Frontend commands: `npm ci` installs the toolchain pinned in the lock file, `npm run typecheck` checks TypeScript, `npm run build` updates `web/assets`, and `npm run check:web` runs both checks in sequence. Build assets after source changes before running or packaging tMapOnline. Pyright checks Python in strict mode (Pylance uses the same engine): run `npm run check:python`. For a local environment, install dependencies with `python3 -m pip install -r requirements-dev.txt`, then run `npm ci`. The full check is `npm run check:all`. Four existing services that use version-flexible JSON stores disable only unknown-type diagnostics; their used fields are still checked at runtime, and the rest of Pyright's strict rules remain enabled.

## State and configuration

`config.yaml` controls startup and which pages and sections are enabled. Browser theme, selected players/layers, and map position are stored separately in `localStorage`. Personal data and caches are in `~/Library/Application Support/tMapOnline`, not in the repository. See [telemetry.md](telemetry.md) for the API and telemetry schema.

Configuration separates service startup from page and component availability. User display preferences are stored separately from server settings.
