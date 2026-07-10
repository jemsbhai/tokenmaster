//! Tests for the advisor framework: ThresholdPolicy, PredictivePolicy,
//! CostModelPolicy. Mirrors python/tokenmaster/tests/test_advisor.py.
//!
//! CostModelPolicy reference numbers. Pricing per Mtok: in 2.0, out 10.0,
//! cache_read 0.2, cache_write 2.5 (per token: 2e-6, 1e-5, 2e-7, 2.5e-6).
//! Meter: window 1,000,000; totals 97k, 98k, 99k, 100k -> velocity 1,000,
//! used T_pre = 100,000, eta expected = 900.
//! Ratios (defaults): T_post 15,000; T_sum 10,000; T_hand 5,000.
//!
//!   one_time_compact = 10,000*1e-5 + 15,000*(2.5e-6 - 2e-7) = 0.1345
//!   saving_per_turn  = 85,000*2e-7 = 0.017
//!   k*               = 0.1345 / 0.017 = 7.9118
//!   info_compact     = 0.10*100,000*2e-6 = 0.02
//!   net_compact(k)   = 0.1545 - 0.017k
//!   one_time_handoff = 5,000*1e-5 + 5,000*2.3e-6 = 0.0615
//!   info_handoff     = 0.20*100,000*2e-6 = 0.04
//!   net_handoff(k)   = 0.1015 + friction - 0.019k

use serde_json::json;
use tokenmaster::{
    Action, CostModelConfig, CostModelPolicy, EffectEstimate, Error, Event, EventKind, Meter,
    MeterConfig, MeterState, ModelProfile, Policy, PredictivePolicy, Pricing, RationaleTrace,
    Recommendation, TaskContext, TaskCriticality, ThresholdPolicy, Urgency, SCHEMA_VERSION,
};

/// pytest.approx defaults: rel 1e-6, abs 1e-12.
fn approx(actual: f64, expected: f64) {
    let tolerance = (1e-6 * expected.abs()).max(1e-12);
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} != {expected}"
    );
}

fn profile(window: i64) -> ModelProfile {
    ModelProfile::new("test:model", "test", window).unwrap()
}

fn meter_at(total: i64, window: i64) -> Meter {
    let mut m = Meter::new(profile(window)).unwrap();
    m.record_value(&json!({ "input_tokens": total })).unwrap();
    m
}

fn steady_meter(totals: &[i64], window: i64) -> Meter {
    let mut m = Meter::new(profile(window)).unwrap();
    for total in totals {
        m.record_value(&json!({ "input_tokens": total })).unwrap();
    }
    m
}

fn pricing() -> Pricing {
    Pricing {
        input: 2.0,
        output: 10.0,
        cache_read: 0.2,
        cache_write: 2.5,
        currency: "USD".to_string(),
        as_of: Some("2026-07-07".to_string()),
    }
}

fn cost_meter(window: i64) -> Meter {
    steady_meter(&[97_000, 98_000, 99_000, 100_000], window)
}

// ------------------------------------------------------------------------ //
// ThresholdPolicy through Meter::advise

#[test]
fn green_fill_recommends_continue() {
    let rec = meter_at(300, 1_000).advise(None, None);
    assert_eq!(rec.action, Action::Continue);
    assert_eq!(rec.urgency, Urgency::None);
    assert!(rec.rationale.comparison.contains("fill 0.300"));
}

#[test]
fn warn_band_recommends_compact_soon() {
    let rec = meter_at(750, 1_000).advise(None, None);
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Soon);
}

#[test]
fn critical_fill_recommends_compact_now() {
    let rec = meter_at(900, 1_000).advise(None, None);
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
}

#[test]
fn exhausted_headroom_recommends_compact_now_with_reason() {
    let rec = meter_at(1_100, 1_000).advise(None, None);
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
    assert!(rec.rationale.comparison.contains("exhausted"));
}

#[test]
fn default_policy_aligns_with_meter_thresholds() {
    let mut m = Meter::with_config(
        profile(1_000),
        MeterConfig {
            caution: 0.50,
            critical: 0.60,
            ..MeterConfig::default()
        },
    )
    .unwrap();
    m.record_value(&json!({ "input_tokens": 550 })).unwrap();
    let rec = m.advise(None, None);
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Soon);
    assert_eq!(rec.rationale.inputs["warn_at"], json!(0.50));
    assert_eq!(rec.rationale.inputs["compact_at"], json!(0.60));
}

#[test]
fn baseline_estimates_no_effects() {
    let rec = meter_at(900, 1_000).advise(None, None);
    assert_eq!(rec.expected.tokens_spent, None);
    assert_eq!(rec.expected.tokens_freed, None);
    assert_eq!(rec.expected.cost_delta, None);
    assert_eq!(rec.expected.fidelity_risk, None);
}

#[test]
fn advise_emits_event_with_wire_round_trip() {
    let mut m = meter_at(900, 1_000);
    let before = m.events().len();
    let rec = m.advise(None, None);
    let advisor_events: Vec<&Event> = m.events()[before..]
        .iter()
        .filter(|e| matches!(e.kind, EventKind::AdvisorRecommendation { .. }))
        .collect();
    assert_eq!(advisor_events.len(), 1);
    let event = advisor_events[0];
    assert_eq!(event.turn_id, Some(1));
    match &event.kind {
        EventKind::AdvisorRecommendation { recommendation } => {
            assert_eq!(*recommendation, rec);
        }
        other => panic!("expected AdvisorRecommendation, got {other:?}"),
    }
    let back = Event::from_value(&serde_json::to_value(event).unwrap()).unwrap();
    assert_eq!(&back, event);
}

#[test]
fn task_context_appears_in_rationale_and_round_trips() {
    let task = TaskContext {
        expected_remaining_turns: Some(7),
        task_criticality: TaskCriticality::High,
    };
    let rec = meter_at(300, 1_000).advise(Some(&task), None);
    assert_eq!(rec.rationale.inputs["expected_remaining_turns"], json!(7));
    let back = TaskContext::from_value(&serde_json::to_value(task).unwrap()).unwrap();
    assert_eq!(back, task);
}

#[test]
fn custom_policy_injection() {
    struct AlwaysHandoff;

    impl Policy for AlwaysHandoff {
        fn policy_id(&self) -> &str {
            "always-handoff"
        }

        fn evaluate(&self, _state: &MeterState, _task: Option<&TaskContext>) -> Recommendation {
            Recommendation {
                action: Action::Handoff,
                urgency: Urgency::Now,
                rationale: RationaleTrace {
                    comparison: "stub".to_string(),
                    ..RationaleTrace::default()
                },
                expected: EffectEstimate::default(),
                policy_id: self.policy_id().to_string(),
                schema_version: SCHEMA_VERSION.to_string(),
            }
        }
    }

    let rec = meter_at(100, 1_000).advise(None, Some(&AlwaysHandoff));
    assert_eq!(rec.action, Action::Handoff);
    assert_eq!(rec.policy_id, "always-handoff");
}

#[test]
fn threshold_policy_validation() {
    let err = ThresholdPolicy::new(0.9, 0.8).unwrap_err();
    assert_eq!(
        err.to_string(),
        "thresholds must satisfy 0 < warn_at < compact_at <= 1"
    );
}

// ------------------------------------------------------------------------ //
// PredictivePolicy

#[test]
fn predictive_continue_when_coverage_ample() {
    // velocity 100, used 1300, headroom 98700 -> conservative eta 987
    let mut m = steady_meter(&[1_000, 1_100, 1_200, 1_300], 100_000);
    let task = TaskContext {
        expected_remaining_turns: Some(10),
        ..TaskContext::default()
    };
    let rec = m.advise(Some(&task), Some(&PredictivePolicy::new()));
    assert_eq!(rec.action, Action::Continue);
    assert_eq!(rec.urgency, Urgency::None);
    assert!(rec.rationale.comparison.contains("covers horizon 10"));
    assert_eq!(rec.rationale.derived["required_turns"], json!(13));
    assert_eq!(rec.rationale.derived["projected_used_at_horizon"], json!(2_300));
}

#[test]
fn predictive_acts_now_when_eta_below_horizon() {
    let mut m = steady_meter(&[1_000, 1_100, 1_200, 1_300], 100_000);
    let task = TaskContext {
        expected_remaining_turns: Some(2_000),
        ..TaskContext::default()
    };
    let rec = m.advise(Some(&task), Some(&PredictivePolicy::new()));
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
    assert!(rec.rationale.comparison.contains("< horizon 2000"));
}

#[test]
fn predictive_soon_when_buffer_margin_eaten() {
    // conservative eta 987.0; horizon 985 -> covers task, eats the buffer
    let mut m = steady_meter(&[1_000, 1_100, 1_200, 1_300], 100_000);
    let task = TaskContext {
        expected_remaining_turns: Some(985),
        ..TaskContext::default()
    };
    let rec = m.advise(Some(&task), Some(&PredictivePolicy::new()));
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Soon);
}

#[test]
fn predictive_without_horizon_guards_buffer() {
    // velocity 200, used 800, headroom 200 -> conservative eta 1.0
    let mut m = steady_meter(&[400, 600, 800], 1_000);
    let rec = m.advise(None, Some(&PredictivePolicy::new()));
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
    assert!(rec.rationale.comparison.contains("horizon unknown"));
}

#[test]
fn predictive_cold_start_delegates_to_fallback() {
    let mut m = meter_at(900, 1_000);
    let rec = m.advise(None, Some(&PredictivePolicy::new()));
    assert_eq!(rec.policy_id, "predictive");
    assert_eq!(rec.rationale.derived["delegated_to"], json!("threshold"));
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
    assert!(rec.rationale.comparison.contains("delegated to threshold"));
}

#[test]
fn predictive_exhausted_headroom_acts_now() {
    let mut m = steady_meter(&[400, 700, 1_100], 1_000);
    let rec = m.advise(None, Some(&PredictivePolicy::new()));
    assert_eq!(rec.action, Action::Compact);
    assert_eq!(rec.urgency, Urgency::Now);
    assert!(rec.rationale.comparison.contains("exhausted"));
}

#[test]
fn predictive_parameter_validation() {
    assert!(matches!(
        PredictivePolicy::with_params(-1, 2.0),
        Err(Error::Value(_))
    ));
    assert!(matches!(
        PredictivePolicy::with_params(3, 0.5),
        Err(Error::Value(_))
    ));
}

// ------------------------------------------------------------------------ //
// CostModelPolicy

#[test]
fn cost_model_k_star_matches_contract_formula() {
    let task = TaskContext {
        expected_remaining_turns: Some(3),
        ..TaskContext::default()
    };
    let rec = cost_meter(1_000_000).advise(Some(&task), Some(&CostModelPolicy::new(Some(pricing()))));
    approx(
        rec.rationale.derived["k_star"].as_f64().unwrap(),
        0.1345 / 0.017,
    );
    approx(
        rec.rationale.derived["k_star_with_info"].as_f64().unwrap(),
        0.1545 / 0.017,
    );
}

#[test]
fn cost_model_continue_below_break_even() {
    let task = TaskContext {
        expected_remaining_turns: Some(3),
        ..TaskContext::default()
    };
    let rec = cost_meter(1_000_000).advise(Some(&task), Some(&CostModelPolicy::new(Some(pricing()))));
    assert_eq!(rec.action, Action::Continue);
    assert_eq!(rec.urgency, Urgency::None);
    assert_eq!(rec.expected.cost_delta, Some(0.0));
    approx(
        rec.rationale.derived["net_compact"].as_f64().unwrap(),
        0.1545 - 3.0 * 0.017,
    );
}

#[test]
fn cost_model_handoff_wins_long_horizon_zero_friction() {
    let task = TaskContext {
        expected_remaining_turns: Some(20),
        ..TaskContext::default()
    };
    let rec = cost_meter(1_000_000).advise(Some(&task), Some(&CostModelPolicy::new(Some(pricing()))));
    assert_eq!(rec.action, Action::Handoff);
    assert_eq!(rec.urgency, Urgency::Soon);
    approx(rec.expected.cost_delta.unwrap(), 0.1015 - 20.0 * 0.019);
    approx(rec.expected.fidelity_risk.unwrap(), 0.20);
    assert_eq!(rec.expected.tokens_freed, Some(95_000));
}

#[test]
fn cost_model_friction_flips_choice_to_compact() {
    let task = TaskContext {
        expected_remaining_turns: Some(20),
        ..TaskContext::default()
    };
    let policy = CostModelPolicy::with_config(
        Some(pricing()),
        CostModelConfig {
            human_friction: 0.5,
            ..CostModelConfig::default()
        },
    )
    .unwrap();
    let rec = cost_meter(1_000_000).advise(Some(&task), Some(&policy));
    assert_eq!(rec.action, Action::Compact);
    approx(rec.expected.cost_delta.unwrap(), 0.1545 - 20.0 * 0.017);
    assert_eq!(rec.expected.tokens_spent, Some(10_000));
    assert_eq!(rec.expected.tokens_freed, Some(85_000));
    approx(rec.expected.fidelity_risk.unwrap(), 0.10);
}

#[test]
fn cost_model_overflow_within_horizon_forces_action_now() {
    // window 105,000 -> headroom 5,000, eta expected 5 < k=20
    let task = TaskContext {
        expected_remaining_turns: Some(20),
        ..TaskContext::default()
    };
    let rec = cost_meter(105_000).advise(Some(&task), Some(&CostModelPolicy::new(Some(pricing()))));
    assert_ne!(rec.action, Action::Continue);
    assert_eq!(rec.urgency, Urgency::Now);
    assert_eq!(rec.rationale.derived["overflow_within_horizon"], json!(true));
    assert!(rec.rationale.comparison.contains("infeasible"));
}

#[test]
fn cost_model_exhausted_picks_cheaper_action_now() {
    let rec = cost_meter(90_000).advise(None, Some(&CostModelPolicy::new(Some(pricing()))));
    assert_ne!(rec.action, Action::Continue);
    assert_eq!(rec.urgency, Urgency::Now);
    assert_eq!(rec.rationale.derived["exhausted"], json!(true));
}

#[test]
fn cost_model_without_pricing_uses_unit_ledger() {
    let task = TaskContext {
        expected_remaining_turns: Some(20),
        ..TaskContext::default()
    };
    let rec = cost_meter(1_000_000).advise(Some(&task), Some(&CostModelPolicy::new(None)));
    assert_eq!(rec.rationale.derived["ledger_unit"], json!("token-units"));
    assert!(rec.rationale.comparison.contains("token-units"));
}

#[test]
fn cost_model_cold_start_delegates() {
    let mut m = meter_at(900, 1_000);
    let rec = m.advise(None, Some(&CostModelPolicy::new(Some(pricing()))));
    assert_eq!(rec.policy_id, "cost-model");
    assert_eq!(rec.rationale.derived["delegated_to"], json!("threshold"));
    assert_eq!(rec.action, Action::Compact);
}

#[test]
fn cost_model_parameter_validation() {
    let bad = |config: CostModelConfig| CostModelPolicy::with_config(Some(pricing()), config);
    assert!(matches!(
        bad(CostModelConfig {
            compaction_ratio: 0.0,
            ..CostModelConfig::default()
        }),
        Err(Error::Value(_))
    ));
    assert!(matches!(
        bad(CostModelConfig {
            expected_handoff_loss: 1.5,
            ..CostModelConfig::default()
        }),
        Err(Error::Value(_))
    ));
    assert!(matches!(
        bad(CostModelConfig {
            human_friction: -0.1,
            ..CostModelConfig::default()
        }),
        Err(Error::Value(_))
    ));
    assert!(matches!(
        bad(CostModelConfig {
            default_horizon: 0,
            ..CostModelConfig::default()
        }),
        Err(Error::Value(_))
    ));
}
