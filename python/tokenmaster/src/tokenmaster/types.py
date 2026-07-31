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
class PricingScope:
    """Where a provider's pricing schedule applies.

    ``basis`` names the quantity used to select a tier.  The first bundled
    schedule uses ``request_input_tokens``: uncached input, cache reads, and
    cache writes are all input categories and therefore all participate in
    the threshold.
    """

    service_tier: str = "standard"
    region: str = "global"
    basis: str = "request_input_tokens"
    unpriced_usage_categories: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("service_tier", "region", "basis"):
            if not getattr(self, name).strip():
                raise ValueError(f"{name} must be non-empty")
        categories = tuple(self.unpriced_usage_categories)
        allowed = {
            "input_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "output_tokens",
            "reasoning_tokens",
        }
        if len(set(categories)) != len(categories):
            raise ValueError("unpriced usage categories must be unique")
        if any(category not in allowed for category in categories):
            raise ValueError("unpriced usage category is unsupported")
        object.__setattr__(self, "unpriced_usage_categories", categories)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "service_tier": self.service_tier,
            "region": self.region,
            "basis": self.basis,
        }
        if self.unpriced_usage_categories:
            result["unpriced_usage_categories"] = list(
                self.unpriced_usage_categories
            )
        return result

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PricingScope":
        raw_unpriced = d.get("unpriced_usage_categories", ())
        if not isinstance(raw_unpriced, (list, tuple)):
            raise ValueError("unpriced_usage_categories must be an array")
        return cls(
            service_tier=str(d.get("service_tier", "standard")),
            region=str(d.get("region", "global")),
            basis=str(d.get("basis", "request_input_tokens")),
            unpriced_usage_categories=tuple(str(value) for value in raw_unpriced),
        )


@dataclass(frozen=True)
class PricingTier:
    """One inclusive input-token threshold and the prices it activates."""

    min_input_tokens: int
    pricing: Pricing

    def __post_init__(self) -> None:
        if self.min_input_tokens < 0:
            raise ValueError("min_input_tokens must be non-negative")

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_input_tokens": self.min_input_tokens,
            "pricing": self.pricing.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PricingTier":
        pricing = d.get("pricing")
        if not isinstance(pricing, Mapping):
            raise ValueError("pricing tier requires a pricing object")
        return cls(
            min_input_tokens=int(d["min_input_tokens"]),
            pricing=Pricing.from_dict(pricing),
        )


@dataclass(frozen=True)
class PricingSchedule:
    """A backward-compatible flat price plus optional inclusive tiers."""

    base: Pricing
    tiers: tuple[PricingTier, ...] = ()
    scope: PricingScope = field(default_factory=PricingScope)

    def __post_init__(self) -> None:
        tiers = tuple(sorted(self.tiers, key=lambda tier: tier.min_input_tokens))
        if len({tier.min_input_tokens for tier in tiers}) != len(tiers):
            raise ValueError("pricing tier thresholds must be unique")
        if any(tier.pricing.currency != self.base.currency for tier in tiers):
            raise ValueError("all pricing tiers must use the base currency")
        if self.scope.basis != "request_input_tokens":
            raise ValueError("unsupported pricing scope basis")
        object.__setattr__(self, "tiers", tiers)

    def price_for(self, input_tokens: int) -> tuple[Pricing, int | None]:
        """Return the price and selected inclusive tier threshold."""
        if input_tokens < 0:
            raise ValueError("input_tokens must be non-negative")
        selected = self.base
        selected_min: int | None = None
        for tier in self.tiers:
            if input_tokens < tier.min_input_tokens:
                break
            selected = tier.pricing
            selected_min = tier.min_input_tokens
        return selected, selected_min

    def to_dict(self) -> dict[str, Any]:
        return {
            "base": self.base.to_dict(),
            "tiers": [tier.to_dict() for tier in self.tiers],
            "scope": self.scope.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "PricingSchedule":
        base = d.get("base")
        if not isinstance(base, Mapping):
            raise ValueError("pricing schedule requires a base pricing object")
        raw_tiers = d.get("tiers", ())
        if not isinstance(raw_tiers, (list, tuple)):
            raise ValueError("pricing schedule tiers must be an array")
        raw_scope = d.get("scope", {})
        if not isinstance(raw_scope, Mapping):
            raise ValueError("pricing schedule scope must be an object")
        return cls(
            base=Pricing.from_dict(base),
            tiers=tuple(PricingTier.from_dict(tier) for tier in raw_tiers),
            scope=PricingScope.from_dict(raw_scope),
        )


@dataclass(frozen=True)
class CostQuote:
    """A priced, exclusive ``TurnUsage`` with tier provenance."""

    model_id: str
    tier_basis_tokens: int
    tier_min_input_tokens: int | None
    pricing: Pricing
    input_cost: float
    cache_read_cost: float
    cache_write_cost: float
    output_cost: float
    reasoning_cost: float
    total_cost: float
    currency: str
    as_of: str | None
    source: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "tier_basis_tokens": self.tier_basis_tokens,
            "tier_min_input_tokens": self.tier_min_input_tokens,
            "pricing": self.pricing.to_dict(),
            "input_cost": self.input_cost,
            "cache_read_cost": self.cache_read_cost,
            "cache_write_cost": self.cache_write_cost,
            "output_cost": self.output_cost,
            "reasoning_cost": self.reasoning_cost,
            "total_cost": self.total_cost,
            "currency": self.currency,
            "as_of": self.as_of,
            "source": self.source,
        }


@dataclass(frozen=True)
class CostEstimate:
    """Conservative request-cost reservation with explicit assumptions."""

    model_id: str
    tier_basis_tokens: int
    tier_min_input_tokens: int | None
    pricing: Pricing
    input_tokens: int
    reserved_output_tokens: int
    input_rate_kind: str
    input_rate: float
    output_rate: float
    input_cost: float
    output_cost: float
    total_cost: float
    currency: str
    as_of: str | None
    source: str
    conservative: bool
    assumptions: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_id": self.model_id,
            "tier_basis_tokens": self.tier_basis_tokens,
            "tier_min_input_tokens": self.tier_min_input_tokens,
            "pricing": self.pricing.to_dict(),
            "input_tokens": self.input_tokens,
            "reserved_output_tokens": self.reserved_output_tokens,
            "input_rate_kind": self.input_rate_kind,
            "input_rate": self.input_rate,
            "output_rate": self.output_rate,
            "input_cost": self.input_cost,
            "output_cost": self.output_cost,
            "total_cost": self.total_cost,
            "currency": self.currency,
            "as_of": self.as_of,
            "source": self.source,
            "conservative": self.conservative,
            "assumptions": list(self.assumptions),
        }


@dataclass(frozen=True)
class LimitCheck:
    """Result of validating a request against one model capacity."""

    model_id: str
    capacity_kind: str
    capacity: int
    input_tokens: int
    requested_output_tokens: int | None
    reserved_output_tokens: int
    context_output_tokens: int
    context_tokens: int
    max_input_tokens: int
    max_output_tokens: int | None
    input_exceeded: bool
    context_exceeded: bool
    output_exceeded: bool
    allowed: bool
    violations: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["violations"] = list(self.violations)
        return d


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
