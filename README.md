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

The tokenmaster core packages are at 0.2.0 for Python, JavaScript, and Rust.
The companion ctxmaster packages are at 0.1.2 for Python and 0.1.1 for
JavaScript and Rust. All are alpha: the core contract
(docs/core-api.md) is implemented in all three languages, and the JavaScript
and Rust ports reproduce all nine conformance vectors under spec/ that
freeze the arithmetic across languages. The JavaScript packages carry zero
runtime dependencies (the wrapper depends only on the core); the Rust
crates depend on serde and serde_json only.

The bundled registry contains 15 offline profiles, including GPT-5.6 Sol,
Terra, and Luna with tier-aware Standard pricing. Maintainers can explicitly
check official OpenAI documentation with `tokenmaster-models`; a weekly
workflow reports drift for review. Library imports and ordinary meter use
never access the network or mutate registry data.

## Repository layout

    python/tokenmaster    core library (PyPI: tokenmaster)
    python/ctxmaster      visualization layer (PyPI: ctxmaster)
    js/tokenmaster        core library (npm: tokenmaster)
    js/ctxmaster          visualization layer (npm: ctxmaster)
    rust/tokenmaster      core library (crates.io: tokenmaster)
    rust/ctxmaster        visualization layer (crates.io: ctxmaster)

## License

MIT
