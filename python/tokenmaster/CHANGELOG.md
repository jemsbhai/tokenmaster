# Changelog

All notable changes to tokenmaster are documented in this file.

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
