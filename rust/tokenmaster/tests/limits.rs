//! Request-limit validation tests.

use tokenmaster::{check_profile_request_limits, CapacityKind, ModelProfile};

fn profile() -> ModelProfile {
    let mut profile = ModelProfile::new("openai:test", "openai", 1_050_000).unwrap();
    profile.max_output = Some(128_000);
    profile
}

#[test]
fn max_input_is_fixed_by_full_model_output_cap() {
    let at_limit =
        check_profile_request_limits(&profile(), 922_000, Some(1), 0, CapacityKind::Nominal)
            .unwrap();
    assert!(at_limit.allowed);
    assert_eq!(at_limit.max_input_tokens, 922_000);

    let beyond =
        check_profile_request_limits(&profile(), 922_001, Some(1), 0, CapacityKind::Nominal)
            .unwrap();
    assert!(beyond.input_exceeded);
    assert_eq!(beyond.violations, vec!["input_tokens"]);
}

#[test]
fn context_uses_larger_of_reservation_and_request_without_summing() {
    let check = check_profile_request_limits(
        &profile(),
        930_000,
        Some(100_000),
        120_000,
        CapacityKind::Nominal,
    )
    .unwrap();
    assert_eq!(check.context_output_tokens, 120_000);
    assert_eq!(check.context_tokens, 1_050_000);
    assert!(!check.context_exceeded);
    // The independent provider-safe input ceiling still applies.
    assert!(check.input_exceeded);
}

#[test]
fn only_explicit_requested_output_is_checked_against_output_cap() {
    let reservation =
        check_profile_request_limits(&profile(), 1, None, 200_000, CapacityKind::Nominal).unwrap();
    assert!(!reservation.output_exceeded);

    let request =
        check_profile_request_limits(&profile(), 1, Some(128_001), 0, CapacityKind::Nominal)
            .unwrap();
    assert!(request.output_exceeded);
    assert_eq!(request.violations, vec!["requested_output_tokens"]);
}

#[test]
fn effective_capacity_is_opt_in_and_serializes_the_canonical_shape() {
    let mut calibrated = profile();
    calibrated.effective = Some(tokenmaster::CalibrationRecord {
        model_id: calibrated.model_id.clone(),
        effective_context: 900_000,
        method: "probe".to_string(),
        source: "local".to_string(),
        measured_at: None,
        confidence: None,
        schema_version: tokenmaster::SCHEMA_VERSION.to_string(),
    });
    let check = check_profile_request_limits(
        &calibrated,
        772_000,
        Some(128_000),
        0,
        CapacityKind::Effective,
    )
    .unwrap();
    assert_eq!(check.capacity_kind, "effective");
    assert_eq!(check.capacity, 900_000);
    assert_eq!(check.max_input_tokens, 772_000);
    assert!(check.allowed);

    let wire = serde_json::to_value(&check).unwrap();
    let expected_keys = [
        "allowed",
        "capacity",
        "capacity_kind",
        "context_exceeded",
        "context_output_tokens",
        "context_tokens",
        "input_exceeded",
        "input_tokens",
        "max_input_tokens",
        "max_output_tokens",
        "model_id",
        "output_exceeded",
        "requested_output_tokens",
        "reserved_output_tokens",
        "violations",
    ];
    let mut actual_keys = wire
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual_keys.sort_unstable();
    assert_eq!(actual_keys, expected_keys);
}

#[test]
fn negative_request_counts_are_rejected() {
    assert!(check_profile_request_limits(&profile(), -1, None, 0, CapacityKind::Nominal,).is_err());
    assert!(
        check_profile_request_limits(&profile(), 0, Some(-1), 0, CapacityKind::Nominal,).is_err()
    );
    assert!(check_profile_request_limits(&profile(), 0, None, -1, CapacityKind::Nominal,).is_err());
}
