from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class SensorRecord:
    id: str
    name: str
    road: str | None
    direction: str | None
    latitude: float
    longitude: float
    lanes: int | None
    source: str


@dataclass(frozen=True)
class ReadingRecord:
    sensor_id: str
    observed_at: datetime | None
    flow_vph: float | None
    speed_mph: float | None
    occupancy: float | None
