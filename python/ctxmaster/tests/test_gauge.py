"""Tests for the context gauge, rendered to plain text and asserted on content."""

import pytest
from rich.console import Console

from ctxmaster import ContextGauge
from tokenmaster import Meter
from tokenmaster.types import CalibrationRecord, ModelProfile


def profile(window=100_000, effective=None):
    return ModelProfile(
        model_id="test:model",
        provider="test",
        window_nominal=window,
        effective=effective,
    )


def make_gauge(**kwargs):
    console = Console(width=100, record=True, color_system=None)
    gauge = ContextGauge(console=console, bar_width=kwargs.pop("bar_width", 30), **kwargs)
    return gauge, console


def test_render_shows_usage_numbers_and_percent():
    gauge, console = make_gauge()
    m = Meter(profile(window=100_000))
    m.record({"input_tokens": 50_000})
    gauge.print(m.state())
    text = console.export_text()
    assert "50,000" in text
    assert "100,000" in text
    assert "50.0%" in text
    assert "test:model" in text


def test_cold_start_reason_is_shown():
    gauge, console = make_gauge()
    m = Meter(profile())
    m.record({"input_tokens": 1_000})
    gauge.print(m.state())
    text = console.export_text()
    assert "cold start" in text


def test_uncalibrated_capacity_is_labeled():
    gauge, console = make_gauge()
    m = Meter(profile())
    m.record({"input_tokens": 1_000})
    gauge.print(m.state())
    assert "uncalibrated" in console.export_text()


def test_calibrated_capacity_shows_source_and_effective_window():
    cal = CalibrationRecord(
        model_id="test:model",
        effective_context=80_000,
        method="probe-kit",
        source="local run",
    )
    gauge, console = make_gauge()
    m = Meter(profile(window=100_000, effective=cal))
    m.record({"input_tokens": 40_000})
    gauge.print(m.state())
    text = console.export_text()
    assert "80,000" in text
    assert "probe-kit" in text
    assert "uncalibrated" not in text


def test_zone_label_rendered_for_critical_fill():
    gauge, console = make_gauge()
    m = Meter(profile(window=1_000))
    m.record({"input_tokens": 900})
    gauge.print(m.state())
    assert "CRITICAL" in console.export_text()


def test_eta_rendered_with_conservative_bound():
    gauge, console = make_gauge()
    m = Meter(profile(window=100_000))
    for total in (1_000, 1_300, 1_650, 2_100):
        m.record({"input_tokens": total})
    gauge.print(m.state())
    text = console.export_text()
    assert "eta" in text
    assert "conservative" in text


def test_attach_prints_on_record_and_unsubscribe_stops():
    gauge, console = make_gauge()
    m = Meter(profile())
    unsubscribe = gauge.attach(m)
    m.record({"input_tokens": 12_345})
    unsubscribe()
    m.record({"input_tokens": 20_000})
    text = console.export_text()
    assert "12,345" in text
    assert text.count("ctxmaster") == 1


def test_render_smoke_at_minimum_bar_width():
    gauge, console = make_gauge(bar_width=5)
    m = Meter(profile())
    m.record({"input_tokens": 50_000})
    gauge.print(m.state())
    assert "50,000" in console.export_text()


def test_bar_width_validation():
    with pytest.raises(ValueError):
        ContextGauge(bar_width=3)
