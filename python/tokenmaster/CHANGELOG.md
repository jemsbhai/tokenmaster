# Changelog

All notable changes to tokenmaster are documented in this file.

## 0.2.0 (2026-07-31)

- Added bundled profiles for the complete OpenAI GPT-5.6 family: Sol,
  Terra, and Luna. The `gpt-5.6` and `openai:gpt-5.6` aliases resolve to
  Sol.
- Recorded the verified 1,050,000-token windows, 128,000-token output caps,
  dated pricing, nonzero cache-write pricing, and Standard long-context
  prices above 272K input tokens for all three GPT-5.6 profiles.
- Added backward-compatible `PricingSchedule`, `PricingTier`, and
  `PricingScope` registry data, tier-aware `quote_usage`, request limit
  checks, conservative `quote_estimate` reservations, and schedule-aware
  compaction/handoff economics.
- Added the explicit `tokenmaster-models check|propose|discover|apply`
  maintainer tool. It reads allow-listed official OpenAI Markdown, checks
  model pages against central pricing, emits source hashes and reviewable
  diffs, and never runs from the normal Tokenmaster runtime.
- Added a weekly report-only registry drift workflow. New models and aliases
  remain proposals; the workflow never mutates the default branch or
  publishes packages.
- Corrected the bundled GPT-5.4 mini output cap to 128,000 tokens and
  refreshed its pricing provenance.
- Added Gemini 3.1 Pro's verified 65,536-token output cap, Standard tier above
  200K prompt tokens, and custom-tools endpoint alias; corrected Gemini 3.5
  Flash's exact capacity. Gemini token-hour cache storage is explicitly
  unpriced, so quotes and cost policies fail closed instead of treating writes
  as free.

## 0.1.1 (2026-07-13)

- Documentation-only release; no code changes.
- README: new "Models outside the registry" section covering custom
  ModelProfile construction, process-wide registration with aliases, and
  overriding bundled capacities or pricing (prompted by feedback from a
  downstream integrator).
- README: event stream corrected to six event types; the JavaScript (npm)
  and Rust (crates.io) ports recorded as live at 0.1.0 and conformant
  against the shared vectors.

## 0.1.0 (2026-07-07)

- Typed data model (ModelProfile, TurnUsage, MeterState, CalibrationRecord)
  with provenance tags, validation, and exact JSON round-trips.
- Meter: latest-turn accounting, EWMA velocity with incremental variance,
  conservative turns-to-exhaustion, zone logic, exhaustion semantics, and
  persistence by replay.
- Bundled model registry (12 models, dated and cited pricing), alias and
  dated-suffix resolution, user overrides, Meter.for_model.
- Typed event stream with deterministic per-turn emission: TurnRecorded,
  ZoneChanged, VelocityShift, ModelChanged, AdvisorRecommendation,
  HandoffEvaluated; wire round-trips via event_from_dict.
- Advisor: ThresholdPolicy baseline, PredictivePolicy (conservative-eta
  coverage with fallback delegation), CostModelPolicy (cache break-even k*,
  dual-unit ledger, feasibility handling).
- Handoff fidelity protocol: probe categories, weighted scoring,
  adapter protocols for every LLM touchpoint, ExactMatchJudge,
  reproducibility fields and explicit caveats.
- Conformance vectors under spec/ with normative comparison rules.

## 0.0.1 (2026-07-07)

- Placeholder release reserving the package name on PyPI.
- Exposes `__version__` and `about()` only. No functional API yet.
