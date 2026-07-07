"""Tests for the handoff fidelity protocol, fully offline via stub adapters."""

import pytest

from tokenmaster import (
    ExactMatchJudge,
    FidelityReport,
    HandoffEvaluated,
    Meter,
    Probe,
    ProbeCategory,
    evaluate_handoff,
    event_from_dict,
)
from tokenmaster.types import ModelProfile


def probe(pid, category, question, gold, weight=1.0):
    return Probe(
        id=pid,
        category=category,
        question=question,
        gold_answer=gold,
        weight=weight,
    )


PROBES = [
    probe("p1", ProbeCategory.OBJECTIVE, "What is being built?", "a tokenmeter"),
    probe("p2", ProbeCategory.DECISIONS, "Which license was chosen?", "MIT"),
    probe("p3", ProbeCategory.STATE, "How many tests pass?", "80"),
]


class ScriptedAnswerer:
    """Answers from a fixed mapping; empty string for unknown questions."""

    name = "scripted"

    def __init__(self, answers):
        self.answers = answers

    def answer(self, handoff_artifact, question):
        return self.answers.get(question, "")


def test_probe_round_trip_and_weight_validation():
    p = PROBES[0]
    assert Probe.from_dict(p.to_dict()) == p
    with pytest.raises(ValueError):
        probe("bad", ProbeCategory.STATE, "q", "a", weight=0)


def test_exact_match_judge_is_normalized_containment():
    j = ExactMatchJudge()
    assert j.judge("q", "MIT", "The license is   mit.")[0] is True
    assert j.judge("q", "42", "it is 42, confirmed")[0] is True
    assert j.judge("q", "MIT", "Apache-2.0")[0] is False


def test_perfect_handoff_scores_one():
    answerer = ScriptedAnswerer(
        {
            "What is being built?": "We are building a tokenmeter for LLMs.",
            "Which license was chosen?": "MIT",
            "How many tests pass?": "All 80 of them.",
        }
    )
    report = evaluate_handoff("artifact", answerer=answerer, probes=PROBES)
    assert report.score == pytest.approx(1.0)
    assert report.per_category == {
        "objective": 1.0,
        "decisions": 1.0,
        "state": 1.0,
    }
    assert report.answerer == "scripted"
    assert report.judge == "exact-match"


def test_weighted_partial_score_and_per_category():
    probes = [
        probe("a", ProbeCategory.OBJECTIVE, "Q1?", "alpha", weight=1.0),
        probe("b", ProbeCategory.DECISIONS, "Q2?", "beta", weight=3.0),
    ]
    answerer = ScriptedAnswerer({"Q1?": "alpha", "Q2?": "wrong"})
    report = evaluate_handoff("artifact", answerer=answerer, probes=probes)
    assert report.score == pytest.approx(0.25)
    assert report.per_category["objective"] == pytest.approx(1.0)
    assert report.per_category["decisions"] == pytest.approx(0.0)


def test_unanswerable_probe_counts_zero_and_is_flagged():
    answerer = ScriptedAnswerer({"What is being built?": "a tokenmeter"})
    report = evaluate_handoff(
        "artifact", answerer=answerer, probes=PROBES[:2]
    )
    outcomes = {o.probe.id: o for o in report.outcomes}
    assert outcomes["p2"].answerable is False
    assert outcomes["p2"].correct is False
    assert outcomes["p2"].answer is None
    assert report.score == pytest.approx(0.5)


def test_requires_probes_or_generator():
    with pytest.raises(ValueError):
        evaluate_handoff("artifact", answerer=ScriptedAnswerer({}))


def test_generator_path_records_seed_and_name():
    class StubGenerator:
        name = "stub-generator"

        def generate(self, source_context, n, seed=None):
            assert source_context == "the source"
            assert seed == 1234
            return PROBES[:n]

    answerer = ScriptedAnswerer(
        {"What is being built?": "a tokenmeter", "Which license was chosen?": "MIT"}
    )
    report = evaluate_handoff(
        "artifact",
        answerer=answerer,
        source_context="the source",
        probe_generator=StubGenerator(),
        n=2,
        seed=1234,
    )
    assert report.generator == "stub-generator"
    assert report.seed == 1234
    assert len(report.outcomes) == 2


def test_caveats_recorded_for_naive_pieces():
    answerer = ScriptedAnswerer({"What is being built?": "a tokenmeter"})
    report = evaluate_handoff("artifact", answerer=answerer, probes=PROBES[:1])
    joined = " ".join(report.caveats)
    assert "answerability" in joined
    assert "containment" in joined


def test_report_json_round_trip():
    answerer = ScriptedAnswerer({"What is being built?": "a tokenmeter"})
    report = evaluate_handoff("artifact", answerer=answerer, probes=PROBES[:1])
    back = FidelityReport.from_dict(report.to_dict())
    assert back == report


def test_meter_report_handoff_emits_event_with_wire_round_trip():
    m = Meter(
        ModelProfile(model_id="test:model", provider="test", window_nominal=1_000)
    )
    m.record({"input_tokens": 500})
    seen = []
    m.subscribe(seen.append)
    answerer = ScriptedAnswerer({"What is being built?": "a tokenmeter"})
    report = evaluate_handoff("artifact", answerer=answerer, probes=PROBES[:1])
    m.report_handoff(report)
    events = [e for e in seen if isinstance(e, HandoffEvaluated)]
    assert len(events) == 1
    assert events[0].report == report
    assert events[0].turn_id == 1
    back = event_from_dict(events[0].to_dict())
    assert back == events[0]
