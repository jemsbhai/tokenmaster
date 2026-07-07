"""Tests for the event stream: emission rules, ordering, delivery, wire form.

VelocityShift reference numbers, alpha = 0.3, factor = 1.5, context totals
1000, 1100, 1200, 1300, 1800:

  g = 100, 100, 100 -> mean stays 100.0 (velocity exposed from turn 3)
  g5 = 500 -> diff = 400, incr = 120, mean = 220.0
  ratio 220 / 100 = 2.2 >= 1.5 -> VelocityShift(previous=100, current=220)
"""

import pytest

from tokenmaster import (
    Meter,
    ModelChanged,
    TurnRecorded,
    VelocityShift,
    ZoneChanged,
    event_from_dict,
)
from tokenmaster.types import ModelProfile, Zone


def profile(window=10_000):
    return ModelProfile(
        model_id="test:model", provider="test", window_nominal=window
    )


def collect(meter):
    seen = []
    meter.subscribe(seen.append)
    return seen


def test_turn_recorded_carries_turn_and_state():
    m = Meter(profile())
    seen = collect(m)
    m.record({"input_tokens": 500})
    assert len(seen) == 1
    ev = seen[0]
    assert isinstance(ev, TurnRecorded)
    assert ev.turn_id == 1
    assert ev.turn.input_tokens == 500
    assert ev.state == m.state()


def test_zone_changed_emitted_only_on_crossing():
    m = Meter(profile(window=1_000))
    seen = collect(m)
    m.record({"input_tokens": 500})   # green, no crossing
    m.record({"input_tokens": 720})   # green -> caution
    m.record({"input_tokens": 730})   # still caution, no event
    m.record({"input_tokens": 860})   # caution -> critical
    zone_events = [e for e in seen if isinstance(e, ZoneChanged)]
    assert [(e.from_zone, e.to_zone) for e in zone_events] == [
        (Zone.GREEN, Zone.CAUTION),
        (Zone.CAUTION, Zone.CRITICAL),
    ]
    assert zone_events[0].turn_id == 2
    assert zone_events[1].turn_id == 4


def test_velocity_shift_on_factor_breach():
    m = Meter(profile(window=100_000))
    seen = collect(m)
    for total in (1_000, 1_100, 1_200, 1_300, 1_800):
        m.record({"input_tokens": total})
    shifts = [e for e in seen if isinstance(e, VelocityShift)]
    assert len(shifts) == 1
    assert shifts[0].previous == pytest.approx(100.0)
    assert shifts[0].current == pytest.approx(220.0)
    assert shifts[0].turn_id == 5


def test_no_velocity_shift_on_steady_growth():
    m = Meter(profile(window=100_000))
    seen = collect(m)
    for total in (1_000, 1_100, 1_200, 1_300, 1_400, 1_500):
        m.record({"input_tokens": total})
    assert not [e for e in seen if isinstance(e, VelocityShift)]


def test_model_changed_on_mid_conversation_switch():
    m = Meter(profile())
    seen = collect(m)
    m.record({"input_tokens": 100})
    m.record({"input_tokens": 200, "model_id": "test:other-model"})
    m.record({"input_tokens": 300, "model_id": "test:other-model"})
    switches = [e for e in seen if isinstance(e, ModelChanged)]
    assert len(switches) == 1
    assert switches[0].previous_model_id == "test:model"
    assert switches[0].new_model_id == "test:other-model"
    assert switches[0].turn_id == 2


def test_event_order_is_deterministic():
    m = Meter(profile(window=1_000))
    seen = collect(m)
    m.record({"input_tokens": 500})
    m.record({"input_tokens": 900, "model_id": "test:other-model"})
    second_turn = [e for e in seen if e.turn_id == 2]
    assert [type(e) for e in second_turn] == [
        TurnRecorded,
        ZoneChanged,
        ModelChanged,
    ]


def test_unsubscribe_stops_delivery():
    m = Meter(profile())
    seen = []
    unsubscribe = m.subscribe(seen.append)
    m.record({"input_tokens": 100})
    unsubscribe()
    m.record({"input_tokens": 200})
    assert len(seen) == 1


def test_events_iterator_replays_all_in_order():
    m = Meter(profile(window=1_000))
    m.record({"input_tokens": 500})
    m.record({"input_tokens": 720})
    log = list(m.events())
    assert [type(e) for e in log] == [TurnRecorded, TurnRecorded, ZoneChanged]


def test_event_wire_round_trip():
    m = Meter(profile(window=1_000))
    m.record({"input_tokens": 720})
    for ev in m.events():
        back = event_from_dict(ev.to_dict())
        assert back == ev


def test_subscriber_exceptions_propagate():
    m = Meter(profile())

    def broken(_event):
        raise RuntimeError("visualizer bug")

    m.subscribe(broken)
    with pytest.raises(RuntimeError, match="visualizer bug"):
        m.record({"input_tokens": 100})
