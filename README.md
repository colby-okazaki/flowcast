# FlowCast

**Short-term traffic flow forecasting for road sensors.**

Traffic on a freeway follows strong daily and weekly patterns, but the exact flow 15, 30 or 60 minutes from now still depends on what is happening right now. FlowCast collects readings from road sensors (vehicles per hour, speed and lane occupancy), stores them, and forecasts near-future traffic flow for each sensor. A dashboard shows every sensor on a map and compares what the model predicted against what actually happened, with error metrics, so you can see how good the forecasts really are.

The project is built as a set of small services rather than a single script, so each part — ingestion, storage, model serving, API and UI — can be developed, tested and scaled on its own.

## How it works

1. **Ingest.** A pipeline pulls readings from a data source, validates every row (missing values, impossible speeds, negative flow, duplicates, unknown sensors), and bulk-loads the clean rows into PostgreSQL. Every run is recorded with how many rows were inserted and rejected, and why.
2. **Forecast.** When a forecast is requested, the API gathers the sensor's recent history and sends it to the model service, which returns predictions for each horizon (for example 15, 30 and 60 minutes ahead).
3. **Store and serve.** Predictions are saved with the model version that produced them, so results stay traceable when models change. Recent predictions are cached in Redis and the cache is cleared whenever a new forecast is written.
4. **Evaluate.** Models are scored with walk-forward backtesting — every forecast uses only data from before its cutoff — and the dashboard reports MAE, RMSE and MAPE on actual vs. predicted flow.

## Architecture

```
                ┌──────────────┐
  data source → │ ingest       │──COPY──┐
                │ (Python)     │        ▼
                └──────────────┘   ┌────────────┐
┌───────────┐   ┌──────────────┐   │ PostgreSQL │
│ web       │──▶│ api          │──▶│            │
│ React +   │   │ Express + TS │   └────────────┘
│ Leaflet   │   │              │──▶ Redis (prediction cache)
└───────────┘   └──────┬───────┘
                       │ POST /predict
                       ▼
                ┌──────────────┐
                │ ml           │  model registry → seasonal baseline, …
                │ (FastAPI)    │
                └──────────────┘
```

## Tech stack

| Layer | Technologies |
| --- | --- |
| API | Node.js 24, Express 5, TypeScript, zod, node-postgres, ioredis |
| Model service | Python 3.12, FastAPI, pydantic |
| Ingestion | Python 3.12, psycopg 3 (COPY bulk loading) |
| Database | PostgreSQL 17 |
| Cache | Redis 7 |
| Frontend | React 19, Vite, Recharts, Leaflet (react-leaflet) |
| Testing | Vitest, Supertest, pytest |
| Infrastructure | Docker, Docker Compose, GitHub Actions CI |

## Features

- REST API with request validation, structured errors and a `/health` endpoint that reports Postgres, Redis and the model service separately
- Forecast orchestration: history lookup → model service → bulk upsert of predictions → cache invalidation
- Redis-cached prediction reads (`x-cache: HIT/MISS` header)
- Model registry with a pluggable `Forecaster` interface and a seasonal-average baseline (same weekday and time of day)
- Walk-forward backtesting with no look-ahead leakage
- Ingestion pipeline with pluggable data sources, per-reason rejection counts, idempotent re-runs and an audit table of every run
- Database schema for sensors, readings, model versions, predictions and ingestion runs, with constraints that reject physically impossible values
- Dashboard with a sensor map, actual-vs-predicted chart, horizon and time-window controls, and live error metrics (light and dark mode)

## Project structure

```
db/migrations/      PostgreSQL schema
services/api/       Express + TypeScript REST API
services/ml/        FastAPI model service, models, backtesting
services/ingest/    Data sources, validation, bulk loading
web/                React dashboard
.github/workflows/  CI
docker-compose.yml  Local stack
```

## Getting started

Requires Docker and Node.js 24.

Start Postgres, Redis, the model service and the API:

```bash
docker compose up -d --build
```

Load four weeks of readings:

```bash
docker compose run --rm ingest --source synthetic --days 28
```

Start the dashboard:

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173, pick a sensor on the map and click **Generate forecast**.

> The included `synthetic` source generates realistic rush-hour patterns for five Los Angeles freeway locations, including occasional faulty readings, so the whole stack can run locally without credentials. It is for development only. Real feeds plug in by implementing the `Source` interface in `services/ingest/ingest/sources/`.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Status of Postgres, Redis and the model service |
| GET | `/api/sensors` | All sensors |
| GET | `/api/sensors/:id` | One sensor |
| GET | `/api/sensors/:id/readings?hours=24` | Recent readings, oldest first |
| GET | `/api/sensors/:id/predictions?hours=24&horizon=15` | Upcoming predictions (cached) |
| GET | `/api/sensors/:id/comparison?hours=24&horizon=15` | Actual vs. predicted series with MAE, RMSE and MAPE |
| POST | `/api/sensors/:id/forecast` | Generate a forecast. Body: `{ "model": "baseline", "horizonsMinutes": [15, 30, 60] }` |

The model service also exposes `GET /health`, `GET /models` and `POST /predict` on port 8000.

## Running tests

API:

```bash
cd services/api && npm install && npm test
```

Model service:

```bash
cd services/ml && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

Ingestion:

```bash
cd services/ingest && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest
```

CI runs all three test suites, type-checks and builds the frontend, and builds every Docker image on each push.
