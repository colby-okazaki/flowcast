from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import timedelta
from typing import Sequence

from .models.base import Forecaster, Observation


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
