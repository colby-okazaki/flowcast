from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

from .sources import SOURCES, get_source
from .validate import validate_readings

# Re-fetch a little before the newest stored reading so late-arriving corrections are picked up.
INCREMENTAL_OVERLAP = timedelta(days=1)


def parse_duration(text: str) -> timedelta:
    """Parse "30m", "6h" or "1d"."""
    match = re.fullmatch(r"(\d+)([mhd])", text.strip())
    if not match:
        raise argparse.ArgumentTypeError(f"invalid duration '{text}', expected e.g. 30m, 6h, 1d")
    value, unit = int(match.group(1)), match.group(2)
    return {"m": timedelta(minutes=value), "h": timedelta(hours=value), "d": timedelta(days=value)}[unit]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Ingest traffic readings into FlowCast")
    p.add_argument("--source", default="synthetic", choices=sorted(SOURCES))
    p.add_argument("--days", type=int, help="how many days back from now to ingest (default: per source)")
    p.add_argument(
        "--incremental",
        action="store_true",
        help="start from the newest reading already stored for this source; falls back to --days when empty",
    )
    p.add_argument("--every", type=parse_duration, help="keep running, ingesting once per interval (e.g. 6h)")
    p.add_argument("--dry-run", action="store_true", help="validate only; do not write to the database")
    p.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    return p.parse_args(argv)


def resolve_window(
    now: datetime, lookback_days: int, latest_stored: datetime | None, incremental: bool
) -> tuple[datetime, datetime]:
    end = now.replace(second=0, microsecond=0)
    end -= timedelta(minutes=end.minute % 5)
    start = end - timedelta(days=lookback_days)
    if incremental and latest_stored is not None:
        start = max(start, latest_stored - INCREMENTAL_OVERLAP)
    return start, end


def run_once(args: argparse.Namespace) -> int:
    source = get_source(args.source)
    lookback_days = args.days or source.default_lookback_days

    if not args.dry_run and not args.database_url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    conn = None
    latest = None
    if not args.dry_run:
        import psycopg  # imported lazily so --dry-run and tests need no database driver

        from . import db

        conn = psycopg.connect(args.database_url)
        if args.incremental:
            latest = db.latest_reading_time(conn, source.name)

    try:
        start, end = resolve_window(datetime.now(timezone.utc), lookback_days, latest, args.incremental)
        print(f"[{source.name}] window {start:%Y-%m-%d %H:%M} -> {end:%Y-%m-%d %H:%M} UTC")

        sensors = source.sensors()
        report = validate_readings(
            source.readings(start, end),
            known_sensors={s.id for s in sensors},
            lanes={s.id: s.lanes for s in sensors},
        )
        print(f"[{source.name}] {len(report.valid)} valid, {report.rejected_total} rejected {dict(report.rejected)}")
        if conn is None:
            return 0

        run_id = db.start_run(conn, source.name)
        try:
            db.upsert_sensors(conn, sensors)
            inserted = db.insert_readings(conn, report.valid)
            conn.commit()
        except Exception as exc:
            conn.rollback()
            db.finish_run(conn, run_id, status="failed", rejected=report.rejected_total, error=str(exc))
            raise
        db.finish_run(conn, run_id, status="succeeded", inserted=inserted, rejected=report.rejected_total)
        print(f"[{source.name}] inserted {inserted} new rows (run {run_id})")
        return 0
    finally:
        if conn is not None:
            conn.close()


def run(args: argparse.Namespace) -> int:
    if args.every is None:
        return run_once(args)
    # Scheduler mode: a failed run is logged and retried next interval instead of killing the loop.
    while True:
        try:
            run_once(args)
        except Exception as exc:  # noqa: BLE001
            print(f"[{args.source}] run failed: {exc}", file=sys.stderr)
        print(f"[{args.source}] next run in {args.every}")
        time.sleep(args.every.total_seconds())


def main() -> None:
    sys.exit(run(parse_args()))


if __name__ == "__main__":
    main()
