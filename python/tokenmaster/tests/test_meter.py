"""Tests for Meter state computation against hand-computed values.

The EWMA reference sequence, alpha = 0.3, context totals 1000, 1300, 1650,
2100:

  g2 = 300 -> mean = 300.0, var = 0.0
  g3 = 350 -> diff = 50,  incr = 15.0,  mean = 315.0
              var = 0.7 * (0 + 50 * 15.0) = 525.0
  g4 = 450 -> diff = 135, incr = 40.5,  mean = 355.5
              var = 0.7 * (525 + 135 * 40.5) = 4194.75

  velocity = 355.5, velocity_std = sqrt(4194.75) = 64.76688...
  headroom (nominal window 10000, reserve 0) = 10000 - 2100 = 7900
  eta expected = 7900 / 355.5 = 22.22222...
  eta conservative = 7900 / (355.5 + 64.76688) = 18.79285...
"""

import math

import pytest

from tokenmaster import Meter
from tokenmaster.types import (
    Breakdown,
    CalibrationRecord,
    ModelProfile,
    TurnUsage,
    Zone,
)


def profile(window=10_000, effective=None):
    return ModelProfile(
        model_id="test:model",
        provider="test",
        window_nominal=window,
        effective=effective,
    )


def turn_with_total(total):
    """A turn whose context_total equals ``total`` (all in input_tokens)."""
    return {"input_tokens": total}


def test_empty_meter_state():
    m = Meter(profile())
    s = m.state()
    assert s.turns == 0
    assert s.used_tokens == 0
    assert s.velocity is None
    assert s.eta_turns is None
    assert s.zone is Zone.GREEN
    assert "cold start" in s.provenance["velocity"]


def test_used_tokens_is_latest_context_total_not_a_sum():
    m = Meter(profile())
    m.record(turn_with_total(1_000))
    m.record(turn_with_total(1_300))
    assert m.state().used_tokens == 1_300


def test_cold_start_hides_velocity_until_three_turns():
    m = Meter(profile())
    m.record(turn_with_total(1_000))
    m.record(turn_with_total(1_300))
    s = m.state()
    assert s.turns == 2
    assert s.velocity is None
    assert s.eta_turns is None


def test_hand_computed_ewma_velocity_std_and_eta():
    m = Meter(profile())
    for total in (1_000, 1_300, 1_650, 2_100):
        m.record(turn_with_total(total))
    s = m.state()
    assert s.velocity == pytest.approx(355.5)
    assert s.velocity_std == pytest.approx(math.sqrt(4194.75))
    assert s.headroom_effective == 7_900
    assert s.eta_turns.expected == pytest.approx(7_900 / 355.5)
    assert s.eta_turns.conservative == pytest.approx(
        7_900 / (355.5 + math.sqrt(4194.75))
    )
    assert "ewma alpha=0.3" in s.provenance["velocity"]


def test_zero_growth_yields_no_eta_with_reason():
    m = Meter(profile())
    for total in (1_000, 1_000, 1_000):
        m.record(turn_with_total(total))
    s = m.state()
    assert s.velocity == pytest.approx(0.0)
    assert s.eta_turns is None
    assert "not positive" in s.provenance["eta_turns"]


def test_zone_transitions_on_fill_effective():
    m = Meter(profile(window=1_000))
    m.record(turn_with_total(500))
    assert m.state().zone is Zone.GREEN
    m.record(turn_with_total(720))
    assert m.state().zone is Zone.CAUTION
    m.record(turn_with_total(860))
    assert m.state().zone is Zone.CRITICAL


def test_calibration_shifts_zones_and_headroom():
    cal = CalibrationRecord(
        model_id="test:model",
        effective_context=800,
        method="probe-kit",
        source="local run",
    )
    m = Meter(profile(window=1_000, effective=cal))
    m.record(turn_with_total(700))
    s = m.state()
    # 700 / 800 = 0.875 -> critical against effective capacity,
    # while 700 / 1000 = 0.70 would only be caution against nominal.
    assert s.fill_effective == pytest.approx(0.875)
    assert s.zone is Zone.CRITICAL
    assert s.headroom_effective == 100
    assert s.headroom_nominal == 300


def test_reserved_output_subtracts_from_headroom():
    m = Meter(profile(window=1_000), reserved_output=200)
    m.record(turn_with_total(300))
    s = m.state()
    assert s.headroom_nominal == 500
    assert s.headroom_effective == 500


def test_hidden_overhead_and_cache_come_from_latest_turn():
    m = Meter(profile())
    m.record(
        TurnUsage(
            turn_id=1,
            input_tokens=100,
            cache_read_tokens=400,
            cache_write_tokens=50,
            breakdown=Breakdown(system_prompt=300, tool_schemas=150),
        )
    )
    s = m.state()
    assert s.hidden_overhead == 450
    assert s.cache.stable_prefix_tokens == 450
    assert s.cache.last_cache_read == 400
    assert s.cache.last_cache_write == 50


def test_meter_json_round_trip_reproduces_state():
    m = Meter(profile(), reserved_output=100, alpha=0.3)
    for total in (1_000, 1_300, 1_650, 2_100):
        m.record(turn_with_total(total))
    restored = Meter.from_json(m.to_json())
    assert restored.state() == m.state()


def test_record_accepts_plain_dict_and_fills_identity():
    m = Meter(profile())
    stored = m.record({"input_tokens": 10, "output_tokens": 5})
    assert stored.turn_id == 1
    assert stored.model_id == "test:model"
    assert stored.timestamp is not None


def test_constructor_validation():
    with pytest.raises(ValueError):
        Meter(profile(), alpha=0.0)
    with pytest.raises(ValueError):
        Meter(profile(), caution=0.9, critical=0.8)
    with pytest.raises(ValueError):
        Meter(profile(), reserved_output=-1)


def test_exhausted_headroom_yields_no_eta_with_reason():
    m = Meter(profile(window=1_000))
    for total in (400, 700, 1_100):
        m.record(turn_with_total(total))
    s = m.state()
    assert s.velocity is not None
    assert s.eta_turns is None
    assert "exhausted" in s.provenance["eta_turns"]
    assert s.fill_effective > 1.0
    assert s.zone is Zone.CRITICAL
