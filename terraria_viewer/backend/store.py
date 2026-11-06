"""Backwards-compatible facade for viewer state and domain services."""

from __future__ import annotations

from .store_common import *
from ..models import DroppedCoin, NpcEntity
from .services.player_history import PlayerHistoryMixin
from .services.movement import MovementMixin
from .services.live_telemetry import LiveTelemetryMixin
from .services.monitoring import MonitoringMixin
from .services.world_map import WorldMapMixin
from .services.map_tile_pyramid import MapTilePyramid
from .services.map_render_profiles import MapRenderProfileStore
from ..sprite_renderer import MapItemSpriteRenderer, NpcSpriteRenderer, PlayerSpriteRenderer


class StatusStore(PlayerHistoryMixin, MovementMixin, LiveTelemetryMixin, MonitoringMixin, WorldMapMixin):
    WARNING_MARKERS = (
        "no route to host",
        "nodename nor servname provided, or not known",
        "проверка ssh controlmaster не прошла",
        "процесс туннеля завершился с кодом",
        "туннель переподключается",
        "silently caught exception",
        "at system.net.sockets.socket.",
    )

    def __init__(
        self,
        events_file: Path = EVENTS_FILE,
        history_file: Path = HISTORY_FILE,
        players_file: Path = PLAYERS_FILE,
        metrics_file: Path = METRICS_FILE,
        avatars_dir: Path = PLAYER_AVATARS_DIR,
        movements_dir: Path = PLAYER_MOVEMENTS_DIR,
        exploration_dir: Path = WORLD_MAP_EXPLORATION_DIR,
        npc_sprites_dir: Path = NPC_SPRITES_DIR,
        npc_textures_dir: Path = NPC_TEXTURES_DIR,
        map_sprites_dir: Path = MAP_SPRITES_DIR,
        death_retention_seconds: int = 3600,
        event_retention_seconds: int = 2592000,
        event_max_entries: int = 5000,
    ) -> None:
        self._lock = threading.Lock()
        self._live_update_condition = threading.Condition()
        self._live_update_sequence = 0
        self._events_file = events_file
        self._history_file = history_file
        self._players_file = players_file
        self._death_retention_seconds = max(0, int(death_retention_seconds))
        self._event_retention_seconds = max(0, int(event_retention_seconds))
        self._event_max_entries = max(1, int(event_max_entries))
        self._metrics_file = metrics_file
        self._avatars_dir = avatars_dir
        self.avatar_directory = avatars_dir
        self._npc_sprites_dir = npc_sprites_dir
        self.npc_sprite_directory = npc_sprites_dir
        self._npc_textures_dir = npc_textures_dir
        self._map_sprites_dir = map_sprites_dir
        self.map_sprite_directory = map_sprites_dir
        self._coin_sprite_cache: dict[int, str | None] = {}
        self._sprite_renderer_lock = threading.Lock()
        self._player_sprite_renderer = PlayerSpriteRenderer()
        self._npc_sprite_renderer = NpcSpriteRenderer()
        self._map_item_sprite_renderer = MapItemSpriteRenderer()
        self._movements_dir = movements_dir
        self._exploration_dir = exploration_dir
        self._world_map_cache_file = movements_dir / "world-map-cache.json"
        self._world_map_cache: dict[str, dict[str, Any]] = {}
        self._world_map_cache_dirty = False
        self._world_map_cache_last_saved_at = time.monotonic()
        self._map_tile_pyramid = MapTilePyramid(
            disk_cache_directory=movements_dir.parent / "map-tile-pyramid"
        )
        self._map_render_profiles = MapRenderProfileStore()
        self._map_tile_generation_lock = threading.BoundedSemaphore(2)
        self._events: list[dict[str, Any]] = []
        self._history: list[dict[str, Any]] = []
        self._players: dict[str, dict[str, Any]] = {}
        self._movement_cache: dict[str, dict[str, Any]] = {}
        self._movement_visited_tiles: dict[tuple[str, str], set[str]] = {}
        self._movement_last_saved_at: dict[str, float] = {}
        self._players_last_saved_monotonic = 0.0
        self._metrics_last_saved_monotonic = 0.0
        self._online_player_ids: list[str] = []
        self._players_updated_at: float | None = None
        self._server_info: dict[str, Any] = {
            "version": None,
            "game_time": None,
            "port": GAME_PORT,
            "max_players": None,
            "world": None,
            "map_scan": None,
            "deaths_updated_at": None,
        }
        self._host_metrics: dict[str, Any] = {}
        self._load_metrics()
        self._game_started_at: float | None = None
        self._tunnel_started_at: float | None = None
        self._tunnel_reconnecting = False
        self._network_interface: str | None = None
        self._network_gateway: str | None = None
        self._vpn_active = False
        self._game_running = False
        self._listener_up = False
        self._tunnel_ready = False
        self._players_online: int | None = None
        self._player_names: list[str] | None = None
        self._players_checked_at: float | None = None
        self._telemetry_received_at: float | None = None
        self._telemetry_last_received_monotonic: float | None = None
        self._telemetry_interval_ms: float | None = None
        self._telemetry_snapshot_id: int | None = None
        self._active_npcs: list[NpcEntity] = []
        self._active_npcs_world_id: str | None = None
        self._active_coins: list[DroppedCoin] = []
        self._active_coins_world_id: str | None = None
        self._updated_at = time.time()
        self._load_world_map_cache()
        self._load_events()
        self._load_history()
        self._load_players()

    def notify_live_update(self) -> None:
        """Wake SSE clients after a new telemetry snapshot has been applied."""
        with self._live_update_condition:
            self._live_update_sequence += 1
            self._live_update_condition.notify_all()

    def wait_for_live_update(self, previous_sequence: int, timeout: float) -> int:
        """Wait until telemetry advances, while allowing periodic SSE heartbeats."""
        with self._live_update_condition:
            self._live_update_condition.wait_for(
                lambda: self._live_update_sequence != previous_sequence,
                timeout=max(0.0, timeout),
            )
            return self._live_update_sequence

    def live_update_sequence(self) -> int:
        with self._live_update_condition:
            return self._live_update_sequence
