from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable

from .records import ReadingRecord

MAX_SPEED_MPH = 120
MAX_FLOW_PER_LANE_VPH = 3000  # well above physical lane capacity (~2,200 vph)
ASSUMED_LANES_WHEN_UNKNOWN = 6  # some sources (e.g. WebTRIS) do not publish lane counts


@dataclass
class ValidationReport:
    valid: list[ReadingRecord] = field(default_factory=list)
    rejected: Counter[str] = field(default_factory=Counter)

    @property
    def rejected_total(self) -> int:
        return sum(self.rejected.values())


def reject_reason(r: ReadingRecord, known_sensors: set[str], lanes: dict[str, int | None]) -> str | None:
    if r.sensor_id not in known_sensors:
        return "unknown_sensor"
    if r.observed_at is None:
        return "missing_timestamp"
    if r.observed_at.tzinfo is None:
        return "naive_timestamp"
    if r.flow_vph is None:
        return "missing_flow"
    if r.flow_vph < 0:
        return "negative_flow"
    lane_count = lanes.get(r.sensor_id) or ASSUMED_LANES_WHEN_UNKNOWN
    if r.flow_vph > MAX_FLOW_PER_LANE_VPH * lane_count:
        return "flow_above_capacity"
    if r.speed_mph is not None and not (0 <= r.speed_mph <= MAX_SPEED_MPH):
        return "impossible_speed"
    if r.occupancy is not None and not (0 <= r.occupancy <= 1):
        return "bad_occupancy"
    return None


def validate_readings(
    rows: Iterable[ReadingRecord],
    known_sensors: set[str],
    lanes: dict[str, int | None] | None = None,
) -> ValidationReport:
    """Split raw rows into valid rows and counted rejections. Later duplicates of a (sensor, time) key are dropped."""
    lanes = lanes or {}
    report = ValidationReport()
    seen: set[tuple[str, object]] = set()
    for r in rows:
        reason = reject_reason(r, known_sensors, lanes)
        if reason is None:
            key = (r.sensor_id, r.observed_at)
            if key in seen:
                reason = "duplicate"
            else:
                seen.add(key)
        if reason:
            report.rejected[reason] += 1
        else:
            report.valid.append(r)
    return report
