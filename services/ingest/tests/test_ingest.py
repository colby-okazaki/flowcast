from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from ingest.main import parse_args, run
from ingest.records import ReadingRecord
from ingest.sources import SyntheticSource, get_source
from ingest.validate import validate_readings

T0 = datetime(2026, 11, 23, 8, 0, tzinfo=timezone.utc)


def reading(**overrides):
    base = dict(sensor_id="s", observed_at=T0, flow_vph=1200, speed_mph=55.0, occupancy=0.1)
    base.update(overrides)
    return ReadingRecord(**base)


class TestValidation:
    def test_accepts_clean_rows(self):
        report = validate_readings([reading()], known_sensors={"s"})
        assert len(report.valid) == 1
        assert report.rejected_total == 0

    def test_rejects_each_fault_with_a_reason(self):
        rows = [
            reading(sensor_id="ghost"),
            reading(observed_at=None),
            reading(observed_at=T0.replace(tzinfo=None)),
            reading(flow_vph=None),
            reading(flow_vph=-1),
            reading(flow_vph=10_000),
            reading(speed_mph=250),
            reading(occupancy=1.7),
        ]
        report = validate_readings(rows, known_sensors={"s"}, lanes={"s": 2})
        assert report.valid == []
        assert set(report.rejected) == {
            "unknown_sensor",
            "missing_timestamp",
            "naive_timestamp",
            "missing_flow",
            "negative_flow",
            "flow_above_capacity",
            "impossible_speed",
            "bad_occupancy",
        }

    def test_drops_duplicate_keys(self):
        report = validate_readings([reading(), reading(flow_vph=999)], known_sensors={"s"})
        assert len(report.valid) == 1
        assert report.rejected["duplicate"] == 1


class TestSyntheticSource:
    def test_is_deterministic_and_covers_every_interval(self):
        a = list(SyntheticSource(seed=1).readings(T0, T0 + timedelta(hours=1)))
        b = list(SyntheticSource(seed=1).readings(T0, T0 + timedelta(hours=1)))
        assert a == b
        assert len(a) == len(SyntheticSource().sensors()) * 12

    def test_weekday_rush_hour_exceeds_overnight(self):
        src = SyntheticSource(bad_row_rate=0)
        monday = datetime(2026, 11, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
        night = [r.flow_vph for r in src.readings(monday + timedelta(hours=3), monday + timedelta(hours=4))]
        rush = [r.flow_vph for r in src.readings(monday + timedelta(hours=17), monday + timedelta(hours=18))]
        assert sum(rush) / len(rush) > 2 * sum(night) / len(night)

    def test_injected_faults_are_all_caught(self):
        src = SyntheticSource(seed=7, bad_row_rate=0.2)
        sensors = src.sensors()
        rows = list(src.readings(T0, T0 + timedelta(days=1)))
        report = validate_readings(rows, {s.id for s in sensors}, {s.id: s.lanes for s in sensors})
        assert report.rejected_total > 0
        assert len(report.valid) + report.rejected_total == len(rows)

    def test_unknown_source_name(self):
        try:
            get_source("nope")
        except ValueError as e:
            assert "synthetic" in str(e)
        else:
            raise AssertionError("expected ValueError")


def test_dry_run_needs_no_database(capsys):
    assert run(parse_args(["--days", "1", "--dry-run"])) == 0
    assert "valid" in capsys.readouterr().out
