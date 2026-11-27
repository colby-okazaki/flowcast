import json
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from ingest.main import INCREMENTAL_OVERLAP, parse_duration, resolve_window
from ingest.sources.webtris import HttpResponse, WebTrisSource, parse_report_row, parse_site
from ingest.validate import validate_readings

SITE = {
    "Id": "19667",
    "Name": "M4/2246A",
    "Description": "MIDAS site at M4/2246A priority 1 on link 199; GPS Ref: 1;2; Westbound",
    "Longitude": -0.4496,
    "Latitude": 51.4953,
    "Status": "Active",
}


def row(day: str, ending: str, volume: str = "300", mph: str = "62") -> dict:
    return {"Report Date": f"{day}T00:00:00", "Time Period Ending": ending, "Total Volume": volume, "Avg mph": mph}


class FakeHttp:
    """Serves canned WebTRIS responses and records every requested URL."""

    def __init__(self, pages: dict[int, list[dict]] | None = None, empty: bool = False):
        self.pages = pages or {}
        self.empty = empty
        self.urls: list[str] = []

    def __call__(self, url: str) -> HttpResponse:
        self.urls.append(url)
        parsed = urlparse(url)
        if parsed.path.endswith("/sites/19667"):
            return HttpResponse(200, json.dumps({"row_count": 1, "sites": [SITE]}).encode())
        if self.empty:
            return HttpResponse(204, b"")
        page = int(parse_qs(parsed.query)["page"][0])
        links = [{"rel": "nextPage", "href": "..."}] if page + 1 in self.pages else []
        body = {"Header": {"row_count": 0, "links": links}, "Rows": self.pages.get(page, [])}
        return HttpResponse(200, json.dumps(body).encode())


def source(http: FakeHttp, **kw) -> WebTrisSource:
    return WebTrisSource(site_ids=["19667"], http_get=http, pause_seconds=0, **kw)


class TestParsing:
    def test_site_becomes_readable_sensor(self):
        s = parse_site(SITE)
        assert s.id == "webtris-19667"
        assert s.name == "M4 Westbound (2246A)"
        assert (s.road, s.direction, s.source) == ("M4", "W", "webtris")

    def test_row_is_interval_start_in_utc_and_scaled_to_hourly_flow(self):
        # 1 June is British Summer Time (UTC+1); the 08:14 interval starts at 08:00 local = 07:00 UTC.
        r = parse_report_row("webtris-1", row("2026-06-01", "08:14:00", volume="450"))
        assert r.observed_at == datetime(2026, 6, 1, 7, 0, tzinfo=timezone.utc)
        assert r.flow_vph == 1800
        assert r.speed_mph == 62

    def test_winter_rows_are_utc_plus_zero(self):
        r = parse_report_row("webtris-1", row("2026-01-15", "00:14:00"))
        assert r.observed_at == datetime(2026, 1, 15, 0, 0, tzinfo=timezone.utc)

    def test_blank_volume_is_missing_and_rejected_by_validation(self):
        r = parse_report_row("webtris-1", row("2026-06-01", "00:14:00", volume="", mph=""))
        assert r.flow_vph is None and r.speed_mph is None
        report = validate_readings([r], known_sensors={"webtris-1"})
        assert report.rejected["missing_flow"] == 1

    def test_real_motorway_flow_passes_validation_without_lane_count(self):
        r = parse_report_row("webtris-1", row("2026-06-01", "08:14:00", volume="1600"))  # 6,400 vph
        assert len(validate_readings([r], {"webtris-1"}, {"webtris-1": None}).valid) == 1


class TestSource:
    def test_follows_pagination_and_filters_to_window(self):
        http = FakeHttp(
            pages={
                1: [row("2026-06-01", "00:14:00"), row("2026-06-01", "00:29:00")],
                2: [row("2026-06-01", "00:44:00"), row("2026-06-02", "00:14:00")],
            }
        )
        start = datetime(2026, 5, 31, 23, 15, tzinfo=timezone.utc)  # 00:15 BST on 1 June
        end = datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc)
        readings = list(source(http).readings(start, end))
        assert [r.observed_at.strftime("%H:%M") for r in readings] == ["23:15", "23:30"]
        assert sum("page=2" in u for u in http.urls) == 1

    def test_no_content_yields_nothing(self):
        http = FakeHttp(empty=True)
        start = datetime(2026, 11, 1, tzinfo=timezone.utc)
        assert list(source(http).readings(start, start + timedelta(days=2))) == []

    def test_long_windows_are_split_into_chunks(self):
        http = FakeHttp(empty=True)
        start = datetime(2026, 1, 1, 12, tzinfo=timezone.utc)
        list(source(http, chunk_days=31).readings(start, start + timedelta(days=90)))
        report_calls = [u for u in http.urls if "reports/Daily" in u]
        assert len(report_calls) == 3


class TestScheduling:
    NOW = datetime(2026, 11, 27, 12, 3, tzinfo=timezone.utc)

    def test_full_run_uses_lookback(self):
        start, end = resolve_window(self.NOW, 30, latest_stored=None, incremental=False)
        assert end == datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
        assert start == end - timedelta(days=30)

    def test_incremental_starts_just_before_newest_stored_reading(self):
        latest = datetime(2026, 6, 29, 23, 45, tzinfo=timezone.utc)
        start, _ = resolve_window(self.NOW, 240, latest_stored=latest, incremental=True)
        assert start == latest - INCREMENTAL_OVERLAP

    def test_incremental_with_empty_db_falls_back_to_lookback(self):
        start, end = resolve_window(self.NOW, 240, latest_stored=None, incremental=True)
        assert start == end - timedelta(days=240)

    def test_parse_duration(self):
        assert parse_duration("6h") == timedelta(hours=6)
        assert parse_duration("30m") == timedelta(minutes=30)
        assert parse_duration("1d") == timedelta(days=1)
