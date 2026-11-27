from __future__ import annotations

from datetime import datetime
from typing import Sequence

import psycopg

from .records import ReadingRecord, SensorRecord


def upsert_sensors(conn: psycopg.Connection, sensors: Sequence[SensorRecord]) -> None:
    with conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO sensors (id, name, road, direction, latitude, longitude, lanes, source)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, road = EXCLUDED.road, direction = EXCLUDED.direction,
                latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                lanes = EXCLUDED.lanes, source = EXCLUDED.source
            """,
            [(s.id, s.name, s.road, s.direction, s.latitude, s.longitude, s.lanes, s.source) for s in sensors],
        )


def insert_readings(conn: psycopg.Connection, readings: Sequence[ReadingRecord]) -> int:
    """COPY into a temp table, then merge. Much faster than row-by-row INSERTs and idempotent on re-runs."""
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TEMP TABLE staging_readings (LIKE readings INCLUDING DEFAULTS) ON COMMIT DROP
            """
        )
        with cur.copy(
            "COPY staging_readings (sensor_id, observed_at, flow_vph, speed_mph, occupancy) FROM STDIN"
        ) as copy:
            for r in readings:
                copy.write_row((r.sensor_id, r.observed_at, round(r.flow_vph), r.speed_mph, r.occupancy))
        cur.execute(
            """
            INSERT INTO readings SELECT * FROM staging_readings
            ON CONFLICT (sensor_id, observed_at) DO NOTHING
            """
        )
        return cur.rowcount


def latest_reading_time(conn: psycopg.Connection, source: str) -> datetime | None:
    """Newest reading stored for any sensor from `source`, used as the start of incremental runs."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT max(r.observed_at)
              FROM readings r JOIN sensors s ON s.id = r.sensor_id
             WHERE s.source = %s
            """,
            (source,),
        )
        (latest,) = cur.fetchone()
    return latest


def start_run(conn: psycopg.Connection, source: str) -> int:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO ingestion_runs (source) VALUES (%s) RETURNING id", (source,))
        (run_id,) = cur.fetchone()
    conn.commit()
    return run_id


def finish_run(
    conn: psycopg.Connection, run_id: int, *, status: str, inserted: int = 0, rejected: int = 0, error: str | None = None
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ingestion_runs
               SET finished_at = now(), status = %s, rows_inserted = %s, rows_rejected = %s, error = %s
             WHERE id = %s
            """,
            (status, inserted, rejected, error, run_id),
        )
    conn.commit()
