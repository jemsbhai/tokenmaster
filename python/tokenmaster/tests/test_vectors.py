"""Conformance: replay every committed vector and match states and events.

This is the same harness the JavaScript and Rust ports must mirror
(spec/README.md defines the normative comparison rules).
"""

import json
import math
from pathlib import Path

import pytest

from tokenmaster import (
    Meter,
    ModelChanged,
    TurnRecorded,
    VelocityShift,
    ZoneChanged,
)
from tokenmaster.types import ModelProfile, TurnUsage

VECTORS_DIR = Path(__file__).resolve().parents[3] / "spec" / "vectors"
VECTOR_PATHS = sorted(VECTORS_DIR.glob("*.json")) if VECTORS_DIR.exists() else []

SKIP_KEYS = {"timestamp"}
FLOAT_TOL = 1e-9


def assert_matches(actual, expected, path=""):
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected dict"
        for key, value in expected.items():
            if key in SKIP_KEYS:
                continue
            assert key in actual, f"{path}.{key}: missing"
            assert_matches(actual[key], value, f"{path}.{key}")
        extra = set(actual) - set(expected) - SKIP_KEYS
        assert not extra, f"{path}: unexpected keys {extra}"
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), (
            f"{path}: length {len(actual)} != {len(expected)}"
        )
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_matches(a, e, f"{path}[{i}]")
    elif isinstance(expected, float) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)), f"{path}: expected number"
        assert math.isclose(
            float(actual), expected, rel_tol=FLOAT_TOL, abs_tol=FLOAT_TOL
        ), f"{path}: {actual} != {expected}"
    else:
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"


def slim_event(event) -> dict:
    entry: dict = {"event_type": event.EVENT_TYPE, "turn_id": event.turn_id}
    if isinstance(event, ZoneChanged):
        entry.update(
            from_zone=event.from_zone.value,
            to_zone=event.to_zone.value,
            fill_effective=event.fill_effective,
        )
    elif isinstance(event, VelocityShift):
        entry.update(previous=event.previous, current=event.current)
    elif isinstance(event, ModelChanged):
        entry.update(
            previous_model_id=event.previous_model_id,
            new_model_id=event.new_model_id,
        )
    return entry


@pytest.mark.skipif(
    not VECTOR_PATHS, reason="no committed vectors; run spec/generate_vectors.py"
)
@pytest.mark.parametrize(
    "vector_path", VECTOR_PATHS, ids=[p.stem for p in VECTOR_PATHS]
)
def test_vector_conformance(vector_path):
    vector = json.loads(vector_path.read_text(encoding="utf-8"))
    meter = Meter(
        ModelProfile.from_dict(vector["profile"]),
        reserved_output=vector["config"]["reserved_output"],
        alpha=vector["config"]["alpha"],
        caution=vector["config"]["caution"],
        critical=vector["config"]["critical"],
        velocity_shift_factor=vector["config"]["velocity_shift_factor"],
    )
    events = []
    meter.subscribe(events.append)

    states = []
    for turn_dict in vector["turns"]:
        turn = TurnUsage.from_dict(turn_dict)
        recorded = meter.record(turn)
        # structural rule for turn_recorded payloads
        latest = [e for e in events if isinstance(e, TurnRecorded)][-1]
        assert latest.turn == recorded
        assert latest.state == meter.state()
        states.append(meter.state().to_dict())

    assert_matches(states, vector["expected"]["states"], "states")
    assert_matches(
        [slim_event(e) for e in events], vector["expected"]["events"], "events"
    )
