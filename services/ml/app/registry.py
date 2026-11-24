from __future__ import annotations

from .models.base import Forecaster
from .models.baseline import SeasonalAverageForecaster


class ModelRegistry:
    """Maps model names to loaded forecasters.

    Models are registered in code for now. Trained models will be loaded as
    versioned artifacts from MODEL_DIR, keyed by the `model_versions` table.
    """

    def __init__(self) -> None:
        self._models: dict[str, Forecaster] = {}

    def register(self, model: Forecaster) -> None:
        self._models[model.name] = model

    def get(self, name: str) -> Forecaster | None:
        return self._models.get(name)

    def list(self) -> list[dict[str, str]]:
        return [{"name": m.name, "version": m.version} for m in self._models.values()]


def default_registry() -> ModelRegistry:
    registry = ModelRegistry()
    registry.register(SeasonalAverageForecaster())
    return registry
