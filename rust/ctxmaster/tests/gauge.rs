//! Tests for the context gauge: rendered output captured through a sink and
//! asserted on content. Mirrors js/ctxmaster/test/gauge.test.mjs (itself a
//! mirror of python/ctxmaster/tests/test_gauge.py), including color
//! emission and the live in-place redraw.

use std::sync::{Arc, Mutex};

use ctxmaster::{ContextGauge, GaugeOptions};
use serde_json::json;
use tokenmaster::{CalibrationRecord, Error, Meter, MeterConfig, ModelProfile, SCHEMA_VERSION};

fn profile(window: i64, effective: Option<i64>) -> ModelProfile {
    let mut p = ModelProfile::new("test:model", "test", window).unwrap();
    if let Some(effective_context) = effective {
        p.effective = Some(CalibrationRecord {
            model_id: "test:model".to_string(),
            effective_context,
            method: "probe-kit".to_string(),
            source: "local run".to_string(),
            measured_at: None,
            confidence: None,
            schema_version: SCHEMA_VERSION.to_string(),
        });
        p.validate().unwrap();
    }
    p
}

fn make_gauge(bar_width: usize, colors: Option<bool>) -> (ContextGauge, Arc<Mutex<String>>) {
    let buffer = Arc::new(Mutex::new(String::new()));
    let sink = Arc::clone(&buffer);
    let gauge = ContextGauge::with_options(GaugeOptions {
        write: Some(Box::new(move |chunk: &str| {
            sink.lock().unwrap().push_str(chunk)
        })),
        colors,
        bar_width,
        ..GaugeOptions::default()
    })
    .unwrap();
    (gauge, buffer)
}

fn text(buffer: &Arc<Mutex<String>>) -> String {
    buffer.lock().unwrap().clone()
}

fn record_total(m: &mut Meter, total: i64) {
    m.record_value(&json!({ "input_tokens": total })).unwrap();
}

#[test]
fn render_shows_usage_numbers_and_percent() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    record_total(&mut m, 50_000);
    gauge.print(&m.state());
    let out = text(&buffer);
    assert!(out.contains("50,000"));
    assert!(out.contains("100,000"));
    assert!(out.contains("50.0%"));
    assert!(out.contains("test:model"));
}

#[test]
fn cold_start_reason_is_shown() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    record_total(&mut m, 1_000);
    gauge.print(&m.state());
    assert!(text(&buffer).contains("cold start"));
}

#[test]
fn uncalibrated_capacity_is_labeled() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    record_total(&mut m, 1_000);
    gauge.print(&m.state());
    assert!(text(&buffer).contains("uncalibrated"));
}

#[test]
fn calibrated_capacity_shows_source_and_effective_window() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, Some(80_000))).unwrap();
    record_total(&mut m, 40_000);
    gauge.print(&m.state());
    let out = text(&buffer);
    assert!(out.contains("80,000"));
    assert!(out.contains("probe-kit"));
    assert!(!out.contains("uncalibrated"));
}

#[test]
fn zone_label_rendered_for_critical_fill() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(1_000, None)).unwrap();
    record_total(&mut m, 900);
    gauge.print(&m.state());
    assert!(text(&buffer).contains("CRITICAL"));
}

#[test]
fn eta_rendered_with_conservative_bound() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    for total in [1_000, 1_300, 1_650, 2_100] {
        record_total(&mut m, total);
    }
    gauge.print(&m.state());
    let out = text(&buffer);
    assert!(out.contains("eta"));
    assert!(out.contains("conservative"));
}

#[test]
fn attach_prints_on_record_and_unsubscribe_stops() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    let id = gauge.attach(&mut m);
    record_total(&mut m, 12_345);
    assert!(m.unsubscribe(id));
    record_total(&mut m, 20_000);
    let out = text(&buffer);
    assert!(out.contains("12,345"));
    assert_eq!(out.matches("ctxmaster").count(), 1);
}

#[test]
fn render_smoke_at_minimum_bar_width() {
    let (gauge, buffer) = make_gauge(5, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    record_total(&mut m, 50_000);
    gauge.print(&m.state());
    assert!(text(&buffer).contains("50,000"));
}

#[test]
fn bar_width_validation() {
    let result = ContextGauge::with_options(GaugeOptions {
        bar_width: 3,
        ..GaugeOptions::default()
    });
    match result {
        Err(Error::Value(message)) => assert_eq!(message, "bar_width must be at least 5"),
        _ => panic!("expected bar_width validation error"),
    }
}

#[test]
fn optional_rows_render_reserved_output_overhead_and_cache() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::with_config(
        profile(100_000, None),
        MeterConfig {
            reserved_output: 2_000,
            ..MeterConfig::default()
        },
    )
    .unwrap();
    m.record_value(&json!({
        "input_tokens": 10_000,
        "cache_read_tokens": 8_000,
        "cache_write_tokens": 500,
        "breakdown": { "system_prompt": 3_000, "tool_schemas": 1_200 }
    }))
    .unwrap();
    gauge.print(&m.state());
    let out = text(&buffer);
    assert!(out.contains("2,000 tok output"));
    assert!(out.contains("4,200 tok (system prompt + tool schemas)"));
    assert!(out.contains("~8,500 tok stable prefix"));
}

#[test]
fn custom_sink_defaults_to_plain_text_explicit_colors_emit_ansi() {
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    record_total(&mut m, 50_000);

    let (plain_gauge, plain_buffer) = make_gauge(30, None);
    plain_gauge.print(&m.state());
    assert!(!text(&plain_buffer).contains("\u{1b}["));

    let (color_gauge, color_buffer) = make_gauge(30, Some(true));
    color_gauge.print(&m.state());
    assert!(text(&color_buffer).contains("\u{1b}["));
}

#[test]
fn live_draws_immediately_redraws_in_place_and_stop_detaches() {
    let (gauge, buffer) = make_gauge(30, None);
    let mut m = Meter::new(profile(100_000, None)).unwrap();
    let id = gauge.live(&mut m);
    assert_eq!(text(&buffer).matches("ctxmaster").count(), 1);

    record_total(&mut m, 25_000);
    let out = text(&buffer);
    assert_eq!(out.matches("ctxmaster").count(), 2);
    assert!(
        out.contains("A\u{1b}[0J"),
        "expected a cursor-up and clear sequence"
    );
    assert!(out.contains("25,000"));

    assert!(m.unsubscribe(id));
    record_total(&mut m, 50_000);
    assert_eq!(text(&buffer).matches("ctxmaster").count(), 2);
}
