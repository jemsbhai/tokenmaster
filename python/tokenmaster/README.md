# tokenmaster

Core context-budget metering and decision engine for LLM applications.

tokenmaster is being built to answer four questions for any model, provider,
and conversation:

1. How much context has been used, and on what (messages, system prompt, tool
   schemas, reasoning tokens, cache reads)?
2. How much usable budget remains, measured against calibrated effective
   capacity rather than the advertised window?
3. How many turns remain until exhaustion at the current token velocity?
4. Should this conversation be compacted or handed off now, and what would
   that decision cost?

The package is computational only: it ingests provider-reported usage (with
tokenizer-based estimation as an optional fallback), maintains meter state,
and emits snapshots and events through a stable, serializable schema.
Rendering is deliberately excluded. The companion package ctxmaster provides
a CLI, terminal gauge, and dashboards on top of this schema, and third
parties can build their own visualizers against the same contract.

## Status

0.0.1 is a placeholder release reserving the name while the core API is
designed. Do not build against it yet. Development happens at
https://github.com/jemsbhai/tokenmaster

## License

MIT
