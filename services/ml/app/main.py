from __future__ import annotations

from datetime import datetime

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

from .backtest import backfill_predictions
from .models.base import Forecaster, ForecastPoint, Observation
from .registry import ModelRegistry, default_registry


class HistoryPoint(BaseModel):
    observed_at: datetime
    flow_vph: float = Field(ge=0)


class PredictRequest(BaseModel):
    sensor_id: str
    model: str = "baseline"
    horizons_minutes: list[int] = Field(default=[15, 30, 60], min_length=1, max_length=12)
    history: list[HistoryPoint] = Field(min_length=1)

    @field_validator("horizons_minutes")
    @classmethod
    def positive_horizons(cls, v: list[int]) -> list[int]:
        if any(h <= 0 or h > 24 * 60 for h in v):
            raise ValueError("horizons must be between 1 and 1440 minutes")
        return v


MAX_BACKFILL_CUTOFFS = 2000


class BackfillRequest(PredictRequest):
    cutoffs: list[datetime] = Field(min_length=1, max_length=MAX_BACKFILL_CUTOFFS)


class PredictPoint(BaseModel):
    target_time: datetime
    horizon_minutes: int
    predicted_flow: float


class PredictResponse(BaseModel):
    sensor_id: str
    model: str
    model_version: str
    points: list[PredictPoint]


def create_app(registry: ModelRegistry | None = None) -> FastAPI:
    registry = registry or default_registry()
    app = FastAPI(title="FlowCast ML Service", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"status": "ok", "models": registry.list()}

    @app.get("/models")
    def list_models() -> list[dict[str, str]]:
        return registry.list()

    def resolve(req: PredictRequest) -> tuple[Forecaster, list[Observation]]:
        model = registry.get(req.model)
        if model is None:
            raise HTTPException(status_code=404, detail=f"Unknown model '{req.model}'")
        history = sorted(
            (Observation(observed_at=h.observed_at, flow_vph=h.flow_vph) for h in req.history),
            key=lambda o: o.observed_at,
        )
        return model, history

    def respond(req: PredictRequest, model: Forecaster, points: list[ForecastPoint]) -> PredictResponse:
        return PredictResponse(
            sensor_id=req.sensor_id,
            model=model.name,
            model_version=model.version,
            points=[PredictPoint(**p.__dict__) for p in points],
        )

    @app.post("/predict", response_model=PredictResponse)
    def predict(req: PredictRequest) -> PredictResponse:
        model, history = resolve(req)
        return respond(req, model, model.predict(history, req.horizons_minutes))

    @app.post("/predict/backfill", response_model=PredictResponse)
    def backfill(req: BackfillRequest) -> PredictResponse:
        """Forecasts as they would have been made at each cutoff, for scoring against actuals."""
        model, history = resolve(req)
        return respond(req, model, backfill_predictions(model, history, req.horizons_minutes, req.cutoffs))

    return app


app = create_app()
