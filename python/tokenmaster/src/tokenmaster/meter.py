"""Meter: turn ingestion, MeterState computation, and event emission.

Definitions implemented here are the reference for the golden vectors and for
the JavaScript and Rust ports:

- used_tokens: ``context_total`` of the latest turn (full prompt of that
  request plus its response), not a sum over turns.
- growth: g_t = used_t - used_(t-1), defined from the second turn onward.
- velocity: exponentially weighted moving average of g_t with smoothing
  factor alpha (contract decision D2: alpha 0.3), exposed once at least
  three turns are recorded; before that it is None with a provenance reason.
- velocity_std: square root of the exponentially weighted variance
  maintained incrementally alongside the mean.
- eta_turns.expected = headroom_effective / velocity;
  eta_turns.conservative = headroom_effective / (velocity + velocity_std).
- zone: keyed to fill_effective with thresholds caution 0.70 and critical
  0.85 (contract decision D1, provisional pending experiment E2).

Event emission per recorded turn, in this deterministic order (section 4):
TurnRecorded, then ZoneChanged (on boundary crossing), then VelocityShift
(when exposed velocity moves by more than velocity_shift_factor, provisional
default 1.5), then ModelChanged (when the turn's model_id differs from the
previous one). Subscriber callbacks are synchronous and exceptions propagate
to the caller of record(): a subscriber that throws is a bug worth hearing
about, and consumers that disagree can wrap their own callbacks. The event
history kept for the iterator is unbounded in 0.1. Persistence via
from_dict/from_json replays turns, so event timestamps are regenerated on
restore; MeterState round-trips exactly, the event log does not claim to.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Iterator, Mapping

from .advisor import Policy, Recommendation, TaskContext, ThresholdPolicy
from .events import (
    AdvisorRecommendation,
    Event,
    EventCallback,
    ModelChanged,
    TurnRecorded,
    VelocityShift,
    ZoneChanged,
)
from .types import (
    SCHEMA_VERSION,
    CacheState,
    EtaEstimate,
    MeterState,
    ModelProfile,
    TurnUsage,
    Zone,
)

_COLD_START_TURNS = 3


def _is_velocity_shift(previous: float, current: float, factor: float) -> bool:
    if previous == 0.0 and current == 0.0:
        return False
    if previous == 0.0 or current == 0.0:
        return True
    if (previous > 0.0) != (current > 0.0):
        return True
    ratio = abs(current) / abs(previous)
    return ratio >= factor or (1.0 / ratio) >= factor


class Meter:
    """Context-budget meter for one conversation against one model profile."""

    def __init__(
        self,
        profile: ModelProfile,
        *,
        reserved_output: int = 0,
        alpha: float = 0.3,
        caution: float = 0.70,
        critical: float = 0.85,
        velocity_shift_factor: float = 1.5,
    ) -> None:
        if not 0.0 < alpha <= 1.0:
            raise ValueError("alpha must be in (0, 1]")
        if not 0.0 < caution < critical <= 1.0:
            raise ValueError("thresholds must satisfy 0 < caution < critical <= 1")
        if reserved_output < 0:
            raise ValueError("reserved_output must be non-negative")
        if velocity_shift_factor <= 1.0:
            raise ValueError("velocity_shift_factor must be greater than 1")
        self.profile = profile
        self.reserved_output = reserved_output
        self.alpha = alpha
        self.caution = caution
        self.critical = critical
        self.velocity_shift_factor = velocity_shift_factor
        self._turns: list[TurnUsage] = []
        self._ew_mean: float | None = None
        self._ew_var: float = 0.0
        self._events: list[Event] = []
        self._subscribers: list[EventCallback] = []
        self._current_model: str = profile.model_id

    # ------------------------------------------------------------------ #
    # construction from the registry

    @classmethod
    def for_model(cls, model_id: str, **kwargs: Any) -> "Meter":
        """Construct a Meter from the bundled registry, zero configuration.

        Accepts canonical ids, bare names, aliases, and dated snapshot
        suffixes; raises UnknownModelError with close-match suggestions
        otherwise.
        """
        from .registry import get_profile

        return cls(get_profile(model_id), **kwargs)

    # ------------------------------------------------------------------ #
    # ingestion

    def record(self, usage: TurnUsage | Mapping[str, Any]) -> TurnUsage:
        """Record one turn. Accepts a TurnUsage or a canonical plain dict.

        turn_id and timestamp are filled in when absent. Emits events in the
        documented order and returns the stored TurnUsage.
        """
        next_id = len(self._turns) + 1
        if isinstance(usage, TurnUsage):
            turn = usage if usage.turn_id == next_id else TurnUsage.from_dict(
                usage.to_dict(), turn_id=next_id
            )
        else:
            d = dict(usage)
            d.setdefault("model_id", self.profile.model_id)
            d.setdefault("timestamp", _utcnow())
            turn = TurnUsage.from_dict(d, turn_id=next_id)

        pre_state = self.state()
        prev_zone = pre_state.zone
        prev_velocity = pre_state.velocity

        prev_total = self._turns[-1].context_total() if self._turns else None
        self._turns.append(turn)
        if prev_total is not None:
            growth = float(turn.context_total() - prev_total)
            self._update_ewma(growth)

        state = self.state()
        self._emit(TurnRecorded(turn_id=turn.turn_id, turn=turn, state=state))
        if state.zone != prev_zone:
            self._emit(
                ZoneChanged(
                    turn_id=turn.turn_id,
                    from_zone=prev_zone,
                    to_zone=state.zone,
                    fill_effective=state.fill_effective,
                )
            )
        if (
            prev_velocity is not None
            and state.velocity is not None
            and _is_velocity_shift(
                prev_velocity, state.velocity, self.velocity_shift_factor
            )
        ):
            self._emit(
                VelocityShift(
                    turn_id=turn.turn_id,
                    previous=prev_velocity,
                    current=state.velocity,
                )
            )
        if turn.model_id and turn.model_id != self._current_model:
            self._emit(
                ModelChanged(
                    turn_id=turn.turn_id,
                    previous_model_id=self._current_model,
                    new_model_id=turn.model_id,
                )
            )
            self._current_model = turn.model_id
        return turn

    def _update_ewma(self, growth: float) -> None:
        if self._ew_mean is None:
            self._ew_mean = growth
            self._ew_var = 0.0
            return
        diff = growth - self._ew_mean
        incr = self.alpha * diff
        self._ew_mean = self._ew_mean + incr
        self._ew_var = (1.0 - self.alpha) * (self._ew_var + diff * incr)

    # ------------------------------------------------------------------ #
    # events

    def subscribe(self, callback: EventCallback):
        """Register a synchronous event callback; returns an unsubscriber."""
        self._subscribers.append(callback)

        def unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return unsubscribe

    def events(self) -> Iterator[Event]:
        """Iterate over all events emitted so far, in order."""
        return iter(tuple(self._events))

    def _emit(self, event: Event) -> None:
        self._events.append(event)
        for callback in tuple(self._subscribers):
            callback(event)

    # ------------------------------------------------------------------ #
    # advisor

    def advise(
        self,
        task: TaskContext | None = None,
        *,
        policy: Policy | None = None,
    ) -> Recommendation:
        """Evaluate a policy against the current state and emit the result.

        The default policy is a ThresholdPolicy aligned to this meter's own
        zone thresholds, so the gauge and the default advice cannot
        disagree. Every call emits an AdvisorRecommendation event; the
        caller controls the cadence.
        """
        chosen = policy or ThresholdPolicy(
            warn_at=self.caution, compact_at=self.critical
        )
        recommendation = chosen.evaluate(self.state(), task)
        self._emit(
            AdvisorRecommendation(
                turn_id=self._turns[-1].turn_id if self._turns else None,
                recommendation=recommendation,
            )
        )
        return recommendation

    # ------------------------------------------------------------------ #
    # state

    def state(self) -> MeterState:
        used = self._turns[-1].context_total() if self._turns else 0
        nominal = self.profile.window_nominal
        effective = self.profile.window_effective
        headroom_nominal = nominal - used - self.reserved_output
        headroom_effective = effective - used - self.reserved_output
        fill_nominal = used / nominal
        fill_effective = used / effective

        provenance: dict[str, str] = {
            "window_effective": self.profile.effective_source,
        }
        if self._turns:
            provenance["used_tokens"] = self._turns[-1].source.value

        velocity: float | None = None
        velocity_std: float | None = None
        eta: EtaEstimate | None = None
        if len(self._turns) >= _COLD_START_TURNS and self._ew_mean is not None:
            velocity = self._ew_mean
            velocity_std = math.sqrt(self._ew_var)
            provenance["velocity"] = f"derived (ewma alpha={self.alpha})"
            if headroom_effective <= 0:
                provenance["eta_turns"] = "exhausted (no headroom remaining)"
            elif velocity > 0:
                expected = headroom_effective / velocity
                conservative = headroom_effective / (velocity + velocity_std)
                eta = EtaEstimate(expected=expected, conservative=conservative)
                provenance["eta_turns"] = "derived"
            else:
                provenance["eta_turns"] = "unavailable (velocity not positive)"
        else:
            provenance["velocity"] = (
                f"unavailable (cold start, needs {_COLD_START_TURNS} turns)"
            )
            provenance["eta_turns"] = provenance["velocity"]

        zone = Zone.GREEN
        if fill_effective >= self.critical:
            zone = Zone.CRITICAL
        elif fill_effective >= self.caution:
            zone = Zone.CAUTION

        hidden: int | None = None
        cache: CacheState | None = None
        if self._turns:
            last = self._turns[-1]
            if last.breakdown is not None:
                hidden = last.breakdown.system_prompt + last.breakdown.tool_schemas
                provenance["hidden_overhead"] = last.source.value
            if last.cache_read_tokens or last.cache_write_tokens:
                cache = CacheState(
                    stable_prefix_tokens=last.cache_read_tokens
                    + last.cache_write_tokens,
                    last_cache_read=last.cache_read_tokens,
                    last_cache_write=last.cache_write_tokens,
                )
                provenance["cache"] = "estimated"

        return MeterState(
            model_id=self.profile.model_id,
            turns=len(self._turns),
            used_tokens=used,
            window_nominal=nominal,
            window_effective=effective,
            effective_source=self.profile.effective_source,
            reserved_output=self.reserved_output,
            headroom_nominal=headroom_nominal,
            headroom_effective=headroom_effective,
            fill_nominal=fill_nominal,
            fill_effective=fill_effective,
            velocity=velocity,
            velocity_std=velocity_std,
            eta_turns=eta,
            zone=zone,
            hidden_overhead=hidden,
            cache=cache,
            provenance=provenance,
        )

    # ------------------------------------------------------------------ #
    # introspection and persistence

    @property
    def turns(self) -> tuple[TurnUsage, ...]:
        return tuple(self._turns)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "profile": self.profile.to_dict(),
            "config": {
                "reserved_output": self.reserved_output,
                "alpha": self.alpha,
                "caution": self.caution,
                "critical": self.critical,
                "velocity_shift_factor": self.velocity_shift_factor,
            },
            "turns": [t.to_dict() for t in self._turns],
        }

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Meter":
        config = d.get("config", {})
        meter = cls(
            ModelProfile.from_dict(d["profile"]),
            reserved_output=int(config.get("reserved_output", 0)),
            alpha=float(config.get("alpha", 0.3)),
            caution=float(config.get("caution", 0.70)),
            critical=float(config.get("critical", 0.85)),
            velocity_shift_factor=float(config.get("velocity_shift_factor", 1.5)),
        )
        for turn_dict in d.get("turns", []):
            meter.record(TurnUsage.from_dict(turn_dict))
        return meter

    @classmethod
    def from_json(cls, blob: str) -> "Meter":
        return cls.from_dict(json.loads(blob))


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = ["Meter"]
