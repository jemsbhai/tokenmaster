# Changelog

All notable changes to the Tokenmaster Rust crate are documented here.

## 0.2.0 (2026-07-31)

- Added the complete GPT-5.6 Sol, Terra, and Luna profiles, including the
  `gpt-5.6`/`openai:gpt-5.6` Sol aliases, verified capacities, cache-write
  prices, and Standard long-context tiers above 272K input tokens.
- Added standalone `PricingSchedule`, `PricingTier`, and `PricingScope`
  types without changing the existing public `Pricing` or `ModelProfile`
  struct-literal shapes.
- Added tier-aware usage quotes, request limit checks, Registry schedule
  lookup/overrides, conservative request-cost estimates, and schedule-aware
  compaction/handoff economics in parity with Python and JavaScript.
- Corrected GPT-5.4 mini's bundled maximum output to 128,000 tokens.
- Added Gemini 3.1 Pro's verified 65,536-token output cap, Standard tier above
  200K prompt tokens, and custom-tools endpoint alias; corrected Gemini 3.5
  Flash's exact capacity. Gemini token-hour cache storage is explicitly
  unpriced, so quotes and cost policies fail closed instead of treating writes
  as free.

## 0.1.0 (2026-07-08)

- Initial conformant Rust implementation of the Tokenmaster 0.1 core API,
  registry, meter, advisor policies, event stream, and handoff fidelity
  protocol.
