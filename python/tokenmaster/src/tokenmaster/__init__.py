"""tokenmaster: core context-budget metering and decision engine for LLM applications.

0.2 alpha: implements the stable 0.1 Meter/Event wire contract plus additive
tier-aware pricing and request-limit APIs, with conformance vectors under
spec/. Provider usage adapters, tokenizer estimators, and LLM-backed probe
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
from .registry import (
    Registry,
    UnknownModelError,
    check_request_limits,
    default_registry,
    get_pricing_schedule,
    get_profile,
    quote_estimate,
    quote_usage,
)
from .types import (
    SCHEMA_VERSION,
    Breakdown,
    CacheState,
    CalibrationRecord,
    CostEstimate,
    CostQuote,
    EtaEstimate,
    LimitCheck,
    MeterState,
    ModelProfile,
    Pricing,
    PricingSchedule,
    PricingScope,
    PricingTier,
    TurnUsage,
    UsageSource,
    Zone,
)

__version__ = "0.2.0"

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
    "get_pricing_schedule",
    "quote_usage",
    "quote_estimate",
    "check_request_limits",
    "SCHEMA_VERSION",
    "Breakdown",
    "CacheState",
    "CalibrationRecord",
    "EtaEstimate",
    "MeterState",
    "ModelProfile",
    "Pricing",
    "PricingScope",
    "PricingTier",
    "PricingSchedule",
    "CostEstimate",
    "CostQuote",
    "LimitCheck",
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
