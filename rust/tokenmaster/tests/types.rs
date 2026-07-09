//! Tests for the typed data model: serialization round-trips and validation.
//!
//! Mirrors python/tokenmaster/tests/test_types.py one to one, plus
//! Rust-surface additions (enum parsing, dict-truthiness at from_value,
//! explicit-null wire shape) marked below.

use std::str::FromStr;

use serde_json::{json, Value};
use tokenmaster::{
    Breakdown, CacheState, CalibrationRecord, Error, EtaEstimate, MeterState, ModelProfile,
    Pricing, TurnUsage, UsageSource, Zone, SCHEMA_VERSION,
};

fn make_profile() -> ModelProfile {
    ModelProfile {
        model_id: "test:model".to_string(),
        provider: "test".to_string(),
        window_nominal: 10_000,
        max_output: Some(1_000),
        pricing: Some(Pricing {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            currency: "USD".to_string(),
            as_of: Some("2026-07-07".to_string()),
        }),
        tokenizer_hint: None,
        effective: None,
        source: "user".to_string(),
        schema_version: SCHEMA_VERSION.to_string(),
    }
}

fn make_calibration() -> CalibrationRecord {
    CalibrationRecord {
        model_id: "test:model".to_string(),
        effective_context: 8_000,
        method: "probe-kit".to_string(),
        source: "local run".to_string(),
        measured_at: Some("2026-07-01".to_string()),
        confidence: None,
        schema_version: SCHEMA_VERSION.to_string(),
    }
}

// ------------------------------------------------------------------------ //
// mirrored from the Python suite

#[test]
fn context_total_sums_all_five_categories() {
    let mut turn = TurnUsage::new(1);
    turn.input_tokens = 100;
    turn.cache_read_tokens = 200;
    turn.cache_write_tokens = 50;
    turn.output_tokens = 30;
    turn.reasoning_tokens = 20;
    assert_eq!(turn.context_total(), 400);
}

#[test]
fn turn_usage_rejects_negative_counts() {
    let mut turn = TurnUsage::new(1);
    turn.input_tokens = -1;
    let err = turn.validate().unwrap_err();
    assert_eq!(err.to_string(), "input_tokens must be non-negative");

    let via_wire = TurnUsage::from_value(&json!({"turn_id": 1, "input_tokens": -1}));
    assert!(matches!(via_wire, Err(Error::Value(_))));
}

#[test]
fn turn_usage_from_value_ignores_unknown_keys_and_defaults_missing() {
    let v = json!({"input_tokens": 10, "provider_specific_junk": 999});
    let turn = TurnUsage::from_value_with_turn_id(&v, Some(1)).unwrap();
    assert_eq!(turn.turn_id, 1);
    assert_eq!(turn.input_tokens, 10);
    assert_eq!(turn.output_tokens, 0);
    assert_eq!(turn.source, UsageSource::Reported);
}

#[test]
fn turn_usage_round_trip() {
    let mut turn = TurnUsage::new(3);
    turn.input_tokens = 10;
    turn.output_tokens = 5;
    turn.breakdown = Some(Breakdown {
        system_prompt: 4,
        tool_schemas: 2,
        ..Breakdown::default()
    });
    turn.source = UsageSource::Mixed;
    turn.raw = json!({"anything": 1}).as_object().cloned();
    turn.validate().unwrap();

    let wire = serde_json::to_value(&turn).unwrap();
    let back = TurnUsage::from_value(&wire).unwrap();
    assert_eq!(back, turn);
}

#[test]
fn profile_effective_defaults_to_nominal_with_honest_provenance() {
    let profile = make_profile();
    assert_eq!(profile.window_effective(), 10_000);
    assert_eq!(profile.effective_source(), "nominal (uncalibrated)");
}

#[test]
fn profile_calibration_overrides_effective() {
    let mut profile = make_profile();
    profile.effective = Some(make_calibration());
    profile.validate().unwrap();
    assert_eq!(profile.window_effective(), 8_000);
    assert!(profile.effective_source().contains("probe-kit"));
}

#[test]
fn profile_round_trip_with_nested_types() {
    let mut profile = make_profile();
    profile.effective = Some(CalibrationRecord {
        measured_at: None,
        ..make_calibration()
    });
    let wire = serde_json::to_value(&profile).unwrap();
    let back = ModelProfile::from_value(&wire).unwrap();
    assert_eq!(back, profile);
}

#[test]
fn profile_rejects_nonpositive_window() {
    let via_new = ModelProfile::new("test:model", "test", 0);
    assert!(matches!(via_new, Err(Error::Value(_))));

    let mut profile = make_profile();
    profile.window_nominal = 0;
    assert_eq!(
        profile.validate().unwrap_err().to_string(),
        "window_nominal must be positive"
    );
}

#[test]
fn meter_state_round_trip_via_json() {
    let state = MeterState {
        model_id: "test:model".to_string(),
        turns: 2,
        used_tokens: 400,
        window_nominal: 10_000,
        window_effective: 8_000,
        effective_source: "nominal (uncalibrated)".to_string(),
        reserved_output: 0,
        headroom_nominal: 9_600,
        headroom_effective: 7_600,
        fill_nominal: 0.04,
        fill_effective: 0.05,
        velocity: None,
        velocity_std: None,
        eta_turns: None,
        zone: Zone::Green,
        hidden_overhead: None,
        cache: None,
        provenance: [(
            "velocity".to_string(),
            "unavailable (cold start, needs 3 turns)".to_string(),
        )]
        .into_iter()
        .collect(),
        schema_version: SCHEMA_VERSION.to_string(),
    };

    let parsed: Value = serde_json::from_str(&state.to_json()).unwrap();
    let back = MeterState::from_value(&parsed).unwrap();
    assert_eq!(back, state);
    assert_eq!(back.schema_version, SCHEMA_VERSION);
}

// ------------------------------------------------------------------------ //
// Rust-surface additions

#[test]
fn profile_rejects_nonpositive_effective_context() {
    let mut profile = make_profile();
    profile.effective = Some(CalibrationRecord {
        effective_context: 0,
        ..make_calibration()
    });
    assert_eq!(
        profile.validate().unwrap_err().to_string(),
        "effective_context must be positive"
    );
}

#[test]
fn zone_and_usage_source_parse_wire_values() {
    assert_eq!(Zone::from_str("green").unwrap(), Zone::Green);
    assert_eq!(Zone::from_str("critical").unwrap(), Zone::Critical);
    assert_eq!(UsageSource::from_str("mixed").unwrap(), UsageSource::Mixed);
    assert_eq!(Zone::Caution.as_str(), "caution");
    assert_eq!(UsageSource::Estimated.as_str(), "estimated");

    let err = Zone::from_str("bogus").unwrap_err();
    assert_eq!(err.to_string(), "'bogus' is not a valid Zone");
    let err = UsageSource::from_str("bogus").unwrap_err();
    assert_eq!(err.to_string(), "'bogus' is not a valid UsageSource");
}

#[test]
fn serialized_enums_and_nulls_match_the_wire_schema() {
    let turn = TurnUsage::new(1);
    let wire = serde_json::to_value(&turn).unwrap();
    assert_eq!(wire["source"], json!("reported"));
    // Explicit nulls, never omitted keys.
    assert_eq!(wire["model_id"], Value::Null);
    assert_eq!(wire["breakdown"], Value::Null);
    assert_eq!(wire["raw"], Value::Null);
    assert_eq!(wire["schema_version"], json!(SCHEMA_VERSION));
}

#[test]
fn from_value_applies_dict_truthiness_to_nested_objects() {
    // Empty objects count as absent, mirroring the reference's `if d.get(...)`.
    let v = json!({
        "model_id": "test:model",
        "provider": "test",
        "window_nominal": 10_000,
        "pricing": {},
        "effective": {}
    });
    let profile = ModelProfile::from_value(&v).unwrap();
    assert!(profile.pricing.is_none());
    assert!(profile.effective.is_none());

    let t = json!({"turn_id": 1, "raw": {}, "breakdown": {}});
    let turn = TurnUsage::from_value(&t).unwrap();
    assert!(turn.raw.is_none());
    assert!(turn.breakdown.is_none());

    // A truthy non-object at a nested boundary is a loud error.
    let bad = json!({
        "model_id": "test:model",
        "provider": "test",
        "window_nominal": 10_000,
        "pricing": "junk"
    });
    assert!(matches!(ModelProfile::from_value(&bad), Err(Error::Parse(_))));
}

#[test]
fn pricing_defaults_apply_on_partial_wire_input() {
    let p = Pricing::from_value(&json!({"input": 3.0, "output": 15.0})).unwrap();
    assert_eq!(p.cache_read, 0.0);
    assert_eq!(p.cache_write, 0.0);
    assert_eq!(p.currency, "USD");
    assert_eq!(p.as_of, None);
}

#[test]
fn eta_and_cache_round_trip() {
    let eta = EtaEstimate {
        expected: 26.5,
        conservative: 24.7,
    };
    let back = EtaEstimate::from_value(&serde_json::to_value(eta).unwrap()).unwrap();
    assert_eq!(back, eta);

    let cache = CacheState {
        stable_prefix_tokens: 900,
        last_cache_read: 800,
        last_cache_write: 100,
    };
    let back = CacheState::from_value(&serde_json::to_value(cache).unwrap()).unwrap();
    assert_eq!(back, cache);
}
