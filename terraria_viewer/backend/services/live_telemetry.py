from __future__ import annotations

from ...models import LiveTelemetrySnapshot, NpcEntity

from ..store_common import (
    Any,
    SPRITE_RENDERER_CACHE,
    SPRITE_RENDERER_SOURCE,
    TERRARIA_CLIENT_IMAGES,
    cast,
    StoreMixinContract,
    is_valid_player_name,
    is_valid_png,
    hashlib,
    json,
    re,
    shutil,
    subprocess,
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

    def set_server_info(self, **values: Any) -> None:
        with self._lock:
            self._server_info.update({key: value for key, value in values.items() if value is not None})
            self._server_info["updated_at"] = time.time()
            self._save_metrics_locked()

    def set_live_telemetry(self, snapshot: dict[str, Any]) -> None:
        """Apply one trusted-local tModLoader telemetry snapshot to monitor storage."""
        telemetry = LiveTelemetrySnapshot.from_payload(snapshot)
        server = telemetry.server
        world = telemetry.world
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
        pylons = [pylon.to_payload() for pylon in telemetry.pylons]
        if telemetry.has_pylon_snapshot:
            with self._lock:
                cache_key = self._world_map_cache_key(world)
                world_cache = self._world_map_cache.setdefault(cache_key, {
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
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
                if world_cache.get("pylons") != pylons:
                    world_cache["pylons"] = pylons
                    self._world_map_cache_dirty = True
                self._save_world_map_cache_if_due()
        base_captures = telemetry.base_map_captures
        if base_captures:
            with self._lock:
                cache_key = self._world_map_cache_key(world)
                world_cache = self._world_map_cache.setdefault(cache_key, {
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
                    "base_map_chunks": {},
                    "base_map_chunk_times": {},
                })
                world_cache.update({
                    "world_id": world.get("id", world.get("world_id")),
                    "world_name": world.get("name") or world.get("world_name"),
                    "width": world.get("width"),
                    "height": world.get("height"),
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
            active_bosses=world.get("activeBosses"),
            defeated_bosses=world.get("defeatedBosses"),
            boss_defeat_counts=world.get("bossDefeatCounts"),
            boss_status=world.get("bossStatus"),
            telemetry_updated_at=telemetry.generated_at,
        )
        with self._lock:
            self._telemetry_received_at = time.time()

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
        java, javac = shutil.which("java"), shutil.which("javac")
        if not java or not javac:
            return None
        try:
            with self._sprite_renderer_lock:
                classes = SPRITE_RENDERER_CACHE / "classes"
                class_file = classes / "com/github/antag99/textract/extract/TerrariaMapItemSpriteRenderer.class"
                sources = [
                    SPRITE_RENDERER_SOURCE / "LzxDecoder.java",
                    SPRITE_RENDERER_SOURCE / "TerrariaPlayerSpriteRenderer.java",
                    SPRITE_RENDERER_SOURCE / "TerrariaNpcSpriteRenderer.java",
                    SPRITE_RENDERER_SOURCE / "TerrariaMapItemSpriteRenderer.java",
                ]
                stamp = max(path.stat().st_mtime_ns for path in sources)
                stamp_file = SPRITE_RENDERER_CACHE / "source-stamp"
                try:
                    compiled_stamp = int(stamp_file.read_text(encoding="ascii"))
                except (OSError, ValueError):
                    compiled_stamp = 0
                if not class_file.is_file() or compiled_stamp != stamp:
                    classes.mkdir(mode=0o700, parents=True, exist_ok=True)
                    compiled = subprocess.run(
                        [javac, "-d", str(classes), *(str(path) for path in sources)],
                        capture_output=True, text=True, timeout=45, check=False,
                    )
                    if compiled.returncode != 0:
                        return None
                    stamp_file.write_text(str(stamp), encoding="ascii")
                self._map_sprites_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                rendered = subprocess.run(
                    [java, "-Djava.awt.headless=true", "-cp", str(classes),
                     "com.github.antag99.textract.extract.TerrariaMapItemSpriteRenderer",
                     str(source), str(output)],
                    capture_output=True, text=True, timeout=20, check=False,
                )
                if rendered.returncode != 0 or not output.is_file() or not is_valid_png(output.read_bytes()):
                    output.unlink(missing_ok=True)
                    return None
        except (OSError, subprocess.SubprocessError, ValueError):
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
        # Include the renderer revision so existing full-body icons are replaced
        # automatically after deploying the head-portrait crop.
        digest = hashlib.sha256(f"head-portrait-outline-v6:{source_key}:{frame_width}x{frame_height}".encode("utf-8")).hexdigest()[:32]
        output = self._npc_sprites_dir / f"{digest}.png"
        if output.is_file():
            try:
                if not is_valid_png(output.read_bytes()):
                    output.unlink()
            except OSError:
                return None
        if not output.is_file():
            java, javac = shutil.which("java"), shutil.which("javac")
            if not java or not javac:
                return None
            try:
                with self._sprite_renderer_lock:
                    classes = SPRITE_RENDERER_CACHE / "classes"
                    class_file = classes / "com/github/antag99/textract/extract/TerrariaNpcSpriteRenderer.class"
                    sources = [
                        SPRITE_RENDERER_SOURCE / "LzxDecoder.java",
                        SPRITE_RENDERER_SOURCE / "TerrariaPlayerSpriteRenderer.java",
                        SPRITE_RENDERER_SOURCE / "TerrariaNpcSpriteRenderer.java",
                        SPRITE_RENDERER_SOURCE / "TerrariaMapItemSpriteRenderer.java",
                    ]
                    stamp = max(path.stat().st_mtime_ns for path in sources)
                    stamp_file = SPRITE_RENDERER_CACHE / "source-stamp"
                    try:
                        compiled_stamp = int(stamp_file.read_text(encoding="ascii"))
                    except (OSError, ValueError):
                        compiled_stamp = 0
                    if not class_file.is_file() or compiled_stamp != stamp:
                        classes.mkdir(mode=0o700, parents=True, exist_ok=True)
                        compiled = subprocess.run(
                            [javac, "-d", str(classes), *(str(path) for path in sources)],
                            capture_output=True, text=True, timeout=45, check=False,
                        )
                        if compiled.returncode != 0:
                            if head_texture:
                                return self._write_npc_sprite(npc_type, texture_hash, body_frame_width, body_frame_height)
                            return None
                        stamp_file.write_text(str(stamp), encoding="ascii")
                    self._npc_sprites_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                    rendered = subprocess.run(
                        [java, "-Djava.awt.headless=true", "-cp", str(classes),
                         "com.github.antag99.textract.extract.TerrariaNpcSpriteRenderer",
                         str(source), str(output), str(frame_width), str(frame_height), str(head_texture).lower()],
                        capture_output=True, text=True, timeout=20, check=False,
                    )
                    if rendered.returncode != 0 or not output.is_file() or not is_valid_png(output.read_bytes()):
                        output.unlink(missing_ok=True)
                        if head_texture:
                            return self._write_npc_sprite(npc_type, texture_hash, body_frame_width, body_frame_height)
                        return None
            except (OSError, subprocess.SubprocessError, ValueError):
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
        self._events.append({
            "time": now,
            "source": source,
            "message": " ".join(message.strip().split())[:400],
            "severity": self._severity(source, message),
        })

    def record_error(self, source: str, message: str) -> None:
        message = " ".join(message.strip().split())[:400]
        if not message:
            return
        now = time.time()
        with self._lock:
            self._append_event_locked(source, message, now)
            self._updated_at = now
            self._save_events_locked()
