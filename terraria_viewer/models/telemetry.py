"""Typed models for the tModLoader JSONL snapshot boundary."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, cast


def _object(value: Any) -> dict[str, Any]:
    """Narrow an untrusted JSON object after checking its runtime shape."""
    return cast(dict[str, Any], value) if isinstance(value, dict) else {}


def _integer(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _integer_or(value: Any, fallback: int) -> int:
    parsed = _integer(value)
    return parsed if parsed is not None else fallback


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _optional_object(value: Any) -> dict[str, Any] | None:
    return _object(value) if isinstance(value, dict) else None


@dataclass(frozen=True)
class TilePosition:
    """A Terraria tile coordinate pair used by a player's live sample."""

    tile_x: int
    tile_y: int

    @classmethod
    def from_payload(cls, value: Any) -> TilePosition | None:
        raw = _object(value)
        tile_x = _integer(raw.get("tileX"))
        tile_y = _integer(raw.get("tileY"))
        if tile_x is None or tile_y is None or tile_x < 0 or tile_y < 0:
            return None
        return cls(tile_x, tile_y)

    def to_payload(self) -> dict[str, int]:
        return {"tileX": self.tile_x, "tileY": self.tile_y}


@dataclass(frozen=True)
class PlayerSnapshot:
    """A validated player sample with explicit fields used by the viewer."""

    name: str
    uuid: str | None
    joined_at: float | None
    session_seconds: float | None
    position: TilePosition | None
    teleported: bool
    map_capture: dict[str, Any] | None
    appearance: dict[str, Any] | None
    team: int | None
    direction: int | None

    @classmethod
    def from_payload(cls, value: Any) -> PlayerSnapshot | None:
        raw = _object(value)
        name = str(raw.get("name") or "").strip()
        if not name:
            return None
        uuid_value = raw.get("uuid")
        return cls(
            name=name,
            uuid=str(uuid_value) if uuid_value else None,
            joined_at=_number(raw.get("joinedAtUnix")),
            session_seconds=_number(raw.get("sessionSeconds")),
            position=TilePosition.from_payload(raw.get("position")),
            teleported=raw.get("teleported") is True,
            map_capture=_optional_object(raw.get("mapCapture")),
            appearance=_optional_object(raw.get("appearance")),
            team=(
                team
                if (team := _integer(raw.get("team"))) is not None and 0 <= team <= 5
                else None
            ),
            direction=(
                direction
                if (direction := _integer(raw.get("direction"))) in (-1, 1)
                else None
            ),
        )

    def to_store_payload(self) -> dict[str, Any]:
        """Keep the established store field names at the model boundary."""
        return {
            "name": self.name,
            "uuid": self.uuid,
            "joined_at": self.joined_at,
            "session_seconds": self.session_seconds,
            "position": self.position.to_payload() if self.position is not None else None,
            "teleported": self.teleported,
            "mapCapture": self.map_capture,
            "appearance": self.appearance,
            "team": self.team,
            "direction": self.direction,
        }


@dataclass(frozen=True)
class NpcEntity:
    """An NPC or boss currently present in the Terraria world."""

    entity_id: str
    npc_type: int
    name: str
    is_boss: bool
    tile_x: int
    tile_y: int
    frame_width: int
    frame_height: int
    head_slot: int
    boss_head_slot: int
    mod_texture: str
    head_texture: str
    icon_url: str | None = None

    @classmethod
    def from_payload(cls, value: Any) -> NpcEntity | None:
        raw = _object(value)
        tile_x, tile_y, npc_type = (
            _integer(raw.get("x")), _integer(raw.get("y")), _integer(raw.get("type"))
        )
        if tile_x is None or tile_y is None or npc_type is None:
            return None
        if tile_x < 0 or tile_y < 0 or npc_type < 1:
            return None
        return cls(
            entity_id=str(raw.get("id", ""))[:32],
            npc_type=npc_type,
            name=str(raw.get("name") or "NPC").strip()[:100],
            is_boss=raw.get("boss") is True,
            tile_x=tile_x,
            tile_y=tile_y,
            frame_width=max(1, min(1024, _integer_or(raw.get("frameWidth"), 32))),
            frame_height=max(1, min(1024, _integer_or(raw.get("frameHeight"), 32))),
            head_slot=_integer_or(raw.get("headSlot"), -1),
            boss_head_slot=_integer_or(raw.get("bossHeadSlot"), -1),
            mod_texture=str(raw.get("modTexture") or ""),
            head_texture=str(raw.get("headTexture") or ""),
        )

    def with_icon(self, icon_url: str | None) -> NpcEntity:
        return replace(self, icon_url=icon_url)

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.entity_id, "type": self.npc_type, "name": self.name,
            "boss": self.is_boss, "x": self.tile_x, "y": self.tile_y,
            "icon_url": self.icon_url,
        }


@dataclass(frozen=True)
class DroppedCoin:
    """A dropped vanilla coin stack and its map sprite."""

    entity_id: str
    item_type: int
    name: str
    tile_x: int
    tile_y: int
    stack: int
    icon_url: str | None = None

    @classmethod
    def from_payload(cls, value: Any) -> DroppedCoin | None:
        raw = _object(value)
        item_type, tile_x, tile_y, stack = (
            _integer(raw.get("type")), _integer(raw.get("x")),
            _integer(raw.get("y")), _integer(raw.get("stack")),
        )
        if item_type not in {71, 72, 73, 74} or tile_x is None or tile_y is None or stack is None:
            return None
        if tile_x < 0 or tile_y < 0 or stack < 1:
            return None
        default_names = {71: "Медная монета", 72: "Серебряная монета", 73: "Золотая монета", 74: "Платиновая монета"}
        return cls(
            entity_id=str(raw.get("id", ""))[:32],
            item_type=item_type,
            name=str(raw.get("name") or default_names[item_type]).strip()[:100],
            tile_x=tile_x, tile_y=tile_y, stack=stack,
        )

    def with_icon(self, icon_url: str | None) -> DroppedCoin:
        return replace(self, icon_url=icon_url)

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.entity_id, "type": self.item_type, "name": self.name,
            "x": self.tile_x, "y": self.tile_y, "stack": self.stack,
            "icon_url": self.icon_url,
        }


@dataclass(frozen=True)
class PlayerDeath:
    """A player death location reported by the game telemetry hook."""

    name: str
    uuid: str | None
    tile_x: int
    tile_y: int
    timestamp: float

    @classmethod
    def from_payload(cls, value: Any) -> PlayerDeath | None:
        raw = _object(value)
        name = str(raw.get("name") or "").strip()
        tile_x = _integer(raw.get("x"))
        tile_y = _integer(raw.get("y"))
        if not name or tile_x is None or tile_y is None or tile_x < 0 or tile_y < 0:
            return None
        uuid_value = raw.get("uuid")
        return cls(
            name=name[:64],
            uuid=str(uuid_value) if uuid_value else None,
            tile_x=tile_x,
            tile_y=tile_y,
            timestamp=_number(raw.get("at")) or 0,
        )


@dataclass(frozen=True)
class Pylon:
    """A placed pylon with its world tile coordinate."""

    tile_x: int
    tile_y: int
    pylon_type: str

    @classmethod
    def from_payload(cls, value: Any) -> Pylon | None:
        raw = _object(value)
        tile_x, tile_y = _integer(raw.get("x")), _integer(raw.get("y"))
        pylon_type = str(raw.get("type") or "").strip()
        if tile_x is None or tile_y is None or tile_x < 0 or tile_y < 0 or not pylon_type:
            return None
        return cls(tile_x, tile_y, pylon_type)

    def to_payload(self) -> dict[str, Any]:
        return {"x": self.tile_x, "y": self.tile_y, "type": self.pylon_type}


@dataclass(frozen=True)
class LiveTelemetrySnapshot:
    """A typed view over one raw snapshot, without changing the JSONL contract."""

    server: dict[str, Any]
    world: dict[str, Any]
    players: tuple[PlayerSnapshot, ...]
    npcs: tuple[NpcEntity, ...]
    coins: tuple[DroppedCoin, ...]
    player_deaths: tuple[PlayerDeath, ...]
    pylons: tuple[Pylon, ...]
    has_pylon_snapshot: bool
    base_map_captures: tuple[dict[str, Any], ...]
    map_scan: dict[str, Any] | None
    game_mode: dict[str, Any] | None
    generated_at: Any

    @classmethod
    def from_payload(cls, value: dict[str, Any]) -> LiveTelemetrySnapshot:
        root = _object(value)
        server = _object(root.get("server"))
        world = _object(root.get("world"))
        raw_players = _object(root.get("players"))
        return cls(
            server=server,
            world=world,
            players=tuple(
                player for item in _json_array(raw_players.get("list"))
                if (player := PlayerSnapshot.from_payload(item)) is not None
            ),
            npcs=tuple(
                npc for item in _json_array(world.get("activeNpcs"))
                if (npc := NpcEntity.from_payload(item)) is not None
            ),
            coins=tuple(
                coin for item in _json_array(world.get("droppedCoins"))
                if (coin := DroppedCoin.from_payload(item)) is not None
            ),
            player_deaths=tuple(
                death for item in _json_array(root.get("playerDeaths"))
                if (death := PlayerDeath.from_payload(item)) is not None
            ),
            pylons=tuple(
                pylon for item in _json_array(root.get("pylons"))
                if (pylon := Pylon.from_payload(item)) is not None
            ),
            has_pylon_snapshot=bool(_json_array(root.get("pylons"))),
            base_map_captures=tuple(
                item for value in _json_array(root.get("baseMapCaptures"))
                if (item := _optional_object(value)) is not None
            ),
            map_scan=_optional_object(root.get("mapScan")),
            game_mode=_optional_object(world.get("gameMode")),
            generated_at=root.get("generatedAtUnix"),
        )


def _json_array(value: Any) -> list[Any]:
    return cast(list[Any], value) if isinstance(value, list) else []
