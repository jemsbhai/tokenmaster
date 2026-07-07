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

Placeholder stage (0.0.1): reserving package names and laying out the monorepo
while the core API is designed. Do not build against these versions.

## Repository layout

    python/tokenmaster    core library (PyPI: tokenmaster)
    python/ctxmaster      visualization layer (PyPI: ctxmaster)
    js/tokenmaster        core placeholder (npm: tokenmaster)
    js/ctxmaster          visualization placeholder (npm: ctxmaster)

Rust crates under the same names will follow in this repository.

## License

MIT
