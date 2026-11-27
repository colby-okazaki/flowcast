from __future__ import annotations

import math
from bisect import bisect_left
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Sequence

from .models.base import Forecaster, ForecastPoint, Observation


def backfill_predictions(
    model: Forecaster,
    series: Sequence[Observation],
    horizons_minutes: Sequence[int],
    cutoffs: Sequence[datetime],
) -> list[ForecastPoint]:
    """Reproduce the forecasts the model would have made at each past cutoff.

    For each cutoff, only observations strictly before it are visible, so the
    resulting predictions can be scored against actuals without leakage.
    When two cutoffs yield the same (target, horizon), the later one wins.
    """
    times = [obs.observed_at for obs in series]
    by_key: dict[tuple[datetime, int], ForecastPoint] = {}
    for cutoff in sorted(cutoffs):
        visible = bisect_left(times, cutoff)
        if visible == 0:
            continue
        for point in model.predict(series[:visible], horizons_minutes):
            by_key[(point.target_time, point.horizon_minutes)] = point
    return sorted(by_key.values(), key=lambda p: (p.target_time, p.horizon_minutes))


@dataclass(frozen=True)
class BacktestResult:
    model: str
    horizon_minutes: int
    n: int
    mae: float
    rmse: float


def rolling_backtest(
    model: Forecaster,
    series: Sequence[Observation],
    horizon_minutes: int,
    min_history: int,
    step: int = 1,
) -> BacktestResult:
    """Walk-forward evaluation: at each cutoff, forecast using only data before it.

    This prevents look-ahead leakage, which is the most common way traffic
    forecasting projects report accuracy they do not actually have.
    """
    if min_history < 1:
        raise ValueError("min_history must be >= 1")

    actual_at = {obs.observed_at: obs.flow_vph for obs in series}
    errors: list[float] = []
    for cutoff in range(min_history, len(series), step):
        history = series[:cutoff]
        [point] = model.predict(history, [horizon_minutes])
        target = history[-1].observed_at + timedelta(minutes=horizon_minutes)
        if target in actual_at:
            errors.append(point.predicted_flow - actual_at[target])

    if not errors:
        raise ValueError("no forecast targets overlapped the series; check horizon and interval")
    return BacktestResult(
        model=model.name,
        horizon_minutes=horizon_minutes,
        n=len(errors),
        mae=sum(abs(e) for e in errors) / len(errors),
        rmse=math.sqrt(sum(e * e for e in errors) / len(errors)),
    )
