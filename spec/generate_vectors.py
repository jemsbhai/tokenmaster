"""Generate the conformance vectors (spec/README.md) from the reference
implementation. Deterministic by construction: fixed timestamps on inputs,
timestamps excluded from expectations.

    python spec/generate_vectors.py
"""

from __future__ import annotations

import json
from pathlib import Path

from tokenmaster import (
    Meter,
    ModelChanged,
    TurnRecorded,
    VelocityShift,
    ZoneChanged,
)
from tokenmaster.types import CalibrationRecord, ModelProfile, TurnUsage

VECTORS_DIR = Path(__file__).parent / "vectors"


def ts(i: int) -> str:
    return f"2026-07-07T00:00:{i:02d}+00:00"


def turns_from_totals(totals, model_id="spec:model"):
    return [
        {
            "input_tokens": total,
            "model_id": model_id,
            "timestamp": ts(i + 1),
        }
        for i, total in enumerate(totals)
    ]


def profile(window=10_000, effective=None, model_id="spec:model"):
    return ModelProfile(
        model_id=model_id,
        provider="spec",
        window_nominal=window,
        effective=effective,
        source="spec fixture",
    )


CALIBRATION = CalibrationRecord(
    model_id="spec:model",
    effective_context=800,
    method="probe-kit",
    source="spec fixture",
    measured_at="2026-07-01",
)

SCENARIOS = [
    {
        "vector_id": "steady-growth-basic",
        "description": (
            "Hand-computed EWMA reference: velocity 355.5, "
            "std sqrt(4194.75), eta from headroom 7900."
        ),
        "profile": profile(window=10_000),
        "config": {},
        "turns": turns_from_totals((1_000, 1_300, 1_650, 2_100)),
    },
    {
        "vector_id": "cold-start",
        "description": "Two turns: velocity and eta null with reasons.",
        "profile": profile(window=10_000),
        "config": {},
        "turns": turns_from_totals((1_000, 1_300)),
    },
    {
        "vector_id": "zone-crossings",
        "description": "green -> caution -> critical with ZoneChanged events.",
        "profile": profile(window=1_000),
        "config": {},
        "turns": turns_from_totals((500, 720, 730, 860)),
    },
    {
        "vector_id": "velocity-shift",
        "description": "EWMA jump 100 -> 220 crosses factor 1.5.",
        "profile": profile(window=100_000),
        "config": {},
        "turns": turns_from_totals((1_000, 1_100, 1_200, 1_300, 1_800)),
    },
    {
        "vector_id": "calibrated-effective",
        "description": (
            "Effective 800 under nominal 1000: fills diverge, zone keys "
            "to effective."
        ),
        "profile": profile(window=1_000, effective=CALIBRATION),
        "config": {},
        "turns": turns_from_totals((700,)),
    },
    {
        "vector_id": "exhausted",
        "description": "Overflow: negative headroom, eta exhausted reason.",
        "profile": profile(window=1_000),
        "config": {},
        "turns": turns_from_totals((400, 700, 1_100)),
    },
    {
        "vector_id": "model-switch",
        "description": "Mid-conversation model_id change emits ModelChanged.",
        "profile": profile(window=10_000),
        "config": {},
        "turns": [
            {"input_tokens": 1_000, "model_id": "spec:model",
             "timestamp": ts(1)},
            {"input_tokens": 1_500, "model_id": "spec:other",
             "timestamp": ts(2)},
        ],
    },
    {
        "vector_id": "cache-breakdown-reserved",
        "description": (
            "Cache reads/writes, breakdown overhead, and reserved output."
        ),
        "profile": profile(window=10_000),
        "config": {"reserved_output": 500},
        "turns": [
            {
                "input_tokens": 100,
                "cache_read_tokens": 400,
                "cache_write_tokens": 50,
                "output_tokens": 30,
                "reasoning_tokens": 20,
                "breakdown": {"system_prompt": 300, "tool_schemas": 150},
                "model_id": "spec:model",
                "timestamp": ts(1),
            }
        ],
    },
    {
        "vector_id": "zero-growth",
        "description": "Flat totals: velocity 0, eta unavailable reason.",
        "profile": profile(window=10_000),
        "config": {},
        "turns": turns_from_totals((1_000, 1_000, 1_000)),
    },
]


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
    elif isinstance(event, TurnRecorded):
        pass  # structural rule: payload equals the turn and state
    return entry


def build(scenario) -> dict:
    meter = Meter(scenario["profile"], **scenario["config"])
    events = []
    meter.subscribe(events.append)
    states = []
    for turn in scenario["turns"]:
        meter.record(TurnUsage.from_dict(turn, turn_id=len(states) + 1))
        states.append(meter.state().to_dict())
    return {
        "schema_version": "0.1",
        "vector_id": scenario["vector_id"],
        "description": scenario["description"],
        "profile": scenario["profile"].to_dict(),
        "config": {
            "reserved_output": meter.reserved_output,
            "alpha": meter.alpha,
            "caution": meter.caution,
            "critical": meter.critical,
            "velocity_shift_factor": meter.velocity_shift_factor,
        },
        "turns": [t.to_dict() for t in meter.turns],
        "expected": {
            "states": states,
            "events": [slim_event(e) for e in events],
        },
    }


def main() -> None:
    VECTORS_DIR.mkdir(exist_ok=True)
    for scenario in SCENARIOS:
        vector = build(scenario)
        path = VECTORS_DIR / f"{vector['vector_id']}.json"
        path.write_text(
            json.dumps(vector, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
