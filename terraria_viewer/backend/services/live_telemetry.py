from __future__ import annotations

from ..store_common import (
    Any,
    SPRITE_RENDERER_CACHE,
    SPRITE_RENDERER_SOURCE,
    TERRARIA_CLIENT_IMAGES,
    _is_valid_player_name,
    _is_valid_png,
    hashlib,
    json,
    re,
    shutil,
    subprocess,
    time,
)


class LiveTelemetryMixin:
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
        server = snapshot.get("server") if isinstance(snapshot.get("server"), dict) else {}
        world = snapshot.get("world") if isinstance(snapshot.get("world"), dict) else {}
        raw_npcs = world.get("activeNpcs") if isinstance(world.get("activeNpcs"), list) else []
        active_npcs: list[dict[str, Any]] = []
        for npc in raw_npcs:
            if not isinstance(npc, dict):
                continue
            try:
                x, y = int(npc.get("x")), int(npc.get("y"))
                npc_type = int(npc.get("type"))
                frame_width = max(1, min(1024, int(npc.get("frameWidth", 32))))
                frame_height = max(1, min(1024, int(npc.get("frameHeight", 32))))
                head_slot = int(npc.get("headSlot", -1))
                boss_head_slot = int(npc.get("bossHeadSlot", -1))
            except (TypeError, ValueError, OverflowError):
                continue
            if x < 0 or y < 0 or npc_type < 1:
                continue
            npc_name = str(npc.get("name") or "NPC").strip()[:100]
            texture_hash = str(npc.get("modTexture") or "")
            head_texture_hash = str(npc.get("headTexture") or "")
            icon_url = self._write_npc_sprite(
                npc_type, texture_hash, frame_width, frame_height,
                head_slot, boss_head_slot, head_texture_hash,
            )
            active_npcs.append({
                "id": str(npc.get("id", ""))[:32],
                "type": npc_type,
                "name": npc_name,
                "boss": npc.get("boss") is True,
                "x": x,
                "y": y,
                "icon_url": icon_url,
            })
        coin_names = {71: "Медная монета", 72: "Серебряная монета", 73: "Золотая монета", 74: "Платиновая монета"}
        raw_coins = world.get("droppedCoins") if isinstance(world.get("droppedCoins"), list) else []
        active_coins: list[dict[str, Any]] = []
        for coin in raw_coins:
            if not isinstance(coin, dict):
                continue
            try:
                item_type, x, y, stack = int(coin.get("type")), int(coin.get("x")), int(coin.get("y")), int(coin.get("stack"))
            except (TypeError, ValueError, OverflowError):
                continue
            if item_type not in coin_names or x < 0 or y < 0 or stack < 1:
                continue
            icon_url = self._write_map_coin_sprite(item_type)
            active_coins.append({
                "id": str(coin.get("id", ""))[:32],
                "type": item_type,
                "name": str(coin.get("name") or coin_names[item_type]).strip()[:100],
                "x": x,
                "y": y,
                "stack": stack,
                "icon_url": icon_url,
            })
        world_id = world.get("id", world.get("world_id"))
        with self._lock:
            self._active_npcs = active_npcs
            self._active_npcs_world_id = str(world_id) if world_id is not None else None
            self._active_coins = active_coins
            self._active_coins_world_id = str(world_id) if world_id is not None else None
        mode = world.get("gameMode") if isinstance(world.get("gameMode"), dict) else {}
        players = snapshot.get("players") if isinstance(snapshot.get("players"), dict) else {}
        player_list = players.get("list") if isinstance(players.get("list"), list) else []
        normalized_players = [
            {
                "name": str(player.get("name", "")),
                "uuid": player.get("uuid"),
                "joined_at": player.get("joinedAtUnix"),
                "session_seconds": player.get("sessionSeconds"),
                "position": player.get("position"),
                "teleported": player.get("teleported") is True,
                "mapCapture": player.get("mapCapture"),
                "appearance": player.get("appearance"),
            }
            for player in player_list
            if isinstance(player, dict) and _is_valid_player_name(player.get("name"))
        ]
        self.set_players_online(len(normalized_players), normalized_players, world=world)
        raw_pylons = snapshot.get("pylons")
        if isinstance(raw_pylons, list):
            pylons = []
            for pylon in raw_pylons:
                if not isinstance(pylon, dict):
                    continue
                try:
                    x, y = int(pylon.get("x")), int(pylon.get("y"))
                except (TypeError, ValueError):
                    continue
                pylon_type = str(pylon.get("type") or "").strip()
                if x < 0 or y < 0 or not pylon_type:
                    continue
                pylons.append({"x": x, "y": y, "type": pylon_type})
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
                    spawn_x, spawn_y = int(world.get("spawnX")), int(world.get("spawnY"))
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
        base_captures = snapshot.get("baseMapCaptures")
        if isinstance(base_captures, list) and base_captures:
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
            map_scan=snapshot.get("mapScan") if isinstance(snapshot.get("mapScan"), dict) else None,
            game_mode=mode.get("name"),
            game_mode_id=mode.get("id"),
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
            telemetry_updated_at=snapshot.get("generatedAtUnix"),
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
                if _is_valid_png(output.read_bytes()):
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
                if rendered.returncode != 0 or not output.is_file() or not _is_valid_png(output.read_bytes()):
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
                if not _is_valid_png(output.read_bytes()):
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
                    if rendered.returncode != 0 or not output.is_file() or not _is_valid_png(output.read_bytes()):
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
