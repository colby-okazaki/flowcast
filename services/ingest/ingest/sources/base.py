from __future__ import annotations

from datetime import datetime
from typing import Iterator, Protocol

from ..records import ReadingRecord, SensorRecord


class Source(Protocol):
    """A traffic data provider. Implement this once per real-world feed."""

    name: str

    def sensors(self) -> list[SensorRecord]: ...

    def readings(self, start: datetime, end: datetime) -> Iterator[ReadingRecord]:
        """Yield raw readings in [start, end). May contain bad rows; validation happens downstream."""
        ...
