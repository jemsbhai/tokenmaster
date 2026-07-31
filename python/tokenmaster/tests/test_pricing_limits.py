"""Tier-aware pricing quotes, registry schedules, and request limits."""

import pytest

from tokenmaster import (
    CalibrationRecord,
    CostModelPolicy,
    Meter,
    ModelProfile,
    Pricing,
    PricingSchedule,
    PricingScope,
    PricingTier,
    Registry,
    TurnUsage,
    check_request_limits,
    get_pricing_schedule,
    get_profile,
    quote_estimate,
    quote_usage,
)


BASE = Pricing(
    input=5.0,
    output=30.0,
    cache_read=0.5,
    cache_write=6.25,
    as_of="2026-07-31",
)
LONG = Pricing(
    input=10.0,
    output=45.0,
    cache_read=1.0,
    cache_write=12.5,
    as_of="2026-07-31",
)
SCOPE = PricingScope(
    service_tier="standard",
    region="global",
    basis="request_input_tokens",
)
SCHEDULE = PricingSchedule(
    base=BASE,
    tiers=(PricingTier(min_input_tokens=272_001, pricing=LONG),),
    scope=SCOPE,
)


def priced_profile(**overrides):
    fields = {
        "model_id": "openai:test-tiered",
        "provider": "openai",
        "window_nominal": 1_050_000,
        "max_output": 128_000,
        "pricing": BASE,
        "source": "official test source",
    }
    fields.update(overrides)
    return ModelProfile(**fields)


def test_pricing_schedule_round_trip_and_inclusive_threshold():
    assert PricingSchedule.from_dict(SCHEDULE.to_dict()) == SCHEDULE
    assert SCHEDULE.price_for(272_000) == (BASE, None)
    assert SCHEDULE.price_for(272_001) == (LONG, 272_001)


def test_pricing_schedule_sorts_tiers_and_rejects_invalid_shapes():
    middle = PricingTier(min_input_tokens=100_000, pricing=BASE)
    high = PricingTier(min_input_tokens=272_001, pricing=LONG)
    schedule = PricingSchedule(base=BASE, tiers=(high, middle))
    assert schedule.tiers == (middle, high)

    with pytest.raises(ValueError, match="unique"):
        PricingSchedule(base=BASE, tiers=(middle, middle))
    with pytest.raises(ValueError, match="currency"):
        PricingSchedule(
            base=BASE,
            tiers=(
                PricingTier(
                    min_input_tokens=1,
                    pricing=Pricing(input=1, output=1, currency="EUR"),
                ),
            ),
        )
    with pytest.raises(ValueError, match="basis"):
        PricingSchedule(base=BASE, scope=PricingScope(basis="total_tokens"))


def test_pricing_scope_round_trips_unpriced_categories_and_omits_empty_marker():
    assert "unpriced_usage_categories" not in PricingScope().to_dict()
    scope = PricingScope(unpriced_usage_categories=("cache_write_tokens",))
    assert PricingScope.from_dict(scope.to_dict()) == scope
    assert scope.to_dict()["unpriced_usage_categories"] == ["cache_write_tokens"]
    with pytest.raises(ValueError, match="unique"):
        PricingScope(
            unpriced_usage_categories=("cache_write_tokens", "cache_write_tokens")
        )
    with pytest.raises(ValueError, match="unsupported"):
        PricingScope(unpriced_usage_categories=("storage_tokens",))
    with pytest.raises(ValueError, match="array"):
        PricingScope.from_dict({"unpriced_usage_categories": "cache_write_tokens"})


def test_registry_parses_sibling_schedule_metadata_and_aliases():
    registry = Registry.from_dict(
        {
            "snapshot_date": "2026-07-31",
            "models": [
                {
                    **priced_profile().to_dict(),
                    "aliases": ["test-latest"],
                    "pricing_scope": SCOPE.to_dict(),
                    "pricing_tiers": [SCHEDULE.tiers[0].to_dict()],
                }
            ],
        }
    )

    assert registry.get("test-latest").model_id == "openai:test-tiered"
    assert registry.get_pricing_schedule("openai:test-latest") == SCHEDULE


def test_register_clears_schedule_and_register_with_schedule_restores_it():
    registry = Registry()
    profile = priced_profile()
    registry.register_with_schedule(profile, SCHEDULE, aliases=["test-latest"])
    assert registry.get_pricing_schedule("test-latest") == SCHEDULE

    registry.register(profile, aliases=["test-latest"])
    assert registry.get_pricing_schedule("test-latest") == PricingSchedule(base=BASE)

    registry.register_with_schedule(profile, SCHEDULE, aliases=["test-latest"])
    assert registry.get_pricing_schedule("test-latest") == SCHEDULE

    with pytest.raises(ValueError, match="base"):
        registry.register_with_schedule(
            profile,
            PricingSchedule(base=Pricing(input=1, output=2)),
        )


def test_quote_usage_uses_all_input_categories_at_272k_boundary():
    registry = Registry()
    registry.register_with_schedule(priced_profile(), SCHEDULE)
    usage = TurnUsage(
        turn_id=1,
        input_tokens=100_000,
        cache_read_tokens=150_000,
        cache_write_tokens=22_000,
        output_tokens=1_000,
        reasoning_tokens=500,
    )

    quote = quote_usage("test-tiered", usage, registry=registry)
    assert quote.tier_basis_tokens == 272_000
    assert quote.tier_min_input_tokens is None
    assert quote.pricing == BASE
    assert quote.input_cost == pytest.approx(0.5)
    assert quote.cache_read_cost == pytest.approx(0.075)
    assert quote.cache_write_cost == pytest.approx(0.1375)
    assert quote.output_cost == pytest.approx(0.03)
    assert quote.reasoning_cost == pytest.approx(0.015)
    assert quote.total_cost == pytest.approx(0.7575)
    assert quote.currency == "USD"
    assert quote.as_of == "2026-07-31"
    assert quote.source == "official test source"

    above = TurnUsage(
        turn_id=2,
        input_tokens=100_001,
        cache_read_tokens=150_000,
        cache_write_tokens=22_000,
        output_tokens=1_000,
        reasoning_tokens=500,
    )
    long_quote = quote_usage("test-tiered", above, registry=registry)
    assert long_quote.tier_basis_tokens == 272_001
    assert long_quote.tier_min_input_tokens == 272_001
    assert long_quote.pricing == LONG
    assert long_quote.input_cost == pytest.approx(1.00001)
    assert long_quote.cache_read_cost == pytest.approx(0.15)
    assert long_quote.cache_write_cost == pytest.approx(0.275)
    assert long_quote.output_cost == pytest.approx(0.045)
    assert long_quote.reasoning_cost == pytest.approx(0.0225)
    assert long_quote.total_cost == pytest.approx(1.49251)
    assert long_quote.to_dict()["pricing"] == LONG.to_dict()


def test_quote_usage_preserves_flat_profile_compatibility():
    profile = priced_profile(model_id="custom:flat")
    quote = quote_usage(
        profile,
        TurnUsage(turn_id=1, input_tokens=1_000, output_tokens=100),
    )
    assert quote.tier_min_input_tokens is None
    assert quote.total_cost == pytest.approx(0.008)

    unpriced = priced_profile(model_id="custom:unpriced", pricing=None)
    with pytest.raises(ValueError, match="no pricing"):
        quote_usage(unpriced, TurnUsage(turn_id=1, input_tokens=1))


def test_quote_estimate_uses_conservative_rate_and_tier_boundary():
    registry = Registry()
    registry.register_with_schedule(priced_profile(), SCHEDULE)

    short = quote_estimate(
        "test-tiered",
        input_tokens=272_000,
        reserved_output_tokens=1_000,
        registry=registry,
    )
    assert short.tier_min_input_tokens is None
    assert short.input_rate_kind == "cache_write"
    assert short.input_rate == 6.25
    assert short.output_rate == 30.0
    assert short.input_cost == pytest.approx(1.7)
    assert short.output_cost == pytest.approx(0.03)
    assert short.total_cost == pytest.approx(1.73)
    assert short.conservative
    assert short.to_dict()["assumptions"] == list(short.assumptions)

    long = quote_estimate(
        "test-tiered",
        input_tokens=272_001,
        reserved_output_tokens=1_000,
        registry=registry,
    )
    assert long.tier_min_input_tokens == 272_001
    assert long.input_rate_kind == "cache_write"
    assert long.input_rate == 12.5
    assert long.total_cost == pytest.approx(3.4450125)


def test_quote_estimate_can_price_uncached_input_without_conservative_reserve():
    estimate = quote_estimate(
        priced_profile(),
        input_tokens=272_000,
        reserved_output_tokens=1_000,
        conservative=False,
        schedule=SCHEDULE,
    )
    assert estimate.input_rate_kind == "input"
    assert estimate.input_rate == 5.0
    assert estimate.total_cost == pytest.approx(1.39)
    assert not estimate.conservative


def test_gemini_cache_storage_is_explicitly_unpriced_and_fails_closed():
    for model_id in ("gemini-3.1-pro-preview", "gemini-3.5-flash"):
        schedule = get_pricing_schedule(model_id)
        assert schedule is not None
        assert schedule.scope.unpriced_usage_categories == ("cache_write_tokens",)

    quote = quote_usage(
        "gemini-3.1-pro-preview",
        TurnUsage(
            turn_id=1,
            input_tokens=150_001,
            cache_read_tokens=50_000,
            output_tokens=1_000,
        ),
    )
    assert quote.tier_min_input_tokens == 200_001
    assert quote.total_cost == pytest.approx(0.638004)

    with pytest.raises(ValueError, match="does not cover.*cache_write_tokens"):
        quote_usage(
            "gemini-3.1-pro-preview",
            TurnUsage(turn_id=2, cache_write_tokens=1),
        )
    with pytest.raises(ValueError, match="cannot conservatively bound"):
        quote_estimate("gemini-3.1-pro-preview", input_tokens=1)

    uncached = quote_estimate(
        "gemini-3.1-pro-preview",
        input_tokens=1,
        conservative=False,
    )
    assert any("no explicit cache" in assumption for assumption in uncached.assumptions)

    with pytest.raises(ValueError, match="requires complete pricing"):
        CostModelPolicy.for_model("gemini-3.1-pro-preview")


def test_gemini_verified_request_limit_boundaries():
    profile = get_profile("gemini-3.1-pro-preview")
    assert check_request_limits(profile, input_tokens=983_040).allowed
    assert check_request_limits(profile, input_tokens=983_041).input_exceeded
    assert check_request_limits(
        profile,
        input_tokens=1,
        requested_output_tokens=65_536,
    ).allowed
    assert check_request_limits(
        profile,
        input_tokens=1,
        requested_output_tokens=65_537,
    ).output_exceeded


@pytest.mark.parametrize("value", [-1, True, 1.5, "1"])
def test_quote_estimate_rejects_invalid_counts(value):
    with pytest.raises(ValueError, match="non-negative int"):
        quote_estimate(priced_profile(), input_tokens=value)


def test_request_limits_use_fixed_nominal_input_ceiling():
    profile = priced_profile()
    at_limit = check_request_limits(profile, input_tokens=922_000)
    assert at_limit.capacity_kind == "nominal"
    assert at_limit.capacity == 1_050_000
    assert at_limit.max_input_tokens == 922_000
    assert at_limit.allowed

    above = check_request_limits(profile, input_tokens=922_001)
    assert above.input_exceeded
    assert not above.context_exceeded
    assert above.violations == ("input_tokens",)
    assert not above.allowed


def test_request_limits_check_context_reservation_and_explicit_output_cap():
    profile = priced_profile()
    context = check_request_limits(
        profile,
        input_tokens=900_000,
        reserved_output_tokens=150_001,
    )
    assert context.context_output_tokens == 150_001
    assert context.context_tokens == 1_050_001
    assert context.context_exceeded
    assert context.violations == ("context_tokens",)

    output = check_request_limits(
        profile,
        input_tokens=1,
        requested_output_tokens=128_001,
        reserved_output_tokens=1,
    )
    assert output.context_output_tokens == 128_001
    assert output.output_exceeded
    assert output.violations == ("requested_output_tokens",)
    assert output.to_dict()["violations"] == ["requested_output_tokens"]


def test_request_limits_support_effective_capacity_and_nominal_fallback():
    calibrated = priced_profile(
        effective=CalibrationRecord(
            model_id="openai:test-tiered",
            effective_context=900_000,
            method="probe",
            source="local",
        )
    )
    effective = check_request_limits(
        calibrated,
        input_tokens=772_000,
        capacity="effective",
    )
    assert effective.capacity == 900_000
    assert effective.max_input_tokens == 772_000
    assert effective.allowed

    fallback = check_request_limits(
        priced_profile(),
        input_tokens=922_000,
        capacity="effective",
    )
    assert fallback.capacity == 1_050_000
    assert fallback.allowed


@pytest.mark.parametrize(
    "kwargs, message",
    [
        ({"input_tokens": -1}, "input_tokens"),
        (
            {"input_tokens": 1, "requested_output_tokens": -1},
            "requested_output_tokens",
        ),
        (
            {"input_tokens": 1, "reserved_output_tokens": -1},
            "reserved_output_tokens",
        ),
        ({"input_tokens": 1, "capacity": "other"}, "capacity"),
    ],
)
def test_request_limits_reject_invalid_inputs(kwargs, message):
    with pytest.raises(ValueError, match=message):
        check_request_limits(priced_profile(), **kwargs)


def test_cost_model_uses_distinct_pre_post_and_handoff_tiers():
    meter = Meter(
        ModelProfile(
            model_id="openai:test-tiered",
            provider="openai",
            window_nominal=1_000_000,
            pricing=BASE,
        )
    )
    for total in (297_000, 298_000, 299_000, 300_000):
        meter.record({"input_tokens": total})

    recommendation = meter.advise(
        policy=CostModelPolicy(pricing_schedule=SCHEDULE),
    )
    derived = recommendation.rationale.derived
    assert derived["pre_tier_min_input_tokens"] == 272_001
    assert derived["post_tier_min_input_tokens"] is None
    assert derived["handoff_tier_min_input_tokens"] is None
    assert derived["saving_per_turn_compact"] == pytest.approx(0.2775)
    assert derived["one_time_compact"] == pytest.approx(1.60875)
    assert derived["one_time_handoff"] == pytest.approx(0.76125)


def test_cost_model_for_model_loads_registry_schedule():
    registry = Registry()
    registry.register_with_schedule(priced_profile(), SCHEDULE)
    policy = CostModelPolicy.for_model("test-tiered", registry=registry)
    assert policy.pricing == BASE
    assert policy.pricing_schedule == SCHEDULE
