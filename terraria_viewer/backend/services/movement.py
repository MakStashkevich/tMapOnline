# Persisted player movement is deliberately schema-flexible across older JSON versions.
# Values are shape-checked at each read boundary before use.
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false
from __future__ import annotations

from ..store_common import (
    AVATAR_RENDERER_VERSION,
    Any,
    Path,
    WORLD_MAP_CHUNK_SIZE,
    as_json_object,
    StoreMixinContract,
    base64,
    hashlib,
    json,
    math,
    struct,
    time,
    zlib,
)


class MovementMixin(StoreMixinContract):
    @staticmethod
    def _appearance_signature(appearance: Any) -> str:
        """Hash visual fields and equipped slots while leaving telemetry fully persisted."""
        try:
            appearance_data = as_json_object(appearance)
            visual_fields = (
                "head", "equippedHead", "body", "legs", "hair", "beard", "face",
                "faceHead", "faceFlower", "skinVariant", "hairColor", "skinColor", "eyeColor",
                "hairSettings", "modEquipTextures", "hideVisibleAccessory", "hideMisc",
            )
            render_data: dict[str, Any] = {
                key: appearance_data[key]
                for key in visual_fields
                if key in appearance_data
            }
            for collection_name in ("armor", "dyes", "miscEquips", "miscDyes"):
                slots = appearance_data.get(collection_name)
                if not isinstance(slots, list):
                    continue
                render_data[collection_name] = [
                    {
                        key: slot.get(key)
                        for key in (
                            "slotIndex", "type", "netId", "prefix", "dye", "modName",
                            "modItemName", "headSlot", "bodySlot", "legSlot", "faceSlot",
                            "beardSlot", "backSlot", "frontSlot", "shoeSlot", "waistSlot",
                            "neckSlot", "handOnSlot", "handOffSlot", "shieldSlot", "wingSlot",
                        )
                    }
                    for slot in slots
                    if isinstance(slot, dict) and int(slot.get("stack", 0) or 0) > 0
                ]
            canonical = json.dumps(
                {"renderer_version": AVATAR_RENDERER_VERSION, "appearance": render_data},
                sort_keys=True,
                ensure_ascii=False,
                separators=(",", ":"),
            )
        except (TypeError, ValueError):
            canonical = "{}"
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _position_from_player(player: dict[str, Any]) -> tuple[int, int] | None:
        position = player.get("position")
        position = as_json_object(position)
        if not position:
            return None
        try:
            x, y = int(position["tileX"]), int(position["tileY"])
        except (KeyError, TypeError, ValueError, OverflowError):
            return None
        return (x, y) if x >= 0 and y >= 0 else None

    def _movement_path(self, player_id: str) -> Path:
        digest = hashlib.sha256(player_id.encode("utf-8")).hexdigest()[:32]
        return self._movements_dir / f"{digest}.json"

    def _load_movement(self, player_id: str) -> dict[str, Any]:
        if player_id in self._movement_cache:
            return self._movement_cache[player_id]
        try:
            movement = as_json_object(json.loads(self._movement_path(player_id).read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            movement = {}
        movement.setdefault("schema_version", 1)
        movement.setdefault("player", {"id": player_id})
        movement.setdefault("worlds", {})
        movement["worlds"] = as_json_object(movement["worlds"])
        for world_key, raw_world_data in movement["worlds"].items():
            world_data = as_json_object(raw_world_data)
            if not world_data:
                world_data = {"visited_tiles": [], "positions": []}
                movement["worlds"][world_key] = world_data
            world_data.setdefault("visited_tiles", [])
            world_data.setdefault("positions", [])
            self._movement_visited_tiles[(player_id, str(world_key))] = set(world_data["visited_tiles"])
        self._movement_cache[player_id] = movement
        return movement

    def _save_movement(self, player_id: str) -> None:
        self._movements_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = self._movement_path(player_id)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(self._movement_cache[player_id], ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(path)
        self._movement_last_saved_at[player_id] = time.monotonic()

    def _save_movement_if_due(self, player_id: str) -> None:
        last_saved = self._movement_last_saved_at.get(player_id, 0.0)
        if time.monotonic() - last_saved >= 1.0:
            self._save_movement(player_id)

    def _load_world_map_cache(self) -> None:
        try:
            loaded = as_json_object(json.loads(self._world_map_cache_file.read_text(encoding="utf-8")))
            worlds = as_json_object(loaded.get("worlds"))
            if worlds:
                self._world_map_cache = {
                    str(key): value for key, value in worlds.items()
                    if isinstance(value, dict)
                }
        except (OSError, ValueError, TypeError):
            self._world_map_cache = {}

    def _save_world_map_cache(self) -> None:
        self._world_map_cache_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._world_map_cache_file.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"schema_version": 1, "worlds": self._world_map_cache}, ensure_ascii=False),
            encoding="utf-8",
        )
        temporary.replace(self._world_map_cache_file)
        self._world_map_cache_dirty = False
        self._world_map_cache_last_saved_at = time.monotonic()

    def _save_world_map_cache_if_due(self) -> None:
        if self._world_map_cache_dirty and time.monotonic() - self._world_map_cache_last_saved_at >= 5:
            self._save_world_map_cache()

    @staticmethod
    def _world_map_cache_key(world: dict[str, Any]) -> str:
        world_id = world.get("id", world.get("world_id"))
        name = str(world.get("name") or world.get("world_name") or "unknown").casefold()
        return f"{world_id}:{name}" if world_id is not None else name

    def _world_movement_record(self, movement: dict[str, Any], world: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        world_id = world.get("id", world.get("world_id"))
        world_name = str(world.get("name") or world.get("world") or self._server_info.get("world") or "unknown")
        world_key = f"{world_id}:{world_name.casefold()}" if world_id is not None else world_name.casefold()
        world_data = movement["worlds"].setdefault(world_key, {
            "world_id": world_id,
            "world_name": world_name,
            "width": world.get("width", world.get("world_width", self._server_info.get("world_width"))),
            "height": world.get("height", world.get("world_height", self._server_info.get("world_height"))),
            "visited_tiles": [],
            "positions": [],
        })
        world_data["world_name"] = world_name
        world_data["width"] = world.get("width", world.get("world_width", world_data.get("width")))
        world_data["height"] = world.get("height", world.get("world_height", world_data.get("height")))
        return world_key, world_data

    def _record_player_movement(
        self, player_id: str, name: str, uuid: str | None, position: tuple[int, int],
        world: dict[str, Any], now: float, map_capture: Any = None, teleported: bool = False
    ) -> None:
        movement = self._load_movement(player_id)
        movement["player"] = {"id": player_id, "name": name, "uuid": uuid}
        world_key, world_data = self._world_movement_record(movement, world)
        tile_x, tile_y = position
        tile_key = f"{tile_x},{tile_y}"
        path = world_data["positions"]
        last = path[-1] if path else None
        # The tModLoader hook marks Player.Teleport exactly. Keep that point in
        # the route, but don't count it as exploration or save its map capture.
        is_teleport = bool(teleported)
        # Some teleport items/mods synchronize the position without calling
        # Player.Teleport on the server. Detect physically implausible jumps as
        # a fallback; ordinary falling/flight remains under this speed limit.
        last = as_json_object(last)
        if last:
            distance = math.hypot(tile_x - int(last.get("x", tile_x)), tile_y - int(last.get("y", tile_y)))
            world_width = int(world_data.get("width") or 0)
            try:
                elapsed = max(0.0, now - float(last.get("time", now)))
            except (TypeError, ValueError):
                elapsed = 0.0
            world_scale_jump = world_width > 0 and distance > max(1000.0, world_width * 0.35)
            sudden_jump = distance >= 250.0 and elapsed <= 15.0 and distance / max(elapsed, 1.0) >= 45.0
            if world_scale_jump or sudden_jump:
                is_teleport = True
        visited = self._movement_visited_tiles.setdefault(
            (player_id, world_key), set(world_data.get("visited_tiles", []))
        )
        changed = False
        if not is_teleport and tile_key not in visited:
            visited.add(tile_key)
            world_data["visited_tiles"].append(tile_key)
            changed = True
        if not last or last.get("x") != tile_x or last.get("y") != tile_y:
            point = {"time": now, "x": tile_x, "y": tile_y}
            if is_teleport:
                point["teleport"] = True
            path.append(point)
            changed = True
        if not is_teleport and self._merge_map_capture(world_data, map_capture):
            changed = True
        if not is_teleport and self._merge_tile_capture(world_data, map_capture):
            changed = True
        if changed:
            movement["updated_at"] = now
            self._save_movement_if_due(player_id)

    @staticmethod
    def _merge_map_capture(world_data: dict[str, Any], capture: Any, chunk_field: str = "map_chunks") -> bool:
        """Merge one compressed Terraria map-color viewport into 64x64 JSON chunks."""
        if not isinstance(capture, dict) or capture.get("encoding") != "rgba-zlib-base64":
            return False
        try:
            x, y = int(capture["x"]), int(capture["y"])
            width, height = int(capture["width"]), int(capture["height"])
            if x < 0 or y < 0 or not 0 < width <= 128 or not 0 < height <= 128:
                return False
            encoded = base64.b64decode(str(capture["data"]), validate=True)
            pixels = zlib.decompress(encoded)
            if len(pixels) != width * height * 4:
                return False
        except (KeyError, TypeError, ValueError, OverflowError, zlib.error):
            return False

        chunk_size = WORLD_MAP_CHUNK_SIZE
        chunks = world_data.setdefault(chunk_field, {})
        if not isinstance(chunks, dict):
            chunks = world_data[chunk_field] = {}
        first_chunk_x, last_chunk_x = x // chunk_size, (x + width - 1) // chunk_size
        first_chunk_y, last_chunk_y = y // chunk_size, (y + height - 1) // chunk_size
        changed_chunks: dict[str, bytearray] = {}
        for chunk_y in range(first_chunk_y, last_chunk_y + 1):
            for chunk_x in range(first_chunk_x, last_chunk_x + 1):
                key = f"{chunk_x},{chunk_y}"
                try:
                    target = bytearray(zlib.decompress(base64.b64decode(chunks[key], validate=True)))
                    if len(target) != chunk_size * chunk_size * 4:
                        target = bytearray(chunk_size * chunk_size * 4)
                except (KeyError, TypeError, ValueError, zlib.error):
                    target = bytearray(chunk_size * chunk_size * 4)

                left = max(x, chunk_x * chunk_size)
                top = max(y, chunk_y * chunk_size)
                right = min(x + width, (chunk_x + 1) * chunk_size)
                bottom = min(y + height, (chunk_y + 1) * chunk_size)
                copy_bytes = (right - left) * 4
                chunk_changed = False
                for world_y in range(top, bottom):
                    source_start = ((world_y - y) * width + left - x) * 4
                    target_start = ((world_y - chunk_y * chunk_size) * chunk_size + left - chunk_x * chunk_size) * 4
                    source_row = pixels[source_start:source_start + copy_bytes]
                    target_row = target[target_start:target_start + copy_bytes]
                    if bytes(target_row) != source_row:
                        target[target_start:target_start + copy_bytes] = source_row
                        chunk_changed = True

                if chunk_changed:
                    changed_chunks[key] = target

        for key, target in changed_chunks.items():
            chunks[key] = base64.b64encode(zlib.compress(target, level=1)).decode("ascii")
        light_changed = False
        if chunk_field == "base_map_chunks":
            updated_at = time.time()
            times = world_data.setdefault("base_map_chunk_times", {})
            for key in changed_chunks:
                times[key] = updated_at
            light_sources = world_data.setdefault("light_sources", {})
            if isinstance(light_sources, dict) and isinstance(capture.get("lightSources"), list):
                chunk_left, chunk_top = x, y
                chunk_right, chunk_bottom = x + width, y + height
                for coordinate in list(light_sources):
                    try:
                        light_x, light_y = (int(value) for value in coordinate.split(",", 1))
                    except (AttributeError, TypeError, ValueError):
                        continue
                    if chunk_left <= light_x < chunk_right and chunk_top <= light_y < chunk_bottom:
                        if light_sources.pop(coordinate, None) is not None:
                            light_changed = True
                for raw_point in capture["lightSources"]:
                    if not isinstance(raw_point, (list, tuple)) or len(raw_point) != 2:
                        continue
                    try:
                        light_x, light_y = int(raw_point[0]), int(raw_point[1])
                    except (TypeError, ValueError, OverflowError):
                        continue
                    if chunk_left <= light_x < chunk_right and chunk_top <= light_y < chunk_bottom:
                        coordinate = f"{light_x},{light_y}"
                        if light_sources.get(coordinate) != 1:
                            light_sources[coordinate] = 1
                            light_changed = True
        if not changed_chunks and not light_changed:
            return False
        world_data["map_chunk_size"] = chunk_size
        world_data["map_updated_at"] = time.time()
        return True

    @staticmethod
    def _merge_tile_capture(world_data: dict[str, Any], capture: Any) -> bool:
        """Persist compact tile and wall IDs for delayed map hover lookups."""
        if not isinstance(capture, dict) or not capture.get("tileInfo"):
            return False
        try:
            x, y = int(capture["x"]), int(capture["y"])
            width, height = int(capture["width"]), int(capture["height"])
            if x < 0 or y < 0 or not 0 < width <= 128 or not 0 < height <= 128:
                return False
            raw = zlib.decompress(base64.b64decode(str(capture["tileInfo"]), validate=True))
            if len(raw) != width * height * 4:
                return False
        except (KeyError, TypeError, ValueError, OverflowError, zlib.error):
            return False

        chunk_size = WORLD_MAP_CHUNK_SIZE
        chunks = world_data.setdefault("tile_chunks", {})
        if not isinstance(chunks, dict):
            chunks = world_data["tile_chunks"] = {}
        names = world_data.setdefault("tile_names", {})
        if not isinstance(names, dict):
            names = world_data["tile_names"] = {}
        names_language = capture.get("tileNamesLanguage")
        names_version = capture.get("tileNamesVersion")
        language_changed = False
        try:
            if names_version is not None and int(world_data.get("tile_names_version", 0)) != int(names_version):
                names.clear()
                world_data["tile_names_version"] = int(names_version)
                language_changed = True
        except (TypeError, ValueError):
            pass
        if isinstance(names_language, str) and names_language.strip():
            previous_language = world_data.get("tile_names_language")
            if previous_language and previous_language != names_language:
                names.clear()
                language_changed = True
            world_data["tile_names_language"] = names_language[:24]
        changed = language_changed
        for chunk_y in range(y // chunk_size, (y + height - 1) // chunk_size + 1):
            for chunk_x in range(x // chunk_size, (x + width - 1) // chunk_size + 1):
                key = f"{chunk_x},{chunk_y}"
                chunk_changed = key not in chunks
                try:
                    target = bytearray(zlib.decompress(base64.b64decode(chunks[key], validate=True)))
                    if len(target) != chunk_size * chunk_size * 4:
                        target = bytearray(chunk_size * chunk_size * 4)
                except (KeyError, TypeError, ValueError, zlib.error):
                    target = bytearray(chunk_size * chunk_size * 4)
                left, top = max(x, chunk_x * chunk_size), max(y, chunk_y * chunk_size)
                right, bottom = min(x + width, (chunk_x + 1) * chunk_size), min(y + height, (chunk_y + 1) * chunk_size)
                row_bytes = (right - left) * 4
                for world_y in range(top, bottom):
                    source_start = ((world_y - y) * width + left - x) * 4
                    target_start = ((world_y - chunk_y * chunk_size) * chunk_size + left - chunk_x * chunk_size) * 4
                    row = raw[source_start:source_start + row_bytes]
                    if bytes(target[target_start:target_start + row_bytes]) != row:
                        target[target_start:target_start + row_bytes] = row
                        chunk_changed = True
                        changed = True
                if chunk_changed:
                    chunks[key] = base64.b64encode(zlib.compress(target, level=1)).decode("ascii")
                    changed = True
        for key, value in capture.get("tileNames", {}).items() if isinstance(capture.get("tileNames"), dict) else ():
            if isinstance(value, str) and value.strip() and names.get(str(key)) != value:
                names[str(key)] = value[:120]
                changed = True
        world_data["tile_info_updated_at"] = time.time()
        return changed

    @staticmethod
    def _merge_map_tile_updates(world_data: dict[str, Any], capture: Any) -> bool:
        """Apply sparse map edits to cached chunks and retain a live delta for browsers."""
        if not isinstance(capture, dict) or capture.get("encoding") != "tile-updates-v1":
            return False
        try:
            raw = zlib.decompress(base64.b64decode(str(capture["data"]), validate=True))
            count = int(capture.get("count", 0))
            if count < 1 or count > 512 or len(raw) not in {count * 12, count * 13}:
                return False
        except (KeyError, TypeError, ValueError, OverflowError, zlib.error):
            return False

        chunk_size = WORLD_MAP_CHUNK_SIZE
        base_chunks = world_data.setdefault("base_map_chunks", {})
        base_times = world_data.setdefault("base_map_chunk_times", {})
        tile_chunks = world_data.setdefault("tile_chunks", {})
        names = world_data.setdefault("tile_names", {})
        if not all(isinstance(value, dict) for value in (base_chunks, base_times, tile_chunks, names)):
            return False

        tile_names = capture.get("tileNames")
        names_language = capture.get("tileNamesLanguage")
        language_changed = (
            isinstance(names_language, str)
            and bool(world_data.get("tile_names_language"))
            and world_data.get("tile_names_language") != names_language
        )
        try:
            names_version = int(capture.get("tileNamesVersion", 6))
        except (TypeError, ValueError):
            names_version = 6
        version_changed = int(world_data.get("tile_names_version", names_version) or 0) != names_version
        if language_changed or version_changed:
            names.clear()
        if isinstance(tile_names, dict):
            names.update({str(key): str(value) for key, value in tile_names.items()})
        if isinstance(names_language, str) and names_language.strip():
            world_data["tile_names_language"] = names_language[:24]
        world_data["tile_names_version"] = names_version

        pixel_chunks: dict[str, bytearray] = {}
        info_chunks: dict[str, bytearray] = {}
        updates: list[dict[str, Any]] = []
        record_size = len(raw) // count
        light_sources = world_data.setdefault("light_sources", {})
        for index in range(count):
            offset = index * record_size
            tile_x, tile_y = struct.unpack_from("<HH", raw, offset)
            if tile_x >= int(world_data.get("width", 0) or 0) or tile_y >= int(world_data.get("height", 0) or 0):
                continue
            key = f"{tile_x // chunk_size},{tile_y // chunk_size}"
            if key not in pixel_chunks:
                pixel_chunks[key] = _decoded_map_chunk(base_chunks.get(key), chunk_size)
                info_chunks[key] = _decoded_map_chunk(tile_chunks.get(key), chunk_size)

            local_offset = ((tile_y % chunk_size) * chunk_size + tile_x % chunk_size) * 4
            color = raw[offset + 4:offset + 8]
            tile_info = raw[offset + 8:offset + 12]
            pixels = pixel_chunks[key]
            tile_data = info_chunks[key]
            light_source_changed = False
            if record_size == 13 and isinstance(light_sources, dict):
                coordinate = f"{tile_x},{tile_y}"
                light_source_changed = bool(light_sources.get(coordinate)) != bool(raw[offset + 12])
            if (
                bytes(pixels[local_offset:local_offset + 4]) == color
                and bytes(tile_data[local_offset:local_offset + 4]) == tile_info
                and not light_source_changed
            ):
                continue
            pixels[local_offset:local_offset + 4] = color
            tile_data[local_offset:local_offset + 4] = tile_info
            if record_size == 13 and isinstance(light_sources, dict):
                coordinate = f"{tile_x},{tile_y}"
                if raw[offset + 12]:
                    light_sources[coordinate] = 1
                else:
                    light_sources.pop(coordinate, None)
            updates.append({"x": tile_x, "y": tile_y, "color": list(color)})

        if not updates:
            return False

        updated_at = time.time()
        for key, pixels in pixel_chunks.items():
            base_chunks[key] = base64.b64encode(zlib.compress(pixels, level=1)).decode("ascii")
            tile_chunks[key] = base64.b64encode(zlib.compress(info_chunks[key], level=1)).decode("ascii")
            base_times[key] = updated_at

        revision = int(world_data.get("map_tile_revision", 0)) + 1
        world_data["map_tile_revision"] = revision
        deltas = world_data.setdefault("map_tile_updates", [])
        if not isinstance(deltas, list):
            deltas = world_data["map_tile_updates"] = []
        deltas.append({"revision": revision, "updates": updates})
        # Keep a bounded number of changed tiles, not an arbitrary number of
        # batches. A large explosion can touch many tiles in one revision.
        retained_tile_count = world_data.get("map_tile_update_count")
        if type(retained_tile_count) is not int or retained_tile_count < 0:
            retained_tile_count = sum(
                len(batch.get("updates", []))
                for batch in deltas[:-1]
                if isinstance(batch, dict) and isinstance(batch.get("updates"), list)
            )
        retained_tile_count += len(updates)
        while len(deltas) > 1 and retained_tile_count > 8192:
            oldest = deltas.pop(0)
            if isinstance(oldest, dict) and isinstance(oldest.get("updates"), list):
                retained_tile_count -= len(oldest["updates"])
        world_data["map_tile_update_count"] = retained_tile_count
        world_data["map_updated_at"] = updated_at
        world_data["tile_info_updated_at"] = updated_at
        world_data["map_chunk_size"] = chunk_size
        return True
    def _record_legacy_movement(
        self, player_id: str, name: str, uuid: str | None, positions: Any, visited_tiles: Any
    ) -> None:
        if not positions and not visited_tiles:
            return
        movement = self._load_movement(player_id)
        movement["player"] = {"id": player_id, "name": name, "uuid": uuid}
        world_key, world_data = self._world_movement_record(movement, self._server_info)
        world_key_cache = (player_id, world_key)
        visited = self._movement_visited_tiles.setdefault(world_key_cache, set(world_data.get("visited_tiles", [])))
        for tile in visited_tiles if isinstance(visited_tiles, list) else []:
            tile = str(tile)
            if tile not in visited:
                visited.add(tile)
                world_data["visited_tiles"].append(tile)
        path = world_data["positions"]
        for point in positions if isinstance(positions, list) else []:
            if not isinstance(point, dict):
                continue
            x, y = point.get("tileX", point.get("x")), point.get("tileY", point.get("y"))
            if x is None or y is None:
                continue
            path.append({"time": point.get("time", time.time()), "x": x, "y": y})
        path.sort(key=lambda point: float(point.get("time", 0)))
        movement["updated_at"] = time.time()
        self._save_movement(player_id)

    def _merge_player_movement(self, old_id: str, new_id: str, name: str, uuid: str) -> None:
        old_movement = self._load_movement(old_id)
        new_movement = self._load_movement(new_id)
        for world_key, old_world in old_movement.get("worlds", {}).items():
            new_world = new_movement["worlds"].setdefault(world_key, old_world)
            if new_world is old_world:
                new_movement["worlds"][world_key] = dict(old_world)
                new_world = new_movement["worlds"][world_key]
            for field in ("visited_tiles", "positions"):
                values = [*new_world.get(field, []), *old_world.get(field, [])]
                if field == "visited_tiles":
                    new_world[field] = list(dict.fromkeys(values))
                else:
                    new_world[field] = sorted(values, key=lambda point: float(point.get("time", 0)))
            self._movement_visited_tiles[(new_id, str(world_key))] = set(new_world.get("visited_tiles", []))
        new_movement["player"] = {"id": new_id, "name": name, "uuid": uuid}
        new_movement["updated_at"] = time.time()
        self._save_movement(new_id)
        old_path = self._movement_path(old_id)
        try:
            old_path.unlink()
        except OSError:
            pass
        self._movement_cache.pop(old_id, None)


def _decoded_map_chunk(encoded: Any, chunk_size: int) -> bytearray:
    expected_length = chunk_size * chunk_size * 4
    try:
        decoded = zlib.decompress(base64.b64decode(str(encoded), validate=True))
    except (TypeError, ValueError, zlib.error):
        decoded = b""
    return bytearray(decoded) if len(decoded) == expected_length else bytearray(expected_length)
