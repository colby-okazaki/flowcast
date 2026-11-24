from .base import Source
from .synthetic import SyntheticSource


def get_source(name: str, **kwargs) -> Source:
    """Look up a data source by name. Add real sources (PeMS, WebTRIS, ...) here."""
    sources = {"synthetic": SyntheticSource}
    if name not in sources:
        raise ValueError(f"Unknown source '{name}'. Available: {', '.join(sorted(sources))}")
    return sources[name](**kwargs)


__all__ = ["Source", "SyntheticSource", "get_source"]
