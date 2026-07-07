# tokenmaster

Core context-budget metering and decision engine for LLM applications:
normalized token accounting, effective-budget gauges, turns-to-exhaustion
prediction, and compaction/handoff decisions.

This crate is published in parallel with the Python and npm packages of the
same name; all implementations will conform to one serializable state and
event schema. The companion crate ctxmaster provides visualization on top of
that schema.

## Status

0.0.1 is a placeholder release reserving the name while the core API is
designed. Do not build against it yet. Development happens at
https://github.com/jemsbhai/tokenmaster

## License

MIT
