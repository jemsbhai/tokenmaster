//! Tests for the bundled registry, resolution rules, and Meter::for_model.
//!
//! Mirrors python/tokenmaster/tests/test_registry.py one to one, plus the
//! sync test required by the port ruling: the committed
//! rust/tokenmaster/data/models.json must equal the canonical Python
//! snapshot as JSON whenever the canonical file is reachable (it is not in
//! a packaged-crate context, where the test skips with a note).

use serde_json::{json, Value};
use tokenmaster::{default_registry, get_profile, Error, Meter, ModelProfile, Registry};

fn approx(actual: f64, expected: f64) {
    assert!((actual - expected).abs() <= 1e-9, "{actual} != {expected}");
}

#[test]
fn bundled_copy_matches_the_canonical_python_snapshot() {
    let canonical_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../python/tokenmaster/src/tokenmaster/data/models.json"
    );
    let canonical_text = match std::fs::read_to_string(canonical_path) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("canonical models.json absent; sync test skipped (packaged-crate context)");
            return;
        }
    };
    let canonical: Value = serde_json::from_str(&canonical_text).unwrap();
    let bundled: Value = serde_json::from_str(include_str!("../data/models.json")).unwrap();
    assert_eq!(
        bundled, canonical,
        "rust/tokenmaster/data/models.json diverges from the canonical Python snapshot; re-copy it"
    );
}

#[test]
fn bundled_snapshot_integrity() {
    let reg = default_registry();
    assert!(reg.snapshot_date().is_some());
    let profiles = reg.profiles();
    assert!(profiles.len() >= 10);
    for profile in profiles {
        assert!(profile.window_nominal > 0);
        assert!(profile.model_id.contains(':'));
        if let Some(pricing) = &profile.pricing {
            assert!(pricing.as_of.is_some());
            assert!(pricing.input > 0.0);
            assert!(pricing.output > 0.0);
        }
    }
}

#[test]
fn lookup_canonical_id() {
    let p = default_registry()
        .get("anthropic:claude-sonnet-4-6")
        .unwrap();
    assert_eq!(p.window_nominal, 1_000_000);
    approx(p.pricing.as_ref().unwrap().input, 3.0);
}

#[test]
fn lookup_bare_name() {
    let p = default_registry().get("claude-haiku-4-5").unwrap();
    assert_eq!(p.model_id, "anthropic:claude-haiku-4-5");
    assert_eq!(p.window_nominal, 200_000);
}

#[test]
fn lookup_is_case_insensitive() {
    let p = default_registry().get("Anthropic:Claude-Fable-5").unwrap();
    assert_eq!(p.model_id, "anthropic:claude-fable-5");
}

#[test]
fn lookup_dated_snapshot_suffix() {
    let p = default_registry().get("claude-haiku-4-5-20251001").unwrap();
    assert_eq!(p.model_id, "anthropic:claude-haiku-4-5");
    let q = default_registry().get("openai:gpt-5.5-2026-04-14").unwrap();
    assert_eq!(q.model_id, "openai:gpt-5.5");
}

#[test]
fn lookup_alias() {
    let p = default_registry().get("gemini-3.1-pro-preview").unwrap();
    assert_eq!(p.model_id, "google:gemini-3.1-pro");
    assert_eq!(p.window_nominal, 1_048_576);
    assert_eq!(p.max_output, Some(65_536));
    assert!(p.source.contains("/models/gemini-3.1-pro-preview"));
    for alias in [
        "gemini-3.1-pro-preview-customtools",
        "google:gemini-3.1-pro-preview-customtools",
    ] {
        assert_eq!(
            default_registry().get(alias).unwrap().model_id,
            "google:gemini-3.1-pro"
        );
    }

    let flash = default_registry().get("gemini-3.5-flash").unwrap();
    assert_eq!(flash.window_nominal, 1_048_576);
    assert_eq!(flash.max_output, Some(65_536));
    assert!(flash.source.contains("/models/gemini-3.5-flash"));
}

#[test]
fn gpt_5_6_family_profiles_and_aliases() {
    let sol = get_profile("openai:gpt-5.6-sol").unwrap();
    for model_id in ["gpt-5.6-sol", "openai:gpt-5.6", "gpt-5.6"] {
        assert_eq!(
            get_profile(model_id).unwrap().model_id,
            "openai:gpt-5.6-sol"
        );
    }
    assert_eq!(sol.window_nominal, 1_050_000);
    assert_eq!(sol.max_output, Some(128_000));
    let sol_pricing = sol.pricing.as_ref().unwrap();
    approx(sol_pricing.input, 5.0);
    approx(sol_pricing.cache_read, 0.5);
    approx(sol_pricing.cache_write, 6.25);
    approx(sol_pricing.output, 30.0);
    assert_eq!(sol_pricing.as_of.as_deref(), Some("2026-07-31"));
    assert!(sol.source.contains("/gpt-5.6-sol"));

    let terra = get_profile("gpt-5.6-terra").unwrap();
    assert_eq!(terra.model_id, "openai:gpt-5.6-terra");
    assert_eq!(terra.window_nominal, 1_050_000);
    assert_eq!(terra.max_output, Some(128_000));
    let terra_pricing = terra.pricing.as_ref().unwrap();
    approx(terra_pricing.input, 2.0);
    approx(terra_pricing.cache_read, 0.2);
    approx(terra_pricing.cache_write, 2.5);
    approx(terra_pricing.output, 12.0);
    assert_eq!(terra_pricing.as_of.as_deref(), Some("2026-07-31"));
    assert!(terra.source.contains("/gpt-5.6-terra"));

    let luna = get_profile("gpt-5.6-luna").unwrap();
    assert_eq!(luna.model_id, "openai:gpt-5.6-luna");
    assert_eq!(luna.window_nominal, 1_050_000);
    assert_eq!(luna.max_output, Some(128_000));
    let luna_pricing = luna.pricing.as_ref().unwrap();
    approx(luna_pricing.input, 0.2);
    approx(luna_pricing.cache_read, 0.02);
    approx(luna_pricing.cache_write, 0.25);
    approx(luna_pricing.output, 1.2);
    assert_eq!(luna_pricing.as_of.as_deref(), Some("2026-07-31"));
    assert!(luna.source.contains("/gpt-5.6-luna"));
}

#[test]
fn gpt_5_4_mini_profile_uses_verified_output_cap() {
    let profile = get_profile("openai:gpt-5.4-mini").unwrap();
    assert_eq!(profile.max_output, Some(128_000));
    assert_eq!(
        profile.pricing.as_ref().unwrap().as_of.as_deref(),
        Some("2026-07-31")
    );
    assert!(profile.source.contains("/gpt-5.4-mini"));
}

#[test]
fn unknown_model_fails_with_suggestions() {
    let err = default_registry().get("claude-sonet-4-6").unwrap_err();
    assert!(err.to_string().contains("claude-sonnet-4-6"));
    match err {
        Error::UnknownModel {
            model_id,
            suggestions,
        } => {
            assert_eq!(model_id, "claude-sonet-4-6");
            assert!(!suggestions.is_empty());
        }
        other => panic!("expected UnknownModel, got {other:?}"),
    }
}

#[test]
fn register_override_wins() {
    let mut reg = Registry::bundled();
    let mut custom = ModelProfile::new("anthropic:claude-haiku-4-5", "anthropic", 123_456).unwrap();
    custom.source = "user override".to_string();
    reg.register(custom, &[]);
    assert_eq!(reg.get("claude-haiku-4-5").unwrap().window_nominal, 123_456);
    // the process-wide default registry is untouched
    assert_eq!(
        default_registry()
            .get("claude-haiku-4-5")
            .unwrap()
            .window_nominal,
        200_000
    );
}

#[test]
fn for_model_end_to_end() {
    let mut m = Meter::for_model("claude-haiku-4-5").unwrap();
    m.record_value(&json!({ "input_tokens": 50_000 })).unwrap();
    let s = m.state();
    assert_eq!(s.window_nominal, 200_000);
    approx(s.fill_nominal, 0.25);
    assert_eq!(s.model_id, "anthropic:claude-haiku-4-5");
}

#[test]
fn for_model_unknown_id_carries_suggestions() {
    let err = Meter::for_model("claude-sonet-4-6").unwrap_err();
    assert!(matches!(err, Error::UnknownModel { .. }));
}
