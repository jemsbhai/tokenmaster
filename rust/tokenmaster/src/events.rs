//! Typed event stream, per docs/core-api.md section 4.
//!
//! Wire shape for every event:
//!
//! ```text
//! {"event_type": ..., "schema_version": ..., "timestamp": ...,
//!  "turn_id": ..., "payload": {...}}
//! ```
//!
//! This stream is the entire contract between tokenmaster and any
//! visualizer. Events implemented here are the ones the Meter can emit at
//! this point in the port (TurnRecorded, ZoneChanged, VelocityShift,
//! ModelChanged); AdvisorRecommendation and HandoffEvaluated arrive with the
//! advisor and fidelity modules, and CalibrationLoaded awaits its feature,
//! so that no event type exists in code before something emits it.
//!
//! Timestamps are ISO 8601 UTC with a "Z" suffix and microsecond precision,
//! produced by a std-only epoch-to-civil conversion (the reference emits
//! "+00:00" via datetime, the JS port "Z" via Date). Conformance is
//! unaffected: the spec excludes timestamps from comparison everywhere, and
//! wire round trips preserve the stored string verbatim.

use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::types::{
    as_map, opt_i64, req_f64, req_string, string_or, Error, MeterState, TurnUsage, Zone,
    SCHEMA_VERSION,
};

// ------------------------------------------------------------------------ //
// timestamps

/// Gregorian civil date from days since 1970-01-01 (Howard Hinnant's
/// civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_utc(secs: i64, micros: u32) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (h, m, s) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{micros:06}Z")
}

/// Current UTC time as an ISO 8601 string.
pub(crate) fn utcnow() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_utc(now.as_secs() as i64, now.subsec_micros())
}

// ------------------------------------------------------------------------ //
// events

/// One emitted event: the shared envelope plus a typed payload.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Event {
    pub turn_id: Option<i64>,
    pub timestamp: String,
    pub schema_version: String,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// Typed payloads. Wire tag is `event_type`, payload fields nest under
/// `payload`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event_type", content = "payload", rename_all = "snake_case")]
pub enum EventKind {
    /// A turn was ingested; carries the turn and the resulting state.
    TurnRecorded { turn: TurnUsage, state: MeterState },
    /// fill_effective crossed a zone boundary.
    ZoneChanged {
        from_zone: Zone,
        to_zone: Zone,
        fill_effective: f64,
    },
    /// Velocity moved by more than the configured factor between turns.
    VelocityShift { previous: f64, current: f64 },
    /// A recorded turn carried a different model_id than the previous one.
    ///
    /// The Meter keeps gauging against its constructed profile; this event
    /// only reports the switch so consumers can decide what it means for
    /// them.
    ModelChanged {
        previous_model_id: String,
        new_model_id: String,
    },
}

impl EventKind {
    /// Wire tag for this payload.
    pub fn event_type(&self) -> &'static str {
        match self {
            EventKind::TurnRecorded { .. } => "turn_recorded",
            EventKind::ZoneChanged { .. } => "zone_changed",
            EventKind::VelocityShift { .. } => "velocity_shift",
            EventKind::ModelChanged { .. } => "model_changed",
        }
    }
}

fn req_value<'a>(d: &'a Map<String, Value>, key: &str, ctx: &str) -> Result<&'a Value, Error> {
    d.get(key)
        .ok_or_else(|| Error::Parse(format!("{ctx}: missing required field '{key}'")))
}

impl Event {
    /// Construct an event stamped with the current time.
    pub fn new(turn_id: Option<i64>, kind: EventKind) -> Event {
        Event {
            turn_id,
            timestamp: utcnow(),
            schema_version: SCHEMA_VERSION.to_string(),
            kind,
        }
    }

    /// Wire tag for this event.
    pub fn event_type(&self) -> &'static str {
        self.kind.event_type()
    }

    /// JSON string form. Infallible for any event the core produces.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("Event serialization")
    }

    /// Reconstruct a typed event from its wire form (the reference's
    /// `event_from_dict`).
    pub fn from_value(v: &Value) -> Result<Event, Error> {
        let d = as_map(v, "Event")?;
        let event_type = req_string(d, "event_type", "Event")?;
        let empty = Map::new();
        let payload = match d.get("payload") {
            None => &empty,
            Some(p) => as_map(p, "Event payload")?,
        };
        let kind = match event_type.as_str() {
            "turn_recorded" => EventKind::TurnRecorded {
                turn: TurnUsage::from_value(req_value(payload, "turn", "TurnRecorded payload")?)?,
                state: MeterState::from_value(req_value(
                    payload,
                    "state",
                    "TurnRecorded payload",
                )?)?,
            },
            "zone_changed" => EventKind::ZoneChanged {
                from_zone: Zone::from_str(&req_string(
                    payload,
                    "from_zone",
                    "ZoneChanged payload",
                )?)?,
                to_zone: Zone::from_str(&req_string(payload, "to_zone", "ZoneChanged payload")?)?,
                fill_effective: req_f64(payload, "fill_effective", "ZoneChanged payload")?,
            },
            "velocity_shift" => EventKind::VelocityShift {
                previous: req_f64(payload, "previous", "VelocityShift payload")?,
                current: req_f64(payload, "current", "VelocityShift payload")?,
            },
            "model_changed" => EventKind::ModelChanged {
                previous_model_id: req_string(
                    payload,
                    "previous_model_id",
                    "ModelChanged payload",
                )?,
                new_model_id: req_string(payload, "new_model_id", "ModelChanged payload")?,
            },
            other => return Err(Error::Value(format!("Unknown event_type: '{other}'"))),
        };
        Ok(Event {
            turn_id: opt_i64(d, "turn_id", "Event")?,
            timestamp: req_string(d, "timestamp", "Event")?,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "Event")?,
            kind,
        })
    }
}

// ------------------------------------------------------------------------ //
// unit tests for the timestamp conversion (pinned known epochs)

#[cfg(test)]
mod tests {
    use super::{format_utc, utcnow};

    #[test]
    fn format_utc_matches_known_epochs() {
        assert_eq!(format_utc(0, 0), "1970-01-01T00:00:00.000000Z");
        assert_eq!(format_utc(1_767_225_600, 0), "2026-01-01T00:00:00.000000Z");
        // Leap day, midday, with microseconds.
        assert_eq!(
            format_utc(1_709_164_800 + 43_200, 123_456),
            "2024-02-29T12:00:00.123456Z"
        );
    }

    #[test]
    fn utcnow_is_iso_8601_utc() {
        let ts = utcnow();
        assert_eq!(ts.len(), "1970-01-01T00:00:00.000000Z".len());
        assert!(ts.ends_with('Z'));
        assert_eq!(&ts[10..11], "T");
    }
}
