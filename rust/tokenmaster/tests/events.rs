//! Tests for the event stream: wire shape, reconstruction round trips, and
//! (now that meter.rs exists) the Meter-driven emission rules, ordering,
//! and delivery tests mirrored from
//! python/tokenmaster/tests/test_events.py.
//!
//! VelocityShift reference numbers, alpha = 0.3, factor = 1.5, context
//! totals 1000, 1100, 1200, 1300, 1800:
//!
//!   g = 100, 100, 100 -> mean stays 100.0 (velocity exposed from turn 3)
//!   g5 = 500 -> diff = 400, incr = 120, mean = 220.0
//!   ratio 220 / 100 = 2.2 >= 1.5 -> VelocityShift(previous=100, current=220)

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokenmaster::{
    Error, Event, EventKind, Meter, MeterState, ModelProfile, TurnUsage, UsageSource, Zone,
    SCHEMA_VERSION,
};

fn make_state() -> MeterState {
    MeterState {
        model_id: "test:model".to_string(),
        turns: 1,
        used_tokens: 500,
        window_nominal: 10_000,
        window_effective: 10_000,
        effective_source: "nominal (uncalibrated)".to_string(),
        reserved_output: 0,
        headroom_nominal: 9_500,
        headroom_effective: 9_500,
        fill_nominal: 0.05,
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
    }
}

fn make_turn() -> TurnUsage {
    let mut turn = TurnUsage::new(1);
    turn.input_tokens = 500;
    turn.source = UsageSource::Reported;
    turn
}

fn meter_for(window: i64) -> Meter {
    Meter::new(ModelProfile::new("test:model", "test", window).unwrap()).unwrap()
}

fn record_total(m: &mut Meter, total: i64) {
    m.record_value(&json!({ "input_tokens": total })).unwrap();
}

fn collect(meter: &mut Meter) -> Arc<Mutex<Vec<Event>>> {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    meter.subscribe(move |event: &Event| sink.lock().unwrap().push(event.clone()));
    seen
}

// ------------------------------------------------------------------------ //
// wire shape and reconstruction

#[test]
fn envelope_defaults_and_event_type_tags() {
    let ev = Event::new(
        Some(2),
        EventKind::VelocityShift {
            previous: 100.0,
            current: 220.0,
        },
    );
    assert_eq!(ev.turn_id, Some(2));
    assert_eq!(ev.schema_version, SCHEMA_VERSION);
    assert_eq!(ev.event_type(), "velocity_shift");
    assert!(ev.timestamp.ends_with('Z'));

    let kinds = [
        (
            EventKind::TurnRecorded {
                turn: make_turn(),
                state: make_state(),
            },
            "turn_recorded",
        ),
        (
            EventKind::ZoneChanged {
                from_zone: Zone::Green,
                to_zone: Zone::Caution,
                fill_effective: 0.7,
            },
            "zone_changed",
        ),
        (
            EventKind::VelocityShift {
                previous: 100.0,
                current: 220.0,
            },
            "velocity_shift",
        ),
        (
            EventKind::ModelChanged {
                previous_model_id: "test:model".to_string(),
                new_model_id: "test:other-model".to_string(),
            },
            "model_changed",
        ),
    ];
    for (kind, expected) in kinds {
        assert_eq!(kind.event_type(), expected);
    }
}

#[test]
fn wire_shape_matches_the_contract_envelope() {
    let ev = Event::new(
        Some(2),
        EventKind::ZoneChanged {
            from_zone: Zone::Green,
            to_zone: Zone::Caution,
            fill_effective: 0.7,
        },
    );
    let wire = serde_json::to_value(&ev).unwrap();
    assert_eq!(wire["event_type"], json!("zone_changed"));
    assert_eq!(wire["turn_id"], json!(2));
    assert_eq!(wire["schema_version"], json!(SCHEMA_VERSION));
    assert!(wire["timestamp"].is_string());
    assert_eq!(wire["payload"]["from_zone"], json!("green"));
    assert_eq!(wire["payload"]["to_zone"], json!("caution"));
    assert_eq!(wire["payload"]["fill_effective"], json!(0.7));
}

#[test]
fn turn_recorded_payload_nests_turn_and_state() {
    let ev = Event::new(
        Some(1),
        EventKind::TurnRecorded {
            turn: make_turn(),
            state: make_state(),
        },
    );
    let wire = serde_json::to_value(&ev).unwrap();
    assert_eq!(wire["payload"]["turn"]["input_tokens"], json!(500));
    assert_eq!(wire["payload"]["state"]["used_tokens"], json!(500));
    assert_eq!(wire["payload"]["state"]["zone"], json!("green"));
}

#[test]
fn event_wire_round_trip_all_kinds() {
    let events = [
        Event::new(
            Some(1),
            EventKind::TurnRecorded {
                turn: make_turn(),
                state: make_state(),
            },
        ),
        Event::new(
            Some(2),
            EventKind::ZoneChanged {
                from_zone: Zone::Green,
                to_zone: Zone::Caution,
                fill_effective: 0.7,
            },
        ),
        Event::new(
            Some(5),
            EventKind::VelocityShift {
                previous: 100.0,
                current: 220.0,
            },
        ),
        Event::new(
            Some(2),
            EventKind::ModelChanged {
                previous_model_id: "test:model".to_string(),
                new_model_id: "test:other-model".to_string(),
            },
        ),
    ];
    for ev in events {
        let wire = serde_json::to_value(&ev).unwrap();
        let back = Event::from_value(&wire).unwrap();
        assert_eq!(back, ev);
    }
}

#[test]
fn from_value_fills_envelope_defaults() {
    let wire = json!({
        "event_type": "velocity_shift",
        "timestamp": "2026-07-09T00:00:00.000000Z",
        "payload": {"previous": 100.0, "current": 220.0}
    });
    let ev = Event::from_value(&wire).unwrap();
    assert_eq!(ev.turn_id, None);
    assert_eq!(ev.schema_version, SCHEMA_VERSION);
    assert_eq!(ev.timestamp, "2026-07-09T00:00:00.000000Z");
}

#[test]
fn from_value_rejects_unknown_event_type() {
    let wire = json!({
        "event_type": "bogus",
        "timestamp": "2026-07-09T00:00:00.000000Z",
        "payload": {}
    });
    let err = Event::from_value(&wire).unwrap_err();
    assert!(matches!(err, Error::Value(_)));
    assert_eq!(err.to_string(), "Unknown event_type: 'bogus'");

    let not_an_object: Value = json!([1, 2, 3]);
    assert!(Event::from_value(&not_an_object).is_err());
}

// ------------------------------------------------------------------------ //
// Meter-driven emission rules (mirrored from test_events.py)

#[test]
fn turn_recorded_carries_turn_and_state() {
    let mut m = meter_for(10_000);
    let seen = collect(&mut m);
    record_total(&mut m, 500);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let ev = &seen[0];
    assert_eq!(ev.turn_id, Some(1));
    match &ev.kind {
        EventKind::TurnRecorded { turn, state } => {
            assert_eq!(turn.input_tokens, 500);
            assert_eq!(*state, m.state());
        }
        other => panic!("expected TurnRecorded, got {other:?}"),
    }
}

#[test]
fn zone_changed_emitted_only_on_crossing() {
    let mut m = meter_for(1_000);
    let seen = collect(&mut m);
    record_total(&mut m, 500); // green, no crossing
    record_total(&mut m, 720); // green -> caution
    record_total(&mut m, 730); // still caution, no event
    record_total(&mut m, 860); // caution -> critical
    let seen = seen.lock().unwrap();
    let crossings: Vec<(Zone, Zone, Option<i64>)> = seen
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::ZoneChanged {
                from_zone, to_zone, ..
            } => Some((*from_zone, *to_zone, e.turn_id)),
            _ => None,
        })
        .collect();
    assert_eq!(
        crossings,
        vec![
            (Zone::Green, Zone::Caution, Some(2)),
            (Zone::Caution, Zone::Critical, Some(4)),
        ]
    );
}

#[test]
fn velocity_shift_on_factor_breach() {
    let mut m = meter_for(100_000);
    let seen = collect(&mut m);
    for total in [1_000, 1_100, 1_200, 1_300, 1_800] {
        record_total(&mut m, total);
    }
    let seen = seen.lock().unwrap();
    let shifts: Vec<(f64, f64, Option<i64>)> = seen
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::VelocityShift { previous, current } => {
                Some((*previous, *current, e.turn_id))
            }
            _ => None,
        })
        .collect();
    assert_eq!(shifts.len(), 1);
    let (previous, current, turn_id) = shifts[0];
    assert!((previous - 100.0).abs() < 1e-9);
    assert!((current - 220.0).abs() < 1e-9);
    assert_eq!(turn_id, Some(5));
}

#[test]
fn no_velocity_shift_on_steady_growth() {
    let mut m = meter_for(100_000);
    let seen = collect(&mut m);
    for total in [1_000, 1_100, 1_200, 1_300, 1_400, 1_500] {
        record_total(&mut m, total);
    }
    let seen = seen.lock().unwrap();
    assert!(!seen
        .iter()
        .any(|e| matches!(e.kind, EventKind::VelocityShift { .. })));
}

#[test]
fn model_changed_on_mid_conversation_switch() {
    let mut m = meter_for(10_000);
    let seen = collect(&mut m);
    record_total(&mut m, 100);
    m.record_value(&json!({ "input_tokens": 200, "model_id": "test:other-model" }))
        .unwrap();
    m.record_value(&json!({ "input_tokens": 300, "model_id": "test:other-model" }))
        .unwrap();
    let seen = seen.lock().unwrap();
    let switches: Vec<(&str, &str, Option<i64>)> = seen
        .iter()
        .filter_map(|e| match &e.kind {
            EventKind::ModelChanged {
                previous_model_id,
                new_model_id,
            } => Some((previous_model_id.as_str(), new_model_id.as_str(), e.turn_id)),
            _ => None,
        })
        .collect();
    assert_eq!(switches, vec![("test:model", "test:other-model", Some(2))]);
}

#[test]
fn event_order_is_deterministic() {
    let mut m = meter_for(1_000);
    let seen = collect(&mut m);
    record_total(&mut m, 500);
    m.record_value(&json!({ "input_tokens": 900, "model_id": "test:other-model" }))
        .unwrap();
    let seen = seen.lock().unwrap();
    let second_turn: Vec<&str> = seen
        .iter()
        .filter(|e| e.turn_id == Some(2))
        .map(|e| e.event_type())
        .collect();
    assert_eq!(
        second_turn,
        vec!["turn_recorded", "zone_changed", "model_changed"]
    );
}

#[test]
fn unsubscribe_stops_delivery() {
    let mut m = meter_for(10_000);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let id = m.subscribe(move |event: &Event| sink.lock().unwrap().push(event.clone()));
    record_total(&mut m, 100);
    assert!(m.unsubscribe(id));
    record_total(&mut m, 200);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!m.unsubscribe(id));
}

#[test]
fn events_slice_replays_all_in_order() {
    let mut m = meter_for(1_000);
    record_total(&mut m, 500);
    record_total(&mut m, 720);
    let types: Vec<&str> = m.events().iter().map(|e| e.event_type()).collect();
    assert_eq!(types, vec!["turn_recorded", "turn_recorded", "zone_changed"]);
}

#[test]
fn meter_event_wire_round_trip() {
    let mut m = meter_for(1_000);
    record_total(&mut m, 720);
    assert!(!m.events().is_empty());
    for ev in m.events() {
        let back = Event::from_value(&serde_json::to_value(ev).unwrap()).unwrap();
        assert_eq!(&back, ev);
    }
}

#[test]
#[should_panic(expected = "visualizer bug")]
fn subscriber_panics_propagate() {
    let mut m = meter_for(10_000);
    m.subscribe(|_event: &Event| panic!("visualizer bug"));
    let _ = m.record_value(&json!({ "input_tokens": 100 }));
}
