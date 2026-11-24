from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from statistics import fmean
from typing import Sequence

from .base import ForecastPoint, Observation


class SeasonalAverageForecaster:
    """Baseline: average historical flow for the same weekday and time-of-day slot.

    Falls back to the same time-of-day on any weekday, then to the last observed
    value. Every learned model has to beat this to justify its complexity.
    """

    name = "baseline"
    version = "v1"

    def __init__(self, slot_minutes: int = 15) -> None:
        if 60 * 24 % slot_minutes:
            raise ValueError("slot_minutes must divide a day evenly")
        self.slot_minutes = slot_minutes

    def _slot(self, t: datetime) -> int:
        return (t.hour * 60 + t.minute) // self.slot_minutes

    def predict(self, history: Sequence[Observation], horizons_minutes: Sequence[int]) -> list[ForecastPoint]:
        if not history:
            raise ValueError("history must not be empty")

        by_weekday_slot: dict[tuple[int, int], list[float]] = defaultdict(list)
        by_slot: dict[int, list[float]] = defaultdict(list)
        for obs in history:
            slot = self._slot(obs.observed_at)
            by_weekday_slot[(obs.observed_at.weekday(), slot)].append(obs.flow_vph)
            by_slot[slot].append(obs.flow_vph)

        last = history[-1]
        points: list[ForecastPoint] = []
        for h in horizons_minutes:
            target = last.observed_at + timedelta(minutes=h)
            slot = self._slot(target)
            values = by_weekday_slot.get((target.weekday(), slot)) or by_slot.get(slot)
            predicted = fmean(values) if values else last.flow_vph
            points.append(ForecastPoint(target_time=target, horizon_minutes=h, predicted_flow=round(predicted, 1)))
        return points
