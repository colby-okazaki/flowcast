"""Runs against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is set (CI sets it).

WARNING: drops and recreates the `public` schema of the target database.
"""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from ingest.records import ReadingRecord, SensorRecord

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL not set")

MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "migrations"
T0 = datetime(2026, 6, 1, 7, 0, tzinfo=timezone.utc)
SENSOR = SensorRecord("webtris-1", "M4 Westbound (1A)", "M4", "W", 51.49, -0.45, None, "webtris")


@pytest.fixture()
def conn():
    import psycopg

    with psycopg.connect(DATABASE_URL) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        for sql in sorted(MIGRATIONS.glob("*.sql")):
            c.execute(sql.read_text())
        c.commit()
        yield c


def readings(n: int, start: datetime = T0) -> list[ReadingRecord]:
    return [ReadingRecord("webtris-1", start + timedelta(minutes=15 * i), 1000 + i, 60.0, None) for i in range(n)]


def test_insert_is_idempotent_and_tracks_latest_reading(conn):
    from ingest import db

    db.upsert_sensors(conn, [SENSOR])
    assert db.insert_readings(conn, readings(8)) == 8
    conn.commit()
    # Re-running an overlapping window inserts only the new rows.
    assert db.insert_readings(conn, readings(12)) == 4
    conn.commit()

    assert db.latest_reading_time(conn, "webtris") == T0 + timedelta(minutes=15 * 11)
    assert db.latest_reading_time(conn, "synthetic") is None


def test_sensor_upsert_updates_metadata(conn):
    from ingest import db

    db.upsert_sensors(conn, [SENSOR])
    db.upsert_sensors(conn, [SensorRecord(**{**SENSOR.__dict__, "name": "Renamed"})])
    conn.commit()
    (name,) = conn.execute("SELECT name FROM sensors WHERE id = 'webtris-1'").fetchone()
    assert name == "Renamed"


def test_ingestion_runs_are_audited(conn):
    from ingest import db

    run_id = db.start_run(conn, "webtris")
    db.finish_run(conn, run_id, status="succeeded", inserted=10, rejected=2)
    status, inserted, rejected, finished = conn.execute(
        "SELECT status, rows_inserted, rows_rejected, finished_at FROM ingestion_runs WHERE id = %s", (run_id,)
    ).fetchone()
    assert (status, inserted, rejected) == ("succeeded", 10, 2)
    assert finished is not None


def test_schema_rejects_impossible_values(conn):
    import psycopg

    from ingest import db

    db.upsert_sensors(conn, [SENSOR])
    conn.commit()
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO readings (sensor_id, observed_at, flow_vph, speed_mph) VALUES ('webtris-1', now(), 100, 500)"
        )
    conn.rollback()
