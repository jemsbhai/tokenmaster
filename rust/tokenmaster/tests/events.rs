//! Tests for the event stream: wire shape and reconstruction round trips.
//!
//! The reference suite (python/tokenmaster/tests/test_events.py) is mostly
//! Meter-driven: emission rules, ordering, subscribe/unsubscribe, callback
//! propagation. Those tests join this file when meter.rs lands. This step
//! covers what exists without a Meter: the envelope, the wire shape, and
//! Event::from_value (the reference's event_from_dict).

use serde_json::{json, Value};
use tokenmaster::{
    Error, Event, EventKind, MeterState, TurnUsage, UsageSource, Zone, SCHEMA_VERSION,
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
