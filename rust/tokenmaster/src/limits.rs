//! Request-limit checks derived from model profiles.

use serde::Serialize;

use crate::registry::{default_registry, Registry};
use crate::types::{Error, ModelProfile};

/// Which advertised/calibrated capacity to enforce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapacityKind {
    Nominal,
    Effective,
}

impl CapacityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CapacityKind::Nominal => "nominal",
            CapacityKind::Effective => "effective",
        }
    }
}

/// Result of checking input, context reservation, and explicit output caps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LimitCheck {
    pub model_id: String,
    pub capacity_kind: String,
    pub capacity: i64,
    pub input_tokens: i64,
    pub requested_output_tokens: Option<i64>,
    pub reserved_output_tokens: i64,
    pub context_output_tokens: i64,
    pub context_tokens: i64,
    pub max_input_tokens: i64,
    pub max_output_tokens: Option<i64>,
    pub input_exceeded: bool,
    pub context_exceeded: bool,
    pub output_exceeded: bool,
    pub allowed: bool,
    pub violations: Vec<String>,
}

/// Check an explicit profile without consulting a registry.
pub fn check_profile_request_limits(
    profile: &ModelProfile,
    input_tokens: i64,
    requested_output_tokens: Option<i64>,
    reserved_output_tokens: i64,
    capacity_kind: CapacityKind,
) -> Result<LimitCheck, Error> {
    for (name, value) in [
        ("input_tokens", input_tokens),
        ("reserved_output_tokens", reserved_output_tokens),
    ] {
        if value < 0 {
            return Err(Error::Value(format!("{name} must be non-negative")));
        }
    }
    if let Some(value) = requested_output_tokens {
        if value < 0 {
            return Err(Error::Value(
                "requested_output_tokens must be non-negative".to_string(),
            ));
        }
    }
    profile.validate()?;
    if profile.max_output.is_some_and(|value| value < 0) {
        return Err(Error::Value("max_output must be non-negative".to_string()));
    }

    let capacity = match capacity_kind {
        CapacityKind::Nominal => profile.window_nominal,
        CapacityKind::Effective => profile.window_effective(),
    };
    let max_output_tokens = profile.max_output;
    let max_input_tokens = max_output_tokens
        .map(|max_output| capacity.saturating_sub(max_output).max(0))
        .unwrap_or(capacity);
    let context_output_tokens = reserved_output_tokens.max(requested_output_tokens.unwrap_or(0));
    let context_tokens = input_tokens
        .checked_add(context_output_tokens)
        .ok_or_else(|| Error::Value("context token total exceeds i64".to_string()))?;
    let input_exceeded = input_tokens > max_input_tokens;
    let context_exceeded = context_tokens > capacity;
    let output_exceeded = match (requested_output_tokens, max_output_tokens) {
        (Some(requested), Some(maximum)) => requested > maximum,
        _ => false,
    };
    let mut violations = Vec::new();
    if input_exceeded {
        violations.push("input_tokens".to_string());
    }
    if context_exceeded {
        violations.push("context_tokens".to_string());
    }
    if output_exceeded {
        violations.push("requested_output_tokens".to_string());
    }
    Ok(LimitCheck {
        model_id: profile.model_id.clone(),
        capacity_kind: capacity_kind.as_str().to_string(),
        capacity,
        input_tokens,
        requested_output_tokens,
        reserved_output_tokens,
        context_output_tokens,
        context_tokens,
        max_input_tokens,
        max_output_tokens,
        input_exceeded,
        context_exceeded,
        output_exceeded,
        allowed: violations.is_empty(),
        violations,
    })
}

/// Check a bundled model with the process-wide offline registry.
pub fn check_request_limits(
    model_id: &str,
    input_tokens: i64,
    requested_output_tokens: Option<i64>,
    reserved_output_tokens: i64,
    capacity_kind: CapacityKind,
) -> Result<LimitCheck, Error> {
    check_request_limits_with_registry(
        default_registry(),
        model_id,
        input_tokens,
        requested_output_tokens,
        reserved_output_tokens,
        capacity_kind,
    )
}

/// Check a model from an explicit offline registry.
pub fn check_request_limits_with_registry(
    registry: &Registry,
    model_id: &str,
    input_tokens: i64,
    requested_output_tokens: Option<i64>,
    reserved_output_tokens: i64,
    capacity_kind: CapacityKind,
) -> Result<LimitCheck, Error> {
    check_profile_request_limits(
        registry.get(model_id)?,
        input_tokens,
        requested_output_tokens,
        reserved_output_tokens,
        capacity_kind,
    )
}

#[cfg(test)]
mod tests {
    use super::{check_profile_request_limits, CapacityKind};
    use crate::types::ModelProfile;

    fn profile() -> ModelProfile {
        let mut profile = ModelProfile::new("openai:test", "openai", 1_050_000).unwrap();
        profile.max_output = Some(128_000);
        profile
    }

    #[test]
    fn fixed_input_cap_and_context_reservation_are_independent() {
        let check = check_profile_request_limits(
            &profile(),
            922_000,
            Some(10_000),
            128_000,
            CapacityKind::Nominal,
        )
        .unwrap();
        assert!(check.allowed);
        assert_eq!(check.max_input_tokens, 922_000);
        assert_eq!(check.context_output_tokens, 128_000);

        let exceeded = check_profile_request_limits(
            &profile(),
            922_001,
            Some(10_000),
            0,
            CapacityKind::Nominal,
        )
        .unwrap();
        assert!(exceeded.input_exceeded);
        assert!(!exceeded.context_exceeded);
        assert!(!exceeded.allowed);
    }

    #[test]
    fn reservation_is_not_checked_as_an_output_request() {
        let check =
            check_profile_request_limits(&profile(), 1, None, 200_000, CapacityKind::Nominal)
                .unwrap();
        assert!(!check.output_exceeded);
        assert!(check.allowed);
    }
}
