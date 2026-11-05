"""Build, combine, and retain route-aware visibility masks for map tiles."""

from __future__ import annotations

import hashlib
import math
from collections import OrderedDict
from threading import Lock
from typing import Any, cast

from ..store_common import read_map_mask_png


class MapRenderProfileStore:
    """Combine per-player exploration and route masks into bounded render profiles."""

    MASK_SCALE = 0.25
    OVERWORLD_WINDOW_WIDTH = 96
    OVERWORLD_WINDOW_HEIGHT = 54
    UNDERGROUND_RADIUS = 20
    MASK_FORMAT_VERSION = 1

    def __init__(self, max_entries: int = 32, max_bytes: int = 96 * 1024 * 1024) -> None:
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._profiles: OrderedDict[str, bytes] = OrderedDict()
        self._profile_bytes = 0
        self._lock = Lock()

    def get_mask(self, profile_id: str) -> bytes | None:
        with self._lock:
            mask = self._profiles.get(profile_id)
            if mask is not None:
                self._profiles.move_to_end(profile_id)
            return mask

    def build(
        self,
        world_id: str,
        world_width: int,
        world_height: int,
        surface_y: int | None,
        players: list[dict[str, Any]],
        full_map: bool = False,
    ) -> dict[str, Any]:
        mask_width = (world_width + 3) // 4
        mask_height = (world_height + 3) // 4
        if full_map:
            combined_mask = bytearray(b"\xff") * (mask_width * mask_height)
            routes: dict[str, list[dict[str, Any]]] = {}
            for player in players:
                player_id = player.get("id")
                points = player.get("route_positions")
                if isinstance(player_id, str) and isinstance(points, list):
                    routes[player_id] = cast(list[dict[str, Any]], points)
        else:
            combined_mask = bytearray(mask_width * mask_height)
            routes = {}
            for player in players:
                player_mask = bytearray(mask_width * mask_height)
                exploration_png = player.get("exploration_png")
                if isinstance(exploration_png, bytes):
                    self._add_imported_mask(player_mask, mask_width, mask_height, exploration_png)

                points = player.get("route_positions")
                if isinstance(points, list) and points:
                    raw_points = cast(list[Any], points)
                    route_points = [
                        cast(dict[str, Any], point)
                        for point in raw_points
                        if isinstance(point, dict)
                    ]
                    self._add_route_mask(
                        player_mask,
                        mask_width,
                        mask_height,
                        world_width,
                        world_height,
                        surface_y,
                        route_points,
                    )
                    player_id = player.get("id")
                    if isinstance(player_id, str):
                        routes[player_id] = route_points

                for index, visible in enumerate(player_mask):
                    if visible:
                        combined_mask[index] = 255

        mask_bytes = bytes(combined_mask)
        digest = hashlib.blake2b(digest_size=20)
        digest.update(f"{self.MASK_FORMAT_VERSION}:{world_id}:{world_width}:{world_height}:".encode())
        digest.update(mask_bytes)
        profile_id = digest.hexdigest()
        self._retain(profile_id, mask_bytes)
        explored_percent = (
            sum(1 for visible in mask_bytes if visible) / len(mask_bytes) * 100
            if mask_bytes
            else 0.0
        )
        return {
            "id": profile_id,
            "mask_width": mask_width,
            "mask_height": mask_height,
            "explored_percent": round(explored_percent, 2),
            "routes": routes,
        }

    def _retain(self, profile_id: str, mask: bytes) -> None:
        if len(mask) > self._max_bytes:
            return
        with self._lock:
            previous = self._profiles.pop(profile_id, None)
            if previous is not None:
                self._profile_bytes -= len(previous)
            self._profiles[profile_id] = mask
            self._profile_bytes += len(mask)
            while (
                len(self._profiles) > self._max_entries
                or self._profile_bytes > self._max_bytes
            ):
                _, evicted = self._profiles.popitem(last=False)
                self._profile_bytes -= len(evicted)

    @staticmethod
    def _add_imported_mask(
        target: bytearray, mask_width: int, mask_height: int, png: bytes
    ) -> None:
        source_width, source_height, rgba = read_map_mask_png(png)
        if (source_width, source_height) != (mask_width, mask_height):
            return
        for index, alpha in enumerate(rgba[3::4]):
            if alpha:
                target[index] = 255

    def _add_route_mask(
        self,
        mask: bytearray,
        mask_width: int,
        mask_height: int,
        world_width: int,
        world_height: int,
        surface_y: int | None,
        points: list[Any],
    ) -> None:
        valid: list[dict[str, Any]] = []
        for raw in points:
            if not isinstance(raw, dict):
                continue
            raw = cast(dict[str, Any], raw)
            try:
                point = {
                    "x": float(raw["x"]),
                    "y": float(raw["y"]),
                    "time": float(raw.get("time", 0) or 0),
                    "teleport": raw.get("teleport") is True,
                }
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
            if 0 <= point["x"] < world_width and 0 <= point["y"] < world_height:
                valid.append(point)
        valid.sort(key=lambda point: point["time"])
        if not valid:
            return

        self._stamp_route_point(mask, mask_width, mask_height, valid[0], surface_y)
        for previous, current in zip(valid, valid[1:]):
            dx = current["x"] - previous["x"]
            dy = current["y"] - previous["y"]
            distance = math.hypot(dx, dy)
            elapsed = current["time"] - previous["time"]
            sudden_jump = (
                distance >= 250
                and elapsed <= 15
                and distance / max(elapsed, 1) >= 45
            )
            teleport = (
                current["teleport"]
                or distance > max(1000, world_width * 0.35)
                or sudden_jump
            )
            if teleport or elapsed <= 0:
                self._stamp_route_point(mask, mask_width, mask_height, current, surface_y)
                continue

            steps = max(1, math.ceil(distance * self.MASK_SCALE))
            for step in range(steps + 1):
                progress = step / steps
                point = {
                    "x": previous["x"] + dx * progress,
                    "y": previous["y"] + dy * progress,
                }
                self._stamp_route_point(mask, mask_width, mask_height, point, surface_y)

    def _stamp_route_point(
        self,
        mask: bytearray,
        mask_width: int,
        mask_height: int,
        point: dict[str, Any],
        surface_y: int | None,
    ) -> None:
        x = float(point["x"])
        y = float(point["y"])
        if surface_y is not None and y < surface_y:
            left = math.floor((x - self.OVERWORLD_WINDOW_WIDTH / 2) * self.MASK_SCALE)
            top = math.floor((y - self.OVERWORLD_WINDOW_HEIGHT / 2) * self.MASK_SCALE)
            right = left + math.ceil(self.OVERWORLD_WINDOW_WIDTH * self.MASK_SCALE)
            bottom = top + math.ceil(self.OVERWORLD_WINDOW_HEIGHT * self.MASK_SCALE)
            for mask_y in range(max(0, top), min(mask_height, bottom)):
                start = mask_y * mask_width + max(0, left)
                end = mask_y * mask_width + min(mask_width, right)
                if end > start:
                    mask[start:end] = b"\xff" * (end - start)
            return

        center_x = round((x + 0.5) * self.MASK_SCALE)
        center_y = round((y + 0.5) * self.MASK_SCALE)
        radius = math.ceil(self.UNDERGROUND_RADIUS * self.MASK_SCALE)
        radius_squared = radius * radius
        for offset_y in range(-radius, radius + 1):
            for offset_x in range(-radius, radius + 1):
                if offset_x * offset_x + offset_y * offset_y > radius_squared:
                    continue
                mask_x = center_x + offset_x
                mask_y = center_y + offset_y
                if 0 <= mask_x < mask_width and 0 <= mask_y < mask_height:
                    mask[mask_y * mask_width + mask_x] = 255
