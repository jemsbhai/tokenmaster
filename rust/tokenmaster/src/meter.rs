//! Meter: turn ingestion, MeterState computation, and event emission.
//!
//! Port of the Python reference (python/tokenmaster/src/tokenmaster/meter.py),
//! which defines the semantics for the golden vectors:
//!
//! - used_tokens: `context_total()` of the latest turn (full prompt of that
//!   request plus its response), not a sum over turns.
//! - growth: g_t = used_t - used_(t-1), defined from the second turn onward.
//! - velocity: exponentially weighted moving average of g_t with smoothing
//!   factor alpha (contract decision D2: alpha 0.3), exposed once at least
//!   three turns are recorded; before that it is None with a provenance
//!   reason.
//! - velocity_std: square root of the exponentially weighted variance
//!   maintained incrementally alongside the mean.
//! - eta_turns.expected = headroom_effective / velocity;
//!   eta_turns.conservative = headroom_effective / (velocity + velocity_std).
//! - zone: keyed to fill_effective with thresholds caution 0.70 and critical
//!   0.85 (contract decision D1, provisional pending experiment E2).
//!
//! Event emission per recorded turn, in this deterministic order (section
//! 4): TurnRecorded, then ZoneChanged (on boundary crossing), then
//! VelocityShift (when exposed velocity moves by more than
//! velocity_shift_factor, provisional default 1.5), then ModelChanged (when
//! the turn's model_id differs from the previous one). Subscriber callbacks
//! are synchronous and panics propagate to the caller of record(): a
//! subscriber that panics is a bug worth hearing about, and consumers that
//! disagree can wrap their own callbacks. The event history kept for
//! events() is unbounded in 0.1. Persistence via from_value/from_json
//! replays turns, so event timestamps are regenerated on restore; MeterState
//! round-trips exactly, the event log does not claim to.
//!
//! Rust surface notes: record splits into `record` (a TurnUsage) and
//! `record_value` (the reference's plain-dict path); `subscribe` returns a
//! SubscriptionId handle because the reference's self-referential
//! unsubscriber closure is not expressible under ownership, and callbacks
//! carry a Send bound so a Meter can live behind Arc<Mutex<..>>; `events()`
//! returns a borrowed slice, the borrow-checked equivalent of the
//! reference's snapshot iterator. `advise` and `report_handoff` arrive with
//! the advisor and fidelity modules per the port's dependency-honest order.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{json, Map, Value};

use crate::events::{utcnow, Event, EventKind};
use crate::registry::get_profile;
use crate::types::{
    as_map, f64_or, i64_or, req_value, CacheState, Error, EtaEstimate, MeterState, ModelProfile,
    TurnUsage, Zone, SCHEMA_VERSION,
};

const COLD_START_TURNS: usize = 3;

/// Format a float the way Python's str() renders the values this module
/// interpolates into provenance strings (which the conformance vectors
/// compare character for character). Alpha lives in (0, 1], where the only
/// divergence between Python str() and Rust's Display is the integral case:
/// Python renders 1.0 as "1.0", Rust as "1". (Python also switches to
/// scientific notation below 1e-4 where Rust does not; such alphas are
/// outside any sane configuration and no vector uses them.)
fn py_float(x: f64) -> String {
    if x.is_finite() && x == x.trunc() {
        format!("{x}.0")
    } else {
        format!("{x}")
    }
}

fn is_velocity_shift(previous: f64, current: f64, factor: f64) -> bool {
    if previous == 0.0 && current == 0.0 {
        return false;
    }
    if previous == 0.0 || current == 0.0 {
        return true;
    }
    if (previous > 0.0) != (current > 0.0) {
        return true;
    }
    let ratio = current.abs() / previous.abs();
    ratio >= factor || (1.0 / ratio) >= factor
}

/// Handle returned by [`Meter::subscribe`]; pass to [`Meter::unsubscribe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubscriptionId(u64);

/// Meter configuration; the reference's keyword arguments.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MeterConfig {
    pub reserved_output: i64,
    pub alpha: f64,
    pub caution: f64,
    pub critical: f64,
    pub velocity_shift_factor: f64,
}

impl Default for MeterConfig {
    fn default() -> Self {
        MeterConfig {
            reserved_output: 0,
            alpha: 0.3,
            caution: 0.70,
            critical: 0.85,
            velocity_shift_factor: 1.5,
        }
    }
}

type Subscriber = Box<dyn FnMut(&Event) + Send>;

/// Context-budget meter for one conversation against one model profile.
pub struct Meter {
    profile: ModelProfile,
    config: MeterConfig,
    turns: Vec<TurnUsage>,
    ew_mean: Option<f64>,
    ew_var: f64,
    events: Vec<Event>,
    subscribers: Vec<(SubscriptionId, Subscriber)>,
    next_subscription: u64,
    current_model: String,
}

impl fmt::Debug for Meter {
    /// Manual impl: subscriber closures are not Debug. Collections are
    /// summarized by length to keep output bounded.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Meter")
            .field("profile", &self.profile)
            .field("config", &self.config)
            .field("turns", &self.turns.len())
            .field("events", &self.events.len())
            .field("ew_mean", &self.ew_mean)
            .field("ew_var", &self.ew_var)
            .field("current_model", &self.current_model)
            .finish_non_exhaustive()
    }
}

impl Meter {
    /// Construct with default configuration.
    pub fn new(profile: ModelProfile) -> Result<Meter, Error> {
        Meter::with_config(profile, MeterConfig::default())
    }

    /// Construct with explicit configuration. Validation messages are the
    /// reference's, character for character.
    pub fn with_config(profile: ModelProfile, config: MeterConfig) -> Result<Meter, Error> {
        if !(config.alpha > 0.0 && config.alpha <= 1.0) {
            return Err(Error::Value("alpha must be in (0, 1]".to_string()));
        }
        if !(config.caution > 0.0 && config.caution < config.critical && config.critical <= 1.0) {
            return Err(Error::Value(
                "thresholds must satisfy 0 < caution < critical <= 1".to_string(),
            ));
        }
        if config.reserved_output < 0 {
            return Err(Error::Value("reserved_output must be non-negative".to_string()));
        }
        if config.velocity_shift_factor <= 1.0 {
            return Err(Error::Value(
                "velocity_shift_factor must be greater than 1".to_string(),
            ));
        }
        profile.validate()?;
        let current_model = profile.model_id.clone();
        Ok(Meter {
            profile,
            config,
            turns: Vec::new(),
            ew_mean: None,
            ew_var: 0.0,
            events: Vec::new(),
            subscribers: Vec::new(),
            next_subscription: 0,
            current_model,
        })
    }

    // ------------------------------------------------------------------ //
    // construction from the registry

    /// Construct a Meter from the bundled registry, zero configuration.
    ///
    /// Accepts canonical ids, bare names, aliases, and dated snapshot
    /// suffixes; fails with [`Error::UnknownModel`] carrying close-match
    /// suggestions otherwise.
    pub fn for_model(model_id: &str) -> Result<Meter, Error> {
        Meter::with_config(get_profile(model_id)?, MeterConfig::default())
    }

    /// [`Meter::for_model`] with explicit configuration.
    pub fn for_model_with_config(model_id: &str, config: MeterConfig) -> Result<Meter, Error> {
        Meter::with_config(get_profile(model_id)?, config)
    }

    // ------------------------------------------------------------------ //
    // ingestion

    /// Record one turn from a TurnUsage. turn_id is reassigned to the next
    /// sequential id (the reference rebuilds the turn when the id differs;
    /// same result). Emits events in the documented order and returns the
    /// stored TurnUsage.
    pub fn record(&mut self, usage: TurnUsage) -> Result<TurnUsage, Error> {
        let next_id = self.turns.len() as i64 + 1;
        let mut turn = usage;
        turn.turn_id = next_id;
        turn.validate()?;
        Ok(self.record_prepared(turn))
    }

    /// Record one turn from a canonical plain object (the reference's dict
    /// path). model_id and timestamp are filled in when the keys are
    /// absent.
    pub fn record_value(&mut self, usage: &Value) -> Result<TurnUsage, Error> {
        let next_id = self.turns.len() as i64 + 1;
        let mut d = as_map(usage, "TurnUsage")?.clone();
        d.entry("model_id".to_string())
            .or_insert_with(|| Value::String(self.profile.model_id.clone()));
        d.entry("timestamp".to_string())
            .or_insert_with(|| Value::String(utcnow()));
        let turn = TurnUsage::from_value_with_turn_id(&Value::Object(d), Some(next_id))?;
        Ok(self.record_prepared(turn))
    }

    fn record_prepared(&mut self, turn: TurnUsage) -> TurnUsage {
        let pre_state = self.state();
        let prev_zone = pre_state.zone;
        let prev_velocity = pre_state.velocity;

        let prev_total = self.turns.last().map(|t| t.context_total());
        self.turns.push(turn.clone());
        if let Some(prev) = prev_total {
            let growth = (turn.context_total() - prev) as f64;
            self.update_ewma(growth);
        }

        let state = self.state();
        let zone = state.zone;
        let fill_effective = state.fill_effective;
        let velocity = state.velocity;
        self.emit(Event::new(
            Some(turn.turn_id),
            EventKind::TurnRecorded {
                turn: turn.clone(),
                state,
            },
        ));
        if zone != prev_zone {
            self.emit(Event::new(
                Some(turn.turn_id),
                EventKind::ZoneChanged {
                    from_zone: prev_zone,
                    to_zone: zone,
                    fill_effective,
                },
            ));
        }
        if let (Some(previous), Some(current)) = (prev_velocity, velocity) {
            if is_velocity_shift(previous, current, self.config.velocity_shift_factor) {
                self.emit(Event::new(
                    Some(turn.turn_id),
                    EventKind::VelocityShift { previous, current },
                ));
            }
        }
        if let Some(model_id) = turn.model_id.clone() {
            if !model_id.is_empty() && model_id != self.current_model {
                self.emit(Event::new(
                    Some(turn.turn_id),
                    EventKind::ModelChanged {
                        previous_model_id: self.current_model.clone(),
                        new_model_id: model_id.clone(),
                    },
                ));
                self.current_model = model_id;
            }
        }
        turn
    }

    fn update_ewma(&mut self, growth: f64) {
        match self.ew_mean {
            None => {
                self.ew_mean = Some(growth);
                self.ew_var = 0.0;
            }
            Some(mean) => {
                let diff = growth - mean;
                let incr = self.config.alpha * diff;
                self.ew_mean = Some(mean + incr);
                self.ew_var = (1.0 - self.config.alpha) * (self.ew_var + diff * incr);
            }
        }
    }

    // ------------------------------------------------------------------ //
    // events

    /// Register a synchronous event callback; returns a handle for
    /// [`Meter::unsubscribe`].
    pub fn subscribe(&mut self, callback: impl FnMut(&Event) + Send + 'static) -> SubscriptionId {
        self.next_subscription += 1;
        let id = SubscriptionId(self.next_subscription);
        self.subscribers.push((id, Box::new(callback)));
        id
    }

    /// Remove a callback; returns whether anything was removed.
    pub fn unsubscribe(&mut self, id: SubscriptionId) -> bool {
        let before = self.subscribers.len();
        self.subscribers.retain(|(sid, _)| *sid != id);
        self.subscribers.len() != before
    }

    /// All events emitted so far, in order.
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    fn emit(&mut self, event: Event) {
        self.events.push(event);
        let event = self.events.last().expect("just pushed");
        for (_, callback) in self.subscribers.iter_mut() {
            callback(event);
        }
    }

    // ------------------------------------------------------------------ //
    // state

    /// The gauge cluster: a pure function of the profile, the turn history,
    /// and configuration.
    pub fn state(&self) -> MeterState {
        let used = self.turns.last().map(|t| t.context_total()).unwrap_or(0);
        let nominal = self.profile.window_nominal;
        let effective = self.profile.window_effective();
        let headroom_nominal = nominal - used - self.config.reserved_output;
        let headroom_effective = effective - used - self.config.reserved_output;
        let fill_nominal = used as f64 / nominal as f64;
        let fill_effective = used as f64 / effective as f64;

        let mut provenance = BTreeMap::new();
        provenance.insert("window_effective".to_string(), self.profile.effective_source());
        if let Some(last) = self.turns.last() {
            provenance.insert("used_tokens".to_string(), last.source.as_str().to_string());
        }

        let mut velocity = None;
        let mut velocity_std = None;
        let mut eta = None;
        match (self.turns.len() >= COLD_START_TURNS, self.ew_mean) {
            (true, Some(mean)) => {
                let std = self.ew_var.sqrt();
                velocity = Some(mean);
                velocity_std = Some(std);
                provenance.insert(
                    "velocity".to_string(),
                    format!("derived (ewma alpha={})", py_float(self.config.alpha)),
                );
                if headroom_effective <= 0 {
                    provenance.insert(
                        "eta_turns".to_string(),
                        "exhausted (no headroom remaining)".to_string(),
                    );
                } else if mean > 0.0 {
                    eta = Some(EtaEstimate {
                        expected: headroom_effective as f64 / mean,
                        conservative: headroom_effective as f64 / (mean + std),
                    });
                    provenance.insert("eta_turns".to_string(), "derived".to_string());
                } else {
                    provenance.insert(
                        "eta_turns".to_string(),
                        "unavailable (velocity not positive)".to_string(),
                    );
                }
            }
            _ => {
                let reason = format!("unavailable (cold start, needs {COLD_START_TURNS} turns)");
                provenance.insert("velocity".to_string(), reason.clone());
                provenance.insert("eta_turns".to_string(), reason);
            }
        }

        let zone = if fill_effective >= self.config.critical {
            Zone::Critical
        } else if fill_effective >= self.config.caution {
            Zone::Caution
        } else {
            Zone::Green
        };

        let mut hidden_overhead = None;
        let mut cache = None;
        if let Some(last) = self.turns.last() {
            if let Some(breakdown) = &last.breakdown {
                hidden_overhead = Some(breakdown.system_prompt + breakdown.tool_schemas);
                provenance.insert(
                    "hidden_overhead".to_string(),
                    last.source.as_str().to_string(),
                );
            }
            if last.cache_read_tokens != 0 || last.cache_write_tokens != 0 {
                cache = Some(CacheState {
                    stable_prefix_tokens: last.cache_read_tokens + last.cache_write_tokens,
                    last_cache_read: last.cache_read_tokens,
                    last_cache_write: last.cache_write_tokens,
                });
                provenance.insert("cache".to_string(), "estimated".to_string());
            }
        }

        MeterState {
            model_id: self.profile.model_id.clone(),
            turns: self.turns.len() as i64,
            used_tokens: used,
            window_nominal: nominal,
            window_effective: effective,
            effective_source: self.profile.effective_source(),
            reserved_output: self.config.reserved_output,
            headroom_nominal,
            headroom_effective,
            fill_nominal,
            fill_effective,
            velocity,
            velocity_std,
            eta_turns: eta,
            zone,
            hidden_overhead,
            cache,
            provenance,
            schema_version: SCHEMA_VERSION.to_string(),
        }
    }

    // ------------------------------------------------------------------ //
    // introspection and persistence

    pub fn profile(&self) -> &ModelProfile {
        &self.profile
    }

    pub fn config(&self) -> MeterConfig {
        self.config
    }

    pub fn turns(&self) -> &[TurnUsage] {
        &self.turns
    }

    /// Wire form: schema_version, profile, config, and the turn list.
    pub fn to_value(&self) -> Value {
        json!({
            "schema_version": SCHEMA_VERSION,
            "profile": serde_json::to_value(&self.profile).expect("ModelProfile serialization"),
            "config": {
                "reserved_output": self.config.reserved_output,
                "alpha": self.config.alpha,
                "caution": self.config.caution,
                "critical": self.config.critical,
                "velocity_shift_factor": self.config.velocity_shift_factor,
            },
            "turns": self
                .turns
                .iter()
                .map(|t| serde_json::to_value(t).expect("TurnUsage serialization"))
                .collect::<Vec<_>>(),
        })
    }

    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// Restore by replaying turns; events are re-emitted with fresh
    /// timestamps, MeterState round-trips exactly.
    pub fn from_value(v: &Value) -> Result<Meter, Error> {
        let d = as_map(v, "Meter")?;
        let profile = ModelProfile::from_value(req_value(d, "profile", "Meter")?)?;
        let empty = Map::new();
        let config_map = match d.get("config") {
            None | Some(Value::Null) => &empty,
            Some(c) => as_map(c, "Meter config")?,
        };
        let config = MeterConfig {
            reserved_output: i64_or(config_map, "reserved_output", 0, "Meter config")?,
            alpha: f64_or(config_map, "alpha", 0.3, "Meter config")?,
            caution: f64_or(config_map, "caution", 0.70, "Meter config")?,
            critical: f64_or(config_map, "critical", 0.85, "Meter config")?,
            velocity_shift_factor: f64_or(
                config_map,
                "velocity_shift_factor",
                1.5,
                "Meter config",
            )?,
        };
        let mut meter = Meter::with_config(profile, config)?;
        match d.get("turns") {
            None | Some(Value::Null) => {}
            Some(turns_value) => {
                let turns = turns_value.as_array().ok_or_else(|| {
                    Error::Parse("Meter: field 'turns' is not an array".to_string())
                })?;
                for turn_value in turns {
                    let turn = TurnUsage::from_value(turn_value)?;
                    meter.record(turn)?;
                }
            }
        }
        Ok(meter)
    }

    pub fn from_json(blob: &str) -> Result<Meter, Error> {
        let v: Value = serde_json::from_str(blob)
            .map_err(|e| Error::Parse(format!("Meter: invalid JSON: {e}")))?;
        Meter::from_value(&v)
    }
}

// ------------------------------------------------------------------------ //
// unit tests for the module-private helpers

#[cfg(test)]
mod tests {
    use super::{is_velocity_shift, py_float};

    #[test]
    fn py_float_matches_python_str_on_provenance_values() {
        assert_eq!(py_float(0.3), "0.3");
        assert_eq!(py_float(1.0), "1.0");
        assert_eq!(py_float(0.25), "0.25");
        assert_eq!(py_float(2.0), "2.0");
    }

    #[test]
    fn velocity_shift_predicate_edges() {
        assert!(!is_velocity_shift(0.0, 0.0, 1.5));
        assert!(is_velocity_shift(0.0, 50.0, 1.5));
        assert!(is_velocity_shift(50.0, 0.0, 1.5));
        assert!(is_velocity_shift(100.0, -100.0, 1.5));
        assert!(is_velocity_shift(100.0, 150.0, 1.5));
        assert!(is_velocity_shift(150.0, 100.0, 1.5));
        assert!(!is_velocity_shift(100.0, 149.0, 1.5));
    }
}
