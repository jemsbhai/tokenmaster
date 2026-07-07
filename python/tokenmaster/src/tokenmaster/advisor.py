"""Advisor: policies, recommendations, and rationale traces (contract section 5).

Judgment lives here; measurement lives in the Meter. Every recommendation
ships with the arithmetic that produced it (principle P4: no silent
thresholds), and effect estimates a policy cannot honestly make stay None
rather than being invented.

ThresholdPolicy is the deliberate baseline: it reproduces current practice
(fixed fill fractions, as in tokenlens, Inspect AI, and agent frameworks)
and estimates no effects, because a threshold knows nothing about costs.
That blindness is the point of comparison for the policies that follow.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol

from .types import SCHEMA_VERSION, MeterState


class Action(str, Enum):
    CONTINUE = "continue"
    COMPACT = "compact"
    HANDOFF = "handoff"


class Urgency(str, Enum):
    NONE = "none"
    SOON = "soon"
    NOW = "now"


class TaskCriticality(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


@dataclass(frozen=True)
class TaskContext:
    """Minimal task hints (contract decision D6)."""

    expected_remaining_turns: int | None = None
    task_criticality: TaskCriticality = TaskCriticality.NORMAL

    def to_dict(self) -> dict[str, Any]:
        return {
            "expected_remaining_turns": self.expected_remaining_turns,
            "task_criticality": self.task_criticality.value,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "TaskContext":
        return cls(
            expected_remaining_turns=(
                None
                if d.get("expected_remaining_turns") is None
                else int(d["expected_remaining_turns"])
            ),
            task_criticality=TaskCriticality(d.get("task_criticality", "normal")),
        )


@dataclass(frozen=True)
class RationaleTrace:
    """The arithmetic behind a recommendation: inputs, derived values, verdict."""

    inputs: dict[str, Any] = field(default_factory=dict)
    derived: dict[str, Any] = field(default_factory=dict)
    comparison: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "RationaleTrace":
        return cls(
            inputs=dict(d.get("inputs", {})),
            derived=dict(d.get("derived", {})),
            comparison=str(d.get("comparison", "")),
        )


@dataclass(frozen=True)
class EffectEstimate:
    """Expected consequences of following the recommendation. None = unknown."""

    tokens_spent: int | None = None
    tokens_freed: int | None = None
    cost_delta: float | None = None
    fidelity_risk: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "EffectEstimate":
        return cls(
            tokens_spent=(
                None if d.get("tokens_spent") is None else int(d["tokens_spent"])
            ),
            tokens_freed=(
                None if d.get("tokens_freed") is None else int(d["tokens_freed"])
            ),
            cost_delta=(
                None if d.get("cost_delta") is None else float(d["cost_delta"])
            ),
            fidelity_risk=(
                None if d.get("fidelity_risk") is None else float(d["fidelity_risk"])
            ),
        )


@dataclass(frozen=True)
class Recommendation:
    action: Action
    urgency: Urgency
    rationale: RationaleTrace
    expected: EffectEstimate
    policy_id: str
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action.value,
            "urgency": self.urgency.value,
            "rationale": self.rationale.to_dict(),
            "expected": self.expected.to_dict(),
            "policy_id": self.policy_id,
            "schema_version": self.schema_version,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Recommendation":
        return cls(
            action=Action(d["action"]),
            urgency=Urgency(d["urgency"]),
            rationale=RationaleTrace.from_dict(d.get("rationale", {})),
            expected=EffectEstimate.from_dict(d.get("expected", {})),
            policy_id=str(d["policy_id"]),
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )


class Policy(Protocol):
    """A policy consumes measurement and optional task context, returns judgment."""

    policy_id: str

    def evaluate(
        self, state: MeterState, task: TaskContext | None = None
    ) -> Recommendation: ...


class ThresholdPolicy:
    """Baseline: recommend compaction when fill_effective crosses a fraction.

    Below warn_at: continue. In [warn_at, compact_at): compact soon (start
    planning). At or above compact_at, or with no headroom left: compact now.
    Never recommends handoff; a threshold has no concept of one.
    """

    def __init__(self, *, warn_at: float = 0.70, compact_at: float = 0.85) -> None:
        if not 0.0 < warn_at < compact_at <= 1.0:
            raise ValueError("thresholds must satisfy 0 < warn_at < compact_at <= 1")
        self.warn_at = warn_at
        self.compact_at = compact_at
        self.policy_id = "threshold"

    def evaluate(
        self, state: MeterState, task: TaskContext | None = None
    ) -> Recommendation:
        fill = state.fill_effective
        headroom = state.headroom_effective
        inputs: dict[str, Any] = {
            "fill_effective": fill,
            "headroom_effective": headroom,
            "warn_at": self.warn_at,
            "compact_at": self.compact_at,
            "expected_remaining_turns": (
                task.expected_remaining_turns if task else None
            ),
        }

        if headroom <= 0:
            action, urgency = Action.COMPACT, Urgency.NOW
            comparison = f"headroom_effective {headroom} <= 0 (exhausted)"
        elif fill >= self.compact_at:
            action, urgency = Action.COMPACT, Urgency.NOW
            comparison = f"fill {fill:.3f} >= compact_at {self.compact_at:.2f}"
        elif fill >= self.warn_at:
            action, urgency = Action.COMPACT, Urgency.SOON
            comparison = (
                f"warn_at {self.warn_at:.2f} <= fill {fill:.3f} "
                f"< compact_at {self.compact_at:.2f}"
            )
        else:
            action, urgency = Action.CONTINUE, Urgency.NONE
            comparison = f"fill {fill:.3f} < warn_at {self.warn_at:.2f}"

        return Recommendation(
            action=action,
            urgency=urgency,
            rationale=RationaleTrace(
                inputs=inputs,
                derived={"note": "threshold baseline estimates no effects"},
                comparison=comparison,
            ),
            expected=EffectEstimate(),
            policy_id=self.policy_id,
        )


class PredictivePolicy:
    """Fuel-gauge policy: act when projected range no longer covers the task.

    Compares eta_turns.conservative against the task horizon
    (expected_remaining_turns) plus a safety buffer. Without a horizon it
    guards the buffer alone: running within buffer_turns of exhaustion is
    act-now territory regardless of the task. When no prediction exists
    (cold start, non-positive velocity) it delegates to a fallback policy,
    ThresholdPolicy by default, and says so in the rationale.

    buffer_turns (provisional default 3) and soon_factor (provisional
    default 2.0) await measurement; task_criticality is recorded in the
    rationale but not yet weighted, deliberately, until experiments say how.
    Like the baseline, this policy knows when to act, not what acting costs,
    so every effect estimate stays None; costing is CostModelPolicy's job.
    """

    def __init__(
        self,
        *,
        buffer_turns: int = 3,
        soon_factor: float = 2.0,
        fallback: Policy | None = None,
    ) -> None:
        if buffer_turns < 0:
            raise ValueError("buffer_turns must be non-negative")
        if soon_factor < 1.0:
            raise ValueError("soon_factor must be at least 1")
        self.buffer_turns = buffer_turns
        self.soon_factor = soon_factor
        self.fallback: Policy = fallback or ThresholdPolicy()
        self.policy_id = "predictive"

    def evaluate(
        self, state: MeterState, task: TaskContext | None = None
    ) -> Recommendation:
        eta = state.eta_turns
        horizon = task.expected_remaining_turns if task else None
        inputs: dict[str, Any] = {
            "fill_effective": state.fill_effective,
            "headroom_effective": state.headroom_effective,
            "conservative_eta": eta.conservative if eta else None,
            "expected_eta": eta.expected if eta else None,
            "horizon": horizon,
            "buffer_turns": self.buffer_turns,
            "soon_factor": self.soon_factor,
            "task_criticality": task.task_criticality.value if task else None,
        }

        if state.headroom_effective <= 0:
            return Recommendation(
                action=Action.COMPACT,
                urgency=Urgency.NOW,
                rationale=RationaleTrace(
                    inputs=inputs,
                    comparison=(
                        f"headroom_effective {state.headroom_effective} <= 0 "
                        "(exhausted)"
                    ),
                ),
                expected=EffectEstimate(),
                policy_id=self.policy_id,
            )

        if eta is None:
            reason = state.provenance.get("eta_turns", "eta unavailable")
            base = self.fallback.evaluate(state, task)
            return Recommendation(
                action=base.action,
                urgency=base.urgency,
                rationale=RationaleTrace(
                    inputs=inputs,
                    derived={
                        "delegated_to": self.fallback.policy_id,
                        "reason": reason,
                        "fallback_comparison": base.rationale.comparison,
                    },
                    comparison=(
                        f"prediction unavailable ({reason}); "
                        f"delegated to {self.fallback.policy_id}"
                    ),
                ),
                expected=base.expected,
                policy_id=self.policy_id,
            )

        conservative = eta.conservative
        derived: dict[str, Any] = {}
        if horizon is not None and state.velocity is not None:
            derived["projected_used_at_horizon"] = int(
                state.used_tokens + horizon * state.velocity
            )

        if horizon is not None:
            required = horizon + self.buffer_turns
            derived["required_turns"] = required
            if conservative < horizon:
                action, urgency = Action.COMPACT, Urgency.NOW
                comparison = (
                    f"conservative eta {conservative:.1f} < horizon {horizon}"
                )
            elif conservative < required:
                action, urgency = Action.COMPACT, Urgency.SOON
                comparison = (
                    f"conservative eta {conservative:.1f} < horizon {horizon} "
                    f"+ buffer {self.buffer_turns}"
                )
            else:
                action, urgency = Action.CONTINUE, Urgency.NONE
                comparison = (
                    f"conservative eta {conservative:.1f} covers horizon "
                    f"{horizon} + buffer {self.buffer_turns}"
                )
        else:
            soon_band = self.buffer_turns * self.soon_factor
            if conservative <= self.buffer_turns:
                action, urgency = Action.COMPACT, Urgency.NOW
                comparison = (
                    f"conservative eta {conservative:.1f} <= buffer "
                    f"{self.buffer_turns} (horizon unknown)"
                )
            elif conservative <= soon_band:
                action, urgency = Action.COMPACT, Urgency.SOON
                comparison = (
                    f"conservative eta {conservative:.1f} <= buffer band "
                    f"{soon_band:.1f} (horizon unknown)"
                )
            else:
                action, urgency = Action.CONTINUE, Urgency.NONE
                comparison = (
                    f"conservative eta {conservative:.1f} exceeds buffer band "
                    f"{soon_band:.1f} (horizon unknown)"
                )

        return Recommendation(
            action=action,
            urgency=urgency,
            rationale=RationaleTrace(
                inputs=inputs, derived=derived, comparison=comparison
            ),
            expected=EffectEstimate(),
            policy_id=self.policy_id,
        )


__all__ = [
    "Action",
    "Urgency",
    "TaskCriticality",
    "TaskContext",
    "RationaleTrace",
    "EffectEstimate",
    "Recommendation",
    "Policy",
    "ThresholdPolicy",
    "PredictivePolicy",
]
