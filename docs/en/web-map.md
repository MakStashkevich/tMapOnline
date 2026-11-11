# tMapOnline web map

This document explains how the web map works. The browser receives the map and game data from the Python service instead of connecting to Terraria directly. The tModLoader mod sends game information to the service. The service prepares API responses, images, and history.

The data flow, cache, map layers, and responsibilities of the main components are described below. “Tile” and “chunk” mean different things here: a tile is one Terraria game square, while a chunk is a rectangular piece of a finished image that the browser loads separately.

## From the API to a pixel

1. `web/src/map/world-map.ts` creates the map, loads modules from `/api/site-config`, requests world metadata, and connects renderers to controllers.
2. The server sends already-rasterized PNG fragments through `GET /api/world-map/tile?world=…&level=…&x=…&y=…`. The browser does not transfer RGB arrays or recolor the whole map every time it opens.
3. `MapSnapshotCache` stores the client snapshot and chunks in IndexedDB. `MapPyramidLayerRenderer` keeps a coarse overview and chooses the detail level for the current zoom. Visible chunks have priority, and stale requests are cancelled.
4. `MapViewportController` converts the wheel, pinch, and drag gestures into viewport coordinates. The world coordinate under the zoom point affects network request priority.
5. A separate lightweight live request updates players and entities. NPC, pylon, and other object markers are rendered in their own DOM layer above the map image.
6. Tile changes arrive as telemetry deltas, update backend storage, and affect the relevant base and pyramid PNG chunks.

A renderer draws data. A controller handles user actions and coordinates requests. A delta is a small message containing changes only, not the entire map.

Map layers update independently. The base layer is the world image. Exploration shows revealed areas. A mask is a black-and-white image that determines where a layer is visible. Other layers show current positions, route lines, Map Ping, the background, and interface controls. When adding a layer, the browser must receive its data from the API and pass it to the component that draws it. Changing one layer should not force other layers to reload.

## State ownership

| State                                                           | Source of truth                        | Survives a page reload?                              |
| --------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Server features, collection intervals, and route-history period | `config.yaml` and `/api/site-config`   | Yes                                                  |
| Layers, smoothing, and display frequency                        | Browser `localStorage`                 | Yes, in this browser profile                         |
| Chunks and client cache state                                   | Browser IndexedDB                      | Yes, until the browser clears site data              |
| Explored map, player/session history, events, and boss progress | Files in the tMapOnline data directory | Yes, independently of the browser                    |
| Live positions and current NPCs                                 | Fresh server-mod snapshots             | No; they expire if the source stops or becomes stale |
| Map textures/masks and PNG pyramid                              | Backend storage, by world and profile  | Yes                                                  |

`localStorage` stores small persistent browser preferences; IndexedDB stores larger items such as chunks. They belong to that browser and device, so another phone does not receive them automatically. The server data directory contains regular files on the computer running tMapOnline.

Web visibility settings belong to the browser user. They are not server settings and are not synchronized between devices. Server configuration can disable a layer entirely; a browser toggle cannot enable a feature that the server has disabled.

## Main components

- `app-shell.ts` and `core/modules.ts`: menu, configurable actions/sections, and shared extension points.
- `components/map-display-settings.ts`: local map preferences and change notifications.
- `components/map-action-menu.ts`, `components/pixel-modal.ts`, `components/map-zoom-controls.ts`: reusable menu and modal interface and behavior.
- `map/world-map.ts`: the map composition root; it should not take on chunk codecs, gestures, caching, and every DOM layer again.
- `map/map-snapshot-cache.ts`, `map/map-tile-bitmap-cache.ts`, `map/map-tile-pyramid-renderer.ts`: image loading and caching.
- `map/map-viewport-controller.ts`: coordinate transforms, gestures, zoom, and visible-area requests.
- `map/map-entity-layer.ts` and `map/map-tooltip-controller.ts`: live markers and game tooltips.
- `map/map-player-path-service.ts`, `map/map-route-layer.ts`, `map/map-exploration-mask.ts`: route selection, exploration masks, and lines.

A composition root creates components and connects them. A codec packs and unpacks data. Use searches in `web/src` to confirm file locations: a file can move, but each component should keep a narrow, clear responsibility.

## Performance and Safari/iOS

- Do not create a giant canvas or bitmap the size of the whole world during zoom. Work with visible chunks and keep the coarse layer until detailed tiles are ready.
- Do not clear a rendered layer when the detail level changes. Keep the old/coarse bitmap visible until the new one arrives to avoid a flash of empty background.
- Cancel stale requests and do not apply responses from an old viewport to a new area. During pinch zoom, prioritize chunks around the gesture center.
- Keep layer and marker sizes and transforms stable throughout pinch animation. Do not remove and recreate NPC DOM sprites on every zoom change.
- Use reasonable bitmap limits and avoid copying large pixel arrays unnecessarily: iOS Safari has different limits from desktop browsers.
- After changes in this area, test wheel zoom and pinch zoom in Safari on iOS separately. A successful build alone does not prove the phone has no flicker.

## Changing the map

1. Find where the page loads data and trace it through the API and cache.
2. Load large maps lazily: use viewport-based API requests and cache by world/version/profile/level/coordinates.
3. Request large datasets separately from compact live snapshots. Do not add full history to frequent polling.
4. Store user preferences in the browser; keep server intervals, feature availability, and history periods in server configuration.
5. Build new interface elements from reusable components and existing pixel tokens, with keyboard and mobile behavior in mind.
6. When the protocol changes, update the TypeScript consumer, backend handler/store, and mod producer together.
7. Rebuild assets after TypeScript or SCSS changes; see `npm run build`.

## Current limitations

The map is transferred as PNG chunks. Tile arrays remain on the server as the source data and are needed to regenerate images and tooltips. Unexplored regions do not reveal the real world to the client: they are masked on the server. Live entities depend on fresh mod snapshots; a stale snapshot is not used to display coordinates.
