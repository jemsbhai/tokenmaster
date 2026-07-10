# ctxmaster

The context gauge for [tokenmaster](https://crates.io/crates/tokenmaster):
a terminal panel showing context used against calibrated effective capacity,
token velocity, projected turns to exhaustion, and the current zone, redrawn
in place as the conversation runs.

Every number displayed comes straight from tokenmaster's MeterState; the
gauge computes nothing itself. Rendering is raw ANSI with zero dependencies
beyond the core: no terminal framework, no color crate.

## Install

    cargo add ctxmaster tokenmaster

## Quickstart

```rust
use ctxmaster::ContextGauge;
use tokenmaster::Meter;

let mut meter = Meter::for_model("claude-haiku-4-5")?;
let gauge = ContextGauge::new();

// live: draws now, redraws in place on every recorded turn
let live = gauge.live(&mut meter);
// ... record turns on the meter as the conversation runs ...
meter.unsubscribe(live);

// or render once, on demand
gauge.print(&meter.state());
```

A simulated conversation driving the gauge ships as an example in the
repository:

    cargo run --example demo -p ctxmaster

## What the panel shows

- A zone-colored fill bar against the effective window, with tick marks at
  the caution and critical thresholds and the fill percentage.
- Context accounting: used tokens against effective capacity, with the
  nominal window alongside, and the capacity provenance (calibrated source
  or "nominal (uncalibrated)").
- Velocity with dispersion, ETA with its conservative bound, and the zone,
  each falling back to the meter's own provenance reason when a value is
  not yet available (cold start, exhausted, velocity not positive).
- Optional rows when the state carries them: reserved output, hidden
  overhead (system prompt plus tool schemas), and the estimated stable
  cache prefix.

Color support is detected from NO_COLOR, FORCE_COLOR, TERM=dumb, and TTY
state when writing to the default stream; a custom write sink defaults to
plain text unless colors are requested explicitly.

Threshold ticks are display parameters (defaults caution 0.70, critical
0.85) because MeterState at schema 0.1 does not carry the meter's
thresholds; a Meter configured with custom thresholds should be paired with
a gauge constructed to match. Promoting thresholds into MeterState is a
schema 0.2 candidate.

Windows note: raw ANSI renders correctly in Windows Terminal and modern
PowerShell. A legacy conhost without virtual terminal processing shows
escape codes instead.

## License

MIT
