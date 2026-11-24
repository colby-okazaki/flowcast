from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

from .sources import get_source
from .validate import validate_readings


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Ingest traffic readings into FlowCast")
    p.add_argument("--source", default="synthetic")
    p.add_argument("--days", type=int, default=14, help="how many days back from now to ingest")
    p.add_argument("--dry-run", action="store_true", help="validate only; do not write to the database")
    p.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    return p.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    source = get_source(args.source)
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    end -= timedelta(minutes=end.minute % 5)
    start = end - timedelta(days=args.days)

    sensors = source.sensors()
    report = validate_readings(
        source.readings(start, end),
        known_sensors={s.id for s in sensors},
        lanes={s.id: s.lanes for s in sensors},
    )
    print(f"[{source.name}] {len(report.valid)} valid, {report.rejected_total} rejected {dict(report.rejected)}")

    if args.dry_run:
        return 0
    if not args.database_url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    import psycopg  # imported lazily so --dry-run and tests need no database driver

    from . import db

    with psycopg.connect(args.database_url) as conn:
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


def main() -> None:
    sys.exit(run(parse_args()))


if __name__ == "__main__":
    main()
