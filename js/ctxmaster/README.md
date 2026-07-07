# ctxmaster

Visualization layer for tokenmaster, the core context-budget metering and
decision engine for LLM applications. ctxmaster will provide the user-facing
surfaces: a CLI, a live terminal gauge (context used, effective budget
remaining, projected turns to exhaustion, compaction and handoff advice), and
dashboard renderers. It consumes the serializable state and event schema that
tokenmaster emits; anyone can build an alternative visualizer against the
same contract.

This npm package is published in parallel with the Python package of the same
name on PyPI, with a Rust crate to follow.

## Status

0.0.1 is a placeholder release reserving the name while the core API is
designed. Do not build against it yet. Development happens at
https://github.com/jemsbhai/tokenmaster

## License

MIT
