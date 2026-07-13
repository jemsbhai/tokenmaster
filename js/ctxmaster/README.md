# ctxmaster

Visualization layer for
[tokenmaster](https://www.npmjs.com/package/tokenmaster), the core
context-budget metering and decision engine for LLM applications.

The hero surface is the context gauge: a zone-colored fill bar against the
model's effective window with threshold ticks, and ancillary rows for context
accounting, capacity provenance, token velocity, projected turns to
exhaustion with a conservative bound, zone, reserved output, hidden overhead,
and cache prefix. The gauge computes nothing itself; every number comes off
tokenmaster's MeterState, and anyone can build an alternative visualizer
against the same event stream.

Rendering is raw ANSI with zero runtime dependencies beyond the core: no
color library, no terminal framework. Color support is detected from
NO_COLOR, FORCE_COLOR, TERM, and TTY state, and can be forced either way.

## Install

    npm install ctxmaster

## Quickstart

```js
import { Meter } from "tokenmaster";
import { ContextGauge } from "ctxmaster";

const meter = Meter.forModel("anthropic:claude-haiku-4-5");
const gauge = new ContextGauge();

gauge.attach(meter); // prints a fresh gauge on every recorded turn

meter.record({ input_tokens: 48_000, output_tokens: 1_200 });
```

For an in-place updating display in interactive sessions:

```js
const live = gauge.live(meter);
// record turns; the panel updates in place
live.stop();
```

On Node 24 and later the handle is disposable, so
`using live = gauge.live(meter)` detaches automatically at scope exit.
Rendering somewhere other than stdout, or without colors, goes through
options: `new ContextGauge({ write: sink, colors: false })`, and
`render(state)` returns the panel as a string for any environment.

A runnable demonstration lives at `examples/demo.mjs` in the repository: a
simulated agent accelerating from green into critical.

## What is in 0.1.0

The terminal gauge with per-turn and live rendering, ported from the Python
wrapper with the same panel layout and display formats. Planned next: the
advice panel rendering tokenmaster recommendations with their rationale, a
CLI, and dashboard surfaces. The crates.io packages of the same names are
live at 0.1.0.

## License

MIT
