"""Tests for the advisor framework and the ThresholdPolicy baseline."""

import pytest

from tokenmaster import (
    Action,
    AdvisorRecommendation,
    Meter,
    Recommendation,
    TaskContext,
    TaskCriticality,
    ThresholdPolicy,
    Urgency,
    event_from_dict,
)
from tokenmaster.types import ModelProfile


def profile(window=1_000):
    return ModelProfile(
        model_id="test:model", provider="test", window_nominal=window
    )


def meter_at(total, window=1_000):
    m = Meter(profile(window=window))
    m.record({"input_tokens": total})
    return m


def test_green_fill_recommends_continue():
    rec = meter_at(300).advise()
    assert rec.action is Action.CONTINUE
    assert rec.urgency is Urgency.NONE
    assert "fill 0.300" in rec.rationale.comparison


def test_warn_band_recommends_compact_soon():
    rec = meter_at(750).advise()
    assert rec.action is Action.COMPACT
    assert rec.urgency is Urgency.SOON


def test_critical_fill_recommends_compact_now():
    rec = meter_at(900).advise()
    assert rec.action is Action.COMPACT
    assert rec.urgency is Urgency.NOW


def test_exhausted_headroom_recommends_compact_now_with_reason():
    rec = meter_at(1_100).advise()
    assert rec.action is Action.COMPACT
    assert rec.urgency is Urgency.NOW
    assert "exhausted" in rec.rationale.comparison


def test_default_policy_aligns_with_meter_thresholds():
    m = Meter(profile(), caution=0.50, critical=0.60)
    m.record({"input_tokens": 550})
    rec = m.advise()
    assert rec.action is Action.COMPACT
    assert rec.urgency is Urgency.SOON
    assert rec.rationale.inputs["warn_at"] == 0.50
    assert rec.rationale.inputs["compact_at"] == 0.60


def test_baseline_estimates_no_effects():
    rec = meter_at(900).advise()
    expected = rec.expected
    assert expected.tokens_spent is None
    assert expected.tokens_freed is None
    assert expected.cost_delta is None
    assert expected.fidelity_risk is None


def test_advise_emits_event_with_wire_round_trip():
    m = meter_at(900)
    seen = []
    m.subscribe(seen.append)
    rec = m.advise()
    events = [e for e in seen if isinstance(e, AdvisorRecommendation)]
    assert len(events) == 1
    assert events[0].recommendation == rec
    assert events[0].turn_id == 1
    back = event_from_dict(events[0].to_dict())
    assert back == events[0]


def test_task_context_appears_in_rationale_and_round_trips():
    task = TaskContext(expected_remaining_turns=7,
                       task_criticality=TaskCriticality.HIGH)
    rec = meter_at(300).advise(task)
    assert rec.rationale.inputs["expected_remaining_turns"] == 7
    assert TaskContext.from_dict(task.to_dict()) == task


def test_custom_policy_injection():
    class AlwaysHandoff:
        policy_id = "always-handoff"

        def evaluate(self, state, task=None):
            from tokenmaster import EffectEstimate, RationaleTrace

            return Recommendation(
                action=Action.HANDOFF,
                urgency=Urgency.NOW,
                rationale=RationaleTrace(comparison="stub"),
                expected=EffectEstimate(),
                policy_id=self.policy_id,
            )

    rec = meter_at(100).advise(policy=AlwaysHandoff())
    assert rec.action is Action.HANDOFF
    assert rec.policy_id == "always-handoff"


def test_threshold_policy_validation():
    with pytest.raises(ValueError):
        ThresholdPolicy(warn_at=0.9, compact_at=0.8)
