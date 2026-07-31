//! Tier-aware registry and quote tests.

use serde_json::{json, Value};
use tokenmaster::{
    default_registry, get_pricing_schedule, get_profile, quote_estimate,
    quote_estimate_with_registry, quote_profile_estimate, quote_profile_usage,
    quote_usage_with_registry, ModelProfile, Pricing, PricingSchedule, PricingScope, PricingTier,
    Registry, TurnUsage,
};

fn approx(actual: f64, expected: f64) {
    assert!((actual - expected).abs() <= 1e-12, "{actual} != {expected}");
}

fn base_price(input: f64, output: f64) -> Pricing {
    Pricing {
        input,
        output,
        cache_read: input / 10.0,
        cache_write: input * 1.25,
        currency: "USD".to_string(),
        as_of: Some("2026-07-31".to_string()),
    }
}

fn tiered_registry() -> Registry {
    Registry::from_value(&json!({
        "schema_version": "0.1",
        "snapshot_date": "2026-07-31",
        "models": [{
            "model_id": "openai:test-tiered",
            "provider": "openai",
            "aliases": ["test-tiered-alias"],
            "window_nominal": 1_050_000,
            "max_output": 128_000,
            "pricing": {
                "input": 1.0,
                "output": 6.0,
                "cache_read": 0.1,
                "cache_write": 1.25,
                "currency": "USD",
                "as_of": "2026-07-31"
            },
            "pricing_scope": {
                "service_tier": "standard",
                "region": "global",
                "basis": "request_input_tokens"
            },
            "pricing_tiers": [{
                "min_input_tokens": 272001,
                "pricing": {
                    "input": 2.0,
                    "output": 9.0,
                    "cache_read": 0.2,
                    "cache_write": 2.5,
                    "currency": "USD",
                    "as_of": "2026-07-31"
                }
            }],
            "tokenizer_hint": null,
            "source": "official test fixture"
        }]
    }))
    .unwrap()
}

#[test]
fn catalog_schedule_selects_272000_and_272001_boundaries() {
    let registry = tiered_registry();
    let schedule = registry
        .get_pricing_schedule("test-tiered-alias")
        .unwrap()
        .unwrap();
    assert_eq!(schedule.price_for(272_000).unwrap().0.input, 1.0);
    assert_eq!(schedule.price_for(272_000).unwrap().1, None);
    assert_eq!(schedule.price_for(272_001).unwrap().0.input, 2.0);
    assert_eq!(schedule.price_for(272_001).unwrap().1, Some(272_001));

    let wire = serde_json::to_value(&schedule).unwrap();
    assert_eq!(
        wire.as_object().unwrap().keys().collect::<Vec<_>>(),
        vec!["base", "scope", "tiers"]
    );
    assert!(wire.get("source").is_none());
}

#[test]
fn pricing_scope_round_trips_unpriced_categories_and_omits_empty_marker() {
    let empty_wire = serde_json::to_value(PricingScope::default()).unwrap();
    assert!(empty_wire.get("unpriced_usage_categories").is_none());

    let scope = PricingScope::from_value(&json!({
        "unpriced_usage_categories": ["cache_write_tokens"]
    }))
    .unwrap();
    assert_eq!(
        scope.unpriced_usage_categories,
        vec!["cache_write_tokens".to_string()]
    );
    assert_eq!(
        serde_json::to_value(&scope).unwrap()["unpriced_usage_categories"],
        json!(["cache_write_tokens"])
    );

    assert!(PricingScope::from_value(&json!({
        "unpriced_usage_categories": ["cache_write_tokens", "cache_write_tokens"]
    }))
    .unwrap_err()
    .to_string()
    .contains("unique"));
    assert!(PricingScope::from_value(&json!({
        "unpriced_usage_categories": ["storage_tokens"]
    }))
    .unwrap_err()
    .to_string()
    .contains("unsupported"));
    assert!(PricingScope::from_value(&json!({
        "unpriced_usage_categories": "cache_write_tokens"
    }))
    .unwrap_err()
    .to_string()
    .contains("array"));
    assert!(PricingScope::from_value(&json!({
        "unpriced_usage_categories": [1]
    }))
    .is_err());
}

#[test]
fn bundled_gpt_5_6_sol_alias_resolves_verified_short_and_long_prices() {
    let schedule = get_pricing_schedule("openai:gpt-5.6")
        .unwrap()
        .expect("GPT-5.6 Sol is priced");
    let (short, short_min) = schedule.price_for(272_000).unwrap();
    assert_eq!(short_min, None);
    assert_eq!(short.input, 5.0);
    assert_eq!(short.cache_read, 0.5);
    assert_eq!(short.cache_write, 6.25);
    assert_eq!(short.output, 30.0);

    let (long, long_min) = schedule.price_for(272_001).unwrap();
    assert_eq!(long_min, Some(272_001));
    assert_eq!(long.input, 10.0);
    assert_eq!(long.cache_read, 1.0);
    assert_eq!(long.cache_write, 12.5);
    assert_eq!(long.output, 45.0);
}

#[test]
fn bundled_gemini_3_1_pro_selects_the_verified_200k_tier() {
    let schedule = get_pricing_schedule("gemini-3.1-pro-preview")
        .unwrap()
        .expect("Gemini 3.1 Pro is priced");
    let (short, short_min) = schedule.price_for(200_000).unwrap();
    let (long, long_min) = schedule.price_for(200_001).unwrap();
    assert_eq!(short_min, None);
    approx(short.input, 2.0);
    approx(short.cache_read, 0.2);
    approx(short.output, 12.0);
    assert_eq!(long_min, Some(200_001));
    approx(long.input, 4.0);
    approx(long.cache_read, 0.4);
    approx(long.output, 18.0);
}

#[test]
fn bundled_gemini_cache_storage_is_explicitly_unpriced_and_fails_closed() {
    for model_id in ["gemini-3.1-pro-preview", "gemini-3.5-flash"] {
        let schedule = get_pricing_schedule(model_id).unwrap().unwrap();
        assert_eq!(
            schedule.scope.unpriced_usage_categories,
            vec!["cache_write_tokens".to_string()]
        );
    }

    let mut usage = TurnUsage::new(1);
    usage.input_tokens = 150_001;
    usage.cache_read_tokens = 50_000;
    usage.output_tokens = 1_000;
    let quote =
        quote_usage_with_registry(default_registry(), "gemini-3.1-pro-preview", &usage).unwrap();
    assert_eq!(quote.tier_min_input_tokens, Some(200_001));
    approx(quote.total_cost, 0.638004);

    let mut cache_write = TurnUsage::new(2);
    cache_write.cache_write_tokens = 1;
    let error =
        quote_usage_with_registry(default_registry(), "gemini-3.1-pro-preview", &cache_write)
            .unwrap_err();
    assert!(error
        .to_string()
        .contains("does not cover usage categories: cache_write_tokens"));

    let error = quote_estimate("gemini-3.1-pro-preview", 1, 0, true).unwrap_err();
    assert!(error.to_string().contains("cannot conservatively bound"));
    assert!(quote_estimate("gemini-3.1-pro-preview", 0, 0, true).is_ok());

    let uncached = quote_estimate("gemini-3.1-pro-preview", 1, 0, false).unwrap();
    assert!(uncached
        .assumptions
        .iter()
        .any(|assumption| assumption.contains("no explicit cache")));
}

#[test]
fn estimate_rejects_positive_output_reservations_when_output_is_unpriced() {
    let pricing = base_price(2.0, 12.0);
    let mut profile = ModelProfile::new("test:unpriced-output", "test", 10_000).unwrap();
    profile.pricing = Some(pricing.clone());
    let scope = PricingScope {
        unpriced_usage_categories: vec![
            "reasoning_tokens".to_string(),
            "output_tokens".to_string(),
        ],
        ..PricingScope::default()
    };
    let schedule = PricingSchedule::new(pricing, Vec::new(), scope).unwrap();

    assert!(quote_profile_estimate(&profile, 1, 0, true, Some(&schedule)).is_ok());
    let error = quote_profile_estimate(&profile, 0, 1, true, Some(&schedule)).unwrap_err();
    assert!(error.to_string().contains(
        "cannot bound reserved output because these categories are unpriced: output_tokens, reasoning_tokens"
    ));
}

#[test]
fn quote_uses_all_input_categories_for_tier_and_prices_reasoning_as_output() {
    let registry = tiered_registry();
    let mut usage = TurnUsage::new(1);
    usage.input_tokens = 200_000;
    usage.cache_read_tokens = 70_000;
    usage.cache_write_tokens = 2_001;
    usage.output_tokens = 1_000;
    usage.reasoning_tokens = 2_000;

    let quote = quote_usage_with_registry(&registry, "test-tiered", &usage).unwrap();
    assert_eq!(quote.tier_basis_tokens, 272_001);
    assert_eq!(quote.tier_min_input_tokens, Some(272_001));
    approx(quote.input_cost, 0.4);
    approx(quote.cache_read_cost, 0.014);
    approx(quote.cache_write_cost, 0.0050025);
    approx(quote.output_cost, 0.009);
    approx(quote.reasoning_cost, 0.018);
    approx(quote.total_cost, 0.4460025);
    assert_eq!(quote.currency, "USD");
    assert_eq!(quote.source, "official test fixture");

    let wire = serde_json::to_value(&quote).unwrap();
    let expected_keys = [
        "as_of",
        "cache_read_cost",
        "cache_write_cost",
        "currency",
        "input_cost",
        "model_id",
        "output_cost",
        "pricing",
        "reasoning_cost",
        "source",
        "tier_basis_tokens",
        "tier_min_input_tokens",
        "total_cost",
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
fn estimate_uses_conservative_rate_and_exact_tier_boundary() {
    let short = quote_estimate("openai:gpt-5.6", 272_000, 1_000, true).unwrap();
    assert_eq!(short.tier_basis_tokens, 272_000);
    assert_eq!(short.tier_min_input_tokens, None);
    assert_eq!(short.input_rate_kind, "cache_write");
    assert_eq!(short.input_rate, 6.25);
    assert_eq!(short.output_rate, 30.0);
    approx(short.input_cost, 1.7);
    approx(short.output_cost, 0.03);
    approx(short.total_cost, 1.73);
    assert!(short.conservative);
    assert_eq!(
        short.assumptions,
        vec![
            "estimated input uses the highest selected-tier input-category rate",
            "reserved output uses the selected-tier output rate",
        ]
    );

    let long = quote_estimate("gpt-5.6", 272_001, 1_000, true).unwrap();
    assert_eq!(long.tier_basis_tokens, 272_001);
    assert_eq!(long.tier_min_input_tokens, Some(272_001));
    assert_eq!(long.input_rate_kind, "cache_write");
    assert_eq!(long.input_rate, 12.5);
    assert_eq!(long.output_rate, 45.0);
    approx(long.total_cost, 3.4450125);
}

#[test]
fn estimate_can_price_uncached_input_without_conservative_reserve() {
    let profile = get_profile("openai:gpt-5.6").unwrap();
    let schedule = get_pricing_schedule("openai:gpt-5.6").unwrap().unwrap();
    let estimate =
        quote_profile_estimate(&profile, 272_000, 1_000, false, Some(&schedule)).unwrap();
    assert_eq!(estimate.input_rate_kind, "input");
    assert_eq!(estimate.input_rate, 5.0);
    approx(estimate.total_cost, 1.39);
    assert!(!estimate.conservative);
}

#[test]
fn estimate_has_exact_wire_keys_and_rejects_negative_counts() {
    let registry = tiered_registry();
    let estimate = quote_estimate_with_registry(&registry, "test-tiered", 10, 20, true).unwrap();
    let wire = serde_json::to_value(&estimate).unwrap();
    let expected_keys = [
        "as_of",
        "assumptions",
        "conservative",
        "currency",
        "input_cost",
        "input_rate",
        "input_rate_kind",
        "input_tokens",
        "model_id",
        "output_cost",
        "output_rate",
        "pricing",
        "reserved_output_tokens",
        "source",
        "tier_basis_tokens",
        "tier_min_input_tokens",
        "total_cost",
    ];
    let mut actual_keys = wire
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    actual_keys.sort_unstable();
    assert_eq!(actual_keys, expected_keys);
    assert!(wire["assumptions"].is_array());

    assert!(quote_estimate_with_registry(&registry, "test-tiered", -1, 0, true).is_err());
    assert!(quote_estimate_with_registry(&registry, "test-tiered", 0, -1, true).is_err());
}

#[test]
fn estimate_conservative_rate_ties_prefer_uncached_input() {
    let mut profile = ModelProfile::new("test:tied", "test", 10_000).unwrap();
    profile.pricing = Some(Pricing {
        input: 2.0,
        output: 4.0,
        cache_read: 2.0,
        cache_write: 2.0,
        currency: "USD".to_string(),
        as_of: None,
    });
    let estimate = quote_profile_estimate(&profile, 1_000, 0, true, None).unwrap();
    assert_eq!(estimate.input_rate_kind, "input");
    assert_eq!(estimate.input_rate, 2.0);
}

#[test]
fn ordinary_override_clears_bundled_tiers() {
    let mut registry = tiered_registry();
    let mut profile = ModelProfile::new("openai:test-tiered", "openai", 10_000).unwrap();
    profile.pricing = Some(base_price(0.5, 3.0));
    registry.register(profile, &[]);
    let schedule = registry
        .get_pricing_schedule("openai:test-tiered")
        .unwrap()
        .unwrap();
    assert!(schedule.tiers.is_empty());
    assert_eq!(schedule.price_for(999_999).unwrap().0.input, 0.5);
}

#[test]
fn scheduled_override_requires_matching_profile_base() {
    let mut registry = Registry::new(None);
    let mut profile = ModelProfile::new("test:model", "test", 10_000).unwrap();
    profile.pricing = Some(base_price(1.0, 5.0));
    let schedule = PricingSchedule::new(
        base_price(2.0, 10.0),
        vec![PricingTier::new(5_000, base_price(3.0, 15.0)).unwrap()],
        PricingScope::default(),
    )
    .unwrap();
    assert!(registry
        .register_with_schedule(profile, schedule, &[])
        .is_err());
}

#[test]
fn explicit_quotes_reject_a_schedule_whose_base_disagrees_with_the_profile() {
    let mut profile = ModelProfile::new("test:model", "test", 10_000).unwrap();
    profile.pricing = Some(base_price(1.0, 5.0));
    let schedule = PricingSchedule::flat(base_price(2.0, 10.0));
    let usage = TurnUsage::new(1);
    assert!(quote_profile_usage(&profile, &usage, Some(&schedule)).is_err());
    assert!(quote_profile_estimate(&profile, 1, 0, true, Some(&schedule)).is_err());
}

#[test]
fn explicit_profile_without_pricing_cannot_be_quoted() {
    let profile = ModelProfile::new("test:free", "test", 10_000).unwrap();
    let usage = TurnUsage::new(1);
    let error = quote_profile_usage(&profile, &usage, None).unwrap_err();
    assert!(error.to_string().contains("has no pricing"));
}

#[test]
fn schedule_parser_rejects_duplicate_thresholds_and_currency_mismatch() {
    let duplicate: Value = json!({
        "base": base_price(1.0, 5.0),
        "tiers": [
            {"min_input_tokens": 10, "pricing": base_price(2.0, 10.0)},
            {"min_input_tokens": 10, "pricing": base_price(3.0, 15.0)}
        ],
        "scope": {"basis": "request_input_tokens"}
    });
    assert!(PricingSchedule::from_value(&duplicate).is_err());

    let missing_threshold: Value = json!({
        "base": base_price(1.0, 5.0),
        "tiers": [{"pricing": base_price(2.0, 10.0)}]
    });
    assert!(PricingSchedule::from_value(&missing_threshold).is_err());

    let mut eur = base_price(2.0, 10.0);
    eur.currency = "EUR".to_string();
    let mismatch = PricingSchedule::new(
        base_price(1.0, 5.0),
        vec![PricingTier::new(10, eur).unwrap()],
        PricingScope::default(),
    );
    assert!(mismatch.is_err());
}
