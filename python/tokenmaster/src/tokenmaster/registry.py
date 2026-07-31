"""Bundled model registry: capacities and dated pricing, offline by design.

The snapshot ships inside the package (contract P6: nothing phones home;
refresh mechanisms will be explicit adapters). Lookup accepts canonical ids
("anthropic:claude-sonnet-4-6"), bare names ("claude-sonnet-4-6"), registered
aliases, and dated snapshot suffixes ("claude-haiku-4-5-20251001",
"openai:gpt-5.5-2026-04-14"). User-registered profiles override bundled ones.
"""

from __future__ import annotations

import difflib
import json
from importlib import resources
from typing import Any, Iterable, Literal, Mapping

from .types import (
    CostEstimate,
    CostQuote,
    LimitCheck,
    ModelProfile,
    PricingSchedule,
    PricingScope,
    PricingTier,
    TurnUsage,
)

_BUNDLE_PATH = "data/models.json"


class UnknownModelError(LookupError):
    """Raised when a model id cannot be resolved by the registry."""

    def __init__(self, model_id: str, suggestions: list[str]) -> None:
        self.model_id = model_id
        self.suggestions = suggestions
        hint = ""
        if suggestions:
            hint = " Close matches: " + ", ".join(suggestions)
        super().__init__(
            f"Unknown model {model_id!r}; not in the registry."
            + hint
            + " Register it with Registry.register(ModelProfile(...))."
        )


def _norm(s: str) -> str:
    return s.strip().lower()


def _is_dated_suffix(s: str) -> bool:
    """True for version/date tails like '20251001' or '2026-04-14'."""
    return (
        len(s) >= 4
        and any(c.isdigit() for c in s)
        and all(c.isdigit() or c in "-." for c in s)
    )


class Registry:
    """Model profiles keyed by canonical id, with alias resolution."""

    def __init__(self, snapshot_date: str | None = None) -> None:
        self.snapshot_date = snapshot_date
        self._profiles: dict[str, ModelProfile] = {}
        self._alias: dict[str, str] = {}
        self._pricing_schedules: dict[str, PricingSchedule] = {}

    # ------------------------------------------------------------------ #
    # construction

    def register(
        self, profile: ModelProfile, aliases: Iterable[str] = ()
    ) -> ModelProfile:
        """Add or override a profile and clear any previous tier schedule."""
        canonical = _norm(profile.model_id)
        self._profiles[canonical] = profile
        self._pricing_schedules.pop(canonical, None)
        self._alias[canonical] = canonical
        if ":" in canonical:
            bare = canonical.split(":", 1)[1]
            self._alias.setdefault(bare, canonical)
        for alias in aliases:
            a = _norm(alias)
            self._alias[a] = canonical
            if ":" not in a:
                self._alias.setdefault(f"{profile.provider}:{a}", canonical)
        return profile

    def register_with_schedule(
        self,
        profile: ModelProfile,
        schedule: PricingSchedule,
        aliases: Iterable[str] = (),
    ) -> ModelProfile:
        """Register a profile together with its provider pricing schedule."""
        if profile.pricing is None:
            raise ValueError("a scheduled profile requires base pricing")
        if schedule.base != profile.pricing:
            raise ValueError("pricing schedule base must equal profile.pricing")
        registered = self.register(profile, aliases=aliases)
        self._pricing_schedules[_norm(profile.model_id)] = schedule
        return registered

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Registry":
        reg = cls(snapshot_date=d.get("snapshot_date"))
        for entry in d.get("models", []):
            entry = dict(entry)
            aliases = entry.pop("aliases", [])
            raw_tiers = entry.pop("pricing_tiers", None)
            raw_scope = entry.pop("pricing_scope", None)
            profile = ModelProfile.from_dict(entry)
            if raw_tiers is None and raw_scope is None:
                reg.register(profile, aliases=aliases)
                continue
            if profile.pricing is None:
                raise ValueError("pricing tiers require base profile pricing")
            if raw_tiers is None:
                raw_tiers = []
            if not isinstance(raw_tiers, (list, tuple)):
                raise ValueError("pricing_tiers must be an array")
            if raw_scope is None:
                raw_scope = {}
            if not isinstance(raw_scope, Mapping):
                raise ValueError("pricing_scope must be an object")
            schedule = PricingSchedule(
                base=profile.pricing,
                tiers=tuple(PricingTier.from_dict(tier) for tier in raw_tiers),
                scope=PricingScope.from_dict(raw_scope),
            )
            reg.register_with_schedule(profile, schedule, aliases=aliases)
        return reg

    @classmethod
    def bundled(cls) -> "Registry":
        blob = (
            resources.files(__package__).joinpath(_BUNDLE_PATH).read_text("utf-8")
        )
        return cls.from_dict(json.loads(blob))

    # ------------------------------------------------------------------ #
    # lookup

    def get(self, model_id: str) -> ModelProfile:
        key = _norm(model_id)
        hit = self._alias.get(key)
        if hit is not None:
            return self._profiles[hit]

        # dated snapshot suffixes: longest known base wins
        best: str | None = None
        for base, canonical in self._alias.items():
            if key.startswith(base + "-") and _is_dated_suffix(key[len(base) + 1 :]):
                if best is None or len(base) > len(best):
                    best = base
        if best is not None:
            return self._profiles[self._alias[best]]

        suggestions = difflib.get_close_matches(key, self._alias.keys(), n=3)
        raise UnknownModelError(model_id, suggestions)

    def get_pricing_schedule(self, model_id: str) -> PricingSchedule | None:
        """Return tier-aware pricing, or a flat schedule for a priced model."""
        profile = self.get(model_id)
        canonical = _norm(profile.model_id)
        schedule = self._pricing_schedules.get(canonical)
        if schedule is not None:
            return schedule
        if profile.pricing is None:
            return None
        return PricingSchedule(base=profile.pricing)

    def __contains__(self, model_id: str) -> bool:
        try:
            self.get(model_id)
            return True
        except UnknownModelError:
            return False

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._profiles))

    @property
    def profiles(self) -> tuple[ModelProfile, ...]:
        return tuple(self._profiles[k] for k in sorted(self._profiles))


_default: Registry | None = None


def default_registry() -> Registry:
    """The bundled registry, loaded once per process."""
    global _default
    if _default is None:
        _default = Registry.bundled()
    return _default


def get_profile(model_id: str) -> ModelProfile:
    """Resolve against the default registry."""
    return default_registry().get(model_id)


def get_pricing_schedule(model_id: str) -> PricingSchedule | None:
    """Resolve a model's bundled tier-aware or flat pricing schedule."""
    return default_registry().get_pricing_schedule(model_id)


def _resolve_profile(
    model_or_profile: str | ModelProfile,
    registry: Registry | None,
) -> tuple[ModelProfile, Registry]:
    resolved_registry = registry or default_registry()
    if isinstance(model_or_profile, ModelProfile):
        return model_or_profile, resolved_registry
    return resolved_registry.get(model_or_profile), resolved_registry


def quote_usage(
    model_or_profile: str | ModelProfile,
    usage: TurnUsage,
    *,
    registry: Registry | None = None,
    schedule: PricingSchedule | None = None,
) -> CostQuote:
    """Price exclusive usage categories with tier and source provenance.

    The tier basis is every request-input category: uncached input, cached
    reads, and cache writes.  Reasoning tokens are billed at the selected
    output rate.  ``TurnUsage`` categories are exclusive by contract, so no
    category is subtracted or counted twice here.
    """
    profile, resolved_registry = _resolve_profile(model_or_profile, registry)
    selected_schedule = _resolve_pricing_schedule(
        profile,
        resolved_registry,
        schedule,
    )
    unpriced = tuple(
        category
        for category in selected_schedule.scope.unpriced_usage_categories
        if getattr(usage, category) > 0
    )
    if unpriced:
        raise ValueError(
            f"model {profile.model_id!r} pricing does not cover usage categories: "
            + ", ".join(unpriced)
        )

    tier_basis = (
        usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens
    )
    pricing, tier_min = selected_schedule.price_for(tier_basis)
    per_mtok = 1_000_000.0
    input_cost = usage.input_tokens * pricing.input / per_mtok
    cache_read_cost = usage.cache_read_tokens * pricing.cache_read / per_mtok
    cache_write_cost = usage.cache_write_tokens * pricing.cache_write / per_mtok
    output_cost = usage.output_tokens * pricing.output / per_mtok
    reasoning_cost = usage.reasoning_tokens * pricing.output / per_mtok
    total_cost = (
        input_cost
        + cache_read_cost
        + cache_write_cost
        + output_cost
        + reasoning_cost
    )
    return CostQuote(
        model_id=profile.model_id,
        tier_basis_tokens=tier_basis,
        tier_min_input_tokens=tier_min,
        pricing=pricing,
        input_cost=input_cost,
        cache_read_cost=cache_read_cost,
        cache_write_cost=cache_write_cost,
        output_cost=output_cost,
        reasoning_cost=reasoning_cost,
        total_cost=total_cost,
        currency=pricing.currency,
        as_of=pricing.as_of,
        source=profile.source,
    )


def quote_estimate(
    model_or_profile: str | ModelProfile,
    *,
    input_tokens: int,
    reserved_output_tokens: int = 0,
    conservative: bool = True,
    registry: Registry | None = None,
    schedule: PricingSchedule | None = None,
) -> CostEstimate:
    """Reserve estimated request cost without guessing cache composition.

    Tier selection uses the caller's total estimated request input.  In the
    default conservative mode, every estimated input token uses the highest
    of the selected tier's uncached-input, cache-read, and cache-write rates;
    this matters for GPT-5.6, whose cache writes cost more than uncached
    input.  Reserved output uses the selected output rate.
    """
    _require_token_count("input_tokens", input_tokens)
    _require_token_count("reserved_output_tokens", reserved_output_tokens)
    if not isinstance(conservative, bool):
        raise ValueError("conservative must be a bool")
    profile, resolved_registry = _resolve_profile(model_or_profile, registry)
    selected_schedule = _resolve_pricing_schedule(
        profile,
        resolved_registry,
        schedule,
    )
    unpriced = set(selected_schedule.scope.unpriced_usage_categories)
    unpriced_input = unpriced.intersection(
        {"input_tokens", "cache_read_tokens", "cache_write_tokens"}
    )
    if input_tokens > 0 and (
        "input_tokens" in unpriced or (conservative and unpriced_input)
    ):
        raise ValueError(
            f"model {profile.model_id!r} pricing cannot conservatively bound "
            "estimated input because these categories are unpriced: "
            + ", ".join(sorted(unpriced_input))
        )
    unpriced_output = unpriced.intersection({"output_tokens", "reasoning_tokens"})
    if reserved_output_tokens > 0 and unpriced_output:
        raise ValueError(
            f"model {profile.model_id!r} pricing cannot bound reserved output "
            "because these categories are unpriced: "
            + ", ".join(sorted(unpriced_output))
        )
    pricing, tier_min = selected_schedule.price_for(input_tokens)
    rates = (
        ("input", pricing.input),
        ("cache_read", pricing.cache_read),
        ("cache_write", pricing.cache_write),
    )
    assumptions: tuple[str, ...]
    if conservative:
        input_rate_kind, input_rate = max(rates, key=lambda item: item[1])
        assumptions = (
            "estimated input uses the highest selected-tier input-category rate",
            "reserved output uses the selected-tier output rate",
        )
    else:
        input_rate_kind, input_rate = rates[0]
        assumptions = (
            "estimated input is treated as uncached input",
            "reserved output uses the selected-tier output rate",
        )
        if unpriced_input:
            assumptions += (
                "unpriced cache-write storage is excluded; valid only when no "
                "explicit cache is created",
            )
    input_cost = input_tokens * input_rate / 1_000_000.0
    output_cost = reserved_output_tokens * pricing.output / 1_000_000.0
    return CostEstimate(
        model_id=profile.model_id,
        tier_basis_tokens=input_tokens,
        tier_min_input_tokens=tier_min,
        pricing=pricing,
        input_tokens=input_tokens,
        reserved_output_tokens=reserved_output_tokens,
        input_rate_kind=input_rate_kind,
        input_rate=input_rate,
        output_rate=pricing.output,
        input_cost=input_cost,
        output_cost=output_cost,
        total_cost=input_cost + output_cost,
        currency=pricing.currency,
        as_of=pricing.as_of,
        source=profile.source,
        conservative=conservative,
        assumptions=assumptions,
    )


def check_request_limits(
    model_or_profile: str | ModelProfile,
    *,
    input_tokens: int,
    requested_output_tokens: int | None = None,
    reserved_output_tokens: int = 0,
    capacity: Literal["nominal", "effective"] = "nominal",
    registry: Registry | None = None,
) -> LimitCheck:
    """Check input, context reservation, and explicit output limits.

    ``max_input_tokens`` is the provider-safe input ceiling obtained by
    reserving the profile's full advertised output cap.  The independent
    context check uses the larger of the caller's requested and reserved
    output amounts, which lets callers expose a smaller request-specific
    reservation without weakening the fixed provider input ceiling.
    """
    counts = {
        "input_tokens": input_tokens,
        "reserved_output_tokens": reserved_output_tokens,
    }
    if requested_output_tokens is not None:
        counts["requested_output_tokens"] = requested_output_tokens
    for name, value in counts.items():
        _require_token_count(name, value)
    if capacity not in ("nominal", "effective"):
        raise ValueError("capacity must be 'nominal' or 'effective'")

    profile, _ = _resolve_profile(model_or_profile, registry)
    selected_capacity = (
        profile.window_nominal
        if capacity == "nominal"
        else profile.window_effective
    )
    max_output = profile.max_output
    max_input = (
        selected_capacity
        if max_output is None
        else max(0, selected_capacity - max_output)
    )
    context_output = max(reserved_output_tokens, requested_output_tokens or 0)
    context_tokens = input_tokens + context_output
    input_exceeded = input_tokens > max_input
    context_exceeded = context_tokens > selected_capacity
    output_exceeded = (
        requested_output_tokens is not None
        and max_output is not None
        and requested_output_tokens > max_output
    )
    violations: list[str] = []
    if input_exceeded:
        violations.append("input_tokens")
    if context_exceeded:
        violations.append("context_tokens")
    if output_exceeded:
        violations.append("requested_output_tokens")
    return LimitCheck(
        model_id=profile.model_id,
        capacity_kind=capacity,
        capacity=selected_capacity,
        input_tokens=input_tokens,
        requested_output_tokens=requested_output_tokens,
        reserved_output_tokens=reserved_output_tokens,
        context_output_tokens=context_output,
        context_tokens=context_tokens,
        max_input_tokens=max_input,
        max_output_tokens=max_output,
        input_exceeded=input_exceeded,
        context_exceeded=context_exceeded,
        output_exceeded=output_exceeded,
        allowed=not violations,
        violations=tuple(violations),
    )


def _resolve_pricing_schedule(
    profile: ModelProfile,
    registry: Registry,
    schedule: PricingSchedule | None,
) -> PricingSchedule:
    if schedule is not None:
        if profile.pricing is not None and schedule.base != profile.pricing:
            raise ValueError("pricing schedule base must equal profile.pricing")
        return schedule
    try:
        candidate = registry.get_pricing_schedule(profile.model_id)
    except UnknownModelError:
        candidate = None
    if candidate is not None and candidate.base == profile.pricing:
        return candidate
    if profile.pricing is not None:
        return PricingSchedule(base=profile.pricing)
    raise ValueError(f"model {profile.model_id!r} has no pricing")


def _require_token_count(name: str, value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative int")


__all__ = [
    "Registry",
    "UnknownModelError",
    "default_registry",
    "get_profile",
    "get_pricing_schedule",
    "quote_usage",
    "quote_estimate",
    "check_request_limits",
]
