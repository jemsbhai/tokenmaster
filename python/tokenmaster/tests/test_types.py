"""Tests for the typed data model: serialization round-trips and validation."""

import pytest

from tokenmaster.types import (
    SCHEMA_VERSION,
    Breakdown,
    CalibrationRecord,
    MeterState,
    ModelProfile,
    Pricing,
    TurnUsage,
    UsageSource,
    Zone,
)


def make_profile(**overrides):
    base = dict(
        model_id="test:model",
        provider="test",
        window_nominal=10_000,
        max_output=1_000,
        pricing=Pricing(input=3.0, output=15.0, cache_read=0.3, cache_write=3.75,
                        as_of="2026-07-07"),
    )
    base.update(overrides)
    return ModelProfile(**base)


def test_context_total_sums_all_five_categories():
    turn = TurnUsage(
        turn_id=1,
        input_tokens=100,
        cache_read_tokens=200,
        cache_write_tokens=50,
        output_tokens=30,
        reasoning_tokens=20,
    )
    assert turn.context_total() == 400


def test_turn_usage_rejects_negative_counts():
    with pytest.raises(ValueError):
        TurnUsage(turn_id=1, input_tokens=-1)


def test_turn_usage_from_dict_ignores_unknown_keys_and_defaults_missing():
    turn = TurnUsage.from_dict(
        {"input_tokens": 10, "provider_specific_junk": 999}, turn_id=1
    )
    assert turn.input_tokens == 10
    assert turn.output_tokens == 0
    assert turn.source is UsageSource.REPORTED


def test_turn_usage_round_trip():
    turn = TurnUsage(
        turn_id=3,
        input_tokens=10,
        output_tokens=5,
        breakdown=Breakdown(system_prompt=4, tool_schemas=2),
        source=UsageSource.MIXED,
        raw={"anything": 1},
    )
    back = TurnUsage.from_dict(turn.to_dict())
    assert back == turn


def test_profile_effective_defaults_to_nominal_with_honest_provenance():
    profile = make_profile()
    assert profile.window_effective == 10_000
    assert profile.effective_source == "nominal (uncalibrated)"


def test_profile_calibration_overrides_effective():
    cal = CalibrationRecord(
        model_id="test:model",
        effective_context=8_000,
        method="probe-kit",
        source="local run",
        measured_at="2026-07-01",
    )
    profile = make_profile(effective=cal)
    assert profile.window_effective == 8_000
    assert "probe-kit" in profile.effective_source


def test_profile_round_trip_with_nested_types():
    cal = CalibrationRecord(
        model_id="test:model",
        effective_context=8_000,
        method="probe-kit",
        source="local run",
    )
    profile = make_profile(effective=cal)
    back = ModelProfile.from_dict(profile.to_dict())
    assert back == profile


def test_profile_rejects_nonpositive_window():
    with pytest.raises(ValueError):
        make_profile(window_nominal=0)


def test_meter_state_round_trip_via_json():
    state = MeterState(
        model_id="test:model",
        turns=2,
        used_tokens=400,
        window_nominal=10_000,
        window_effective=8_000,
        effective_source="nominal (uncalibrated)",
        reserved_output=0,
        headroom_nominal=9_600,
        headroom_effective=7_600,
        fill_nominal=0.04,
        fill_effective=0.05,
        velocity=None,
        velocity_std=None,
        eta_turns=None,
        zone=Zone.GREEN,
        hidden_overhead=None,
        cache=None,
        provenance={"velocity": "unavailable (cold start, needs 3 turns)"},
    )
    back = MeterState.from_dict(state.to_dict())
    assert back == state
    assert back.schema_version == SCHEMA_VERSION
