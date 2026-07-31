/**
 * tokenmaster: context-budget instrumentation core for LLM applications.
 *
 * JavaScript port of the reference implementation. Version 0.2 preserves the
 * stable 0.1 meter/event wire contract and adds tier-aware pricing and request
 * limit APIs. This entry point re-exports the public surface.
 */

export {
  SCHEMA_VERSION,
  Zone,
  UsageSource,
  asZone,
  asUsageSource,
  Pricing,
  PricingScope,
  PricingTier,
  PricingSchedule,
  CostEstimate,
  CostQuote,
  LimitCheck,
  CalibrationRecord,
  ModelProfile,
  Breakdown,
  TurnUsage,
  EtaEstimate,
  CacheState,
  MeterState,
} from "./types.js";

export type {
  PricingDict,
  PricingScopeDict,
  PricingTierDict,
  PricingScheduleDict,
  CostEstimateDict,
  CostQuoteDict,
  CapacityKind,
  LimitCheckDict,
  CalibrationRecordDict,
  ModelProfileDict,
  BreakdownDict,
  TurnUsageDict,
  EtaEstimateDict,
  CacheStateDict,
  MeterStateDict,
} from "./types.js";

export {
  Action,
  Urgency,
  TaskCriticality,
  asAction,
  asUrgency,
  asTaskCriticality,
  TaskContext,
  RationaleTrace,
  EffectEstimate,
  Recommendation,
  ThresholdPolicy,
  PredictivePolicy,
  CostModelPolicy,
} from "./advisor.js";

export type {
  Policy,
  CostModelPolicyOptions,
  TaskContextDict,
  RationaleTraceDict,
  EffectEstimateDict,
  RecommendationDict,
} from "./advisor.js";

export {
  Event,
  TurnRecorded,
  ZoneChanged,
  VelocityShift,
  ModelChanged,
  AdvisorRecommendation,
  HandoffEvaluated,
  eventFromDict,
} from "./events.js";

export type { EventCallback, EventDict, EventInit } from "./events.js";

export { Meter } from "./meter.js";

export type { MeterConfigDict, MeterDict, MeterOptions } from "./meter.js";

export {
  Registry,
  UnknownModelError,
  defaultRegistry,
  getProfile,
  getPricingSchedule,
  quoteEstimate,
  quoteUsage,
  checkRequestLimits,
} from "./registry.js";

export type {
  ModelOrProfile,
  UsageLike,
  CostEstimateOptions,
  RequestLimitOptions,
} from "./registry.js";

export {
  ProbeCategory,
  asProbeCategory,
  Probe,
  ProbeOutcome,
  FidelityReport,
  ExactMatchJudge,
  evaluateHandoff,
} from "./fidelity.js";

export type {
  ProbeGenerator,
  Answerer,
  Judge,
  ProbeDict,
  ProbeOutcomeDict,
  FidelityReportDict,
} from "./fidelity.js";
