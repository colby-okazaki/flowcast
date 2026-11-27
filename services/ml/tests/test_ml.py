from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.backtest import backfill_predictions, rolling_backtest
from app.main import create_app
from app.models.base import Observation
from app.models.baseline import SeasonalAverageForecaster

MONDAY = datetime(2026, 11, 2, tzinfo=timezone.utc)


def weekly_series(weeks: int, interval_min: int = 15) -> list[Observation]:
    """Perfectly periodic series: flow depends only on weekday and hour."""
    out = []
    t = MONDAY
    end = MONDAY + timedelta(weeks=weeks)
    while t < end:
        out.append(Observation(observed_at=t, flow_vph=float(t.weekday() * 100 + t.hour * 10)))
        t += timedelta(minutes=interval_min)
    return out


class TestBaseline:
    def test_uses_same_weekday_and_slot(self):
        history = weekly_series(weeks=2)
        [point] = SeasonalAverageForecaster().predict(history, [60])
        target = history[-1].observed_at + timedelta(minutes=60)
        assert point.target_time == target
        assert point.predicted_flow == target.weekday() * 100 + target.hour * 10

    def test_falls_back_to_last_value_with_no_matching_slot(self):
        history = [Observation(MONDAY, 500.0)]
        [point] = SeasonalAverageForecaster().predict(history, [30])
        assert point.predicted_flow == 500.0

    def test_rejects_empty_history(self):
        with pytest.raises(ValueError):
            SeasonalAverageForecaster().predict([], [15])

    def test_backtest_is_exact_on_periodic_data(self):
        series = weekly_series(weeks=3)
        result = rolling_backtest(SeasonalAverageForecaster(), series, horizon_minutes=15, min_history=96 * 7, step=4)
        assert result.n > 0
        assert result.mae == 0


class LastValueModel:
    """Predicts the last visible value, which makes leakage easy to detect."""

    name = "last"
    version = "t"

    def predict(self, history, horizons_minutes):
        from app.models.base import ForecastPoint

        last = history[-1]
        return [ForecastPoint(last.observed_at + timedelta(minutes=h), h, last.flow_vph) for h in horizons_minutes]


class TestBackfill:
    def test_only_sees_data_before_each_cutoff(self):
        series = [Observation(MONDAY + timedelta(minutes=15 * i), float(i)) for i in range(10)]
        cutoff = MONDAY + timedelta(minutes=15 * 4)  # observations 0..3 visible
        [point] = backfill_predictions(LastValueModel(), series, [15], [cutoff])
        assert point.predicted_flow == 3.0
        assert point.target_time == MONDAY + timedelta(minutes=60)

    def test_skips_cutoffs_before_any_data_and_sorts_output(self):
        series = [Observation(MONDAY + timedelta(minutes=15 * i), float(i)) for i in range(10)]
        cutoffs = [MONDAY + timedelta(hours=2), MONDAY - timedelta(hours=1), MONDAY + timedelta(hours=1)]
        points = backfill_predictions(LastValueModel(), series, [15], cutoffs)
        assert len(points) == 2
        assert points == sorted(points, key=lambda p: p.target_time)


class TestApi:
    client = TestClient(create_app())

    def test_health_lists_models(self):
        res = self.client.get("/health")
        assert res.status_code == 200
        assert {"name": "baseline", "version": "v1"} in res.json()["models"]

    def test_predict_returns_one_point_per_horizon(self):
        history = [
            {"observed_at": (MONDAY + timedelta(minutes=5 * i)).isoformat(), "flow_vph": 1000 + i}
            for i in range(12)
        ]
        res = self.client.post(
            "/predict", json={"sensor_id": "s-1", "horizons_minutes": [15, 30], "history": history}
        )
        assert res.status_code == 200
        body = res.json()
        assert body["model_version"] == "v1"
        assert [p["horizon_minutes"] for p in body["points"]] == [15, 30]

    def test_unknown_model_is_404(self):
        res = self.client.post(
            "/predict",
            json={"sensor_id": "s", "model": "nope", "history": [{"observed_at": MONDAY.isoformat(), "flow_vph": 1}]},
        )
        assert res.status_code == 404

    def test_backfill_returns_points_per_cutoff_and_horizon(self):
        history = [
            {"observed_at": (MONDAY + timedelta(minutes=15 * i)).isoformat(), "flow_vph": 1000 + i}
            for i in range(96)
        ]
        cutoffs = [(MONDAY + timedelta(hours=h)).isoformat() for h in (6, 12, 18)]
        res = self.client.post(
            "/predict/backfill",
            json={"sensor_id": "s", "horizons_minutes": [15, 60], "history": history, "cutoffs": cutoffs},
        )
        assert res.status_code == 200
        assert len(res.json()["points"]) == 6

    @pytest.mark.parametrize(
        "body",
        [
            {"sensor_id": "s", "history": []},
            {"sensor_id": "s", "horizons_minutes": [0], "history": [{"observed_at": "2026-11-02T00:00:00Z", "flow_vph": 1}]},
            {"sensor_id": "s", "history": [{"observed_at": "2026-11-02T00:00:00Z", "flow_vph": -5}]},
        ],
    )
    def test_invalid_requests_are_422(self, body):
        assert self.client.post("/predict", json=body).status_code == 422
