/**
 * Typed data model for the tokenmaster core, per docs/core-api.md (0.1).
 *
 * Zero runtime dependencies. Every top-level wire type carries
 * `schema_version` and serializes to plain JSON-compatible objects via
 * `toDict` / `fromDict`. Wire fields are snake_case in memory and on the
 * wire (contract P3: one schema, three languages), and absent optionals are
 * explicit nulls, never omitted keys, mirroring the Python reference.
 *
 * `toJSON()` follows the JavaScript platform convention: it returns the
 * plain object, so `JSON.stringify(value)` serializes correctly. Call
 * `JSON.stringify(value.toDict())` when a string is needed explicitly.
 *
 * Instances are frozen after construction, mirroring the reference's frozen
 * dataclasses.
 */

export const SCHEMA_VERSION = "0.1";

// ---------------------------------------------------------------------------
// coercion helpers mirroring the reference's int()/float()/str() usage and
// Python dict-truthiness at the from_dict boundaries

function asInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return Math.trunc(n);
}

function asFloat(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return n;
}

function reqString(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new TypeError(`${field} is required`);
  }
  return String(value);
}

function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Python dict-truthiness: a mapping counts only when it has at least one key. */
function nonEmptyDict(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length > 0 ? record : null;
}

// ---------------------------------------------------------------------------
// enums

export const Zone = {
  GREEN: "green",
  CAUTION: "caution",
  CRITICAL: "critical",
} as const;
export type Zone = (typeof Zone)[keyof typeof Zone];

const ZONE_VALUES = new Set<string>(Object.values(Zone));

export function asZone(value: unknown): Zone {
  if (typeof value === "string" && ZONE_VALUES.has(value)) {
    return value as Zone;
  }
  throw new RangeError(`'${String(value)}' is not a valid Zone`);
}

export const UsageSource = {
  REPORTED: "reported",
  ESTIMATED: "estimated",
  MIXED: "mixed",
} as const;
export type UsageSource = (typeof UsageSource)[keyof typeof UsageSource];

const USAGE_SOURCE_VALUES = new Set<string>(Object.values(UsageSource));

export function asUsageSource(value: unknown): UsageSource {
  if (typeof value === "string" && USAGE_SOURCE_VALUES.has(value)) {
    return value as UsageSource;
  }
  throw new RangeError(`'${String(value)}' is not a valid UsageSource`);
}

// ---------------------------------------------------------------------------
// Pricing

export interface PricingDict {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  currency: string;
  as_of: string | null;
}

/** Per-Mtok prices, with the date they were captured. */
export class Pricing {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly currency: string;
  readonly as_of: string | null;

  constructor(fields: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
    currency?: string;
    as_of?: string | null;
  }) {
    this.input = fields.input;
    this.output = fields.output;
    this.cache_read = fields.cache_read ?? 0.0;
    this.cache_write = fields.cache_write ?? 0.0;
    this.currency = fields.currency ?? "USD";
    this.as_of = fields.as_of ?? null;
    Object.freeze(this);
  }

  toDict(): PricingDict {
    return {
      input: this.input,
      output: this.output,
      cache_read: this.cache_read,
      cache_write: this.cache_write,
      currency: this.currency,
      as_of: this.as_of,
    };
  }

  toJSON(): PricingDict {
    return this.toDict();
  }

  static fromDict(dict: object): Pricing {
    const d = dict as Record<string, unknown>;
    return new Pricing({
      input: asFloat(d["input"], "input"),
      output: asFloat(d["output"], "output"),
      cache_read:
        d["cache_read"] === null || d["cache_read"] === undefined
          ? 0.0
          : asFloat(d["cache_read"], "cache_read"),
      cache_write:
        d["cache_write"] === null || d["cache_write"] === undefined
          ? 0.0
          : asFloat(d["cache_write"], "cache_write"),
      currency:
        d["currency"] === null || d["currency"] === undefined
          ? "USD"
          : String(d["currency"]),
      as_of: optString(d["as_of"]),
    });
  }
}

// ---------------------------------------------------------------------------
// CalibrationRecord

export interface CalibrationRecordDict {
  model_id: string;
  effective_context: number;
  method: string;
  source: string;
  measured_at: string | null;
  confidence: string | null;
  schema_version: string;
}

/** Measured effective capacity for one model. */
export class CalibrationRecord {
  readonly model_id: string;
  readonly effective_context: number;
  readonly method: string;
  readonly source: string;
  readonly measured_at: string | null;
  readonly confidence: string | null;
  readonly schema_version: string;

  constructor(fields: {
    model_id: string;
    effective_context: number;
    method: string;
    source: string;
    measured_at?: string | null;
    confidence?: string | null;
    schema_version?: string;
  }) {
    this.model_id = fields.model_id;
    this.effective_context = fields.effective_context;
    this.method = fields.method;
    this.source = fields.source;
    this.measured_at = fields.measured_at ?? null;
    this.confidence = fields.confidence ?? null;
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    Object.freeze(this);
  }

  toDict(): CalibrationRecordDict {
    return {
      model_id: this.model_id,
      effective_context: this.effective_context,
      method: this.method,
      source: this.source,
      measured_at: this.measured_at,
      confidence: this.confidence,
      schema_version: this.schema_version,
    };
  }

  toJSON(): CalibrationRecordDict {
    return this.toDict();
  }

  static fromDict(dict: object): CalibrationRecord {
    const d = dict as Record<string, unknown>;
    return new CalibrationRecord({
      model_id: reqString(d["model_id"], "model_id"),
      effective_context: asInt(d["effective_context"], "effective_context"),
      method: reqString(d["method"], "method"),
      source: reqString(d["source"], "source"),
      measured_at: optString(d["measured_at"]),
      confidence: optString(d["confidence"]),
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}

// ---------------------------------------------------------------------------
// ModelProfile

export interface ModelProfileDict {
  model_id: string;
  provider: string;
  window_nominal: number;
  max_output: number | null;
  pricing: PricingDict | null;
  tokenizer_hint: string | null;
  effective: CalibrationRecordDict | null;
  source: string;
  schema_version: string;
}

/** Identity and capacities for one model. */
export class ModelProfile {
  readonly model_id: string;
  readonly provider: string;
  readonly window_nominal: number;
  readonly max_output: number | null;
  readonly pricing: Pricing | null;
  readonly tokenizer_hint: string | null;
  readonly effective: CalibrationRecord | null;
  readonly source: string;
  readonly schema_version: string;

  constructor(fields: {
    model_id: string;
    provider: string;
    window_nominal: number;
    max_output?: number | null;
    pricing?: Pricing | null;
    tokenizer_hint?: string | null;
    effective?: CalibrationRecord | null;
    source?: string;
    schema_version?: string;
  }) {
    this.model_id = fields.model_id;
    this.provider = fields.provider;
    this.window_nominal = fields.window_nominal;
    this.max_output = fields.max_output ?? null;
    this.pricing = fields.pricing ?? null;
    this.tokenizer_hint = fields.tokenizer_hint ?? null;
    this.effective = fields.effective ?? null;
    this.source = fields.source ?? "user";
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    if (this.window_nominal <= 0) {
      throw new RangeError("window_nominal must be positive");
    }
    if (this.effective !== null && this.effective.effective_context <= 0) {
      throw new RangeError("effective_context must be positive");
    }
    Object.freeze(this);
  }

  get window_effective(): number {
    return this.effective !== null
      ? this.effective.effective_context
      : this.window_nominal;
  }

  get effective_source(): string {
    return this.effective !== null
      ? `calibration:${this.effective.method} (${this.effective.source})`
      : "nominal (uncalibrated)";
  }

  toDict(): ModelProfileDict {
    return {
      model_id: this.model_id,
      provider: this.provider,
      window_nominal: this.window_nominal,
      max_output: this.max_output,
      pricing: this.pricing !== null ? this.pricing.toDict() : null,
      tokenizer_hint: this.tokenizer_hint,
      effective: this.effective !== null ? this.effective.toDict() : null,
      source: this.source,
      schema_version: this.schema_version,
    };
  }

  toJSON(): ModelProfileDict {
    return this.toDict();
  }

  static fromDict(dict: object): ModelProfile {
    const d = dict as Record<string, unknown>;
    const pricing = nonEmptyDict(d["pricing"]);
    const effective = nonEmptyDict(d["effective"]);
    return new ModelProfile({
      model_id: reqString(d["model_id"], "model_id"),
      provider: reqString(d["provider"], "provider"),
      window_nominal: asInt(d["window_nominal"], "window_nominal"),
      max_output:
        d["max_output"] === null || d["max_output"] === undefined
          ? null
          : asInt(d["max_output"], "max_output"),
      pricing: pricing !== null ? Pricing.fromDict(pricing) : null,
      tokenizer_hint: optString(d["tokenizer_hint"]),
      effective:
        effective !== null ? CalibrationRecord.fromDict(effective) : null,
      source:
        d["source"] === null || d["source"] === undefined
          ? "user"
          : String(d["source"]),
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}

// ---------------------------------------------------------------------------
// Breakdown

export interface BreakdownDict {
  system_prompt: number;
  tool_schemas: number;
  history: number;
  attachments: number;
  query: number;
}

/** Optional estimated split of the standing prompt. */
export class Breakdown {
  readonly system_prompt: number;
  readonly tool_schemas: number;
  readonly history: number;
  readonly attachments: number;
  readonly query: number;

  constructor(
    fields: {
      system_prompt?: number;
      tool_schemas?: number;
      history?: number;
      attachments?: number;
      query?: number;
    } = {}
  ) {
    this.system_prompt = fields.system_prompt ?? 0;
    this.tool_schemas = fields.tool_schemas ?? 0;
    this.history = fields.history ?? 0;
    this.attachments = fields.attachments ?? 0;
    this.query = fields.query ?? 0;
    Object.freeze(this);
  }

  toDict(): BreakdownDict {
    return {
      system_prompt: this.system_prompt,
      tool_schemas: this.tool_schemas,
      history: this.history,
      attachments: this.attachments,
      query: this.query,
    };
  }

  toJSON(): BreakdownDict {
    return this.toDict();
  }

  static fromDict(dict: object): Breakdown {
    const d = dict as Record<string, unknown>;
    return new Breakdown({
      system_prompt:
        d["system_prompt"] === null || d["system_prompt"] === undefined
          ? 0
          : asInt(d["system_prompt"], "system_prompt"),
      tool_schemas:
        d["tool_schemas"] === null || d["tool_schemas"] === undefined
          ? 0
          : asInt(d["tool_schemas"], "tool_schemas"),
      history:
        d["history"] === null || d["history"] === undefined
          ? 0
          : asInt(d["history"], "history"),
      attachments:
        d["attachments"] === null || d["attachments"] === undefined
          ? 0
          : asInt(d["attachments"], "attachments"),
      query:
        d["query"] === null || d["query"] === undefined
          ? 0
          : asInt(d["query"], "query"),
    });
  }
}

// ---------------------------------------------------------------------------
// TurnUsage

const USAGE_COUNT_FIELDS = [
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
] as const;

export interface TurnUsageDict {
  turn_id: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  model_id: string | null;
  timestamp: string | null;
  breakdown: BreakdownDict | null;
  source: UsageSource;
  raw: Record<string, unknown> | null;
  schema_version: string;
}

/**
 * One normalized accounting record per model response.
 *
 * Unknown keys in `fromDict` input are ignored: normalization of
 * provider-specific field names is an adapter's job, and the core accepts
 * only the canonical shape.
 */
export class TurnUsage {
  readonly turn_id: number;
  readonly input_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_tokens: number;
  readonly model_id: string | null;
  readonly timestamp: string | null;
  readonly breakdown: Breakdown | null;
  readonly source: UsageSource;
  readonly raw: Record<string, unknown> | null;
  readonly schema_version: string;

  constructor(fields: {
    turn_id: number;
    input_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    model_id?: string | null;
    timestamp?: string | null;
    breakdown?: Breakdown | null;
    source?: UsageSource;
    raw?: Record<string, unknown> | null;
    schema_version?: string;
  }) {
    this.turn_id = fields.turn_id;
    this.input_tokens = fields.input_tokens ?? 0;
    this.cache_read_tokens = fields.cache_read_tokens ?? 0;
    this.cache_write_tokens = fields.cache_write_tokens ?? 0;
    this.output_tokens = fields.output_tokens ?? 0;
    this.reasoning_tokens = fields.reasoning_tokens ?? 0;
    this.model_id = fields.model_id ?? null;
    this.timestamp = fields.timestamp ?? null;
    this.breakdown = fields.breakdown ?? null;
    this.source = fields.source ?? UsageSource.REPORTED;
    this.raw = fields.raw ?? null;
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    for (const name of USAGE_COUNT_FIELDS) {
      if (this[name] < 0) {
        throw new RangeError(`${name} must be non-negative`);
      }
    }
    Object.freeze(this);
  }

  /** Context occupied after this turn: full prompt plus this response. */
  contextTotal(): number {
    return (
      this.input_tokens +
      this.cache_read_tokens +
      this.cache_write_tokens +
      this.output_tokens +
      this.reasoning_tokens
    );
  }

  toDict(): TurnUsageDict {
    return {
      turn_id: this.turn_id,
      input_tokens: this.input_tokens,
      cache_read_tokens: this.cache_read_tokens,
      cache_write_tokens: this.cache_write_tokens,
      output_tokens: this.output_tokens,
      reasoning_tokens: this.reasoning_tokens,
      model_id: this.model_id,
      timestamp: this.timestamp,
      breakdown: this.breakdown !== null ? this.breakdown.toDict() : null,
      source: this.source,
      raw: this.raw !== null ? { ...this.raw } : null,
      schema_version: this.schema_version,
    };
  }

  toJSON(): TurnUsageDict {
    return this.toDict();
  }

  static fromDict(dict: object, turnId?: number): TurnUsage {
    const d = dict as Record<string, unknown>;
    const breakdown = nonEmptyDict(d["breakdown"]);
    const raw = nonEmptyDict(d["raw"]);
    return new TurnUsage({
      turn_id:
        turnId === undefined
          ? asInt(d["turn_id"], "turn_id")
          : Math.trunc(turnId),
      input_tokens:
        d["input_tokens"] === null || d["input_tokens"] === undefined
          ? 0
          : asInt(d["input_tokens"], "input_tokens"),
      cache_read_tokens:
        d["cache_read_tokens"] === null || d["cache_read_tokens"] === undefined
          ? 0
          : asInt(d["cache_read_tokens"], "cache_read_tokens"),
      cache_write_tokens:
        d["cache_write_tokens"] === null ||
        d["cache_write_tokens"] === undefined
          ? 0
          : asInt(d["cache_write_tokens"], "cache_write_tokens"),
      output_tokens:
        d["output_tokens"] === null || d["output_tokens"] === undefined
          ? 0
          : asInt(d["output_tokens"], "output_tokens"),
      reasoning_tokens:
        d["reasoning_tokens"] === null || d["reasoning_tokens"] === undefined
          ? 0
          : asInt(d["reasoning_tokens"], "reasoning_tokens"),
      model_id: optString(d["model_id"]),
      timestamp: optString(d["timestamp"]),
      breakdown: breakdown !== null ? Breakdown.fromDict(breakdown) : null,
      source: asUsageSource(d["source"] ?? "reported"),
      raw: raw !== null ? { ...raw } : null,
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}

// ---------------------------------------------------------------------------
// EtaEstimate

export interface EtaEstimateDict {
  expected: number;
  conservative: number;
}

/** Projected turns to exhaustion. */
export class EtaEstimate {
  readonly expected: number;
  readonly conservative: number;

  constructor(fields: { expected: number; conservative: number }) {
    this.expected = fields.expected;
    this.conservative = fields.conservative;
    Object.freeze(this);
  }

  toDict(): EtaEstimateDict {
    return { expected: this.expected, conservative: this.conservative };
  }

  toJSON(): EtaEstimateDict {
    return this.toDict();
  }

  static fromDict(dict: object): EtaEstimate {
    const d = dict as Record<string, unknown>;
    return new EtaEstimate({
      expected: asFloat(d["expected"], "expected"),
      conservative: asFloat(d["conservative"], "conservative"),
    });
  }
}

// ---------------------------------------------------------------------------
// CacheState

export interface CacheStateDict {
  stable_prefix_tokens: number;
  last_cache_read: number;
  last_cache_write: number;
}

/** Estimated prompt-cache condition after the latest turn. */
export class CacheState {
  readonly stable_prefix_tokens: number;
  readonly last_cache_read: number;
  readonly last_cache_write: number;

  constructor(fields: {
    stable_prefix_tokens: number;
    last_cache_read: number;
    last_cache_write: number;
  }) {
    this.stable_prefix_tokens = fields.stable_prefix_tokens;
    this.last_cache_read = fields.last_cache_read;
    this.last_cache_write = fields.last_cache_write;
    Object.freeze(this);
  }

  toDict(): CacheStateDict {
    return {
      stable_prefix_tokens: this.stable_prefix_tokens,
      last_cache_read: this.last_cache_read,
      last_cache_write: this.last_cache_write,
    };
  }

  toJSON(): CacheStateDict {
    return this.toDict();
  }

  static fromDict(dict: object): CacheState {
    const d = dict as Record<string, unknown>;
    return new CacheState({
      stable_prefix_tokens: asInt(
        d["stable_prefix_tokens"],
        "stable_prefix_tokens"
      ),
      last_cache_read: asInt(d["last_cache_read"], "last_cache_read"),
      last_cache_write: asInt(d["last_cache_write"], "last_cache_write"),
    });
  }
}

// ---------------------------------------------------------------------------
// MeterState

export interface MeterStateDict {
  model_id: string;
  turns: number;
  used_tokens: number;
  window_nominal: number;
  window_effective: number;
  effective_source: string;
  reserved_output: number;
  headroom_nominal: number;
  headroom_effective: number;
  fill_nominal: number;
  fill_effective: number;
  velocity: number | null;
  velocity_std: number | null;
  eta_turns: EtaEstimateDict | null;
  zone: Zone;
  hidden_overhead: number | null;
  cache: CacheStateDict | null;
  provenance: Record<string, string>;
  schema_version: string;
}

/**
 * The gauge cluster. Measurement only; judgment lives in the Advisor.
 *
 * Renderable standalone by contract decision D10: no event history is
 * needed to draw everything here.
 */
export class MeterState {
  readonly model_id: string;
  readonly turns: number;
  readonly used_tokens: number;
  readonly window_nominal: number;
  readonly window_effective: number;
  readonly effective_source: string;
  readonly reserved_output: number;
  readonly headroom_nominal: number;
  readonly headroom_effective: number;
  readonly fill_nominal: number;
  readonly fill_effective: number;
  readonly velocity: number | null;
  readonly velocity_std: number | null;
  readonly eta_turns: EtaEstimate | null;
  readonly zone: Zone;
  readonly hidden_overhead: number | null;
  readonly cache: CacheState | null;
  readonly provenance: Record<string, string>;
  readonly schema_version: string;

  constructor(fields: {
    model_id: string;
    turns: number;
    used_tokens: number;
    window_nominal: number;
    window_effective: number;
    effective_source: string;
    reserved_output: number;
    headroom_nominal: number;
    headroom_effective: number;
    fill_nominal: number;
    fill_effective: number;
    velocity: number | null;
    velocity_std: number | null;
    eta_turns: EtaEstimate | null;
    zone: Zone;
    hidden_overhead: number | null;
    cache: CacheState | null;
    provenance?: Record<string, string>;
    schema_version?: string;
  }) {
    this.model_id = fields.model_id;
    this.turns = fields.turns;
    this.used_tokens = fields.used_tokens;
    this.window_nominal = fields.window_nominal;
    this.window_effective = fields.window_effective;
    this.effective_source = fields.effective_source;
    this.reserved_output = fields.reserved_output;
    this.headroom_nominal = fields.headroom_nominal;
    this.headroom_effective = fields.headroom_effective;
    this.fill_nominal = fields.fill_nominal;
    this.fill_effective = fields.fill_effective;
    this.velocity = fields.velocity;
    this.velocity_std = fields.velocity_std;
    this.eta_turns = fields.eta_turns;
    this.zone = fields.zone;
    this.hidden_overhead = fields.hidden_overhead;
    this.cache = fields.cache;
    this.provenance = fields.provenance ?? {};
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    Object.freeze(this);
  }

  toDict(): MeterStateDict {
    return {
      model_id: this.model_id,
      turns: this.turns,
      used_tokens: this.used_tokens,
      window_nominal: this.window_nominal,
      window_effective: this.window_effective,
      effective_source: this.effective_source,
      reserved_output: this.reserved_output,
      headroom_nominal: this.headroom_nominal,
      headroom_effective: this.headroom_effective,
      fill_nominal: this.fill_nominal,
      fill_effective: this.fill_effective,
      velocity: this.velocity,
      velocity_std: this.velocity_std,
      eta_turns: this.eta_turns !== null ? this.eta_turns.toDict() : null,
      zone: this.zone,
      hidden_overhead: this.hidden_overhead,
      cache: this.cache !== null ? this.cache.toDict() : null,
      provenance: { ...this.provenance },
      schema_version: this.schema_version,
    };
  }

  toJSON(): MeterStateDict {
    return this.toDict();
  }

  static fromDict(dict: object): MeterState {
    const d = dict as Record<string, unknown>;
    const eta = nonEmptyDict(d["eta_turns"]);
    const cache = nonEmptyDict(d["cache"]);
    return new MeterState({
      model_id: reqString(d["model_id"], "model_id"),
      turns: asInt(d["turns"], "turns"),
      used_tokens: asInt(d["used_tokens"], "used_tokens"),
      window_nominal: asInt(d["window_nominal"], "window_nominal"),
      window_effective: asInt(d["window_effective"], "window_effective"),
      effective_source: reqString(d["effective_source"], "effective_source"),
      reserved_output: asInt(d["reserved_output"], "reserved_output"),
      headroom_nominal: asInt(d["headroom_nominal"], "headroom_nominal"),
      headroom_effective: asInt(d["headroom_effective"], "headroom_effective"),
      fill_nominal: asFloat(d["fill_nominal"], "fill_nominal"),
      fill_effective: asFloat(d["fill_effective"], "fill_effective"),
      velocity:
        d["velocity"] === null || d["velocity"] === undefined
          ? null
          : asFloat(d["velocity"], "velocity"),
      velocity_std:
        d["velocity_std"] === null || d["velocity_std"] === undefined
          ? null
          : asFloat(d["velocity_std"], "velocity_std"),
      eta_turns: eta !== null ? EtaEstimate.fromDict(eta) : null,
      zone: asZone(d["zone"]),
      hidden_overhead:
        d["hidden_overhead"] === null || d["hidden_overhead"] === undefined
          ? null
          : asInt(d["hidden_overhead"], "hidden_overhead"),
      cache: cache !== null ? CacheState.fromDict(cache) : null,
      provenance: {
        ...((d["provenance"] as Record<string, string> | null | undefined) ??
          {}),
      },
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}
