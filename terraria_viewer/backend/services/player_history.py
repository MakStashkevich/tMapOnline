# Player records are persisted as versioned, extensible JSON dictionaries.
# Runtime shape checks protect the fields used by this service.
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false
from __future__ import annotations

from ..store_common import (
    Any,
    as_json_array,
    as_json_object,
    StoreMixinContract,
    HISTORY_RETENTION_SECONDS,
    Path,
    TERRARIA_CLIENT_IMAGES,
    is_valid_player_name,
    hashlib,
    json,
    re,
    time,
)
from ...sprite_renderer import PlayerAppearance


class PlayerHistoryMixin(StoreMixinContract):
    def _load_events(self) -> None:
        try:
            loaded = as_json_array(json.loads(self._events_file.read_text(encoding="utf-8")))
            self._events = [self._normalize_event(as_json_object(event)) for event in loaded if isinstance(event, dict)]
        except (OSError, ValueError, TypeError):
            self._events = []

    @classmethod
    def _normalize_event(cls, event: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(event)
        message = str(normalized.get("message", ""))
        normalized["severity"] = cls._severity(str(normalized.get("source", "")), message)
        return normalized

    @classmethod
    def _severity(cls, source: str, message: str) -> str:
        lowered = message.lower()
        if (
            source == "SSH"
            or "[warn]" in lowered
            or any(marker in lowered for marker in cls.WARNING_MARKERS)
        ):
            return "warning"
        return "error"

    def _load_history(self) -> None:
        try:
            loaded = as_json_array(json.loads(self._history_file.read_text(encoding="utf-8")))
            if loaded:
                cutoff = time.time() - HISTORY_RETENTION_SECONDS
                self._history = [
                    item for item in loaded
                    if isinstance(item, dict) and float(item.get("time", 0)) >= cutoff
                ]
                if len(self._history) != len(loaded):
                    self._save_history_locked()
        except (OSError, ValueError, TypeError):
            self._history = []

    def _load_players(self) -> None:
        try:
            loaded = as_json_object(json.loads(self._players_file.read_text(encoding="utf-8")))
            records = as_json_object(loaded.get("players", {}))
            if loaded:
                self._players_updated_at = loaded.get("updated_at")
            if records:
                self._players = {
                    str(key): value for key, value in records.items()
                    if isinstance(value, dict)
                    and isinstance(value.get("sessions", []), list)
                    and is_valid_player_name(value.get("name"))
                }
            for player_id, record in self._players.items():
                avatar_digest = hashlib.sha256(player_id.encode("utf-8")).hexdigest()[:32]
                current_avatar_path = self._avatars_dir / f"{avatar_digest}.png"
                try:
                    current_avatar = current_avatar_path.read_bytes()
                except OSError:
                    current_avatar = b""
                current_version = hashlib.sha256(current_avatar).hexdigest()[:8] if current_avatar else ""
                expected_avatar_url = f"/player-avatars/{avatar_digest}.png?v={current_version}" if current_version else ""
                appearance_signature = self._appearance_signature(record.get("appearance", {}))
                needs_render = (
                    not current_avatar
                    or record.get("avatar_render_signature") != appearance_signature
                )
                if needs_render:
                    rendered_url = self._write_player_sprite(
                        player_id, str(record.get("name", "Player")), record.get("appearance", {})
                    )
                    record["avatar_url"] = rendered_url
                    record["avatar_render_signature"] = appearance_signature
                else:
                    record["avatar_url"] = expected_avatar_url
                if isinstance(record.get("positions"), list) or isinstance(record.get("visited_tiles"), list):
                    self._record_legacy_movement(
                        player_id,
                        str(record.get("name", "Player")),
                        record.get("uuid"),
                        record.get("positions", []),
                        record.get("visited_tiles", []),
                    )
                    record.pop("positions", None)
                    record.pop("visited_tiles", None)
            # A process exit cannot leave a session marked as currently online.
            now = time.time()
            for record in self._players.values():
                for session in record.get("sessions", []):
                    if isinstance(session, dict) and session.get("ended_at") is None:
                        session["ended_at"] = session.get("last_seen_at", now)
            self._save_players_locked()
        except FileNotFoundError:
            self._players = {}
            self._save_players_locked()
        except (OSError, ValueError, TypeError):
            # Keep a damaged or unreadable history file intact for manual recovery.
            self._players = {}

    def _load_metrics(self) -> None:
        try:
            loaded = as_json_object(json.loads(self._metrics_file.read_text(encoding="utf-8")))
            if loaded:
                self._server_info.update(loaded.get("server", {}))
                self._host_metrics = loaded.get("host", {}) if isinstance(loaded.get("host"), dict) else {}
        except (OSError, ValueError, TypeError):
            pass

    def _save_events_locked(self) -> None:
        self._events_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._events_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._events, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self._events_file)

    def _save_history_locked(self) -> None:
        self._history_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._history_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._history, ensure_ascii=False), encoding="utf-8")
        temporary.replace(self._history_file)

    def _save_players_locked(self) -> None:
        self._players_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self._players_file.with_suffix(".tmp")
        document = {
            "schema_version": 1,
            "updated_at": self._players_updated_at or time.time(),
            "players": self._players,
        }
        temporary.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._players_file)

    def _write_player_sprite(self, player_id: str, name: str, appearance: Any) -> str:
        """Render a pixel avatar from Terraria's own XNB sprite sheets, without a graphics device."""
        appearance = appearance if isinstance(appearance, dict) else {}
        if not TERRARIA_CLIENT_IMAGES.is_dir():
            return ""

        try:
            skin_variant = int(appearance.get("skinVariant", 0) or 0)
            hair = int(appearance.get("hair", -1) if appearance.get("hair") is not None else -1)
            # Visual priority is: transformation accessory texture (it replaces
            # the selected headgear in the renderer), visible vanity head, functional armor head, then the
            # player's unadorned face/hair. Player.head is the visible vanity
            # slot; equippedHead is only the functional armor fallback.
            head = int(appearance.get("head", -1) if appearance.get("head") is not None else -1)
            if head < 0:
                head = int(appearance.get("equippedHead", -1) if appearance.get("equippedHead") is not None else -1)
            armor = appearance.get("armor") if isinstance(appearance.get("armor"), list) else []
            head_item = next(
                (
                    item for item in armor
                    if isinstance(item, dict)
                    and int(item.get("stack", 0) or 0) > 0
                    and int(item.get("headSlot", -1) if item.get("headSlot") is not None else -1) >= 0
                ),
                None,
            )
            if head < 0:
                if head_item is not None:
                    head = int(head_item.get("headSlot", -1))
        except (TypeError, ValueError, OverflowError):
            return ""

        def valid_color(key: str, fallback: str) -> tuple[int, int, int]:
            value = str(appearance.get(key) or fallback)
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
                value = fallback
            return (
                int(value[1:3], 16),
                int(value[3:5], 16),
                int(value[5:7], 16),
            )

        hair_settings = appearance.get("hairSettings") if isinstance(appearance.get("hairSettings"), dict) else {}
        # Terraria's Wolf Mask is head slot 136. Its sprite is a full animal
        # head, so hair layers must not be composited over or behind it.
        wolf_mask = head == 136
        mod_equip_textures = appearance.get("modEquipTextures") if isinstance(appearance.get("modEquipTextures"), dict) else {}
        # Transformation accessories (for example Calamity's Ha-pu Fruit)
        # visually replace both vanity and armor headgear.
        mod_head_texture = str(mod_equip_textures.get("TransformationHead") or mod_equip_textures.get("Head") or "")
        if not mod_head_texture or not Path(mod_head_texture).is_file():
            mod_head_texture = ""
        mod_face_texture = str(mod_equip_textures.get("Face") or "")
        if not mod_face_texture or not Path(mod_face_texture).is_file():
            mod_face_texture = ""
        mod_beard_texture = str(mod_equip_textures.get("Beard") or "")
        if not mod_beard_texture or not Path(mod_beard_texture).is_file():
            mod_beard_texture = ""

        def hair_flag(key: str, default: bool) -> bool:
            value = hair_settings.get(key, default)
            return value if isinstance(value, bool) else default

        digest = hashlib.sha256(player_id.encode("utf-8")).hexdigest()[:32]
        avatar_path = self._avatars_dir / f"{digest}.png"
        try:
            with self._sprite_renderer_lock:
                self._player_sprite_renderer.render(
                    TERRARIA_CLIENT_IMAGES,
                    avatar_path,
                    PlayerAppearance(
                        skin_variant=skin_variant,
                        hair_id=hair,
                        head_id=head,
                        hair_color=valid_color("hairColor", "#49372F"),
                        skin_color=valid_color("skinColor", "#E6B38A"),
                        eye_color=valid_color("eyeColor", "#547B9D"),
                        full_hair=hair_flag("fullHair", False) if not wolf_mask else False,
                        hat_hair=hair_flag("hatHair", False) if not wolf_mask else False,
                        hide_hair=hair_flag("hideHair", False) if not wolf_mask else True,
                        back_hair_draw=hair_flag("backHairDraw", True) if not wolf_mask else False,
                        back_hair_without_headgear=hair_flag("backHairWithoutHeadgear", False),
                        mod_head_texture=Path(mod_head_texture) if mod_head_texture else None,
                        mod_face_texture=Path(mod_face_texture) if mod_face_texture else None,
                        mod_beard_texture=Path(mod_beard_texture) if mod_beard_texture else None,
                    ),
                )
                image_bytes = avatar_path.read_bytes()
        except (OSError, ValueError, TypeError, IndexError):
            return ""

        version = hashlib.sha256(image_bytes).hexdigest()[:8]
        return f"/player-avatars/{digest}.png?v={version}"
