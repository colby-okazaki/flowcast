"""National Highways WebTRIS: real traffic counts from England's motorway loop detectors.

API docs: https://webtris.nationalhighways.co.uk/api/swagger/ui/index
No API key is required. Data is published in 15-minute intervals with a lag of
several months, so the newest readings are typically from a few months ago.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterator
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from ..records import ReadingRecord, SensorRecord

BASE_URL = "https://webtris.nationalhighways.co.uk/api/v1.0"
UK_TZ = ZoneInfo("Europe/London")
INTERVAL = timedelta(minutes=15)

# One pair of sites (both directions) on each of six motorways around London.
# Chosen for near-complete coverage in Apr-Jun 2026; many nearby sites report only blank volumes.
DEFAULT_SITE_IDS = [
    "19667", "19695",  # M4 near Heathrow
    "1430", "2615",    # M1 near Watford
    "9717", "4087",    # M40 near Beaconsfield
    "14496", "14463",  # M3 near Sunbury
    "1848", "3798",    # M11 near Loughton
    "18563", "18576",  # M23 near Gatwick
]

_DIRECTIONS = {"Northbound": "N", "Southbound": "S", "Eastbound": "E", "Westbound": "W"}


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


HttpGet = Callable[[str], HttpResponse]


def urllib_get(url: str, timeout: float = 60, retries: int = 3) -> HttpResponse:
    """GET with retries and exponential backoff on network errors and 5xx responses."""
    request = urllib.request.Request(url, headers={"User-Agent": "flowcast-ingest", "Accept": "application/json"})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as res:
                return HttpResponse(res.status, res.read())
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(2**attempt)
    raise AssertionError("unreachable")


def _ddmmyyyy(d: date) -> str:
    return d.strftime("%d%m%Y")


def _float_or_none(value: str | None) -> float | None:
    if value is None or value.strip() == "":
        return None
    return float(value)


def parse_site(raw: dict) -> SensorRecord:
    """Turn a WebTRIS site into a sensor, e.g. "M4/2246A" + "...; Westbound" -> "M4 Westbound (2246A)"."""
    name: str = raw["Name"]
    road, _, marker = name.partition("/")
    direction_word = next((w for w in _DIRECTIONS if w in raw.get("Description", "")), None)
    pretty = f"{road} {direction_word} ({marker})" if direction_word else name
    return SensorRecord(
        id=f"webtris-{raw['Id']}",
        name=pretty,
        road=road or None,
        direction=_DIRECTIONS.get(direction_word) if direction_word else None,
        latitude=float(raw["Latitude"]),
        longitude=float(raw["Longitude"]),
        lanes=None,  # WebTRIS does not publish lane counts
        source="webtris",
    )


def parse_report_row(sensor_id: str, row: dict) -> ReadingRecord:
    """Convert one 15-minute report row into a reading timestamped at the interval start (UTC)."""
    report_day = datetime.fromisoformat(row["Report Date"]).date()
    hh, mm, *_ = (int(p) for p in row["Time Period Ending"].split(":"))
    # "Time Period Ending" 00:14 means the interval 00:00-00:14:59 local time.
    local_start = datetime(report_day.year, report_day.month, report_day.day, hh, mm, tzinfo=UK_TZ) - timedelta(
        minutes=14
    )
    volume = _float_or_none(row.get("Total Volume"))
    return ReadingRecord(
        sensor_id=sensor_id,
        observed_at=local_start.astimezone(timezone.utc),
        flow_vph=volume * 4 if volume is not None else None,  # 15-minute count -> vehicles per hour
        speed_mph=_float_or_none(row.get("Avg mph")),
        occupancy=None,  # not published by WebTRIS
    )


class WebTrisSource:
    name = "webtris"
    default_lookback_days = 240  # covers the publication lag plus ~3 months of history

    def __init__(
        self,
        site_ids: list[str] | None = None,
        http_get: HttpGet | None = None,
        page_size: int = 10_000,
        chunk_days: int = 31,
        pause_seconds: float = 0.2,
    ) -> None:
        self.site_ids = site_ids or DEFAULT_SITE_IDS
        self._get = http_get or urllib_get
        self.page_size = page_size
        self.chunk_days = chunk_days
        self.pause_seconds = pause_seconds
        self._sensors: list[SensorRecord] | None = None

    def _get_json(self, path: str, params: dict[str, object] | None = None) -> dict | None:
        url = f"{BASE_URL}/{path}" + (f"?{urlencode(params)}" if params else "")
        res = self._get(url)
        if self.pause_seconds:
            time.sleep(self.pause_seconds)  # be polite to a free public API
        if res.status == 204 or not res.body:
            return None
        return json.loads(res.body)

    def sensors(self) -> list[SensorRecord]:
        if self._sensors is None:
            out = []
            for site_id in self.site_ids:
                body = self._get_json(f"sites/{site_id}")
                for raw in (body or {}).get("sites", []):
                    out.append(parse_site(raw))
            self._sensors = out
        return self._sensors

    def readings(self, start: datetime, end: datetime) -> Iterator[ReadingRecord]:
        first_day = start.astimezone(UK_TZ).date()
        last_day = end.astimezone(UK_TZ).date()
        for sensor in self.sensors():
            site_id = sensor.id.removeprefix("webtris-")
            day = first_day
            while day <= last_day:
                chunk_end = min(day + timedelta(days=self.chunk_days - 1), last_day)
                for row in self._report_rows(site_id, day, chunk_end):
                    reading = parse_report_row(sensor.id, row)
                    if reading.observed_at is not None and start <= reading.observed_at < end:
                        yield reading
                day = chunk_end + timedelta(days=1)

    def _report_rows(self, site_id: str, start_day: date, end_day: date) -> Iterator[dict]:
        page = 1
        while True:
            body = self._get_json(
                "reports/Daily",
                {
                    "sites": site_id,
                    "start_date": _ddmmyyyy(start_day),
                    "end_date": _ddmmyyyy(end_day),
                    "page": page,
                    "page_size": self.page_size,
                },
            )
            if body is None:
                return
            yield from body.get("Rows", [])
            links = body.get("Header", {}).get("links", [])
            if not any(link.get("rel") == "nextPage" for link in links):
                return
            page += 1
