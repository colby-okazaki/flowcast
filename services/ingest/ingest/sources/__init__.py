from .base import Source
from .synthetic import SyntheticSource
from .webtris import WebTrisSource

SOURCES: dict[str, type] = {"synthetic": SyntheticSource, "webtris": WebTrisSource}


def get_source(name: str, **kwargs) -> Source:
    """Look up a data source by name."""
    if name not in SOURCES:
        raise ValueError(f"Unknown source '{name}'. Available: {', '.join(sorted(SOURCES))}")
    return SOURCES[name](**kwargs)


__all__ = ["SOURCES", "Source", "SyntheticSource", "WebTrisSource", "get_source"]
