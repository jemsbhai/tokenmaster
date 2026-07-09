//! Typed data model for the tokenmaster core, per docs/core-api.md (0.1).
//!
//! Mirrors the Python reference (`tokenmaster/types.py`). Wire fields are
//! snake_case exactly as the schema (contract P3: one schema, three
//! languages), and absent optionals serialize as explicit nulls, never
//! omitted keys. Parsing goes through `from_value` / `from_json`, which
//! reproduce the reference `from_dict` semantics, including its
//! dict-truthiness rule at nested-object boundaries (pricing, effective,
//! breakdown, raw, eta_turns, cache): any falsy value (null, false, 0, "",
//! [], {}) counts as absent.
//!
//! Cross-port alignment notes:
//! - For defaulted scalar fields, an explicit JSON null counts as absent
//!   (the JS port's precedent; the Python reference raises there).
//! - A truthy non-object at a nested-object boundary is a parse error (the
//!   Python reference's behavior; the JS port silently treats it as absent).
//! - Validation messages the reference raises as ValueError are preserved
//!   character for character.
//!
//! Construction validation: the reference's frozen dataclasses validate on
//! every construction. Rust struct literals cannot enforce that, so
//! validation runs in `new` constructors, in `from_value`, and in the Meter
//! at ingestion; `validate()` is public for literal construction.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::Serialize;
use serde_json::{Map, Value};

/// Wire schema version carried by every top-level object.
pub const SCHEMA_VERSION: &str = "0.1";

// ------------------------------------------------------------------------ //
// error type

/// Error type for the tokenmaster core.
///
/// `Value` corresponds to the reference's ValueError; where the reference
/// message is normative it is preserved character for character. `Parse`
/// covers malformed or missing wire input at `from_value` / `from_json`
/// boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Error {
    /// Invalid value at construction or validation (ValueError analog).
    Value(String),
    /// Malformed or missing data while parsing wire input.
    Parse(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Value(msg) | Error::Parse(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for Error {}

// ------------------------------------------------------------------------ //
// parsing helpers (from_dict semantics)

pub(crate) fn as_map<'a>(v: &'a Value, ctx: &str) -> Result<&'a Map<String, Value>, Error> {
    v.as_object()
        .ok_or_else(|| Error::Parse(format!("{ctx}: expected a JSON object")))
}

/// Python truthiness over JSON values: null, false, 0, "", [], {} are falsy.
fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

fn to_i64(v: &Value, ctx: &str, key: &str) -> Result<i64, Error> {
    match v {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(i)
            } else if let Some(f) = n.as_f64() {
                // Python int() truncates toward zero.
                Ok(f.trunc() as i64)
            } else {
                Err(Error::Parse(format!("{ctx}: field '{key}' is not an integer")))
            }
        }
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| Error::Parse(format!("{ctx}: field '{key}' is not an integer"))),
        _ => Err(Error::Parse(format!("{ctx}: field '{key}' is not an integer"))),
    }
}

fn to_f64(v: &Value, ctx: &str, key: &str) -> Result<f64, Error> {
    match v {
        Value::Number(n) => n
            .as_f64()
            .ok_or_else(|| Error::Parse(format!("{ctx}: field '{key}' is not a number"))),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map_err(|_| Error::Parse(format!("{ctx}: field '{key}' is not a number"))),
        _ => Err(Error::Parse(format!("{ctx}: field '{key}' is not a number"))),
    }
}

fn to_scalar_string(v: &Value, ctx: &str, key: &str) -> Result<String, Error> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        _ => Err(Error::Parse(format!("{ctx}: field '{key}' is not a string"))),
    }
}

fn req_i64(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<i64, Error> {
    match d.get(key) {
        None => Err(Error::Parse(format!("{ctx}: missing required field '{key}'"))),
        Some(v) => to_i64(v, ctx, key),
    }
}

fn i64_or(d: &Map<String, Value>, key: &str, default: i64, ctx: &str) -> Result<i64, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => to_i64(v, ctx, key),
    }
}

pub(crate) fn opt_i64(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<Option<i64>, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(to_i64(v, ctx, key)?)),
    }
}

pub(crate) fn req_f64(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<f64, Error> {
    match d.get(key) {
        None => Err(Error::Parse(format!("{ctx}: missing required field '{key}'"))),
        Some(v) => to_f64(v, ctx, key),
    }
}

fn f64_or(d: &Map<String, Value>, key: &str, default: f64, ctx: &str) -> Result<f64, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => to_f64(v, ctx, key),
    }
}

fn opt_f64(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<Option<f64>, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(to_f64(v, ctx, key)?)),
    }
}

pub(crate) fn req_string(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<String, Error> {
    match d.get(key) {
        None => Err(Error::Parse(format!("{ctx}: missing required field '{key}'"))),
        Some(v) => to_scalar_string(v, ctx, key),
    }
}

pub(crate) fn string_or(d: &Map<String, Value>, key: &str, default: &str, ctx: &str) -> Result<String, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(default.to_string()),
        Some(v) => to_scalar_string(v, ctx, key),
    }
}

fn opt_string(d: &Map<String, Value>, key: &str, ctx: &str) -> Result<Option<String>, Error> {
    match d.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => Ok(Some(to_scalar_string(v, ctx, key)?)),
    }
}

/// Nested-object boundary with Python dict-truthiness: absent or falsy
/// counts as absent; a non-empty object is returned; a truthy non-object is
/// a parse error.
fn truthy_object<'a>(
    d: &'a Map<String, Value>,
    key: &str,
    ctx: &str,
) -> Result<Option<&'a Map<String, Value>>, Error> {
    match d.get(key) {
        None => Ok(None),
        Some(v) if is_falsy(v) => Ok(None),
        Some(Value::Object(o)) => Ok(Some(o)),
        Some(_) => Err(Error::Parse(format!("{ctx}: field '{key}' is not an object"))),
    }
}

fn provenance_map(d: &Map<String, Value>, ctx: &str) -> Result<BTreeMap<String, String>, Error> {
    match d.get("provenance") {
        None => Ok(BTreeMap::new()),
        Some(Value::Object(o)) => {
            let mut out = BTreeMap::new();
            for (k, v) in o {
                match v {
                    Value::String(s) => {
                        out.insert(k.clone(), s.clone());
                    }
                    _ => {
                        return Err(Error::Parse(format!(
                            "{ctx}: provenance values must be strings"
                        )))
                    }
                }
            }
            Ok(out)
        }
        Some(_) => Err(Error::Parse(format!("{ctx}: field 'provenance' is not an object"))),
    }
}

// ------------------------------------------------------------------------ //
// enums

/// Fill zone keyed to fill_effective (contract decision D1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Zone {
    Green,
    Caution,
    Critical,
}

impl Zone {
    pub fn as_str(self) -> &'static str {
        match self {
            Zone::Green => "green",
            Zone::Caution => "caution",
            Zone::Critical => "critical",
        }
    }
}

impl FromStr for Zone {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "green" => Ok(Zone::Green),
            "caution" => Ok(Zone::Caution),
            "critical" => Ok(Zone::Critical),
            other => Err(Error::Value(format!("'{other}' is not a valid Zone"))),
        }
    }
}

/// Where a usage record's numbers came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageSource {
    Reported,
    Estimated,
    Mixed,
}

impl UsageSource {
    pub fn as_str(self) -> &'static str {
        match self {
            UsageSource::Reported => "reported",
            UsageSource::Estimated => "estimated",
            UsageSource::Mixed => "mixed",
        }
    }
}

impl FromStr for UsageSource {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "reported" => Ok(UsageSource::Reported),
            "estimated" => Ok(UsageSource::Estimated),
            "mixed" => Ok(UsageSource::Mixed),
            other => Err(Error::Value(format!("'{other}' is not a valid UsageSource"))),
        }
    }
}

// ------------------------------------------------------------------------ //
// Pricing

/// Per-Mtok prices, with the date they were captured.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub currency: String,
    pub as_of: Option<String>,
}

impl Pricing {
    pub fn new(input: f64, output: f64) -> Self {
        Pricing {
            input,
            output,
            cache_read: 0.0,
            cache_write: 0.0,
            currency: "USD".to_string(),
            as_of: None,
        }
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_map(as_map(v, "Pricing")?)
    }

    fn from_map(d: &Map<String, Value>) -> Result<Self, Error> {
        Ok(Pricing {
            input: req_f64(d, "input", "Pricing")?,
            output: req_f64(d, "output", "Pricing")?,
            cache_read: f64_or(d, "cache_read", 0.0, "Pricing")?,
            cache_write: f64_or(d, "cache_write", 0.0, "Pricing")?,
            currency: string_or(d, "currency", "USD", "Pricing")?,
            as_of: opt_string(d, "as_of", "Pricing")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// CalibrationRecord

/// Measured effective capacity for one model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CalibrationRecord {
    pub model_id: String,
    pub effective_context: i64,
    pub method: String,
    pub source: String,
    pub measured_at: Option<String>,
    pub confidence: Option<String>,
    pub schema_version: String,
}

impl CalibrationRecord {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_map(as_map(v, "CalibrationRecord")?)
    }

    fn from_map(d: &Map<String, Value>) -> Result<Self, Error> {
        Ok(CalibrationRecord {
            model_id: req_string(d, "model_id", "CalibrationRecord")?,
            effective_context: req_i64(d, "effective_context", "CalibrationRecord")?,
            method: req_string(d, "method", "CalibrationRecord")?,
            source: req_string(d, "source", "CalibrationRecord")?,
            measured_at: opt_string(d, "measured_at", "CalibrationRecord")?,
            confidence: opt_string(d, "confidence", "CalibrationRecord")?,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "CalibrationRecord")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// ModelProfile

/// Identity and capacities for one model.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelProfile {
    pub model_id: String,
    pub provider: String,
    pub window_nominal: i64,
    pub max_output: Option<i64>,
    pub pricing: Option<Pricing>,
    pub tokenizer_hint: Option<String>,
    pub effective: Option<CalibrationRecord>,
    pub source: String,
    pub schema_version: String,
}

impl ModelProfile {
    /// Minimal validated constructor; set optional fields on the returned
    /// value and re-run `validate` if `effective` is added afterward.
    pub fn new(
        model_id: impl Into<String>,
        provider: impl Into<String>,
        window_nominal: i64,
    ) -> Result<Self, Error> {
        let profile = ModelProfile {
            model_id: model_id.into(),
            provider: provider.into(),
            window_nominal,
            max_output: None,
            pricing: None,
            tokenizer_hint: None,
            effective: None,
            source: "user".to_string(),
            schema_version: SCHEMA_VERSION.to_string(),
        };
        profile.validate()?;
        Ok(profile)
    }

    /// Reference validation (`__post_init__`); messages are normative.
    pub fn validate(&self) -> Result<(), Error> {
        if self.window_nominal <= 0 {
            return Err(Error::Value("window_nominal must be positive".to_string()));
        }
        if let Some(effective) = &self.effective {
            if effective.effective_context <= 0 {
                return Err(Error::Value("effective_context must be positive".to_string()));
            }
        }
        Ok(())
    }

    /// Calibrated capacity when present, nominal otherwise.
    pub fn window_effective(&self) -> i64 {
        match &self.effective {
            Some(effective) => effective.effective_context,
            None => self.window_nominal,
        }
    }

    /// Provenance string for window_effective; normative text.
    pub fn effective_source(&self) -> String {
        match &self.effective {
            Some(effective) => format!("calibration:{} ({})", effective.method, effective.source),
            None => "nominal (uncalibrated)".to_string(),
        }
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "ModelProfile")?;
        let profile = ModelProfile {
            model_id: req_string(d, "model_id", "ModelProfile")?,
            provider: req_string(d, "provider", "ModelProfile")?,
            window_nominal: req_i64(d, "window_nominal", "ModelProfile")?,
            max_output: opt_i64(d, "max_output", "ModelProfile")?,
            pricing: match truthy_object(d, "pricing", "ModelProfile")? {
                Some(o) => Some(Pricing::from_map(o)?),
                None => None,
            },
            tokenizer_hint: opt_string(d, "tokenizer_hint", "ModelProfile")?,
            effective: match truthy_object(d, "effective", "ModelProfile")? {
                Some(o) => Some(CalibrationRecord::from_map(o)?),
                None => None,
            },
            source: string_or(d, "source", "user", "ModelProfile")?,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "ModelProfile")?,
        };
        profile.validate()?;
        Ok(profile)
    }
}

// ------------------------------------------------------------------------ //
// Breakdown

/// Optional estimated split of the standing prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct Breakdown {
    pub system_prompt: i64,
    pub tool_schemas: i64,
    pub history: i64,
    pub attachments: i64,
    pub query: i64,
}

impl Breakdown {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_map(as_map(v, "Breakdown")?)
    }

    fn from_map(d: &Map<String, Value>) -> Result<Self, Error> {
        Ok(Breakdown {
            system_prompt: i64_or(d, "system_prompt", 0, "Breakdown")?,
            tool_schemas: i64_or(d, "tool_schemas", 0, "Breakdown")?,
            history: i64_or(d, "history", 0, "Breakdown")?,
            attachments: i64_or(d, "attachments", 0, "Breakdown")?,
            query: i64_or(d, "query", 0, "Breakdown")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// TurnUsage

/// One normalized accounting record per model response.
///
/// Unknown keys in `from_value` input are ignored: normalization of
/// provider-specific field names is an adapter's job, and the core accepts
/// only the canonical shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TurnUsage {
    pub turn_id: i64,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub model_id: Option<String>,
    pub timestamp: Option<String>,
    pub breakdown: Option<Breakdown>,
    pub source: UsageSource,
    pub raw: Option<Map<String, Value>>,
    pub schema_version: String,
}

impl TurnUsage {
    /// All-defaults constructor; set fields and call `validate` (or go
    /// through `from_value`, which validates).
    pub fn new(turn_id: i64) -> Self {
        TurnUsage {
            turn_id,
            input_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            output_tokens: 0,
            reasoning_tokens: 0,
            model_id: None,
            timestamp: None,
            breakdown: None,
            source: UsageSource::Reported,
            raw: None,
            schema_version: SCHEMA_VERSION.to_string(),
        }
    }

    /// Context occupied after this turn: full prompt plus this response.
    pub fn context_total(&self) -> i64 {
        self.input_tokens
            + self.cache_read_tokens
            + self.cache_write_tokens
            + self.output_tokens
            + self.reasoning_tokens
    }

    /// Reference validation (`__post_init__`); messages are normative.
    pub fn validate(&self) -> Result<(), Error> {
        let counts = [
            ("input_tokens", self.input_tokens),
            ("cache_read_tokens", self.cache_read_tokens),
            ("cache_write_tokens", self.cache_write_tokens),
            ("output_tokens", self.output_tokens),
            ("reasoning_tokens", self.reasoning_tokens),
        ];
        for (name, value) in counts {
            if value < 0 {
                return Err(Error::Value(format!("{name} must be non-negative")));
            }
        }
        Ok(())
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_value_with_turn_id(v, None)
    }

    /// `from_value` with the reference's `turn_id` override parameter: when
    /// `turn_id` is Some, it replaces whatever the wire input carries.
    pub fn from_value_with_turn_id(v: &Value, turn_id: Option<i64>) -> Result<Self, Error> {
        let d = as_map(v, "TurnUsage")?;
        let turn = TurnUsage {
            turn_id: match turn_id {
                Some(t) => t,
                None => req_i64(d, "turn_id", "TurnUsage")?,
            },
            input_tokens: i64_or(d, "input_tokens", 0, "TurnUsage")?,
            cache_read_tokens: i64_or(d, "cache_read_tokens", 0, "TurnUsage")?,
            cache_write_tokens: i64_or(d, "cache_write_tokens", 0, "TurnUsage")?,
            output_tokens: i64_or(d, "output_tokens", 0, "TurnUsage")?,
            reasoning_tokens: i64_or(d, "reasoning_tokens", 0, "TurnUsage")?,
            model_id: opt_string(d, "model_id", "TurnUsage")?,
            timestamp: opt_string(d, "timestamp", "TurnUsage")?,
            breakdown: match truthy_object(d, "breakdown", "TurnUsage")? {
                Some(o) => Some(Breakdown::from_map(o)?),
                None => None,
            },
            source: UsageSource::from_str(&string_or(d, "source", "reported", "TurnUsage")?)?,
            raw: truthy_object(d, "raw", "TurnUsage")?.cloned(),
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "TurnUsage")?,
        };
        turn.validate()?;
        Ok(turn)
    }
}

// ------------------------------------------------------------------------ //
// EtaEstimate

/// Projected turns to exhaustion.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct EtaEstimate {
    pub expected: f64,
    pub conservative: f64,
}

impl EtaEstimate {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_map(as_map(v, "EtaEstimate")?)
    }

    fn from_map(d: &Map<String, Value>) -> Result<Self, Error> {
        Ok(EtaEstimate {
            expected: req_f64(d, "expected", "EtaEstimate")?,
            conservative: req_f64(d, "conservative", "EtaEstimate")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// CacheState

/// Estimated prompt-cache condition after the latest turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CacheState {
    pub stable_prefix_tokens: i64,
    pub last_cache_read: i64,
    pub last_cache_write: i64,
}

impl CacheState {
    pub fn from_value(v: &Value) -> Result<Self, Error> {
        Self::from_map(as_map(v, "CacheState")?)
    }

    fn from_map(d: &Map<String, Value>) -> Result<Self, Error> {
        Ok(CacheState {
            stable_prefix_tokens: req_i64(d, "stable_prefix_tokens", "CacheState")?,
            last_cache_read: req_i64(d, "last_cache_read", "CacheState")?,
            last_cache_write: req_i64(d, "last_cache_write", "CacheState")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// MeterState

/// The gauge cluster. Measurement only; judgment lives in the Advisor.
///
/// Renderable standalone by contract decision D10: no event history is
/// needed to draw everything here.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MeterState {
    pub model_id: String,
    pub turns: i64,
    pub used_tokens: i64,
    pub window_nominal: i64,
    pub window_effective: i64,
    pub effective_source: String,
    pub reserved_output: i64,
    pub headroom_nominal: i64,
    pub headroom_effective: i64,
    pub fill_nominal: f64,
    pub fill_effective: f64,
    pub velocity: Option<f64>,
    pub velocity_std: Option<f64>,
    pub eta_turns: Option<EtaEstimate>,
    pub zone: Zone,
    pub hidden_overhead: Option<i64>,
    pub cache: Option<CacheState>,
    pub provenance: BTreeMap<String, String>,
    pub schema_version: String,
}

impl MeterState {
    /// JSON string form. Infallible for any state the core produces.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("MeterState serialization")
    }

    pub fn from_value(v: &Value) -> Result<Self, Error> {
        let d = as_map(v, "MeterState")?;
        Ok(MeterState {
            model_id: req_string(d, "model_id", "MeterState")?,
            turns: req_i64(d, "turns", "MeterState")?,
            used_tokens: req_i64(d, "used_tokens", "MeterState")?,
            window_nominal: req_i64(d, "window_nominal", "MeterState")?,
            window_effective: req_i64(d, "window_effective", "MeterState")?,
            effective_source: req_string(d, "effective_source", "MeterState")?,
            reserved_output: req_i64(d, "reserved_output", "MeterState")?,
            headroom_nominal: req_i64(d, "headroom_nominal", "MeterState")?,
            headroom_effective: req_i64(d, "headroom_effective", "MeterState")?,
            fill_nominal: req_f64(d, "fill_nominal", "MeterState")?,
            fill_effective: req_f64(d, "fill_effective", "MeterState")?,
            velocity: opt_f64(d, "velocity", "MeterState")?,
            velocity_std: opt_f64(d, "velocity_std", "MeterState")?,
            eta_turns: match truthy_object(d, "eta_turns", "MeterState")? {
                Some(o) => Some(EtaEstimate::from_map(o)?),
                None => None,
            },
            zone: Zone::from_str(&req_string(d, "zone", "MeterState")?)?,
            hidden_overhead: opt_i64(d, "hidden_overhead", "MeterState")?,
            cache: match truthy_object(d, "cache", "MeterState")? {
                Some(o) => Some(CacheState::from_map(o)?),
                None => None,
            },
            provenance: provenance_map(d, "MeterState")?,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "MeterState")?,
        })
    }
}
