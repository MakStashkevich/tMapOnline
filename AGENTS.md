# Project code rules

## Architecture

- Keep `app-shell.ts` responsible for navigation and application-wide presentation. Put page behavior in page controllers and keep map rendering, cache, viewport input, tooltips, and API access in focused objects under `web/src`.
- Treat each section module as a small feature boundary: it owns its data request and DOM for that section, while shared shell state stays in the shell.
- Keep `TerrariaTunnelTelemetrySystem` as the tModLoader lifecycle/composition boundary. It may register hooks and coordinate collaborators, but put networking, player appearance export, map scanning, localization lookup, and snapshot composition in focused classes.
- Game API reads and writes must stay on the tModLoader-owned thread unless the API explicitly guarantees thread safety. Background services receive immutable serialized data, not live Terraria objects.
- Preserve the existing JSONL schema, HTTP API, storage formats, and gameplay behavior during structural changes. Any contract change must be explicit and update the producer and consumer together.
- Prefer objects that own state and behavior together. Avoid static utility collections, giant page controllers, and partial classes used only to split a long file.

## Source style

- Write readable TypeScript, SCSS, and C#. Do not manually minify or compress source; generated files in `web/assets` are build output and may be minified.
- Use descriptive names and normal formatting. Add short English comments at important boundaries and non-obvious algorithms, especially thread affinity, concurrency, persistence, protocol framing, and rendering/cache behavior. Do not comment obvious syntax line by line.
- Give public collaborators narrow constructor dependencies and explicit methods. Keep DOM access out of data services and keep HTTP/socket/file effects out of presentation objects where practical.
- Handle failures at the boundary that can recover or report them. Do not turn a failed read into valid-looking empty world data.

## Before completion

- Trace callers and the matching consumer before changing a protocol or persisted representation.
- Run `npm run check:web` after TypeScript/SCSS changes.
- Build the tModLoader mod using `python3 tools/build-mod.py` when the local tModLoader installation is available. Do not restart the game server as part of a source refactor unless the user asks.
- Update `docs/architecture.md` to distinguish implemented boundaries from work that remains.
