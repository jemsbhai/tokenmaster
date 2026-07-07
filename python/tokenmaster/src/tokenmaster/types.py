"""Typed data model for the tokenmaster core, per docs/core-api.md (0.1).

Standard library only. Every top-level wire type carries ``schema_version``
and serializes to plain JSON-compatible dictionaries via ``to_dict`` /
``from_dict``.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping

SCHEMA_VERSION = "0.1"


class Zone(str, Enum):
    GREEN = "green"
    CAUTION = "caution"
    CRITICAL = "critical"


class UsageSource(str, Enum):
    REPORTED = "reported"
    ESTIMATED = "estimated"
    MIXED = "mixed"


@dataclass(frozen=True)
class Pricing:
    """Per-Mtok prices, with the date they were captured."""

    input: float
    output: float
    cache_read: float = 0.0
    cache_write: float = 0.0
    currency: str = "USD"
    as_of: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Pricing":
        return cls(
            input=float(d["input"]),
            output=float(d["output"]),
            cache_read=float(d.get("cache_read", 0.0)),
            cache_write=float(d.get("cache_write", 0.0)),
            currency=str(d.get("currency", "USD")),
            as_of=d.get("as_of"),
        )


@dataclass(frozen=True)
class CalibrationRecord:
    """Measured effective capacity for one model."""

    model_id: str
    effective_context: int
    method: str
    source: str
    measured_at: str | None = None
    confidence: str | None = None
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CalibrationRecord":
        return cls(
            model_id=str(d["model_id"]),
            effective_context=int(d["effective_context"]),
            method=str(d["method"]),
            source=str(d["source"]),
            measured_at=d.get("measured_at"),
            confidence=d.get("confidence"),
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )


@dataclass(frozen=True)
class ModelProfile:
    """Identity and capacities for one model."""

    model_id: str
    provider: str
    window_nominal: int
    max_output: int | None = None
    pricing: Pricing | None = None
    tokenizer_hint: str | None = None
    effective: CalibrationRecord | None = None
    source: str = "user"
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.window_nominal <= 0:
            raise ValueError("window_nominal must be positive")
        if self.effective is not None and self.effective.effective_context <= 0:
            raise ValueError("effective_context must be positive")

    @property
    def window_effective(self) -> int:
        if self.effective is not None:
            return self.effective.effective_context
        return self.window_nominal

    @property
    def effective_source(self) -> str:
        if self.effective is not None:
            return f"calibration:{self.effective.method} ({self.effective.source})"
        return "nominal (uncalibrated)"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ModelProfile":
        return cls(
            model_id=str(d["model_id"]),
            provider=str(d["provider"]),
            window_nominal=int(d["window_nominal"]),
            max_output=(None if d.get("max_output") is None else int(d["max_output"])),
            pricing=(Pricing.from_dict(d["pricing"]) if d.get("pricing") else None),
            tokenizer_hint=d.get("tokenizer_hint"),
            effective=(
                CalibrationRecord.from_dict(d["effective"])
                if d.get("effective")
                else None
            ),
            source=str(d.get("source", "user")),
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )


@dataclass(frozen=True)
class Breakdown:
    """Optional estimated split of the standing prompt."""

    system_prompt: int = 0
    tool_schemas: int = 0
    history: int = 0
    attachments: int = 0
    query: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Breakdown":
        return cls(
            system_prompt=int(d.get("system_prompt", 0)),
            tool_schemas=int(d.get("tool_schemas", 0)),
            history=int(d.get("history", 0)),
            attachments=int(d.get("attachments", 0)),
            query=int(d.get("query", 0)),
        )


_USAGE_COUNT_FIELDS = (
    "input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
)


@dataclass(frozen=True)
class TurnUsage:
    """One normalized accounting record per model response.

    Unknown keys in ``from_dict`` input are ignored: normalization of
    provider-specific field names is an adapter's job, and the core accepts
    only the canonical shape.
    """

    turn_id: int
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    model_id: str | None = None
    timestamp: str | None = None
    breakdown: Breakdown | None = None
    source: UsageSource = UsageSource.REPORTED
    raw: dict[str, Any] | None = None
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        for name in _USAGE_COUNT_FIELDS:
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be non-negative")

    def context_total(self) -> int:
        """Context occupied after this turn: full prompt plus this response."""
        return (
            self.input_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
            + self.output_tokens
            + self.reasoning_tokens
        )

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["source"] = self.source.value
        return d

    @classmethod
    def from_dict(cls, d: Mapping[str, Any], *, turn_id: int | None = None) -> "TurnUsage":
        return cls(
            turn_id=int(d["turn_id"]) if turn_id is None else int(turn_id),
            input_tokens=int(d.get("input_tokens", 0)),
            cache_read_tokens=int(d.get("cache_read_tokens", 0)),
            cache_write_tokens=int(d.get("cache_write_tokens", 0)),
            output_tokens=int(d.get("output_tokens", 0)),
            reasoning_tokens=int(d.get("reasoning_tokens", 0)),
            model_id=d.get("model_id"),
            timestamp=d.get("timestamp"),
            breakdown=(
                Breakdown.from_dict(d["breakdown"]) if d.get("breakdown") else None
            ),
            source=UsageSource(d.get("source", "reported")),
            raw=dict(d["raw"]) if d.get("raw") else None,
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )


@dataclass(frozen=True)
class EtaEstimate:
    """Projected turns to exhaustion."""

    expected: float
    conservative: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "EtaEstimate":
        return cls(expected=float(d["expected"]), conservative=float(d["conservative"]))


@dataclass(frozen=True)
class CacheState:
    """Estimated prompt-cache condition after the latest turn."""

    stable_prefix_tokens: int
    last_cache_read: int
    last_cache_write: int

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CacheState":
        return cls(
            stable_prefix_tokens=int(d["stable_prefix_tokens"]),
            last_cache_read=int(d["last_cache_read"]),
            last_cache_write=int(d["last_cache_write"]),
        )


@dataclass(frozen=True)
class MeterState:
    """The gauge cluster. Measurement only; judgment lives in the Advisor.

    Renderable standalone by contract decision D10: no event history is
    needed to draw everything here.
    """

    model_id: str
    turns: int
    used_tokens: int
    window_nominal: int
    window_effective: int
    effective_source: str
    reserved_output: int
    headroom_nominal: int
    headroom_effective: int
    fill_nominal: float
    fill_effective: float
    velocity: float | None
    velocity_std: float | None
    eta_turns: EtaEstimate | None
    zone: Zone
    hidden_overhead: int | None
    cache: CacheState | None
    provenance: dict[str, str] = field(default_factory=dict)
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["zone"] = self.zone.value
        return d

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "MeterState":
        return cls(
            model_id=str(d["model_id"]),
            turns=int(d["turns"]),
            used_tokens=int(d["used_tokens"]),
            window_nominal=int(d["window_nominal"]),
            window_effective=int(d["window_effective"]),
            effective_source=str(d["effective_source"]),
            reserved_output=int(d["reserved_output"]),
            headroom_nominal=int(d["headroom_nominal"]),
            headroom_effective=int(d["headroom_effective"]),
            fill_nominal=float(d["fill_nominal"]),
            fill_effective=float(d["fill_effective"]),
            velocity=(None if d.get("velocity") is None else float(d["velocity"])),
            velocity_std=(
                None if d.get("velocity_std") is None else float(d["velocity_std"])
            ),
            eta_turns=(
                EtaEstimate.from_dict(d["eta_turns"]) if d.get("eta_turns") else None
            ),
            zone=Zone(d["zone"]),
            hidden_overhead=(
                None if d.get("hidden_overhead") is None else int(d["hidden_overhead"])
            ),
            cache=(CacheState.from_dict(d["cache"]) if d.get("cache") else None),
            provenance=dict(d.get("provenance", {})),
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )
