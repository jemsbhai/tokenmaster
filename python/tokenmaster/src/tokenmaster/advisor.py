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


_UNIT_PRICES = (1.0, 5.0, 0.1, 1.25)  # in, out, cache_read, cache_write


class CostModelPolicy:
    """Choose the action minimizing expected cost (contract section 5.2).

    Computes net costs of compact and handoff relative to continuing over a
    horizon of k turns, including the cache economics of the aftermath: the
    one-time summary generation and prefix rewrite versus the per-turn
    cache-read savings of a smaller prefix. The break-even horizon

        k* = (T_sum*p_out + T_post*(p_cw - p_cr)) / ((T_pre - T_post)*p_cr)

    is reported in every rationale; below k* remaining turns, compaction
    loses money before information loss is even counted. Per-turn context
    growth cancels between branches (both paths grow identically), so the
    savings term is exact under the equal-growth assumption.

    Prices come from a Pricing (per-Mtok, converted internally to per-token)
    or, when absent, from provisional unit ratios (in 1.0, out 5.0, cache
    read 0.1, cache write 1.25 per token) with the ledger unit reported as
    "token-units" instead of a currency. All ratios and loss parameters are
    provisional pending experiments E3 and E4 and are recorded in the
    rationale inputs. With no prediction available (cold start), the policy
    delegates to a fallback and says so; with no headroom, it picks the
    cheaper of compact and handoff at urgency now.
    """

    def __init__(
        self,
        *,
        pricing: Pricing | None = None,
        compaction_ratio: float = 0.15,
        summary_output_ratio: float = 0.10,
        handoff_prompt_ratio: float = 0.05,
        expected_compaction_loss: float = 0.10,
        expected_handoff_loss: float = 0.20,
        human_friction: float = 0.0,
        default_horizon: int = 10,
        fallback: Policy | None = None,
    ) -> None:
        for name, value in (
            ("compaction_ratio", compaction_ratio),
            ("summary_output_ratio", summary_output_ratio),
            ("handoff_prompt_ratio", handoff_prompt_ratio),
        ):
            if not 0.0 < value < 1.0:
                raise ValueError(f"{name} must be in (0, 1)")
        for name, value in (
            ("expected_compaction_loss", expected_compaction_loss),
            ("expected_handoff_loss", expected_handoff_loss),
        ):
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} must be in [0, 1]")
        if human_friction < 0:
            raise ValueError("human_friction must be non-negative")
        if default_horizon < 1:
            raise ValueError("default_horizon must be at least 1")
        self.pricing = pricing
        self.compaction_ratio = compaction_ratio
        self.summary_output_ratio = summary_output_ratio
        self.handoff_prompt_ratio = handoff_prompt_ratio
        self.expected_compaction_loss = expected_compaction_loss
        self.expected_handoff_loss = expected_handoff_loss
        self.human_friction = human_friction
        self.default_horizon = default_horizon
        self.fallback: Policy = fallback or ThresholdPolicy()
        self.policy_id = "cost-model"

    @classmethod
    def for_profile(cls, profile: ModelProfile, **kwargs: Any) -> "CostModelPolicy":
        """Construct with the profile's dated pricing (None degrades to units)."""
        return cls(pricing=profile.pricing, **kwargs)

    def _per_token_prices(self) -> tuple[float, float, float, float, str]:
        if self.pricing is not None:
            p = self.pricing
            return (
                p.input / 1e6,
                p.output / 1e6,
                p.cache_read / 1e6,
                p.cache_write / 1e6,
                p.currency,
            )
        i, o, cr, cw = _UNIT_PRICES
        return i, o, cr, cw, "token-units"

    def evaluate(
        self, state: MeterState, task: TaskContext | None = None
    ) -> Recommendation:
        p_in, p_out, p_cr, p_cw, unit = self._per_token_prices()
        horizon = task.expected_remaining_turns if task else None
        horizon_source = "task" if horizon is not None else "default"
        k = horizon if horizon is not None else self.default_horizon

        t_pre = state.used_tokens
        t_post = int(t_pre * self.compaction_ratio)
        t_sum = int(t_pre * self.summary_output_ratio)
        t_hand = int(t_pre * self.handoff_prompt_ratio)

        inputs: dict[str, Any] = {
            "t_pre": t_pre,
            "velocity": state.velocity,
            "horizon": k,
            "horizon_source": horizon_source,
            "prices_per_mtok": (
                self.pricing.to_dict() if self.pricing else "unit ratios (provisional)"
            ),
            "compaction_ratio": self.compaction_ratio,
            "summary_output_ratio": self.summary_output_ratio,
            "handoff_prompt_ratio": self.handoff_prompt_ratio,
            "expected_compaction_loss": self.expected_compaction_loss,
            "expected_handoff_loss": self.expected_handoff_loss,
            "human_friction": self.human_friction,
            "task_criticality": task.task_criticality.value if task else None,
        }

        exhausted = state.headroom_effective <= 0
        if state.eta_turns is None and not exhausted:
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

        saving_per_turn_compact = (t_pre - t_post) * p_cr
        saving_per_turn_handoff = (t_pre - t_hand) * p_cr
        one_time_compact = t_sum * p_out + t_post * (p_cw - p_cr)
        one_time_handoff = t_hand * p_out + t_hand * (p_cw - p_cr)
        info_compact = self.expected_compaction_loss * t_pre * p_in
        info_handoff = self.expected_handoff_loss * t_pre * p_in

        k_star = (
            one_time_compact / saving_per_turn_compact
            if saving_per_turn_compact > 0
            else None
        )
        k_star_with_info = (
            (one_time_compact + info_compact) / saving_per_turn_compact
            if saving_per_turn_compact > 0
            else None
        )

        net_compact = one_time_compact + info_compact - k * saving_per_turn_compact
        net_handoff = (
            one_time_handoff
            + info_handoff
            + self.human_friction
            - k * saving_per_turn_handoff
        )

        overflow = (
            not exhausted
            and state.eta_turns is not None
            and state.eta_turns.expected < k
        )
        continue_feasible = not exhausted and not overflow
        net_continue = 0.0 if continue_feasible else None

        candidates: dict[Action, float] = {
            Action.COMPACT: net_compact,
            Action.HANDOFF: net_handoff,
        }
        if continue_feasible:
            candidates[Action.CONTINUE] = 0.0
        action = min(candidates, key=candidates.__getitem__)
        chosen_net = candidates[action]

        if action is Action.CONTINUE:
            urgency = Urgency.NONE
            expected = EffectEstimate(
                tokens_spent=0, tokens_freed=0, cost_delta=0.0, fidelity_risk=0.0
            )
        else:
            urgency = Urgency.NOW if not continue_feasible else Urgency.SOON
            if action is Action.COMPACT:
                expected = EffectEstimate(
                    tokens_spent=t_sum,
                    tokens_freed=t_pre - t_post,
                    cost_delta=chosen_net,
                    fidelity_risk=self.expected_compaction_loss,
                )
            else:
                expected = EffectEstimate(
                    tokens_spent=t_hand,
                    tokens_freed=t_pre - t_hand,
                    cost_delta=chosen_net,
                    fidelity_risk=self.expected_handoff_loss,
                )

        continue_text = (
            f"{net_continue:+.4f}" if net_continue is not None else "infeasible"
        )
        comparison = (
            f"min over k={k}: continue {continue_text}, "
            f"compact {net_compact:+.4f}, handoff {net_handoff:+.4f} {unit} "
            f"-> {action.value}"
        )

        return Recommendation(
            action=action,
            urgency=urgency,
            rationale=RationaleTrace(
                inputs=inputs,
                derived={
                    "ledger_unit": unit,
                    "k_star": k_star,
                    "k_star_with_info": k_star_with_info,
                    "net_compact": net_compact,
                    "net_handoff": net_handoff,
                    "one_time_compact": one_time_compact,
                    "one_time_handoff": one_time_handoff,
                    "saving_per_turn_compact": saving_per_turn_compact,
                    "overflow_within_horizon": overflow,
                    "exhausted": exhausted,
                    "t_post": t_post,
                    "t_sum": t_sum,
                    "t_hand": t_hand,
                },
                comparison=comparison,
            ),
            expected=expected,
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
    "CostModelPolicy",
]
