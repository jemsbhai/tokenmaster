//! Advisor: policies, recommendations, and rationale traces (contract
//! section 5). Port of python/tokenmaster/src/tokenmaster/advisor.py.
//!
//! Judgment lives here; measurement lives in the Meter. Every recommendation
//! ships with the arithmetic that produced it (principle P4: no silent
//! thresholds), and effect estimates a policy cannot honestly make stay None
//! rather than being invented.
//!
//! ThresholdPolicy is the deliberate baseline: it reproduces current
//! practice (fixed fill fractions, as in tokenlens, Inspect AI, and agent
//! frameworks) and estimates no effects, because a threshold knows nothing
//! about costs. That blindness is the point of comparison for the policies
//! that follow.
//!
//! Comparison strings interpolate numbers with Python's fixed-point
//! formatting (round half to even); see py_fixed below. All arithmetic keeps
//! the reference's expression order so doubles match bit for bit.
//!
//! Rust surface notes: Policy is a trait with Send + Sync supertraits (the
//! same reasoning as the Meter's Send-bound callbacks: policies must be able
//! to live inside shared state), policy_id is a method rather than an
//! attribute, and the reference's keyword-argument constructors map to
//! new() with defaults plus with_params/with_config validating variants and
//! a with_fallback builder for injection.

use std::str::FromStr;

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::types::{
    as_map, opt_f64, opt_i64, req_string, string_or, Error, MeterState, ModelProfile, Pricing,
    SCHEMA_VERSION,
};

// ------------------------------------------------------------------------ //
// formatting

/// Python format(x, ".Nf") emulation: fixed decimals with round half to
/// even, where Rust's {:.N} tie behavior is not specified to match. A tie
/// only exists when the double's decimal expansion terminates exactly at
/// the half digit; {:.30} exposes the expansion far past any tie reachable
/// at the magnitudes this module formats. Negative zero formats as "+0..."
/// here where Python writes "-0..."; no reference string produces negative
/// zero. Translated from the JS port's pyFixed.
fn py_fixed(x: f64, digits: usize, plus_sign: bool) -> String {
    let negative = x < 0.0;
    let abs = x.abs();
    let expanded = format!("{abs:.30}");
    let dot = expanded.find('.').expect("fixed formatting has a dot");
    let int_part = &expanded[..dot];
    let frac_part = &expanded[dot + 1..];
    let mut digits_arr: Vec<u8> = int_part
        .bytes()
        .chain(frac_part.bytes().take(digits))
        .map(|b| b - b'0')
        .collect();
    let next_digit = frac_part
        .as_bytes()
        .get(digits)
        .map(|b| b - b'0')
        .unwrap_or(0);
    let rest_non_zero = frac_part.as_bytes()[(digits + 1).min(frac_part.len())..]
        .iter()
        .any(|b| (b'1'..=b'9').contains(b));
    let mut round_up = false;
    if next_digit > 5 || (next_digit == 5 && rest_non_zero) {
        round_up = true;
    } else if next_digit == 5 && !rest_non_zero {
        round_up = digits_arr.last().copied().unwrap_or(0) % 2 == 1;
    }
    if round_up {
        let mut i = digits_arr.len();
        loop {
            if i == 0 {
                digits_arr.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_arr[i] == 9 {
                digits_arr[i] = 0;
            } else {
                digits_arr[i] += 1;
                break;
            }
        }
    }
    let joined: String = digits_arr.iter().map(|d| (d + b'0') as char).collect();
    let cut = joined.len() - digits;
    let body = if digits > 0 {
        format!("{}.{}", &joined[..cut], &joined[cut..])
    } else {
        joined
    };
    let sign = if negative {
        "-"
    } else if plus_sign {
        "+"
    } else {
        ""
    };
    format!("{sign}{body}")
}

// ------------------------------------------------------------------------ //
// enums

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Continue,
    Compact,
    Handoff,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Continue => "continue",
            Action::Compact => "compact",
            Action::Handoff => "handoff",
        }
    }
}

impl FromStr for Action {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "continue" => Ok(Action::Continue),
            "compact" => Ok(Action::Compact),
            "handoff" => Ok(Action::Handoff),
            other => Err(Error::Value(format!("'{other}' is not a valid Action"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Urgency {
    None,
    Soon,
    Now,
}

impl Urgency {
    pub fn as_str(self) -> &'static str {
        match self {
            Urgency::None => "none",
            Urgency::Soon => "soon",
            Urgency::Now => "now",
        }
    }
}

impl FromStr for Urgency {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "none" => Ok(Urgency::None),
            "soon" => Ok(Urgency::Soon),
            "now" => Ok(Urgency::Now),
            other => Err(Error::Value(format!("'{other}' is not a valid Urgency"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskCriticality {
    Low,
    Normal,
    High,
}

impl TaskCriticality {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskCriticality::Low => "low",
            TaskCriticality::Normal => "normal",
            TaskCriticality::High => "high",
        }
    }
}

impl FromStr for TaskCriticality {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "low" => Ok(TaskCriticality::Low),
            "normal" => Ok(TaskCriticality::Normal),
            "high" => Ok(TaskCriticality::High),
            other => Err(Error::Value(format!(
                "'{other}' is not a valid TaskCriticality"
            ))),
        }
    }
}

// ------------------------------------------------------------------------ //
// data model

/// Minimal task hints (contract decision D6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TaskContext {
    pub expected_remaining_turns: Option<i64>,
    pub task_criticality: TaskCriticality,
}

impl Default for TaskContext {
    fn default() -> Self {
        TaskContext {
            expected_remaining_turns: None,
            task_criticality: TaskCriticality::Normal,
        }
    }
}

impl TaskContext {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "TaskContext")?;
        Ok(TaskContext {
            expected_remaining_turns: opt_i64(d, "expected_remaining_turns", "TaskContext")?,
            task_criticality: TaskCriticality::from_str(&string_or(
                d,
                "task_criticality",
                "normal",
                "TaskContext",
            )?)?,
        })
    }
}

/// The arithmetic behind a recommendation: inputs, derived values, verdict.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct RationaleTrace {
    pub inputs: Map<String, Value>,
    pub derived: Map<String, Value>,
    pub comparison: String,
}

fn map_or_empty(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<Map<String, Value>, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(o)) => Ok(o.clone()),
        Some(_) => Err(Error::Parse(format!("{ctx}: field '{key}' is not an object"))),
    }
}

impl RationaleTrace {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "RationaleTrace")?;
        Ok(RationaleTrace {
            inputs: map_or_empty(d, "inputs", "RationaleTrace")?,
            derived: map_or_empty(d, "derived", "RationaleTrace")?,
            comparison: string_or(d, "comparison", "", "RationaleTrace")?,
        })
    }
}

/// Expected consequences of following the recommendation. None = unknown.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct EffectEstimate {
    pub tokens_spent: Option<i64>,
    pub tokens_freed: Option<i64>,
    pub cost_delta: Option<f64>,
    pub fidelity_risk: Option<f64>,
}

impl EffectEstimate {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "EffectEstimate")?;
        Ok(EffectEstimate {
            tokens_spent: opt_i64(d, "tokens_spent", "EffectEstimate")?,
            tokens_freed: opt_i64(d, "tokens_freed", "EffectEstimate")?,
            cost_delta: opt_f64(d, "cost_delta", "EffectEstimate")?,
            fidelity_risk: opt_f64(d, "fidelity_risk", "EffectEstimate")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recommendation {
    pub action: Action,
    pub urgency: Urgency,
    pub rationale: RationaleTrace,
    pub expected: EffectEstimate,
    pub policy_id: String,
    pub schema_version: String,
}

impl Recommendation {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "Recommendation")?;
        let rationale = match d.get("rationale") {
            None | Some(Value::Null) => RationaleTrace::default(),
            Some(r) => RationaleTrace::from_value(r)?,
        };
        let expected = match d.get("expected") {
            None | Some(Value::Null) => EffectEstimate::default(),
            Some(e) => EffectEstimate::from_value(e)?,
        };
        Ok(Recommendation {
            action: Action::from_str(&req_string(d, "action", "Recommendation")?)?,
            urgency: Urgency::from_str(&req_string(d, "urgency", "Recommendation")?)?,
            rationale,
            expected,
            policy_id: req_string(d, "policy_id", "Recommendation")?,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "Recommendation")?,
        })
    }
}

/// A policy consumes measurement and optional task context, returns
/// judgment.
pub trait Policy: Send + Sync {
    fn policy_id(&self) -> &str;
    fn evaluate(&self, state: &MeterState, task: Option<&TaskContext>) -> Recommendation;
}

// ------------------------------------------------------------------------ //
// ThresholdPolicy

/// Baseline: recommend compaction when fill_effective crosses a fraction.
///
/// Below warn_at: continue. In [warn_at, compact_at): compact soon (start
/// planning). At or above compact_at, or with no headroom left: compact now.
/// Never recommends handoff; a threshold has no concept of one.
#[derive(Debug, Clone)]
pub struct ThresholdPolicy {
    pub warn_at: f64,
    pub compact_at: f64,
}

impl Default for ThresholdPolicy {
    fn default() -> Self {
        ThresholdPolicy {
            warn_at: 0.70,
            compact_at: 0.85,
        }
    }
}

impl ThresholdPolicy {
    pub fn new(warn_at: f64, compact_at: f64) -> Result<Self, Error> {
        if !(warn_at > 0.0 && warn_at < compact_at && compact_at <= 1.0) {
            return Err(Error::Value(
                "thresholds must satisfy 0 < warn_at < compact_at <= 1".to_string(),
            ));
        }
        Ok(ThresholdPolicy { warn_at, compact_at })
    }
}

impl Policy for ThresholdPolicy {
    fn policy_id(&self) -> &str {
        "threshold"
    }

    fn evaluate(&self, state: &MeterState, task: Option<&TaskContext>) -> Recommendation {
        let fill = state.fill_effective;
        let headroom = state.headroom_effective;
        let mut inputs = Map::new();
        inputs.insert("fill_effective".to_string(), json!(fill));
        inputs.insert("headroom_effective".to_string(), json!(headroom));
        inputs.insert("warn_at".to_string(), json!(self.warn_at));
        inputs.insert("compact_at".to_string(), json!(self.compact_at));
        inputs.insert(
            "expected_remaining_turns".to_string(),
            json!(task.and_then(|t| t.expected_remaining_turns)),
        );

        let (action, urgency, comparison) = if headroom <= 0 {
            (
                Action::Compact,
                Urgency::Now,
                format!("headroom_effective {headroom} <= 0 (exhausted)"),
            )
        } else if fill >= self.compact_at {
            (
                Action::Compact,
                Urgency::Now,
                format!(
                    "fill {} >= compact_at {}",
                    py_fixed(fill, 3, false),
                    py_fixed(self.compact_at, 2, false)
                ),
            )
        } else if fill >= self.warn_at {
            (
                Action::Compact,
                Urgency::Soon,
                format!(
                    "warn_at {} <= fill {} < compact_at {}",
                    py_fixed(self.warn_at, 2, false),
                    py_fixed(fill, 3, false),
                    py_fixed(self.compact_at, 2, false)
                ),
            )
        } else {
            (
                Action::Continue,
                Urgency::None,
                format!(
                    "fill {} < warn_at {}",
                    py_fixed(fill, 3, false),
                    py_fixed(self.warn_at, 2, false)
                ),
            )
        };

        let mut derived = Map::new();
        derived.insert(
            "note".to_string(),
            json!("threshold baseline estimates no effects"),
        );
        Recommendation {
            action,
            urgency,
            rationale: RationaleTrace {
                inputs,
                derived,
                comparison,
            },
            expected: EffectEstimate::default(),
            policy_id: self.policy_id().to_string(),
            schema_version: SCHEMA_VERSION.to_string(),
        }
    }
}

// ------------------------------------------------------------------------ //
// PredictivePolicy

/// Fuel-gauge policy: act when projected range no longer covers the task.
///
/// Compares eta_turns.conservative against the task horizon
/// (expected_remaining_turns) plus a safety buffer. Without a horizon it
/// guards the buffer alone: running within buffer_turns of exhaustion is
/// act-now territory regardless of the task. When no prediction exists
/// (cold start, non-positive velocity) it delegates to a fallback policy,
/// ThresholdPolicy by default, and says so in the rationale.
///
/// buffer_turns (provisional default 3) and soon_factor (provisional
/// default 2.0) await measurement; task_criticality is recorded in the
/// rationale but not yet weighted, deliberately, until experiments say how.
/// Like the baseline, this policy knows when to act, not what acting costs,
/// so every effect estimate stays None; costing is CostModelPolicy's job.
pub struct PredictivePolicy {
    buffer_turns: i64,
    soon_factor: f64,
    fallback: Box<dyn Policy>,
}

impl Default for PredictivePolicy {
    fn default() -> Self {
        PredictivePolicy::new()
    }
}

impl PredictivePolicy {
    pub fn new() -> Self {
        PredictivePolicy {
            buffer_turns: 3,
            soon_factor: 2.0,
            fallback: Box::new(ThresholdPolicy::default()),
        }
    }

    pub fn with_params(buffer_turns: i64, soon_factor: f64) -> Result<Self, Error> {
        if buffer_turns < 0 {
            return Err(Error::Value("buffer_turns must be non-negative".to_string()));
        }
        if soon_factor < 1.0 {
            return Err(Error::Value("soon_factor must be at least 1".to_string()));
        }
        Ok(PredictivePolicy {
            buffer_turns,
            soon_factor,
            fallback: Box::new(ThresholdPolicy::default()),
        })
    }

    pub fn with_fallback(mut self, fallback: Box<dyn Policy>) -> Self {
        self.fallback = fallback;
        self
    }
}

/// Shared delegation shape for policies that cannot predict yet.
fn delegated(
    policy_id: &str,
    fallback: &dyn Policy,
    state: &MeterState,
    task: Option<&TaskContext>,
    inputs: Map<String, Value>,
) -> Recommendation {
    let reason = state
        .provenance
        .get("eta_turns")
        .cloned()
        .unwrap_or_else(|| "eta unavailable".to_string());
    let base = fallback.evaluate(state, task);
    let mut derived = Map::new();
    derived.insert("delegated_to".to_string(), json!(fallback.policy_id()));
    derived.insert("reason".to_string(), json!(reason));
    derived.insert(
        "fallback_comparison".to_string(),
        json!(base.rationale.comparison),
    );
    Recommendation {
        action: base.action,
        urgency: base.urgency,
        rationale: RationaleTrace {
            inputs,
            derived,
            comparison: format!(
                "prediction unavailable ({reason}); delegated to {}",
                fallback.policy_id()
            ),
        },
        expected: base.expected,
        policy_id: policy_id.to_string(),
        schema_version: SCHEMA_VERSION.to_string(),
    }
}

impl Policy for PredictivePolicy {
    fn policy_id(&self) -> &str {
        "predictive"
    }

    fn evaluate(&self, state: &MeterState, task: Option<&TaskContext>) -> Recommendation {
        let eta = state.eta_turns;
        let horizon = task.and_then(|t| t.expected_remaining_turns);
        let mut inputs = Map::new();
        inputs.insert("fill_effective".to_string(), json!(state.fill_effective));
        inputs.insert(
            "headroom_effective".to_string(),
            json!(state.headroom_effective),
        );
        inputs.insert(
            "conservative_eta".to_string(),
            json!(eta.map(|e| e.conservative)),
        );
        inputs.insert("expected_eta".to_string(), json!(eta.map(|e| e.expected)));
        inputs.insert("horizon".to_string(), json!(horizon));
        inputs.insert("buffer_turns".to_string(), json!(self.buffer_turns));
        inputs.insert("soon_factor".to_string(), json!(self.soon_factor));
        inputs.insert(
            "task_criticality".to_string(),
            json!(task.map(|t| t.task_criticality.as_str())),
        );

        if state.headroom_effective <= 0 {
            return Recommendation {
                action: Action::Compact,
                urgency: Urgency::Now,
                rationale: RationaleTrace {
                    inputs,
                    derived: Map::new(),
                    comparison: format!(
                        "headroom_effective {} <= 0 (exhausted)",
                        state.headroom_effective
                    ),
                },
                expected: EffectEstimate::default(),
                policy_id: self.policy_id().to_string(),
                schema_version: SCHEMA_VERSION.to_string(),
            };
        }

        let eta = match eta {
            None => {
                return delegated(self.policy_id(), self.fallback.as_ref(), state, task, inputs)
            }
            Some(eta) => eta,
        };

        let conservative = eta.conservative;
        let mut derived = Map::new();
        if let (Some(h), Some(velocity)) = (horizon, state.velocity) {
            derived.insert(
                "projected_used_at_horizon".to_string(),
                json!((state.used_tokens as f64 + h as f64 * velocity).trunc() as i64),
            );
        }

        let (action, urgency, comparison) = if let Some(h) = horizon {
            let required = h + self.buffer_turns;
            derived.insert("required_turns".to_string(), json!(required));
            if conservative < h as f64 {
                (
                    Action::Compact,
                    Urgency::Now,
                    format!(
                        "conservative eta {} < horizon {h}",
                        py_fixed(conservative, 1, false)
                    ),
                )
            } else if conservative < required as f64 {
                (
                    Action::Compact,
                    Urgency::Soon,
                    format!(
                        "conservative eta {} < horizon {h} + buffer {}",
                        py_fixed(conservative, 1, false),
                        self.buffer_turns
                    ),
                )
            } else {
                (
                    Action::Continue,
                    Urgency::None,
                    format!(
                        "conservative eta {} covers horizon {h} + buffer {}",
                        py_fixed(conservative, 1, false),
                        self.buffer_turns
                    ),
                )
            }
        } else {
            let soon_band = self.buffer_turns as f64 * self.soon_factor;
            if conservative <= self.buffer_turns as f64 {
                (
                    Action::Compact,
                    Urgency::Now,
                    format!(
                        "conservative eta {} <= buffer {} (horizon unknown)",
                        py_fixed(conservative, 1, false),
                        self.buffer_turns
                    ),
                )
            } else if conservative <= soon_band {
                (
                    Action::Compact,
                    Urgency::Soon,
                    format!(
                        "conservative eta {} <= buffer band {} (horizon unknown)",
                        py_fixed(conservative, 1, false),
                        py_fixed(soon_band, 1, false)
                    ),
                )
            } else {
                (
                    Action::Continue,
                    Urgency::None,
                    format!(
                        "conservative eta {} exceeds buffer band {} (horizon unknown)",
                        py_fixed(conservative, 1, false),
                        py_fixed(soon_band, 1, false)
                    ),
                )
            }
        };

        Recommendation {
            action,
            urgency,
            rationale: RationaleTrace {
                inputs,
                derived,
                comparison,
            },
            expected: EffectEstimate::default(),
            policy_id: self.policy_id().to_string(),
            schema_version: SCHEMA_VERSION.to_string(),
        }
    }
}

// ------------------------------------------------------------------------ //
// CostModelPolicy

// in, out, cache_read, cache_write
const UNIT_PRICES: (f64, f64, f64, f64) = (1.0, 5.0, 0.1, 1.25);

/// CostModelPolicy parameters; the reference's keyword arguments minus
/// pricing and fallback.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CostModelConfig {
    pub compaction_ratio: f64,
    pub summary_output_ratio: f64,
    pub handoff_prompt_ratio: f64,
    pub expected_compaction_loss: f64,
    pub expected_handoff_loss: f64,
    pub human_friction: f64,
    pub default_horizon: i64,
}

impl Default for CostModelConfig {
    fn default() -> Self {
        CostModelConfig {
            compaction_ratio: 0.15,
            summary_output_ratio: 0.10,
            handoff_prompt_ratio: 0.05,
            expected_compaction_loss: 0.10,
            expected_handoff_loss: 0.20,
            human_friction: 0.0,
            default_horizon: 10,
        }
    }
}

/// Choose the action minimizing expected cost (contract section 5.2).
///
/// Computes net costs of compact and handoff relative to continuing over a
/// horizon of k turns, including the cache economics of the aftermath: the
/// one-time summary generation and prefix rewrite versus the per-turn
/// cache-read savings of a smaller prefix. The break-even horizon
///
/// ```text
/// k* = (T_sum*p_out + T_post*(p_cw - p_cr)) / ((T_pre - T_post)*p_cr)
/// ```
///
/// is reported in every rationale; below k* remaining turns, compaction
/// loses money before information loss is even counted. Per-turn context
/// growth cancels between branches (both paths grow identically), so the
/// savings term is exact under the equal-growth assumption.
///
/// Prices come from a Pricing (per-Mtok, converted internally to per-token)
/// or, when absent, from provisional unit ratios (in 1.0, out 5.0, cache
/// read 0.1, cache write 1.25 per token) with the ledger unit reported as
/// "token-units" instead of a currency. All ratios and loss parameters are
/// provisional pending experiments E3 and E4 and are recorded in the
/// rationale inputs. With no prediction available (cold start), the policy
/// delegates to a fallback and says so; with no headroom, it picks the
/// cheaper of compact and handoff at urgency now.
pub struct CostModelPolicy {
    pricing: Option<Pricing>,
    config: CostModelConfig,
    fallback: Box<dyn Policy>,
}

impl CostModelPolicy {
    pub fn new(pricing: Option<Pricing>) -> Self {
        CostModelPolicy::with_config(pricing, CostModelConfig::default())
            .expect("default cost-model parameters are valid")
    }

    pub fn with_config(pricing: Option<Pricing>, config: CostModelConfig) -> Result<Self, Error> {
        for (name, value) in [
            ("compaction_ratio", config.compaction_ratio),
            ("summary_output_ratio", config.summary_output_ratio),
            ("handoff_prompt_ratio", config.handoff_prompt_ratio),
        ] {
            if !(value > 0.0 && value < 1.0) {
                return Err(Error::Value(format!("{name} must be in (0, 1)")));
            }
        }
        for (name, value) in [
            ("expected_compaction_loss", config.expected_compaction_loss),
            ("expected_handoff_loss", config.expected_handoff_loss),
        ] {
            if !(value >= 0.0 && value <= 1.0) {
                return Err(Error::Value(format!("{name} must be in [0, 1]")));
            }
        }
        if config.human_friction < 0.0 {
            return Err(Error::Value("human_friction must be non-negative".to_string()));
        }
        if config.default_horizon < 1 {
            return Err(Error::Value("default_horizon must be at least 1".to_string()));
        }
        Ok(CostModelPolicy {
            pricing,
            config,
            fallback: Box::new(ThresholdPolicy::default()),
        })
    }

    pub fn with_fallback(mut self, fallback: Box<dyn Policy>) -> Self {
        self.fallback = fallback;
        self
    }

    /// Construct with the profile's dated pricing (None degrades to units).
    pub fn for_profile(profile: &ModelProfile) -> Self {
        CostModelPolicy::new(profile.pricing.clone())
    }

    fn per_token_prices(&self) -> (f64, f64, f64, f64, String) {
        match &self.pricing {
            Some(p) => (
                p.input / 1e6,
                p.output / 1e6,
                p.cache_read / 1e6,
                p.cache_write / 1e6,
                p.currency.clone(),
            ),
            None => {
                let (i, o, cr, cw) = UNIT_PRICES;
                (i, o, cr, cw, "token-units".to_string())
            }
        }
    }
}

impl Policy for CostModelPolicy {
    fn policy_id(&self) -> &str {
        "cost-model"
    }

    fn evaluate(&self, state: &MeterState, task: Option<&TaskContext>) -> Recommendation {
        let (p_in, p_out, p_cr, p_cw, unit) = self.per_token_prices();
        let horizon = task.and_then(|t| t.expected_remaining_turns);
        let horizon_source = if horizon.is_some() { "task" } else { "default" };
        let k = horizon.unwrap_or(self.config.default_horizon);

        let t_pre = state.used_tokens;
        let t_post = (t_pre as f64 * self.config.compaction_ratio) as i64;
        let t_sum = (t_pre as f64 * self.config.summary_output_ratio) as i64;
        let t_hand = (t_pre as f64 * self.config.handoff_prompt_ratio) as i64;

        let mut inputs = Map::new();
        inputs.insert("t_pre".to_string(), json!(t_pre));
        inputs.insert("velocity".to_string(), json!(state.velocity));
        inputs.insert("horizon".to_string(), json!(k));
        inputs.insert("horizon_source".to_string(), json!(horizon_source));
        inputs.insert(
            "prices_per_mtok".to_string(),
            match &self.pricing {
                Some(p) => serde_json::to_value(p).expect("Pricing serialization"),
                None => json!("unit ratios (provisional)"),
            },
        );
        inputs.insert(
            "compaction_ratio".to_string(),
            json!(self.config.compaction_ratio),
        );
        inputs.insert(
            "summary_output_ratio".to_string(),
            json!(self.config.summary_output_ratio),
        );
        inputs.insert(
            "handoff_prompt_ratio".to_string(),
            json!(self.config.handoff_prompt_ratio),
        );
        inputs.insert(
            "expected_compaction_loss".to_string(),
            json!(self.config.expected_compaction_loss),
        );
        inputs.insert(
            "expected_handoff_loss".to_string(),
            json!(self.config.expected_handoff_loss),
        );
        inputs.insert("human_friction".to_string(), json!(self.config.human_friction));
        inputs.insert(
            "task_criticality".to_string(),
            json!(task.map(|t| t.task_criticality.as_str())),
        );

        let exhausted = state.headroom_effective <= 0;
        if state.eta_turns.is_none() && !exhausted {
            return delegated(self.policy_id(), self.fallback.as_ref(), state, task, inputs);
        }

        let saving_per_turn_compact = (t_pre - t_post) as f64 * p_cr;
        let saving_per_turn_handoff = (t_pre - t_hand) as f64 * p_cr;
        let one_time_compact = t_sum as f64 * p_out + t_post as f64 * (p_cw - p_cr);
        let one_time_handoff = t_hand as f64 * p_out + t_hand as f64 * (p_cw - p_cr);
        let info_compact = self.config.expected_compaction_loss * t_pre as f64 * p_in;
        let info_handoff = self.config.expected_handoff_loss * t_pre as f64 * p_in;

        let k_star = if saving_per_turn_compact > 0.0 {
            Some(one_time_compact / saving_per_turn_compact)
        } else {
            None
        };
        let k_star_with_info = if saving_per_turn_compact > 0.0 {
            Some((one_time_compact + info_compact) / saving_per_turn_compact)
        } else {
            None
        };

        let net_compact = one_time_compact + info_compact - k as f64 * saving_per_turn_compact;
        let net_handoff = one_time_handoff + info_handoff + self.config.human_friction
            - k as f64 * saving_per_turn_handoff;

        let overflow = !exhausted
            && state
                .eta_turns
                .map_or(false, |eta| eta.expected < k as f64);
        let continue_feasible = !exhausted && !overflow;

        let mut candidates: Vec<(Action, f64)> =
            vec![(Action::Compact, net_compact), (Action::Handoff, net_handoff)];
        if continue_feasible {
            candidates.push((Action::Continue, 0.0));
        }
        let (mut action, mut chosen_net) = candidates[0];
        for (candidate, net) in candidates.iter().skip(1) {
            if *net < chosen_net {
                action = *candidate;
                chosen_net = *net;
            }
        }

        let (urgency, expected) = if action == Action::Continue {
            (
                Urgency::None,
                EffectEstimate {
                    tokens_spent: Some(0),
                    tokens_freed: Some(0),
                    cost_delta: Some(0.0),
                    fidelity_risk: Some(0.0),
                },
            )
        } else {
            let urgency = if !continue_feasible {
                Urgency::Now
            } else {
                Urgency::Soon
            };
            let expected = if action == Action::Compact {
                EffectEstimate {
                    tokens_spent: Some(t_sum),
                    tokens_freed: Some(t_pre - t_post),
                    cost_delta: Some(chosen_net),
                    fidelity_risk: Some(self.config.expected_compaction_loss),
                }
            } else {
                EffectEstimate {
                    tokens_spent: Some(t_hand),
                    tokens_freed: Some(t_pre - t_hand),
                    cost_delta: Some(chosen_net),
                    fidelity_risk: Some(self.config.expected_handoff_loss),
                }
            };
            (urgency, expected)
        };

        let continue_text = if continue_feasible {
            py_fixed(0.0, 4, true)
        } else {
            "infeasible".to_string()
        };
        let comparison = format!(
            "min over k={k}: continue {continue_text}, compact {}, handoff {} {unit} -> {}",
            py_fixed(net_compact, 4, true),
            py_fixed(net_handoff, 4, true),
            action.as_str()
        );

        let mut derived = Map::new();
        derived.insert("ledger_unit".to_string(), json!(unit));
        derived.insert("k_star".to_string(), json!(k_star));
        derived.insert("k_star_with_info".to_string(), json!(k_star_with_info));
        derived.insert("net_compact".to_string(), json!(net_compact));
        derived.insert("net_handoff".to_string(), json!(net_handoff));
        derived.insert("one_time_compact".to_string(), json!(one_time_compact));
        derived.insert("one_time_handoff".to_string(), json!(one_time_handoff));
        derived.insert(
            "saving_per_turn_compact".to_string(),
            json!(saving_per_turn_compact),
        );
        derived.insert("overflow_within_horizon".to_string(), json!(overflow));
        derived.insert("exhausted".to_string(), json!(exhausted));
        derived.insert("t_post".to_string(), json!(t_post));
        derived.insert("t_sum".to_string(), json!(t_sum));
        derived.insert("t_hand".to_string(), json!(t_hand));

        Recommendation {
            action,
            urgency,
            rationale: RationaleTrace {
                inputs,
                derived,
                comparison,
            },
            expected,
            policy_id: self.policy_id().to_string(),
            schema_version: SCHEMA_VERSION.to_string(),
        }
    }
}

// ------------------------------------------------------------------------ //
// unit tests for the fixed-point formatter

#[cfg(test)]
mod tests {
    use super::py_fixed;

    #[test]
    fn py_fixed_matches_python_format() {
        assert_eq!(py_fixed(0.3, 3, false), "0.300");
        assert_eq!(py_fixed(0.75, 3, false), "0.750");
        assert_eq!(py_fixed(0.7, 2, false), "0.70");
        assert_eq!(py_fixed(0.85, 2, false), "0.85");
        assert_eq!(py_fixed(0.0, 4, true), "+0.0000");
        assert_eq!(py_fixed(-1.5, 1, false), "-1.5");
        assert_eq!(py_fixed(987.0, 1, false), "987.0");
    }

    #[test]
    fn py_fixed_rounds_half_to_even() {
        // Exact binary ties: Python format() rounds these half to even.
        assert_eq!(py_fixed(0.125, 2, false), "0.12");
        assert_eq!(py_fixed(0.375, 2, false), "0.38");
        assert_eq!(py_fixed(2.5, 0, false), "2");
        assert_eq!(py_fixed(3.5, 0, false), "4");
        // Carry propagation through nines (0.99951171875 = 1 - 2^-11,
        // exactly representable, rounds up past the point).
        assert_eq!(py_fixed(0.99951171875, 3, false), "1.000");
    }
}
