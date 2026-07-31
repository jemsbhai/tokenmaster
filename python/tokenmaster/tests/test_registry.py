"""Tests for the bundled registry, resolution rules, and Meter.for_model."""

import pytest

from tokenmaster import (
    Meter,
    Registry,
    UnknownModelError,
    default_registry,
    get_pricing_schedule,
    get_profile,
)
from tokenmaster.types import ModelProfile


def test_bundled_snapshot_integrity():
    reg = default_registry()
    assert reg.snapshot_date is not None
    assert len(reg.profiles) >= 10
    for profile in reg.profiles:
        assert profile.window_nominal > 0
        assert ":" in profile.model_id
        if profile.pricing is not None:
            assert profile.pricing.as_of is not None
            assert profile.pricing.input > 0
            assert profile.pricing.output > 0


def test_lookup_canonical_id():
    p = default_registry().get("anthropic:claude-sonnet-4-6")
    assert p.window_nominal == 1_000_000
    assert p.pricing.input == 3.0


def test_lookup_bare_name():
    p = default_registry().get("claude-haiku-4-5")
    assert p.model_id == "anthropic:claude-haiku-4-5"
    assert p.window_nominal == 200_000


def test_lookup_is_case_insensitive():
    p = default_registry().get("Anthropic:Claude-Fable-5")
    assert p.model_id == "anthropic:claude-fable-5"


def test_lookup_dated_snapshot_suffix():
    p = default_registry().get("claude-haiku-4-5-20251001")
    assert p.model_id == "anthropic:claude-haiku-4-5"
    q = default_registry().get("openai:gpt-5.5-2026-04-14")
    assert q.model_id == "openai:gpt-5.5"


def test_lookup_alias():
    p = default_registry().get("gemini-3.1-pro-preview")
    assert p.model_id == "google:gemini-3.1-pro"
    assert get_profile("gemini-3.1-pro-preview-customtools") is p
    assert get_profile("google:gemini-3.1-pro-preview-customtools") is p


def test_gpt_5_6_family_profiles_and_aliases():
    sol = get_profile("openai:gpt-5.6-sol")
    for model_id in ("gpt-5.6-sol", "openai:gpt-5.6", "gpt-5.6"):
        assert get_profile(model_id) is sol
    assert sol.window_nominal == 1_050_000
    assert sol.max_output == 128_000
    assert sol.pricing.input == 5.0
    assert sol.pricing.cache_read == 0.5
    assert sol.pricing.cache_write == 6.25
    assert sol.pricing.output == 30.0
    assert sol.pricing.as_of == "2026-07-31"
    assert "/gpt-5.6-sol" in sol.source

    terra = get_profile("gpt-5.6-terra")
    assert terra.model_id == "openai:gpt-5.6-terra"
    assert terra.window_nominal == 1_050_000
    assert terra.max_output == 128_000
    assert terra.pricing.input == 2.0
    assert terra.pricing.cache_read == 0.2
    assert terra.pricing.cache_write == 2.5
    assert terra.pricing.output == 12.0
    assert terra.pricing.as_of == "2026-07-31"
    assert "/gpt-5.6-terra" in terra.source

    luna = get_profile("gpt-5.6-luna")
    assert luna.model_id == "openai:gpt-5.6-luna"
    assert luna.window_nominal == 1_050_000
    assert luna.max_output == 128_000
    assert luna.pricing.input == 0.2
    assert luna.pricing.cache_read == 0.02
    assert luna.pricing.cache_write == 0.25
    assert luna.pricing.output == 1.2
    assert luna.pricing.as_of == "2026-07-31"
    assert "/gpt-5.6-luna" in luna.source


def test_gpt_5_4_mini_profile_uses_verified_output_cap():
    profile = get_profile("openai:gpt-5.4-mini")
    assert profile.max_output == 128_000
    assert profile.pricing.as_of == "2026-07-31"
    assert "/gpt-5.4-mini" in profile.source


def test_gemini_3_1_pro_bundles_the_verified_200k_pricing_tier():
    profile = get_profile("gemini-3.1-pro-preview")
    assert profile.window_nominal == 1_048_576
    assert profile.max_output == 65_536
    assert "/models/gemini-3.1-pro-preview" in profile.source
    schedule = get_pricing_schedule("gemini-3.1-pro-preview")
    assert schedule is not None
    short, short_min = schedule.price_for(200_000)
    long, long_min = schedule.price_for(200_001)
    assert short_min is None
    assert short.input == 2.0
    assert short.cache_read == 0.2
    assert short.output == 12.0
    assert long_min == 200_001
    assert long.input == 4.0
    assert long.cache_read == 0.4
    assert long.output == 18.0

    flash = get_profile("gemini-3.5-flash")
    assert flash.window_nominal == 1_048_576
    assert flash.max_output == 65_536
    assert "/models/gemini-3.5-flash" in flash.source


def test_unknown_model_raises_with_suggestions():
    with pytest.raises(UnknownModelError) as exc:
        default_registry().get("claude-sonet-4-6")
    assert "claude-sonnet-4-6" in str(exc.value)


def test_register_override_wins():
    reg = Registry.bundled()
    custom = ModelProfile(
        model_id="anthropic:claude-haiku-4-5",
        provider="anthropic",
        window_nominal=123_456,
        source="user override",
    )
    reg.register(custom)
    assert reg.get("claude-haiku-4-5").window_nominal == 123_456
    # the process-wide default registry is untouched
    assert default_registry().get("claude-haiku-4-5").window_nominal == 200_000


def test_for_model_end_to_end():
    m = Meter.for_model("claude-haiku-4-5")
    m.record({"input_tokens": 50_000})
    s = m.state()
    assert s.window_nominal == 200_000
    assert s.fill_nominal == pytest.approx(0.25)
    assert s.model_id == "anthropic:claude-haiku-4-5"
