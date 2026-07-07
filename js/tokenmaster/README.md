# tokenmaster

Core context-budget metering and decision engine for LLM applications:
normalized token accounting, effective-budget gauges, turns-to-exhaustion
prediction, and compaction/handoff decisions.

This npm package is published in parallel with the Python package of the same
name on PyPI, with a Rust crate to follow; all implementations will conform to
one serializable state and event schema. The companion package ctxmaster
provides visualization on top of that schema.

## Status

0.0.1 is a placeholder release reserving the name while the core API is
designed. Do not build against it yet. Development happens at
https://github.com/jemsbhai/tokenmaster

## License

MIT
