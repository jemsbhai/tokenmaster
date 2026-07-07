"""Tests for the bundled registry, resolution rules, and Meter.for_model."""

import pytest

from tokenmaster import Meter, Registry, UnknownModelError, default_registry
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
