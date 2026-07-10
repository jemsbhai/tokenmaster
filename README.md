# tokenmaster + ctxmaster

Context-budget instrumentation for LLM applications.

**tokenmaster** (core): provider-agnostic token accounting, calibrated
effective-budget gauges, turns-to-exhaustion prediction, and a decision engine
for when to compact a conversation or hand off to a fresh session via a
continuation prompt.

**ctxmaster** (visualization): CLI, terminal gauge, and dashboard renderers
built on tokenmaster. The core emits a stable, serializable state and event
schema, so anyone can build a visualizer against it; ctxmaster is the first.

## Install

    pip install tokenmaster ctxmaster     # Python
    npm install tokenmaster ctxmaster     # JavaScript
    cargo add tokenmaster ctxmaster       # Rust

## Status

Python, JavaScript, and Rust packages are at 0.1.0 (alpha): the core
contract (docs/core-api.md) is implemented in all three languages, and the
JavaScript and Rust ports reproduce all nine conformance vectors under
spec/ that freeze the arithmetic across languages. The JavaScript packages
carry zero runtime dependencies (the wrapper depends only on the core); the
Rust crates depend on serde and serde_json only.

## Repository layout

    python/tokenmaster    core library (PyPI: tokenmaster)
    python/ctxmaster      visualization layer (PyPI: ctxmaster)
    js/tokenmaster        core library (npm: tokenmaster)
    js/ctxmaster          visualization layer (npm: ctxmaster)
    rust/tokenmaster      core library (crates.io: tokenmaster)
    rust/ctxmaster        visualization layer (crates.io: ctxmaster)

## License

MIT
