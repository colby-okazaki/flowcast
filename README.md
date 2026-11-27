# FlowCast

**Short-term traffic flow forecasting for road sensors.**

Traffic on a motorway follows strong daily and weekly patterns, but the exact flow 15, 30 or 60 minutes from now still depends on what is happening right now. FlowCast collects real readings from road sensors (vehicles per hour and average speed), stores them, and forecasts near-future traffic flow for each sensor. A dashboard shows every sensor on a map and compares what the model predicted against what actually happened, with error metrics, so you can see how good the forecasts really are.

It currently tracks 12 loop-detector sites on six motorways around London (M1, M3, M4, M11, M23, M40), using open data from National Highways.

The project is built as a set of small services rather than a single script, so each part — ingestion, storage, model serving, API and UI — can be developed, tested and scaled on its own.

## How it works

1. **Ingest.** A scheduled worker pulls new 15-minute readings every 6 hours, validates every row (missing values, impossible speeds, negative flow, duplicates, unknown sensors), and bulk-loads the clean rows into PostgreSQL. Runs are incremental — each one starts just before the newest stored reading — and every run is recorded with how many rows were inserted and rejected, and why.
2. **Forecast.** When a forecast is requested, the API gathers the sensor's recent history and sends it to the model service, which returns predictions for each horizon (for example 15, 30 and 60 minutes ahead).
3. **Store and serve.** Predictions are saved with the model version that produced them, so results stay traceable when models change. Recent predictions are cached in Redis and the cache is cleared whenever a new forecast is written.
4. **Evaluate.** A backtest replays the model over a past window, forecasting at every 15-minute step using only data from before that step, and stores those predictions. The dashboard then reports MAE, RMSE and MAPE on actual vs. predicted flow.

Public traffic data is published with a delay of several months, so every time window is anchored at each sensor's newest reading ("as of" time) rather than at the current clock time.

## Architecture

```
                ┌──────────────┐
  WebTRIS API → │ ingest       │──COPY──┐
   (every 6 h)  │ (Python)     │        ▼
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
- Backtest backfill that replays a model over up to two weeks of history with no look-ahead leakage
- Ingestion pipeline with pluggable data sources, retries with backoff, incremental runs, per-reason rejection counts, idempotent re-runs and an audit table of every run
- Database schema for sensors, readings, model versions, predictions and ingestion runs, with constraints that reject physically impossible values
- Dashboard with a sensor map, actual-vs-predicted chart in each sensor's local time, horizon and time-window controls, and live error metrics (light and dark mode)
- Unit tests plus integration tests that run against a real PostgreSQL in CI

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

Start Postgres, Redis, the model service, the API and the ingestion scheduler:

```bash
docker compose up -d --build
```

The scheduler's first run backfills about three months of readings (around 100,000 rows), which takes a few minutes. Follow it with:

```bash
docker compose logs -f ingest-scheduler
```

Start the dashboard:

```bash
cd web && npm install && npm run dev
```

Open http://localhost:5173, pick a sensor on the map, click **Backtest window** to score the model over that period, or **Forecast next hour** to forecast forward from the newest reading.

To run a one-off ingestion instead of waiting for the scheduler:

```bash
docker compose run --rm ingest --source webtris --incremental
```

## Data sources

| Source | Description |
| --- | --- |
| `webtris` (default) | [National Highways WebTRIS](https://webtris.nationalhighways.co.uk/api/swagger/ui/index): 15-minute traffic counts and average speeds from motorway loop detectors in England. No API key required. Data is published several months after it is recorded. Contains public sector information licensed under the Open Government Licence v3.0. |
| `synthetic` | Generated rush-hour patterns for five Los Angeles freeway locations, with injected sensor faults. For offline development and tests only. |

New sources plug in by implementing the `Source` interface in `services/ingest/ingest/sources/`.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Status of Postgres, Redis and the model service |
| GET | `/api/sensors` | All sensors, each with `latestReadingAt` |
| GET | `/api/sensors/:id` | One sensor |
| GET | `/api/sensors/:id/readings?hours=24` | Readings in the last `hours` before the newest reading, oldest first |
| GET | `/api/sensors/:id/predictions?hours=24&horizon=15` | Predictions after the newest reading (cached) |
| GET | `/api/sensors/:id/comparison?hours=24&horizon=15` | Actual vs. predicted series with MAE, RMSE and MAPE |
| POST | `/api/sensors/:id/forecast` | Forecast forward from the newest reading. Body: `{ "model": "baseline", "horizonsMinutes": [15, 30, 60] }` |
| POST | `/api/sensors/:id/backfill` | Backtest over past data. Body: `{ "hours": 168, "horizonsMinutes": [15, 30, 60], "stepMinutes": 15 }` |

Responses that depend on time include an `asOf` field with the sensor's newest reading. The model service also exposes `GET /health`, `GET /models`, `POST /predict` and `POST /predict/backfill` on port 8000.

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

Integration tests for the API and ingestion run against a real PostgreSQL when `TEST_DATABASE_URL` is set, and are skipped otherwise. They drop and recreate the `public` schema, so point them at a throwaway database:

```bash
docker run -d --name flowcast-testdb -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 15433:5432 postgres:17
```

```bash
export TEST_DATABASE_URL=postgresql://test:test@localhost:15433/test
```

CI runs all three test suites with a PostgreSQL service container, type-checks and builds the frontend, and builds every Docker image on each push.
