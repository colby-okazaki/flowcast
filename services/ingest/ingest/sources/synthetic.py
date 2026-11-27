from __future__ import annotations

import math
import random
from datetime import datetime, timedelta
from typing import Iterator
from zoneinfo import ZoneInfo

from ..records import ReadingRecord, SensorRecord

_LOCAL_TZ = ZoneInfo("America/Los_Angeles")

# Development-only stand-in for a real feed: lets the whole stack run before a
# real data source is wired up. Never present its output as real traffic data.
_SENSORS = [
    ("syn-405-n-wilshire", "I-405 NB @ Wilshire Blvd", "I-405", "N", 34.0617, -118.4520, 5),
    ("syn-405-s-sunset", "I-405 SB @ Sunset Blvd", "I-405", "S", 34.0731, -118.4636, 5),
    ("syn-10-e-overland", "I-10 EB @ Overland Ave", "I-10", "E", 34.0280, -118.4065, 4),
    ("syn-101-n-vermont", "US-101 NB @ Vermont Ave", "US-101", "N", 34.0886, -118.2917, 4),
    ("syn-110-s-adams", "I-110 SB @ Adams Blvd", "I-110", "S", 34.0326, -118.2741, 4),
]


class SyntheticSource:
    name = "synthetic"
    default_lookback_days = 28

    def __init__(self, seed: int = 42, interval_minutes: int = 5, bad_row_rate: float = 0.005) -> None:
        self.interval = timedelta(minutes=interval_minutes)
        self.bad_row_rate = bad_row_rate
        self._rng = random.Random(seed)

    def sensors(self) -> list[SensorRecord]:
        return [
            SensorRecord(id=i, name=n, road=r, direction=d, latitude=lat, longitude=lon, lanes=lanes, source=self.name)
            for i, n, r, d, lat, lon, lanes in _SENSORS
        ]

    @staticmethod
    def _expected_flow(t: datetime, lanes: int) -> float:
        local = t.astimezone(_LOCAL_TZ)  # rush hours follow local clock time, not UTC
        hour = local.hour + local.minute / 60
        weekday = local.weekday() < 5
        base = 250 + 900 * math.sin(math.pi * max(0.0, hour - 5) / 19) ** 2 if hour > 5 else 250
        am_peak = 1100 * math.exp(-((hour - 8.0) ** 2) / 1.5) if weekday else 0
        pm_peak = 1300 * math.exp(-((hour - 17.5) ** 2) / 2.0) if weekday else 0
        weekend_midday = 500 * math.exp(-((hour - 14) ** 2) / 8) if not weekday else 0
        return (base + am_peak + pm_peak + weekend_midday) * lanes / 4

    def readings(self, start: datetime, end: datetime) -> Iterator[ReadingRecord]:
        for sensor_id, *_rest, lanes in _SENSORS:
            t = start
            while t < end:
                flow = max(0.0, self._expected_flow(t, lanes) * self._rng.gauss(1.0, 0.06))
                capacity = 2000 * lanes
                occupancy = min(0.95, flow / capacity * 0.6)
                speed = max(5.0, 68 - 70 * occupancy**1.5 + self._rng.gauss(0, 2))
                record = ReadingRecord(sensor_id, t, round(flow), round(speed, 1), round(occupancy, 3))
                yield self._maybe_corrupt(record)
                t += self.interval

    def _maybe_corrupt(self, r: ReadingRecord) -> ReadingRecord:
        """Inject the kinds of faults real loop detectors produce so validation gets exercised."""
        if self._rng.random() >= self.bad_row_rate:
            return r
        fault = self._rng.choice(["negative", "missing_flow", "impossible_speed", "bad_occupancy"])
        if fault == "negative":
            return ReadingRecord(r.sensor_id, r.observed_at, -r.flow_vph, r.speed_mph, r.occupancy)
        if fault == "missing_flow":
            return ReadingRecord(r.sensor_id, r.observed_at, None, r.speed_mph, r.occupancy)
        if fault == "impossible_speed":
            return ReadingRecord(r.sensor_id, r.observed_at, r.flow_vph, 250.0, r.occupancy)
        return ReadingRecord(r.sensor_id, r.observed_at, r.flow_vph, r.speed_mph, 1.7)
