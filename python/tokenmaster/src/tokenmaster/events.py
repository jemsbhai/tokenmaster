"""Typed event stream, per docs/core-api.md section 4.

Wire shape for every event:

    {"event_type": ..., "schema_version": ..., "timestamp": ...,
     "turn_id": ..., "payload": {...}}

This stream is the entire contract between tokenmaster and any visualizer.
Events implemented here are the ones the Meter can emit today (TurnRecorded,
ZoneChanged, VelocityShift, ModelChanged); AdvisorRecommendation,
HandoffEvaluated, and CalibrationLoaded arrive with their features so that no
event type exists in code before something emits it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, ClassVar, Mapping

from .types import SCHEMA_VERSION, MeterState, TurnUsage, Zone


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True, kw_only=True)
class Event:
    """Base envelope. Subclasses define EVENT_TYPE and payload fields."""

    EVENT_TYPE: ClassVar[str] = "event"

    turn_id: int | None = None
    timestamp: str = field(default_factory=_utcnow)
    schema_version: str = SCHEMA_VERSION

    def payload(self) -> dict[str, Any]:
        return {}

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.EVENT_TYPE,
            "schema_version": self.schema_version,
            "timestamp": self.timestamp,
            "turn_id": self.turn_id,
            "payload": self.payload(),
        }

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def _from_payload(cls, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {}


@dataclass(frozen=True, kw_only=True)
class TurnRecorded(Event):
    """A turn was ingested; carries the turn and the resulting state."""

    EVENT_TYPE: ClassVar[str] = "turn_recorded"

    turn: TurnUsage
    state: MeterState

    def payload(self) -> dict[str, Any]:
        return {"turn": self.turn.to_dict(), "state": self.state.to_dict()}

    @classmethod
    def _from_payload(cls, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "turn": TurnUsage.from_dict(payload["turn"]),
            "state": MeterState.from_dict(payload["state"]),
        }


@dataclass(frozen=True, kw_only=True)
class ZoneChanged(Event):
    """fill_effective crossed a zone boundary."""

    EVENT_TYPE: ClassVar[str] = "zone_changed"

    from_zone: Zone
    to_zone: Zone
    fill_effective: float

    def payload(self) -> dict[str, Any]:
        return {
            "from_zone": self.from_zone.value,
            "to_zone": self.to_zone.value,
            "fill_effective": self.fill_effective,
        }

    @classmethod
    def _from_payload(cls, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "from_zone": Zone(payload["from_zone"]),
            "to_zone": Zone(payload["to_zone"]),
            "fill_effective": float(payload["fill_effective"]),
        }


@dataclass(frozen=True, kw_only=True)
class VelocityShift(Event):
    """Velocity moved by more than the configured factor between turns."""

    EVENT_TYPE: ClassVar[str] = "velocity_shift"

    previous: float
    current: float

    def payload(self) -> dict[str, Any]:
        return {"previous": self.previous, "current": self.current}

    @classmethod
    def _from_payload(cls, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "previous": float(payload["previous"]),
            "current": float(payload["current"]),
        }


@dataclass(frozen=True, kw_only=True)
class ModelChanged(Event):
    """A recorded turn carried a different model_id than the previous one.

    The Meter keeps gauging against its constructed profile; this event only
    reports the switch so consumers can decide what it means for them.
    """

    EVENT_TYPE: ClassVar[str] = "model_changed"

    previous_model_id: str
    new_model_id: str

    def payload(self) -> dict[str, Any]:
        return {
            "previous_model_id": self.previous_model_id,
            "new_model_id": self.new_model_id,
        }

    @classmethod
    def _from_payload(cls, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "previous_model_id": str(payload["previous_model_id"]),
            "new_model_id": str(payload["new_model_id"]),
        }


_EVENT_TYPES: dict[str, type[Event]] = {
    cls.EVENT_TYPE: cls
    for cls in (TurnRecorded, ZoneChanged, VelocityShift, ModelChanged)
}

EventCallback = Callable[[Event], None]


def event_from_dict(d: Mapping[str, Any]) -> Event:
    """Reconstruct a typed event from its wire dictionary."""
    event_type = d["event_type"]
    cls = _EVENT_TYPES.get(event_type)
    if cls is None:
        raise ValueError(f"Unknown event_type: {event_type!r}")
    return cls(
        turn_id=d.get("turn_id"),
        timestamp=d["timestamp"],
        schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        **cls._from_payload(d.get("payload", {})),
    )


__all__ = [
    "Event",
    "EventCallback",
    "TurnRecorded",
    "ZoneChanged",
    "VelocityShift",
    "ModelChanged",
    "event_from_dict",
]
