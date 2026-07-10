//! Tests for the handoff fidelity protocol, fully offline via stub
//! adapters. Mirrors python/tokenmaster/tests/test_fidelity.py.

use std::collections::HashMap;

use serde_json::json;
use tokenmaster::{
    evaluate_handoff, evaluate_handoff_with, Answerer, Error, EvaluateOptions, Event,
    EventKind, ExactMatchJudge, FidelityReport, Judge, Meter, ModelProfile, Probe,
    ProbeCategory, ProbeGenerator,
};

fn probe(id: &str, category: ProbeCategory, question: &str, gold: &str, weight: f64) -> Probe {
    Probe::new(id, category, question, gold, weight).unwrap()
}

fn probes() -> Vec<Probe> {
    vec![
        probe(
            "p1",
            ProbeCategory::Objective,
            "What is being built?",
            "a tokenmeter",
            1.0,
        ),
        probe(
            "p2",
            ProbeCategory::Decisions,
            "Which license was chosen?",
            "MIT",
            1.0,
        ),
        probe("p3", ProbeCategory::State, "How many tests pass?", "80", 1.0),
    ]
}

/// Answers from a fixed mapping; empty string for unknown questions.
struct ScriptedAnswerer {
    answers: HashMap<String, String>,
}

impl ScriptedAnswerer {
    fn new(pairs: &[(&str, &str)]) -> ScriptedAnswerer {
        ScriptedAnswerer {
            answers: pairs
                .iter()
                .map(|(q, a)| (q.to_string(), a.to_string()))
                .collect(),
        }
    }
}

impl Answerer for ScriptedAnswerer {
    fn name(&self) -> &str {
        "scripted"
    }

    fn answer(&self, _handoff_artifact: &str, question: &str) -> Result<String, Error> {
        Ok(self.answers.get(question).cloned().unwrap_or_default())
    }
}

fn approx(actual: f64, expected: f64) {
    let tolerance = (1e-6 * expected.abs()).max(1e-12);
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} != {expected}"
    );
}

#[test]
fn probe_round_trip_and_weight_validation() {
    let p = probes().remove(0);
    let back = Probe::from_value(&serde_json::to_value(&p).unwrap()).unwrap();
    assert_eq!(back, p);
    let bad = Probe::new("bad", ProbeCategory::State, "q", "a", 0.0);
    assert!(matches!(&bad, Err(Error::Value(_))));
    assert_eq!(
        bad.unwrap_err().to_string(),
        "probe weight must be positive"
    );
}

#[test]
fn exact_match_judge_is_normalized_containment() {
    let j = ExactMatchJudge;
    assert!(j.judge("q", "MIT", "The license is   mit.").unwrap().0);
    assert!(j.judge("q", "42", "it is 42, confirmed").unwrap().0);
    assert!(!j.judge("q", "MIT", "Apache-2.0").unwrap().0);
}

#[test]
fn perfect_handoff_scores_one() {
    let answerer = ScriptedAnswerer::new(&[
        (
            "What is being built?",
            "We are building a tokenmeter for LLMs.",
        ),
        ("Which license was chosen?", "MIT"),
        ("How many tests pass?", "All 80 of them."),
    ]);
    let report = evaluate_handoff("artifact", &answerer, &probes()).unwrap();
    approx(report.score, 1.0);
    let expected: std::collections::BTreeMap<String, f64> =
        [("objective", 1.0), ("decisions", 1.0), ("state", 1.0)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
    assert_eq!(report.per_category, expected);
    assert_eq!(report.answerer.as_deref(), Some("scripted"));
    assert_eq!(report.judge.as_deref(), Some("exact-match"));
}

#[test]
fn weighted_partial_score_and_per_category() {
    let weighted = vec![
        probe("a", ProbeCategory::Objective, "Q1?", "alpha", 1.0),
        probe("b", ProbeCategory::Decisions, "Q2?", "beta", 3.0),
    ];
    let answerer = ScriptedAnswerer::new(&[("Q1?", "alpha"), ("Q2?", "wrong")]);
    let report = evaluate_handoff("artifact", &answerer, &weighted).unwrap();
    approx(report.score, 0.25);
    approx(report.per_category["objective"], 1.0);
    approx(report.per_category["decisions"], 0.0);
}

#[test]
fn unanswerable_probe_counts_zero_and_is_flagged() {
    let answerer = ScriptedAnswerer::new(&[("What is being built?", "a tokenmeter")]);
    let report = evaluate_handoff("artifact", &answerer, &probes()[..2]).unwrap();
    let p2 = report
        .outcomes
        .iter()
        .find(|o| o.probe.id == "p2")
        .expect("p2 outcome");
    assert!(!p2.answerable);
    assert!(!p2.correct);
    assert_eq!(p2.answer, None);
    approx(report.score, 0.5);
}

#[test]
fn requires_probes_or_generator() {
    let answerer = ScriptedAnswerer::new(&[]);
    let result = evaluate_handoff_with("artifact", EvaluateOptions::new(&answerer));
    assert!(matches!(&result, Err(Error::Value(_))));
    assert_eq!(
        result.unwrap_err().to_string(),
        "supply probes, or source_context with a probe_generator"
    );
}

#[test]
fn generator_path_records_seed_and_name() {
    struct StubGenerator;

    impl ProbeGenerator for StubGenerator {
        fn name(&self) -> &str {
            "stub-generator"
        }

        fn generate(
            &self,
            source_context: &str,
            n: usize,
            seed: Option<i64>,
        ) -> Result<Vec<Probe>, Error> {
            assert_eq!(source_context, "the source");
            assert_eq!(seed, Some(1234));
            Ok(probes().into_iter().take(n).collect())
        }
    }

    let answerer = ScriptedAnswerer::new(&[
        ("What is being built?", "a tokenmeter"),
        ("Which license was chosen?", "MIT"),
    ]);
    let generator = StubGenerator;
    let report = evaluate_handoff_with(
        "artifact",
        EvaluateOptions {
            source_context: Some("the source"),
            probe_generator: Some(&generator),
            n: 2,
            seed: Some(1234),
            ..EvaluateOptions::new(&answerer)
        },
    )
    .unwrap();
    assert_eq!(report.generator.as_deref(), Some("stub-generator"));
    assert_eq!(report.seed, Some(1234));
    assert_eq!(report.outcomes.len(), 2);
}

#[test]
fn caveats_recorded_for_naive_pieces() {
    let answerer = ScriptedAnswerer::new(&[("What is being built?", "a tokenmeter")]);
    let report = evaluate_handoff("artifact", &answerer, &probes()[..1]).unwrap();
    let joined = report.caveats.join(" ");
    assert!(joined.contains("answerability"));
    assert!(joined.contains("containment"));
}

#[test]
fn report_json_round_trip() {
    let answerer = ScriptedAnswerer::new(&[("What is being built?", "a tokenmeter")]);
    let report = evaluate_handoff("artifact", &answerer, &probes()[..1]).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
    let back = FidelityReport::from_value(&parsed).unwrap();
    assert_eq!(back, report);
}

#[test]
fn meter_report_handoff_emits_event_with_wire_round_trip() {
    let mut m = Meter::new(ModelProfile::new("test:model", "test", 1_000).unwrap()).unwrap();
    m.record_value(&json!({ "input_tokens": 500 })).unwrap();
    let answerer = ScriptedAnswerer::new(&[("What is being built?", "a tokenmeter")]);
    let report = evaluate_handoff("artifact", &answerer, &probes()[..1]).unwrap();
    let before = m.events().len();
    m.report_handoff(report.clone());
    let handoff_events: Vec<&Event> = m.events()[before..]
        .iter()
        .filter(|e| matches!(e.kind, EventKind::HandoffEvaluated { .. }))
        .collect();
    assert_eq!(handoff_events.len(), 1);
    let event = handoff_events[0];
    assert_eq!(event.turn_id, Some(1));
    match &event.kind {
        EventKind::HandoffEvaluated { report: carried } => {
            assert_eq!(*carried, report);
        }
        other => panic!("expected HandoffEvaluated, got {other:?}"),
    }
    let back = Event::from_value(&serde_json::to_value(event).unwrap()).unwrap();
    assert_eq!(&back, event);
}
