//! Tier-aware pricing schedules and usage quotes.
//!
//! The bundled registry remains an offline snapshot.  A schedule layers
//! optional inclusive input-token thresholds over the existing flat
//! [`Pricing`] value without changing the public shape of [`ModelProfile`].

use std::borrow::Cow;

use serde::Serialize;
use serde_json::Value;

use crate::registry::{default_registry, Registry};
use crate::types::{
    as_map, req_i64, req_value, string_or, Error, ModelProfile, Pricing, TurnUsage,
};

/// The request class to which a pricing schedule applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PricingScope {
    pub service_tier: String,
    pub region: String,
    pub basis: String,
    /// Normalized usage categories for which this schedule has no complete
    /// price. Empty scopes retain the original 0.2 wire representation.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unpriced_usage_categories: Vec<String>,
}

const PRICING_USAGE_CATEGORIES: [&str; 5] = [
    "input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    "reasoning_tokens",
];

impl Default for PricingScope {
    fn default() -> Self {
        PricingScope {
            service_tier: "standard".to_string(),
            region: "global".to_string(),
            basis: "request_input_tokens".to_string(),
            unpriced_usage_categories: Vec::new(),
        }
    }
}

impl PricingScope {
    pub fn new(
        service_tier: impl Into<String>,
        region: impl Into<String>,
        basis: impl Into<String>,
    ) -> Result<Self, Error> {
        let scope = PricingScope {
            service_tier: service_tier.into(),
            region: region.into(),
            basis: basis.into(),
            unpriced_usage_categories: Vec::new(),
        };
        scope.validate()?;
        Ok(scope)
    }

    pub fn validate(&self) -> Result<(), Error> {
        for (name, value) in [
            ("service_tier", &self.service_tier),
            ("region", &self.region),
            ("basis", &self.basis),
        ] {
            if value.trim().is_empty() {
                return Err(Error::Value(format!("{name} must be non-empty")));
            }
        }
        for (index, category) in self.unpriced_usage_categories.iter().enumerate() {
            if !PRICING_USAGE_CATEGORIES.contains(&category.as_str()) {
                return Err(Error::Value(
                    "unpriced usage category is unsupported".to_string(),
                ));
            }
            if self.unpriced_usage_categories[..index].contains(category) {
                return Err(Error::Value(
                    "unpriced usage categories must be unique".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "PricingScope")?;
        let mut scope = PricingScope::new(
            string_or(d, "service_tier", "standard", "PricingScope")?,
            string_or(d, "region", "global", "PricingScope")?,
            string_or(d, "basis", "request_input_tokens", "PricingScope")?,
        )?;
        scope.unpriced_usage_categories = match d.get("unpriced_usage_categories") {
            None => Vec::new(),
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| {
                    value.as_str().map(str::to_string).ok_or_else(|| {
                        Error::Parse(
                            "PricingScope: unpriced_usage_categories must contain strings"
                                .to_string(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => {
                return Err(Error::Parse(
                    "PricingScope: unpriced_usage_categories must be an array".to_string(),
                ))
            }
        };
        scope.validate()?;
        Ok(scope)
    }
}

/// One inclusive request-input threshold and the prices it activates.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PricingTier {
    pub min_input_tokens: i64,
    pub pricing: Pricing,
}

impl PricingTier {
    pub fn new(min_input_tokens: i64, pricing: Pricing) -> Result<Self, Error> {
        let tier = PricingTier {
            min_input_tokens,
            pricing,
        };
        tier.validate()?;
        Ok(tier)
    }

    pub fn validate(&self) -> Result<(), Error> {
        if self.min_input_tokens < 0 {
            return Err(Error::Value(
                "min_input_tokens must be non-negative".to_string(),
            ));
        }
        Ok(())
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "PricingTier")?;
        let min_input_tokens = req_i64(d, "min_input_tokens", "PricingTier")?;
        let pricing_value = req_value(d, "pricing", "PricingTier")?;
        if !pricing_value.is_object() {
            return Err(Error::Value(
                "pricing tier requires a pricing object".to_string(),
            ));
        }
        PricingTier::new(min_input_tokens, Pricing::from_value(pricing_value)?)
    }
}

/// A backward-compatible base price plus optional inclusive input tiers.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PricingSchedule {
    pub base: Pricing,
    pub tiers: Vec<PricingTier>,
    pub scope: PricingScope,
}

impl PricingSchedule {
    pub fn flat(base: Pricing) -> Self {
        PricingSchedule {
            base,
            tiers: Vec::new(),
            scope: PricingScope::default(),
        }
    }

    pub fn new(
        base: Pricing,
        mut tiers: Vec<PricingTier>,
        scope: PricingScope,
    ) -> Result<Self, Error> {
        tiers.sort_by_key(|tier| tier.min_input_tokens);
        let schedule = PricingSchedule { base, tiers, scope };
        schedule.validate()?;
        Ok(schedule)
    }

    /// Validate schedules assembled with a struct literal as well as those
    /// produced by [`PricingSchedule::new`].
    pub fn validate(&self) -> Result<(), Error> {
        self.scope.validate()?;
        if self.scope.basis != "request_input_tokens" {
            return Err(Error::Value("unsupported pricing scope basis".to_string()));
        }
        for tier in &self.tiers {
            tier.validate()?;
        }
        for pair in self.tiers.windows(2) {
            if pair[0].min_input_tokens == pair[1].min_input_tokens {
                return Err(Error::Value(
                    "pricing tier thresholds must be unique".to_string(),
                ));
            }
            if pair[0].min_input_tokens > pair[1].min_input_tokens {
                return Err(Error::Value(
                    "pricing tier thresholds must be strictly increasing".to_string(),
                ));
            }
        }
        if self
            .tiers
            .iter()
            .any(|tier| tier.pricing.currency != self.base.currency)
        {
            return Err(Error::Value(
                "all pricing tiers must use the base currency".to_string(),
            ));
        }
        Ok(())
    }

    /// Return the selected pricing and its inclusive threshold.
    ///
    /// `None` identifies the base tier; additional tiers report their
    /// configured `min_input_tokens` value.
    pub fn price_for(&self, input_tokens: i64) -> Result<(&Pricing, Option<i64>), Error> {
        if input_tokens < 0 {
            return Err(Error::Value(
                "input_tokens must be non-negative".to_string(),
            ));
        }
        self.validate()?;
        let mut selected = &self.base;
        let mut selected_min = None;
        for tier in &self.tiers {
            if input_tokens < tier.min_input_tokens {
                break;
            }
            selected = &tier.pricing;
            selected_min = Some(tier.min_input_tokens);
        }
        Ok((selected, selected_min))
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "PricingSchedule")?;
        let base_value = req_value(d, "base", "PricingSchedule")?;
        if !base_value.is_object() {
            return Err(Error::Value(
                "pricing schedule requires a base pricing object".to_string(),
            ));
        }
        let tiers = match d.get("tiers") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(values)) => values
                .iter()
                .map(PricingTier::from_value)
                .collect::<Result<Vec<_>, _>>()?,
            Some(_) => {
                return Err(Error::Value(
                    "pricing schedule tiers must be an array".to_string(),
                ))
            }
        };
        let scope = match d.get("scope") {
            None | Some(Value::Null) => PricingScope::default(),
            Some(value) if value.is_object() => PricingScope::from_value(value)?,
            Some(_) => {
                return Err(Error::Value(
                    "pricing schedule scope must be an object".to_string(),
                ))
            }
        };
        PricingSchedule::new(Pricing::from_value(base_value)?, tiers, scope)
    }
}

/// A tier-resolved cost for five exclusive token categories.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostQuote {
    pub model_id: String,
    pub tier_basis_tokens: i64,
    pub tier_min_input_tokens: Option<i64>,
    pub pricing: Pricing,
    pub input_cost: f64,
    pub cache_read_cost: f64,
    pub cache_write_cost: f64,
    pub output_cost: f64,
    pub reasoning_cost: f64,
    pub total_cost: f64,
    pub currency: String,
    pub as_of: Option<String>,
    pub source: String,
}

/// A conservative request-cost reservation with explicit assumptions.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CostEstimate {
    pub model_id: String,
    pub tier_basis_tokens: i64,
    pub tier_min_input_tokens: Option<i64>,
    pub pricing: Pricing,
    pub input_tokens: i64,
    pub reserved_output_tokens: i64,
    pub input_rate_kind: String,
    pub input_rate: f64,
    pub output_rate: f64,
    pub input_cost: f64,
    pub output_cost: f64,
    pub total_cost: f64,
    pub currency: String,
    pub as_of: Option<String>,
    pub source: String,
    pub conservative: bool,
    pub assumptions: Vec<String>,
}

fn resolve_profile_schedule<'a>(
    profile: &ModelProfile,
    schedule: Option<&'a PricingSchedule>,
) -> Result<Cow<'a, PricingSchedule>, Error> {
    if let Some(schedule) = schedule {
        schedule.validate()?;
        if profile
            .pricing
            .as_ref()
            .is_some_and(|pricing| pricing != &schedule.base)
        {
            return Err(Error::Value(
                "pricing schedule base must equal profile.pricing".to_string(),
            ));
        }
        return Ok(Cow::Borrowed(schedule));
    }
    let pricing = profile
        .pricing
        .clone()
        .ok_or_else(|| Error::Value(format!("model '{}' has no pricing", profile.model_id)))?;
    Ok(Cow::Owned(PricingSchedule::flat(pricing)))
}

fn usage_category_tokens(usage: &TurnUsage, category: &str) -> Result<i64, Error> {
    match category {
        "input_tokens" => Ok(usage.input_tokens),
        "cache_read_tokens" => Ok(usage.cache_read_tokens),
        "cache_write_tokens" => Ok(usage.cache_write_tokens),
        "output_tokens" => Ok(usage.output_tokens),
        "reasoning_tokens" => Ok(usage.reasoning_tokens),
        _ => Err(Error::Value(
            "unpriced usage category is unsupported".to_string(),
        )),
    }
}

/// Quote a usage record against an explicit profile and optional schedule.
pub fn quote_profile_usage(
    profile: &ModelProfile,
    usage: &TurnUsage,
    schedule: Option<&PricingSchedule>,
) -> Result<CostQuote, Error> {
    usage.validate()?;
    let selected_schedule = resolve_profile_schedule(profile, schedule)?;
    let mut present_unpriced = Vec::new();
    for category in &selected_schedule.scope.unpriced_usage_categories {
        if usage_category_tokens(usage, category)? > 0 {
            present_unpriced.push(category.as_str());
        }
    }
    if !present_unpriced.is_empty() {
        return Err(Error::Value(format!(
            "model '{}' pricing does not cover usage categories: {}",
            profile.model_id,
            present_unpriced.join(", ")
        )));
    }
    let tier_basis_tokens = usage
        .input_tokens
        .checked_add(usage.cache_read_tokens)
        .and_then(|value| value.checked_add(usage.cache_write_tokens))
        .ok_or_else(|| Error::Value("input token total exceeds i64".to_string()))?;
    let (pricing, tier_min_input_tokens) = selected_schedule.price_for(tier_basis_tokens)?;
    let per_mtok = 1_000_000.0;
    let input_cost = usage.input_tokens as f64 * pricing.input / per_mtok;
    let cache_read_cost = usage.cache_read_tokens as f64 * pricing.cache_read / per_mtok;
    let cache_write_cost = usage.cache_write_tokens as f64 * pricing.cache_write / per_mtok;
    let output_cost = usage.output_tokens as f64 * pricing.output / per_mtok;
    let reasoning_cost = usage.reasoning_tokens as f64 * pricing.output / per_mtok;
    let total_cost = input_cost + cache_read_cost + cache_write_cost + output_cost + reasoning_cost;
    Ok(CostQuote {
        model_id: profile.model_id.clone(),
        tier_basis_tokens,
        tier_min_input_tokens,
        pricing: pricing.clone(),
        input_cost,
        cache_read_cost,
        cache_write_cost,
        output_cost,
        reasoning_cost,
        total_cost,
        currency: pricing.currency.clone(),
        as_of: pricing.as_of.clone(),
        source: profile.source.clone(),
    })
}

/// Estimate a request against an explicit profile and optional schedule.
///
/// Tier selection uses total estimated request input. In conservative mode,
/// every input token is reserved at the highest selected-tier rate among
/// uncached input, cache reads, and cache writes. Reserved output uses the
/// selected tier's output rate.
pub fn quote_profile_estimate(
    profile: &ModelProfile,
    input_tokens: i64,
    reserved_output_tokens: i64,
    conservative: bool,
    schedule: Option<&PricingSchedule>,
) -> Result<CostEstimate, Error> {
    for (name, value) in [
        ("input_tokens", input_tokens),
        ("reserved_output_tokens", reserved_output_tokens),
    ] {
        if value < 0 {
            return Err(Error::Value(format!("{name} must be a non-negative int")));
        }
    }
    let selected_schedule = resolve_profile_schedule(profile, schedule)?;
    let mut unpriced_input = selected_schedule
        .scope
        .unpriced_usage_categories
        .iter()
        .filter_map(|category| match category.as_str() {
            "input_tokens" | "cache_read_tokens" | "cache_write_tokens" => Some(category.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    unpriced_input.sort_unstable();
    if input_tokens > 0
        && (unpriced_input.contains(&"input_tokens")
            || (conservative && !unpriced_input.is_empty()))
    {
        return Err(Error::Value(format!(
            "model '{}' pricing cannot conservatively bound estimated input because these categories are unpriced: {}",
            profile.model_id,
            unpriced_input.join(", ")
        )));
    }
    let mut unpriced_output = selected_schedule
        .scope
        .unpriced_usage_categories
        .iter()
        .filter_map(|category| match category.as_str() {
            "output_tokens" | "reasoning_tokens" => Some(category.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    unpriced_output.sort_unstable();
    if reserved_output_tokens > 0 && !unpriced_output.is_empty() {
        return Err(Error::Value(format!(
            "model '{}' pricing cannot bound reserved output because these categories are unpriced: {}",
            profile.model_id,
            unpriced_output.join(", ")
        )));
    }
    let (pricing, tier_min_input_tokens) = selected_schedule.price_for(input_tokens)?;
    let rates = [
        ("input", pricing.input),
        ("cache_read", pricing.cache_read),
        ("cache_write", pricing.cache_write),
    ];
    let (input_rate_kind, input_rate, mut assumptions) = if conservative {
        // Strict `>` preserves Python's first-entry tie break.
        let mut selected = rates[0];
        for candidate in &rates[1..] {
            if candidate.1 > selected.1 {
                selected = *candidate;
            }
        }
        (
            selected.0,
            selected.1,
            vec![
                "estimated input uses the highest selected-tier input-category rate".to_string(),
                "reserved output uses the selected-tier output rate".to_string(),
            ],
        )
    } else {
        (
            rates[0].0,
            rates[0].1,
            vec![
                "estimated input is treated as uncached input".to_string(),
                "reserved output uses the selected-tier output rate".to_string(),
            ],
        )
    };
    if !conservative && !unpriced_input.is_empty() {
        assumptions.push(
            "unpriced cache-write storage is excluded; valid only when no explicit cache is created"
                .to_string(),
        );
    }
    let input_cost = input_tokens as f64 * input_rate / 1_000_000.0;
    let output_cost = reserved_output_tokens as f64 * pricing.output / 1_000_000.0;
    Ok(CostEstimate {
        model_id: profile.model_id.clone(),
        tier_basis_tokens: input_tokens,
        tier_min_input_tokens,
        pricing: pricing.clone(),
        input_tokens,
        reserved_output_tokens,
        input_rate_kind: input_rate_kind.to_string(),
        input_rate,
        output_rate: pricing.output,
        input_cost,
        output_cost,
        total_cost: input_cost + output_cost,
        currency: pricing.currency.clone(),
        as_of: pricing.as_of.clone(),
        source: profile.source.clone(),
        conservative,
        assumptions,
    })
}

/// Quote a bundled model with the process-wide offline registry.
pub fn quote_usage(model_id: &str, usage: &TurnUsage) -> Result<CostQuote, Error> {
    quote_usage_with_registry(default_registry(), model_id, usage)
}

/// Quote a model with an explicit offline registry.
pub fn quote_usage_with_registry(
    registry: &Registry,
    model_id: &str,
    usage: &TurnUsage,
) -> Result<CostQuote, Error> {
    let profile = registry.get(model_id)?;
    let schedule = registry.get_pricing_schedule(model_id)?;
    quote_profile_usage(profile, usage, schedule.as_ref())
}

/// Estimate a bundled model with the process-wide offline registry.
pub fn quote_estimate(
    model_id: &str,
    input_tokens: i64,
    reserved_output_tokens: i64,
    conservative: bool,
) -> Result<CostEstimate, Error> {
    quote_estimate_with_registry(
        default_registry(),
        model_id,
        input_tokens,
        reserved_output_tokens,
        conservative,
    )
}

/// Estimate a model with an explicit offline registry.
pub fn quote_estimate_with_registry(
    registry: &Registry,
    model_id: &str,
    input_tokens: i64,
    reserved_output_tokens: i64,
    conservative: bool,
) -> Result<CostEstimate, Error> {
    let profile = registry.get(model_id)?;
    let schedule = registry.get_pricing_schedule(model_id)?;
    quote_profile_estimate(
        profile,
        input_tokens,
        reserved_output_tokens,
        conservative,
        schedule.as_ref(),
    )
}

#[cfg(test)]
mod tests {
    use super::{PricingSchedule, PricingScope, PricingTier};
    use crate::types::Pricing;

    fn prices(input: f64, output: f64) -> Pricing {
        Pricing {
            input,
            output,
            cache_read: input / 10.0,
            cache_write: input * 1.25,
            currency: "USD".to_string(),
            as_of: Some("2026-07-31".to_string()),
        }
    }

    #[test]
    fn inclusive_tier_boundary_is_exact() {
        let schedule = PricingSchedule::new(
            prices(5.0, 30.0),
            vec![PricingTier::new(272_001, prices(10.0, 45.0)).unwrap()],
            PricingScope::default(),
        )
        .unwrap();
        assert_eq!(schedule.price_for(272_000).unwrap().0.input, 5.0);
        assert_eq!(schedule.price_for(272_000).unwrap().1, None);
        assert_eq!(schedule.price_for(272_001).unwrap().0.input, 10.0);
        assert_eq!(schedule.price_for(272_001).unwrap().1, Some(272_001));
    }
}
