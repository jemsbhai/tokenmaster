"""tokenmaster: core context-budget metering and decision engine for LLM applications.

Pre-release: the data model and Meter computation implement docs/core-api.md
(contract 0.1). Registry, events, advisor policies, and the fidelity protocol
land in subsequent versions; the public surface may still shift before 0.1.0.
"""

from .meter import Meter
from .registry import Registry, UnknownModelError, default_registry, get_profile
from .types import (
    SCHEMA_VERSION,
    Breakdown,
    CacheState,
    CalibrationRecord,
    EtaEstimate,
    MeterState,
    ModelProfile,
    Pricing,
    TurnUsage,
    UsageSource,
    Zone,
)

__version__ = "0.0.1"

__all__ = [
    "Meter",
    "Registry",
    "UnknownModelError",
    "default_registry",
    "get_profile",
    "SCHEMA_VERSION",
    "Breakdown",
    "CacheState",
    "CalibrationRecord",
    "EtaEstimate",
    "MeterState",
    "ModelProfile",
    "Pricing",
    "TurnUsage",
    "UsageSource",
    "Zone",
    "about",
    "__version__",
]


def about() -> dict:
    """Return basic project metadata."""
    return {
        "name": "tokenmaster",
        "version": __version__,
        "summary": (
            "Core context-budget metering and decision engine for "
            "LLM applications."
        ),
        "companion": "ctxmaster (visualization layer)",
        "repository": "https://github.com/jemsbhai/tokenmaster",
        "status": "pre-release",
    }
