-- FlowCast core schema.
-- Runs automatically on first `docker compose up` (mounted into docker-entrypoint-initdb.d).

CREATE TABLE IF NOT EXISTS sensors (
    id          TEXT PRIMARY KEY,               -- source-specific station id, e.g. "pems-400001"
    name        TEXT NOT NULL,
    road        TEXT,
    direction   TEXT CHECK (direction IN ('N', 'S', 'E', 'W')),
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    lanes       SMALLINT CHECK (lanes > 0),
    source      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per sensor per observation interval (typically 5 minutes).
CREATE TABLE IF NOT EXISTS readings (
    sensor_id    TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
    observed_at  TIMESTAMPTZ NOT NULL,
    flow_vph     INTEGER NOT NULL CHECK (flow_vph >= 0),          -- vehicles per hour
    speed_mph    REAL CHECK (speed_mph >= 0 AND speed_mph <= 120),
    occupancy    REAL CHECK (occupancy >= 0 AND occupancy <= 1),
    PRIMARY KEY (sensor_id, observed_at)
);

CREATE INDEX IF NOT EXISTS readings_observed_at_idx ON readings (observed_at);

-- Every trained model gets a row; exactly one may be active per name.
CREATE TABLE IF NOT EXISTS model_versions (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,                  -- e.g. "baseline", "ridge", "xgboost"
    version     TEXT NOT NULL,                  -- e.g. "2026-11-23T10-00"
    algorithm   TEXT NOT NULL,
    params      JSONB NOT NULL DEFAULT '{}',
    metrics     JSONB NOT NULL DEFAULT '{}',    -- backtest MAE / RMSE / MAPE per horizon
    trained_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_active   BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS model_versions_one_active
    ON model_versions (name) WHERE is_active;

CREATE TABLE IF NOT EXISTS predictions (
    id                BIGSERIAL PRIMARY KEY,
    sensor_id         TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
    model_version_id  INTEGER NOT NULL REFERENCES model_versions(id),
    made_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    target_time       TIMESTAMPTZ NOT NULL,
    horizon_minutes   INTEGER NOT NULL CHECK (horizon_minutes > 0),
    predicted_flow    REAL NOT NULL,
    UNIQUE (sensor_id, model_version_id, target_time, horizon_minutes)
);

CREATE INDEX IF NOT EXISTS predictions_sensor_target_idx ON predictions (sensor_id, target_time);

-- Audit trail for every ingestion job.
CREATE TABLE IF NOT EXISTS ingestion_runs (
    id             BIGSERIAL PRIMARY KEY,
    source         TEXT NOT NULL,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at    TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    rows_inserted  INTEGER NOT NULL DEFAULT 0,
    rows_rejected  INTEGER NOT NULL DEFAULT 0,
    error          TEXT
);

-- The baseline model is stateless, so register it up front.
INSERT INTO model_versions (name, version, algorithm, is_active)
VALUES ('baseline', 'v1', 'seasonal-average', true)
ON CONFLICT (name, version) DO NOTHING;
