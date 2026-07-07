"""tokenmaster: core context-budget metering and decision engine for LLM applications.

0.1.x alpha: implements the core API contract (docs/core-api.md, 0.1) with
conformance vectors under spec/. The public surface may still shift before
0.2; provider adapters, tokenizer estimators, and LLM-backed probe
generators are planned but not yet included.
"""

from .advisor import (
    Action,
    CostModelPolicy,
    EffectEstimate,
    Policy,
    PredictivePolicy,
    RationaleTrace,
    Recommendation,
    TaskContext,
    TaskCriticality,
    ThresholdPolicy,
    Urgency,
)
from .events import (
    AdvisorRecommendation,
    Event,
    HandoffEvaluated,
    ModelChanged,
    TurnRecorded,
    VelocityShift,
    ZoneChanged,
    event_from_dict,
)
from .fidelity import (
    Answerer,
    ExactMatchJudge,
    FidelityReport,
    Judge,
    Probe,
    ProbeCategory,
    ProbeGenerator,
    ProbeOutcome,
    evaluate_handoff,
)
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

__version__ = "0.1.0"

__all__ = [
    "Meter",
    "Action",
    "Urgency",
    "TaskCriticality",
    "TaskContext",
    "RationaleTrace",
    "EffectEstimate",
    "Recommendation",
    "Policy",
    "ThresholdPolicy",
    "PredictivePolicy",
    "CostModelPolicy",
    "Event",
    "AdvisorRecommendation",
    "HandoffEvaluated",
    "TurnRecorded",
    "ZoneChanged",
    "VelocityShift",
    "ModelChanged",
    "event_from_dict",
    "Probe",
    "ProbeCategory",
    "ProbeOutcome",
    "FidelityReport",
    "ProbeGenerator",
    "Answerer",
    "Judge",
    "ExactMatchJudge",
    "evaluate_handoff",
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
        "status": "alpha",
    }
