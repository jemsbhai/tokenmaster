# tokenmaster + ctxmaster

Context-budget instrumentation for LLM applications.

**tokenmaster** (core): provider-agnostic token accounting, calibrated
effective-budget gauges, turns-to-exhaustion prediction, and a decision engine
for when to compact a conversation or hand off to a fresh session via a
continuation prompt.

**ctxmaster** (visualization): CLI, terminal gauge, and dashboard renderers
built on tokenmaster. The core emits a stable, serializable state and event
schema, so anyone can build a visualizer against it; ctxmaster is the first.

## Status

Python packages are at 0.1.0 (alpha): the core contract (docs/core-api.md)
is implemented, with conformance vectors under spec/ freezing the arithmetic
for the ports. npm and crates.io names remain 0.0.1 placeholders until the
JavaScript and Rust implementations land.

## Repository layout

    python/tokenmaster    core library (PyPI: tokenmaster)
    python/ctxmaster      visualization layer (PyPI: ctxmaster)
    js/tokenmaster        core placeholder (npm: tokenmaster)
    js/ctxmaster          visualization placeholder (npm: ctxmaster)
    rust/tokenmaster      core placeholder (crates.io: tokenmaster)
    rust/ctxmaster        visualization placeholder (crates.io: ctxmaster)

## License

MIT
