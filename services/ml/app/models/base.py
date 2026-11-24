from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, Sequence


@dataclass(frozen=True)
class Observation:
    observed_at: datetime
    flow_vph: float


@dataclass(frozen=True)
class ForecastPoint:
    target_time: datetime
    horizon_minutes: int
    predicted_flow: float


class Forecaster(Protocol):
    """Every model (baseline, ridge, XGBoost, ...) implements this interface."""

    name: str
    version: str

    def predict(self, history: Sequence[Observation], horizons_minutes: Sequence[int]) -> list[ForecastPoint]:
        """Forecast flow at `last observation + h` for each horizon h.

        `history` is sorted oldest-first and non-empty.
        """
        ...
