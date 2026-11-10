from __future__ import annotations

import math

from ...models import LiveTelemetrySnapshot, NpcEntity, PlayerDeath

from ..store_common import (
    Any,
    TERRARIA_CLIENT_IMAGES,
    as_json_object,
    cast,
    StoreMixinContract,
    is_valid_player_name,
    is_valid_png,
    hashlib,
    json,
    re,
    time,
)


class LiveTelemetryMixin(StoreMixinContract):
    def _save_metrics_locked(self) -> None:
        self._metrics_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._metrics_file.with_suffix(".tmp")
        document = {
            "updated_at": time.time(),
            "server": self._server_info,
            "host": self._host_metrics,
        }
        temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._metrics_file)
        self._metrics_last_saved_monotonic = time.monotonic()

    def _save_metrics_if_due_locked(self) -> None:
        if time.monotonic() - self._metrics_last_saved_monotonic >= 1.0:
            self._save_metrics_locked()

    def set_server_info(self, **values: Any) -> None:
        with self._lock:
            changes = {key: value for key, value in values.items() if value is not None}
            if any(self._server_info.get(key) != value for key, value in changes.items()):
                self._server_info.update(changes)
                self._server_info["updated_at"] = time.time()
                self._save_metrics_if_due_locked()

    def set_live_telemetry(self, snapshot: dict[str, Any]) -> None:
        """Apply one trusted-local tModLoader telemetry snapshot to monitor storage."""
        telemetry = LiveTelemetrySnapshot.from_payload(snapshot)
        received_at = time.time()
        received_monotonic = time.monotonic()
        world = telemetry.world
        with self._lock:
            previous_received = self._telemetry_last_received_monotonic
            if previous_received is not None:
                interval_ms = (received_monotonic - previous_received) * 1000
                previous_interval = self._telemetry_interval_ms
                self._telemetry_interval_ms = (
                    interval_ms if previous_interval is None
                    else previous_interval * 0.8 + interval_ms * 0.2
                )
            self._telemetry_last_received_monotonic = received_monotonic
            self._telemetry_received_at = received_at
            self._telemetry_snapshot_id = telemetry.snapshot_id
            world_id = world.get("id", world.get("world_id"))
            normalized_world_id = str(world_id) if world_id is not None else None
            if normalized_world_id != self._recent_map_pings_world_id:
                self._recent_map_pings.clear()
                self._recent_map_pings_world_id = normalized_world_id
            self._ingest_map_pings_locked(snapshot.get("mapPings"), received_at)
        server = telemetry.server
        active_npcs: list[NpcEntity] = []
        for npc in telemetry.npcs:
            texture_hash = npc.mod_texture
            icon_url = self._write_npc_sprite(
                npc.npc_type, texture_hash, npc.frame_width, npc.frame_height,
                npc.head_slot, npc.boss_head_slot, npc.head_texture,
            )
            active_npcs.append(npc.with_icon(icon_url))
        active_coins = [
            coin.with_icon(self._write_map_coin_sprite(coin.item_type))
            for coin in telemetry.coins
        ]
        world_id = world.get("id", world.get("world_id"))
        with self._lock:
            self._active_npcs = active_npcs
            self._active_npcs_world_id = str(world_id) if world_id is not None else None
            self._active_coins = active_coins
            self._active_coins_world_id = str(world_id) if world_id is not None else None
        players = [player for player in telemetry.players if is_valid_player_name(player.name)]
        self.set_players_online(len(players), players, world=world)
        self._save_player_death_locations(telemetry.player_deaths, world)
        pylons = [pylon.to_payload() for pylon in telemetry.pylons]
        if telemetry.has_pylon_snapshot:
            with self._lock:
                cache_key = self._world_map_cache_key(world)
                world_cache = self._world_map_cache.setdefault(cache_key, {
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "surface_y": world.get("surface"),
                    "spawn_x": world.get("spawnX"),
                    "spawn_y": world.get("spawnY"),
                    "base_map_chunks": {},
                    "base_map_chunk_times": {},
                    "pylons": [],
                })
                try:
                    spawn_x, spawn_y = int(cast(Any, world.get("spawnX"))), int(cast(Any, world.get("spawnY")))
                except (TypeError, ValueError):
                    spawn_x = spawn_y = None
                if spawn_x is not None and spawn_y is not None:
                    if world_cache.get("spawn_x") != spawn_x or world_cache.get("spawn_y") != spawn_y:
                        world_cache["spawn_x"] = spawn_x
                        world_cache["spawn_y"] = spawn_y
                        self._world_map_cache_dirty = True
                surface_y = world.get("surface")
                if surface_y is not None and world_cache.get("surface_y") != surface_y:
                    world_cache["surface_y"] = surface_y
                    self._world_map_cache_dirty = True
                if world_cache.get("pylons") != pylons:
                    world_cache["pylons"] = pylons
                    self._world_map_cache_dirty = True
                self._save_world_map_cache_if_due()
        base_captures = telemetry.base_map_captures
        if telemetry.base_map_tile_updates is not None:
            with self._lock:
                cache_key = self._world_map_cache_key(world)
                world_cache = self._world_map_cache.setdefault(cache_key, {
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "surface_y": world.get("surface"),
                    "base_map_chunks": {},
                    "base_map_chunk_times": {},
                    "tile_chunks": {},
                    "tile_names": {},
                })
                world_cache.update({
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "surface_y": world.get("surface"),
                })
                if self._merge_map_tile_updates(world_cache, telemetry.base_map_tile_updates):
                    self._world_map_cache_dirty = True
                self._save_world_map_cache_if_due()
        if base_captures:
            with self._lock:
                cache_key = self._world_map_cache_key(world)
                world_cache = self._world_map_cache.setdefault(cache_key, {
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "surface_y": world.get("surface"),
                    "base_map_chunks": {},
                    "base_map_chunk_times": {},
                })
                world_cache.update({
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "surface_y": world.get("surface"),
                })
                changed = False
                for item in base_captures:
                    changed = self._merge_map_capture(world_cache, item, "base_map_chunks") or changed
                    changed = self._merge_tile_capture(world_cache, item) or changed
                if changed:
                    self._world_map_cache_dirty = True
                self._save_world_map_cache_if_due()
        else:
            with self._lock:
                self._save_world_map_cache_if_due()
        self.set_server_info(
            version=server.get("version"),
            server_assembly_version=server.get("serverAssemblyVersion"),
            max_players=server.get("maxPlayers"),
            world=world.get("name"),
            world_id=world.get("id"),
            world_width=world.get("width"),
            world_height=world.get("height"),
            world_surface=world.get("surface"),
            map_scan=telemetry.map_scan,
            game_mode=telemetry.game_mode.get("name") if telemetry.game_mode else None,
            game_mode_id=telemetry.game_mode.get("id") if telemetry.game_mode else None,
            hardmode=world.get("hardmode"),
            crimson=world.get("crimson"),
            day=world.get("day"),
            world_time=world.get("time"),
            moon_phase=world.get("moonPhase"),
            blood_moon=world.get("bloodMoon"),
            eclipse=world.get("eclipse"),
            raining=world.get("raining"),
            slime_rain=world.get("slimeRain"),
            active_bosses=world.get("activeBosses", []),
            defeated_bosses=world.get("defeatedBosses", []),
            boss_defeat_counts=world.get("bossDefeatCounts", {}),
            boss_status=world.get("bossStatus", {}),
            telemetry_updated_at=telemetry.generated_at,
        )
        self.notify_live_update()

    def _ingest_map_pings_locked(self, value: Any, received_at: float) -> None:
        self._recent_map_pings = [
            ping for ping in self._recent_map_pings
            if received_at - float(ping.get("timestamp", 0)) < 15
        ]
        if not isinstance(value, list):
            return

        known_ids = {ping["id"] for ping in self._recent_map_pings}
        for item in value:
            if not isinstance(item, dict):
                continue
            ping_id = str(item.get("id") or "")
            player_name = str(item.get("playerName") or "").strip()
            try:
                x, y = float(item.get("x")), float(item.get("y"))
                timestamp = float(item.get("timestamp"))
            except (TypeError, ValueError, OverflowError):
                continue
            if (
                not ping_id or len(ping_id) > 64 or ping_id in known_ids
                or not player_name or len(player_name) > 64
                or not math.isfinite(x) or not math.isfinite(y)
                or not math.isfinite(timestamp) or x < 0 or y < 0
            ):
                continue
            self._recent_map_pings.append({
                "id": ping_id,
                "player_name": player_name,
                "x": x,
                "y": y,
                "timestamp": timestamp,
                "source": "web" if item.get("source") == "web" else "player",
            })
            known_ids.add(ping_id)
        self._recent_map_pings = self._recent_map_pings[-128:]
    def _save_player_death_locations(
        self, deaths: tuple[PlayerDeath, ...], world: dict[str, Any]
    ) -> None:
        """Persist death markers until the configured retention period expires."""
        world_id = world.get("id", world.get("world_id"))
        world_name = str(world.get("name") or world.get("world_name") or "")
        width = int(world.get("width") or 0)
        height = int(world.get("height") or 0)
        with self._lock:
            changed = self._prune_player_deaths_locked(time.time())
            for death in deaths:
                player_id = (
                    f"uuid:{death.uuid.casefold()}" if death.uuid
                    else f"name:{death.name.casefold()}"
                )
                record = self._players.get(player_id)
                if record is None:
                    record = next(
                        (item for item in self._players.values()
                         if str(item.get("name", "")).casefold() == death.name.casefold()),
                        None,
                    )
                if death.tile_x >= width or death.tile_y >= height:
                    continue
                if record is None:
                    record = self._players.setdefault(player_id, {
                        "id": player_id,
                        "name": death.name,
                        "uuid": death.uuid,
                        "first_seen_at": death.timestamp,
                        "last_seen_at": death.timestamp,
                        "total_seconds": 0,
                        "sessions": [],
                    })

                locations = cast(
                    list[dict[str, Any]], record.setdefault("death_locations", [])
                )
                if any(
                    item.get("world_id") == world_id
                    and (
                        item.get("event_id") == death.event_id
                        if death.event_id
                        else item.get("timestamp") == death.timestamp
                    )
                    for item in locations
                ):
                    continue
                locations.append({
                    "world_id": world_id,
                    "world_name": world_name,
                    "x": death.tile_x,
                    "y": death.tile_y,
                    "timestamp": death.timestamp,
                    "event_id": death.event_id,
                })
                changed = True
            if changed:
                self._save_players_locked()

    def _prune_player_deaths_locked(self, now: float) -> bool:
        """Apply the configured TTL while preserving every unexpired death."""
        retention = self._death_retention_seconds
        if retention == 0:
            return False

        cutoff = now - retention
        changed = False
        for record in self._players.values():
            raw_locations = record.get("death_locations")
            if not isinstance(raw_locations, list):
                continue
            locations = cast(list[Any], raw_locations)
            retained: list[Any] = []
            for location in locations:
                try:
                    timestamp = float(as_json_object(location).get("timestamp", 0))
                except (TypeError, ValueError):
                    timestamp = 0
                if timestamp >= cutoff:
                    retained.append(location)
            if len(retained) != len(locations):
                record["death_locations"] = retained
                changed = True
        return changed

    def _write_map_coin_sprite(self, item_type: int) -> str | None:
        """Cache the native in-game sprite for a dropped vanilla coin pile."""
        cached = self._coin_sprite_cache.get(item_type)
        if cached:
            return cached
        if item_type not in {71, 72, 73, 74}:
            return None
        source = TERRARIA_CLIENT_IMAGES / f"Item_{item_type}.xnb"
        if not source.is_file():
            return None
        output = self._map_sprites_dir / f"coin-{item_type}.png"
        if output.is_file():
            try:
                if is_valid_png(output.read_bytes()):
                    result = f"/map-sprites/coin-{item_type}.png"
                    self._coin_sprite_cache[item_type] = result
                    return result
                output.unlink()
            except OSError:
                return None
        try:
            with self._sprite_renderer_lock:
                self._map_item_sprite_renderer.render(source, output)
                if not output.is_file() or not is_valid_png(output.read_bytes()):
                    output.unlink(missing_ok=True)
                    return None
        except (OSError, ValueError):
            return None
        result = f"/map-sprites/coin-{item_type}.png"
        self._coin_sprite_cache[item_type] = result
        return result

    def _write_npc_sprite(
        self, npc_type: int, texture_hash: str, frame_width: int, frame_height: int,
        head_slot: int = -1, boss_head_slot: int = -1, head_texture_hash: str = "",
    ) -> str | None:
        """Cache a native NPC head icon, falling back to a cropped body frame."""
        body_frame_width, body_frame_height = frame_width, frame_height
        head_texture = False
        if head_texture_hash and re.fullmatch(r"[0-9a-f]{64}", head_texture_hash):
            source = self._npc_textures_dir / f"{head_texture_hash}.png"
            source_key = f"mod-head:{head_texture_hash}"
            frame_width = frame_height = 32
            head_texture = True
        elif boss_head_slot >= 0:
            source = TERRARIA_CLIENT_IMAGES / f"NPC_Head_Boss_{boss_head_slot}.xnb"
            source_key = f"boss-head:{boss_head_slot}"
            frame_width = frame_height = 32
            head_texture = source.is_file()
        elif head_slot >= 0:
            source = TERRARIA_CLIENT_IMAGES / f"NPC_Head_{head_slot}.xnb"
            source_key = f"npc-head:{head_slot}"
            frame_width = frame_height = 32
            head_texture = source.is_file()
        elif texture_hash and re.fullmatch(r"[0-9a-f]{64}", texture_hash):
            source = self._npc_textures_dir / f"{texture_hash}.png"
            source_key = f"mod:{texture_hash}"
        else:
            source = TERRARIA_CLIENT_IMAGES / f"NPC_{npc_type}.xnb"
            source_key = f"vanilla:{npc_type}"
        if not source.is_file() and head_texture:
            # A modded head slot has no standalone file in vanilla Content;
            # fall back to the exported full NPC texture if the head asset could
            # not be extracted from the mod archive.
            if texture_hash and re.fullmatch(r"[0-9a-f]{64}", texture_hash):
                source = self._npc_textures_dir / f"{texture_hash}.png"
                source_key = f"mod:{texture_hash}"
                frame_width = max(1, min(1024, body_frame_width))
                frame_height = max(1, min(1024, body_frame_height))
                head_texture = False
            else:
                source = TERRARIA_CLIENT_IMAGES / f"NPC_{npc_type}.xnb"
                source_key = f"vanilla:{npc_type}"
                head_texture = False
        if not source.is_file():
            return None
        # Bump this revision whenever NPC sprite extraction or rendering changes.
        digest = hashlib.sha256(f"terraria-native-head-v11:{source_key}:{frame_width}x{frame_height}".encode("utf-8")).hexdigest()[:32]
        output = self._npc_sprites_dir / f"{digest}.png"
        if output.is_file():
            try:
                if not is_valid_png(output.read_bytes()):
                    output.unlink()
            except OSError:
                return None
        if not output.is_file():
            try:
                with self._sprite_renderer_lock:
                    self._npc_sprite_renderer.render(
                        source,
                        output,
                        frame_width,
                        frame_height,
                        head_texture,
                    )
                    if not output.is_file() or not is_valid_png(output.read_bytes()):
                        output.unlink(missing_ok=True)
                        if head_texture:
                            return self._write_npc_sprite(npc_type, texture_hash, body_frame_width, body_frame_height)
                        return None
            except (OSError, ValueError):
                if head_texture:
                    return self._write_npc_sprite(npc_type, texture_hash, body_frame_width, body_frame_height)
                return None
        return f"/npc-sprites/{digest}.png"

    def has_fresh_telemetry(self, max_age: float = 15) -> bool:
        with self._lock:
            return self._telemetry_received_at is not None and time.time() - self._telemetry_received_at <= max_age

    def set_host_metrics(self, **values: Any) -> None:
        with self._lock:
            self._host_metrics = {**values, "updated_at": time.time()}
            self._save_metrics_locked()

    def set_death_counts(self, counts: dict[str, dict[str, int]]) -> None:
        now = time.time()
        with self._lock:
            for nickname, values in counts.items():
                key = f"name:{nickname.casefold()}"
                record = self._players.get(key)
                if record is None:
                    record = next(
                        (player for player in self._players.values()
                         if str(player.get("name", "")).casefold() == nickname.casefold()),
                        None,
                    )
                if record is None:
                    record = self._players.setdefault(key, {
                        "id": key,
                        "name": nickname,
                        "uuid": None,
                        "first_seen_at": now,
                        "last_seen_at": now,
                        "total_seconds": 0,
                        "sessions": [],
                    })
                record.update(values)
            self._server_info["deaths_updated_at"] = now
            self._players_updated_at = now
            self._save_players_locked()
            self._save_metrics_locked()

    def _append_event_locked(self, source: str, message: str, now: float) -> None:
        normalized_message = " ".join(message.strip().split())[:400]
        candidate = {
            "time": now,
            "first_time": now,
            "source": source,
            "message": normalized_message,
            "severity": self._severity(source, normalized_message),
            "occurrences": 1,
        }
        signature = self._event_signature(candidate)
        for existing in reversed(self._events):
            first_time = float(existing.get("first_time", existing.get("time", 0)) or 0)
            if (
                self._event_signature(existing) == signature
                and now - first_time <= self.EVENT_GROUP_WINDOW_SECONDS
            ):
                existing["time"] = now
                existing["occurrences"] = int(existing.get("occurrences", 1) or 1) + 1
                break
        else:
            self._events.append(candidate)
        self._prune_events_locked(now)

    def record_error(self, source: str, message: str) -> None:
        message = " ".join(message.strip().split())[:400]
        if not message:
            return
        now = time.time()
        with self._lock:
            self._append_event_locked(source, message, now)
            self._updated_at = now
            self._save_events_locked()
