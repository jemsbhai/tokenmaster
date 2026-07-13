# ctxmaster

Visualization layer for [tokenmaster](https://pypi.org/project/tokenmaster/),
the core context-budget metering and decision engine for LLM applications.

The hero surface is the context gauge: a zone-colored fill bar against the
model's effective window with threshold ticks, and ancillary rows for context
accounting, capacity provenance, token velocity, projected turns to
exhaustion with a conservative bound, zone, reserved output, hidden overhead,
and cache prefix. The gauge computes nothing itself; every number comes off
tokenmaster's MeterState, and anyone can build an alternative visualizer
against the same event stream.

## Install

    pip install ctxmaster

## Quickstart

```python
from tokenmaster import Meter
from ctxmaster import ContextGauge

meter = Meter.for_model("anthropic:claude-haiku-4-5")
gauge = ContextGauge()

gauge.attach(meter)   # prints a fresh gauge on every recorded turn

meter.record({"input_tokens": 48_000, "output_tokens": 1_200})
```

For an in-place updating display in interactive sessions:

```python
with gauge.live(meter):
    ...  # record turns; the panel updates in place
```

A runnable demonstration lives at `examples/demo_gauge.py` in the
repository: a simulated agent accelerating from green into critical.

## What is in 0.1.0

The terminal gauge with per-turn and live rendering. Planned next: the
advice panel rendering tokenmaster recommendations with their rationale, a
CLI, and dashboard surfaces. The npm and crates.io packages of the same
name are live at 0.1.0, rendering in raw ANSI with no dependencies beyond
the core.

## License

MIT
