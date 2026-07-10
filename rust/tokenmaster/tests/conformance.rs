//! Conformance: replay every committed vector and match states and events.
//!
//! Rust mirror of python/tokenmaster/tests/test_vectors.py; spec/README.md
//! defines the normative comparison rules: timestamps excluded everywhere,
//! floats within 1e-9 (math.isclose semantics, rel and abs), provenance
//! strings character for character, event order per turn normative, and
//! every turn_recorded payload must structurally equal the recorded turn
//! and resulting state.
//!
//! JSON-boundary note: serde_json preserves the int/float distinction from
//! the JSON literal exactly as Python's json module does, so the isclose
//! rule applies to precisely the fields it applies to in the reference (the
//! JS runner needed a stricter integer workaround here; Rust does not).
//!
//! Vectors are read from the repository's spec/vectors directory; in a
//! packaged-crate context that path is absent and the test skips with a
//! note, mirroring the sync-test convention.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Map, Value};
use tokenmaster::{Event, EventKind, Meter, MeterConfig, ModelProfile, TurnUsage};

const SKIP_KEYS: [&str; 1] = ["timestamp"];
const FLOAT_TOL: f64 = 1e-9;

fn assert_matches(actual: &Value, expected: &Value, path: &str) {
    match expected {
        Value::Object(exp) => {
            let act = match actual {
                Value::Object(o) => o,
                _ => panic!("{path}: expected dict"),
            };
            for (key, value) in exp {
                if SKIP_KEYS.contains(&key.as_str()) {
                    continue;
                }
                let a = act
                    .get(key)
                    .unwrap_or_else(|| panic!("{path}.{key}: missing"));
                assert_matches(a, value, &format!("{path}.{key}"));
            }
            let extra: Vec<&str> = act
                .keys()
                .filter(|k| !exp.contains_key(*k) && !SKIP_KEYS.contains(&k.as_str()))
                .map(String::as_str)
                .collect();
            assert!(extra.is_empty(), "{path}: unexpected keys {extra:?}");
        }
        Value::Array(exp) => {
            let act = match actual {
                Value::Array(a) => a,
                _ => panic!("{path}: expected list"),
            };
            assert!(
                act.len() == exp.len(),
                "{path}: length {} != {}",
                act.len(),
                exp.len()
            );
            for (i, (a, e)) in act.iter().zip(exp).enumerate() {
                assert_matches(a, e, &format!("{path}[{i}]"));
            }
        }
        // A float-parsed expectation: math.isclose with rel and abs 1e-9.
        Value::Number(n) if !n.is_i64() && !n.is_u64() => {
            let e = n.as_f64().unwrap();
            let a = match actual {
                Value::Number(an) => an
                    .as_f64()
                    .unwrap_or_else(|| panic!("{path}: expected number")),
                _ => panic!("{path}: expected number"),
            };
            let close =
                (a - e).abs() <= (FLOAT_TOL * a.abs().max(e.abs())).max(FLOAT_TOL);
            assert!(close, "{path}: {a} != {e}");
        }
        _ => assert_eq!(actual, expected, "{path}: mismatch"),
    }
}

fn slim_event(event: &Event) -> Value {
    let mut entry = Map::new();
    entry.insert("event_type".to_string(), json!(event.event_type()));
    entry.insert("turn_id".to_string(), json!(event.turn_id));
    match &event.kind {
        EventKind::TurnRecorded { .. } => {}
        EventKind::ZoneChanged {
            from_zone,
            to_zone,
            fill_effective,
        } => {
            entry.insert("from_zone".to_string(), json!(from_zone.as_str()));
            entry.insert("to_zone".to_string(), json!(to_zone.as_str()));
            entry.insert("fill_effective".to_string(), json!(fill_effective));
        }
        EventKind::VelocityShift { previous, current } => {
            entry.insert("previous".to_string(), json!(previous));
            entry.insert("current".to_string(), json!(current));
        }
        EventKind::ModelChanged {
            previous_model_id,
            new_model_id,
        } => {
            entry.insert("previous_model_id".to_string(), json!(previous_model_id));
            entry.insert("new_model_id".to_string(), json!(new_model_id));
        }
    }
    Value::Object(entry)
}

fn run_vector(path: &Path) {
    let stem = path
        .file_stem()
        .expect("vector filename")
        .to_string_lossy()
        .to_string();
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{stem}: read failed: {e}"));
    let vector: Value =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{stem}: parse failed: {e}"));

    let profile = ModelProfile::from_value(&vector["profile"])
        .unwrap_or_else(|e| panic!("{stem}: profile: {e}"));
    let config_value = &vector["config"];
    let config = MeterConfig {
        reserved_output: config_value["reserved_output"]
            .as_i64()
            .unwrap_or_else(|| panic!("{stem}: config.reserved_output")),
        alpha: config_value["alpha"]
            .as_f64()
            .unwrap_or_else(|| panic!("{stem}: config.alpha")),
        caution: config_value["caution"]
            .as_f64()
            .unwrap_or_else(|| panic!("{stem}: config.caution")),
        critical: config_value["critical"]
            .as_f64()
            .unwrap_or_else(|| panic!("{stem}: config.critical")),
        velocity_shift_factor: config_value["velocity_shift_factor"]
            .as_f64()
            .unwrap_or_else(|| panic!("{stem}: config.velocity_shift_factor")),
    };
    let mut meter =
        Meter::with_config(profile, config).unwrap_or_else(|e| panic!("{stem}: meter: {e}"));

    let collected: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);
    meter.subscribe(move |event: &Event| sink.lock().unwrap().push(event.clone()));

    let turns = vector["turns"]
        .as_array()
        .unwrap_or_else(|| panic!("{stem}: turns is not an array"));
    let mut states: Vec<Value> = Vec::new();
    for turn_value in turns {
        let turn = TurnUsage::from_value(turn_value)
            .unwrap_or_else(|e| panic!("{stem}: turn: {e}"));
        let recorded = meter
            .record(turn)
            .unwrap_or_else(|e| panic!("{stem}: record: {e}"));
        // Structural rule for turn_recorded payloads. The lock guard is
        // scoped so the next record()'s callback cannot deadlock on it.
        {
            let seen = collected.lock().unwrap();
            let (latest_turn, latest_state) = seen
                .iter()
                .rev()
                .find_map(|e| match &e.kind {
                    EventKind::TurnRecorded { turn, state } => {
                        Some((turn.clone(), state.clone()))
                    }
                    _ => None,
                })
                .unwrap_or_else(|| panic!("{stem}: no turn_recorded event"));
            assert_eq!(latest_turn, recorded, "{stem}: turn_recorded payload turn");
            assert_eq!(
                latest_state,
                meter.state(),
                "{stem}: turn_recorded payload state"
            );
        }
        states.push(
            serde_json::to_value(meter.state())
                .unwrap_or_else(|e| panic!("{stem}: state serialization: {e}")),
        );
    }

    assert_matches(
        &Value::Array(states),
        &vector["expected"]["states"],
        &format!("{stem}: states"),
    );
    let slim: Vec<Value> = collected.lock().unwrap().iter().map(slim_event).collect();
    assert_matches(
        &Value::Array(slim),
        &vector["expected"]["events"],
        &format!("{stem}: events"),
    );
    eprintln!("vector ok: {stem}");
}

#[test]
fn vector_conformance() {
    let dir = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors"));
    if !dir.exists() {
        eprintln!("spec/vectors absent; conformance skipped (packaged-crate context)");
        return;
    }
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("spec/vectors is readable")
        .map(|entry| entry.expect("directory entry").path())
        .filter(|p| p.extension().map_or(false, |ext| ext == "json"))
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no committed vectors; run spec/generate_vectors.py"
    );
    for path in &paths {
        run_vector(path);
    }
    eprintln!("conformance: {} vectors reproduced", paths.len());
}
