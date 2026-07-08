/**
 * tokenmaster: context-budget instrumentation core for LLM applications.
 *
 * JavaScript port of the reference implementation, governed by
 * docs/core-api.md (contract 0.1) and the golden vectors under spec/vectors.
 * Modules land incrementally; this entry point re-exports the public surface.
 */

export {
  SCHEMA_VERSION,
  Zone,
  UsageSource,
  asZone,
  asUsageSource,
  Pricing,
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
  CalibrationRecordDict,
  ModelProfileDict,
  BreakdownDict,
  TurnUsageDict,
  EtaEstimateDict,
  CacheStateDict,
  MeterStateDict,
} from "./types.js";

export {
  Event,
  TurnRecorded,
  ZoneChanged,
  VelocityShift,
  ModelChanged,
  eventFromDict,
} from "./events.js";

export type { EventCallback, EventDict, EventInit } from "./events.js";
