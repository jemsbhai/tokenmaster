//! Tests for Meter state computation against hand-computed values.
//!
//! Mirrors python/tokenmaster/tests/test_meter.py one to one. The EWMA
//! reference sequence, alpha = 0.3, context totals 1000, 1300, 1650, 2100:
//!
//!   g2 = 300 -> mean = 300.0, var = 0.0
//!   g3 = 350 -> diff = 50,  incr = 15.0,  mean = 315.0
//!               var = 0.7 * (0 + 50 * 15.0) = 525.0
//!   g4 = 450 -> diff = 135, incr = 40.5,  mean = 355.5
//!               var = 0.7 * (525 + 135 * 40.5) = 4194.75
//!
//!   velocity = 355.5, velocity_std = sqrt(4194.75) = 64.76688...
//!   headroom (nominal window 10000, reserve 0) = 10000 - 2100 = 7900
//!   eta expected = 7900 / 355.5 = 22.22222...
//!   eta conservative = 7900 / (355.5 + 64.76688) = 18.79285...

use serde_json::json;
use tokenmaster::{
    Breakdown, CalibrationRecord, Error, Meter, MeterConfig, ModelProfile, TurnUsage, Zone,
    SCHEMA_VERSION,
};

fn profile(window: i64) -> ModelProfile {
    ModelProfile::new("test:model", "test", window).unwrap()
}

fn meter(window: i64) -> Meter {
    Meter::new(profile(window)).unwrap()
}

/// Record a turn whose context_total equals `total` (all in input_tokens).
fn record_total(m: &mut Meter, total: i64) {
    m.record_value(&json!({ "input_tokens": total })).unwrap();
}

fn approx(actual: f64, expected: f64) {
    let tolerance = 1e-9_f64.max(1e-9 * expected.abs());
    assert!(
        (actual - expected).abs() <= tolerance,
        "{actual} != {expected}"
    );
}

#[test]
fn empty_meter_state() {
    let m = meter(10_000);
    let s = m.state();
    assert_eq!(s.turns, 0);
    assert_eq!(s.used_tokens, 0);
    assert_eq!(s.velocity, None);
    assert_eq!(s.eta_turns, None);
    assert_eq!(s.zone, Zone::Green);
    assert!(s.provenance["velocity"].contains("cold start"));
}

#[test]
fn used_tokens_is_latest_context_total_not_a_sum() {
    let mut m = meter(10_000);
    record_total(&mut m, 1_000);
    record_total(&mut m, 1_300);
    assert_eq!(m.state().used_tokens, 1_300);
}

#[test]
fn cold_start_hides_velocity_until_three_turns() {
    let mut m = meter(10_000);
    record_total(&mut m, 1_000);
    record_total(&mut m, 1_300);
    let s = m.state();
    assert_eq!(s.turns, 2);
    assert_eq!(s.velocity, None);
    assert_eq!(s.eta_turns, None);
}

#[test]
fn hand_computed_ewma_velocity_std_and_eta() {
    let mut m = meter(10_000);
    for total in [1_000, 1_300, 1_650, 2_100] {
        record_total(&mut m, total);
    }
    let s = m.state();
    let std = 4194.75_f64.sqrt();
    approx(s.velocity.unwrap(), 355.5);
    approx(s.velocity_std.unwrap(), std);
    assert_eq!(s.headroom_effective, 7_900);
    let eta = s.eta_turns.unwrap();
    approx(eta.expected, 7_900.0 / 355.5);
    approx(eta.conservative, 7_900.0 / (355.5 + std));
    assert!(s.provenance["velocity"].contains("ewma alpha=0.3"));
}

#[test]
fn zero_growth_yields_no_eta_with_reason() {
    let mut m = meter(10_000);
    for total in [1_000, 1_000, 1_000] {
        record_total(&mut m, total);
    }
    let s = m.state();
    approx(s.velocity.unwrap(), 0.0);
    assert_eq!(s.eta_turns, None);
    assert!(s.provenance["eta_turns"].contains("not positive"));
}

#[test]
fn zone_transitions_on_fill_effective() {
    let mut m = meter(1_000);
    record_total(&mut m, 500);
    assert_eq!(m.state().zone, Zone::Green);
    record_total(&mut m, 720);
    assert_eq!(m.state().zone, Zone::Caution);
    record_total(&mut m, 860);
    assert_eq!(m.state().zone, Zone::Critical);
}

#[test]
fn calibration_shifts_zones_and_headroom() {
    let mut p = profile(1_000);
    p.effective = Some(CalibrationRecord {
        model_id: "test:model".to_string(),
        effective_context: 800,
        method: "probe-kit".to_string(),
        source: "local run".to_string(),
        measured_at: None,
        confidence: None,
        schema_version: SCHEMA_VERSION.to_string(),
    });
    let mut m = Meter::new(p).unwrap();
    record_total(&mut m, 700);
    let s = m.state();
    // 700 / 800 = 0.875 -> critical against effective capacity,
    // while 700 / 1000 = 0.70 would only be caution against nominal.
    approx(s.fill_effective, 0.875);
    assert_eq!(s.zone, Zone::Critical);
    assert_eq!(s.headroom_effective, 100);
    assert_eq!(s.headroom_nominal, 300);
}

#[test]
fn reserved_output_subtracts_from_headroom() {
    let mut m = Meter::with_config(
        profile(1_000),
        MeterConfig {
            reserved_output: 200,
            ..MeterConfig::default()
        },
    )
    .unwrap();
    record_total(&mut m, 300);
    let s = m.state();
    assert_eq!(s.headroom_nominal, 500);
    assert_eq!(s.headroom_effective, 500);
}

#[test]
fn hidden_overhead_and_cache_come_from_latest_turn() {
    let mut m = meter(10_000);
    let mut turn = TurnUsage::new(1);
    turn.input_tokens = 100;
    turn.cache_read_tokens = 400;
    turn.cache_write_tokens = 50;
    turn.breakdown = Some(Breakdown {
        system_prompt: 300,
        tool_schemas: 150,
        ..Breakdown::default()
    });
    m.record(turn).unwrap();
    let s = m.state();
    assert_eq!(s.hidden_overhead, Some(450));
    let cache = s.cache.unwrap();
    assert_eq!(cache.stable_prefix_tokens, 450);
    assert_eq!(cache.last_cache_read, 400);
    assert_eq!(cache.last_cache_write, 50);
}

#[test]
fn meter_json_round_trip_reproduces_state() {
    let mut m = Meter::with_config(
        profile(10_000),
        MeterConfig {
            reserved_output: 100,
            ..MeterConfig::default()
        },
    )
    .unwrap();
    for total in [1_000, 1_300, 1_650, 2_100] {
        record_total(&mut m, total);
    }
    let restored = Meter::from_json(&m.to_json()).unwrap();
    assert_eq!(restored.state(), m.state());
}

#[test]
fn record_value_accepts_plain_object_and_fills_identity() {
    let mut m = meter(10_000);
    let stored = m
        .record_value(&json!({ "input_tokens": 10, "output_tokens": 5 }))
        .unwrap();
    assert_eq!(stored.turn_id, 1);
    assert_eq!(stored.model_id, Some("test:model".to_string()));
    assert!(stored.timestamp.is_some());
}

#[test]
fn constructor_validation() {
    let profile_ok = || profile(10_000);
    let alpha = Meter::with_config(
        profile_ok(),
        MeterConfig {
            alpha: 0.0,
            ..MeterConfig::default()
        },
    );
    assert_eq!(
        alpha.err().map(|e| e.to_string()),
        Some("alpha must be in (0, 1]".to_string())
    );

    let thresholds = Meter::with_config(
        profile_ok(),
        MeterConfig {
            caution: 0.9,
            critical: 0.8,
            ..MeterConfig::default()
        },
    );
    assert_eq!(
        thresholds.err().map(|e| e.to_string()),
        Some("thresholds must satisfy 0 < caution < critical <= 1".to_string())
    );

    let reserved = Meter::with_config(
        profile_ok(),
        MeterConfig {
            reserved_output: -1,
            ..MeterConfig::default()
        },
    );
    assert!(matches!(reserved, Err(Error::Value(_))));

    let factor = Meter::with_config(
        profile_ok(),
        MeterConfig {
            velocity_shift_factor: 1.0,
            ..MeterConfig::default()
        },
    );
    assert_eq!(
        factor.err().map(|e| e.to_string()),
        Some("velocity_shift_factor must be greater than 1".to_string())
    );
}

#[test]
fn exhausted_headroom_yields_no_eta_with_reason() {
    let mut m = meter(1_000);
    for total in [400, 700, 1_100] {
        record_total(&mut m, total);
    }
    let s = m.state();
    assert!(s.velocity.is_some());
    assert_eq!(s.eta_turns, None);
    assert!(s.provenance["eta_turns"].contains("exhausted"));
    assert!(s.fill_effective > 1.0);
    assert_eq!(s.zone, Zone::Critical);
}
