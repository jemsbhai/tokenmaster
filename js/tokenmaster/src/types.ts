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
// Tiered pricing

export interface PricingScopeDict {
  service_tier: string;
  region: string;
  basis: string;
  unpriced_usage_categories?: string[];
}

const PRICING_USAGE_CATEGORIES = new Set([
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "reasoning_tokens",
]);

/** Provenance dimensions under which a pricing schedule applies. */
export class PricingScope {
  readonly service_tier: string;
  readonly region: string;
  readonly basis: string;
  readonly unpriced_usage_categories: readonly string[];

  constructor(
    fields: {
      service_tier?: string;
      region?: string;
      basis?: string;
      unpriced_usage_categories?: readonly string[];
    } = {}
  ) {
    this.service_tier = fields.service_tier ?? "standard";
    this.region = fields.region ?? "global";
    this.basis = fields.basis ?? "request_input_tokens";
    if (this.service_tier.trim().length === 0) {
      throw new RangeError("service_tier must be non-empty");
    }
    if (this.region.trim().length === 0) {
      throw new RangeError("region must be non-empty");
    }
    if (this.basis.trim().length === 0) {
      throw new RangeError("basis must be non-empty");
    }
    const categories = fields.unpriced_usage_categories ?? [];
    if (!Array.isArray(categories)) {
      throw new TypeError("unpriced_usage_categories must be an array");
    }
    const seen = new Set<string>();
    for (const category of categories) {
      if (typeof category !== "string" || !PRICING_USAGE_CATEGORIES.has(category)) {
        throw new RangeError(
          `unsupported unpriced usage category: ${String(category)}`
        );
      }
      if (seen.has(category)) {
        throw new RangeError(
          `duplicate unpriced usage category: ${category}`
        );
      }
      seen.add(category);
    }
    this.unpriced_usage_categories = Object.freeze([...categories]);
    Object.freeze(this);
  }

  toDict(): PricingScopeDict {
    const scope: PricingScopeDict = {
      service_tier: this.service_tier,
      region: this.region,
      basis: this.basis,
    };
    if (this.unpriced_usage_categories.length > 0) {
      scope.unpriced_usage_categories = [...this.unpriced_usage_categories];
    }
    return scope;
  }

  toJSON(): PricingScopeDict {
    return this.toDict();
  }

  static fromDict(dict: object): PricingScope {
    const d = dict as Record<string, unknown>;
    return new PricingScope({
      service_tier:
        d["service_tier"] === null || d["service_tier"] === undefined
          ? "standard"
          : String(d["service_tier"]),
      region:
        d["region"] === null || d["region"] === undefined
          ? "global"
          : String(d["region"]),
      basis:
        d["basis"] === null || d["basis"] === undefined
          ? "request_input_tokens"
          : String(d["basis"]),
      unpriced_usage_categories:
        d["unpriced_usage_categories"] === undefined
          ? []
          : (d["unpriced_usage_categories"] as readonly string[]),
    });
  }
}

export interface PricingTierDict {
  min_input_tokens: number;
  pricing: PricingDict;
}

/** A price row selected when total request input reaches an inclusive floor. */
export class PricingTier {
  readonly min_input_tokens: number;
  readonly pricing: Pricing;

  constructor(fields: { min_input_tokens: number; pricing: Pricing }) {
    if (
      !Number.isSafeInteger(fields.min_input_tokens) ||
      fields.min_input_tokens < 0
    ) {
      throw new RangeError("min_input_tokens must be a non-negative safe integer");
    }
    this.min_input_tokens = fields.min_input_tokens;
    this.pricing = fields.pricing;
    Object.freeze(this);
  }

  toDict(): PricingTierDict {
    return {
      min_input_tokens: this.min_input_tokens,
      pricing: this.pricing.toDict(),
    };
  }

  toJSON(): PricingTierDict {
    return this.toDict();
  }

  static fromDict(dict: object): PricingTier {
    const d = dict as Record<string, unknown>;
    const pricing = nonEmptyDict(d["pricing"]);
    if (pricing === null) {
      throw new TypeError("pricing is required");
    }
    return new PricingTier({
      min_input_tokens: asInt(d["min_input_tokens"], "min_input_tokens"),
      pricing: Pricing.fromDict(pricing),
    });
  }
}

export interface PricingScheduleDict {
  base: PricingDict;
  tiers: PricingTierDict[];
  scope: PricingScopeDict;
}

/** Base pricing plus ordered request-input tiers and their provenance scope. */
export class PricingSchedule {
  readonly base: Pricing;
  readonly tiers: readonly PricingTier[];
  readonly scope: PricingScope;

  constructor(fields: {
    base: Pricing;
    tiers?: Iterable<PricingTier>;
    scope?: PricingScope;
  }) {
    const tiers = [...(fields.tiers ?? [])].sort(
      (left, right) => left.min_input_tokens - right.min_input_tokens
    );
    for (let index = 0; index < tiers.length; index++) {
      const tier = tiers[index];
      if (
        index > 0 &&
        tiers[index - 1].min_input_tokens === tier.min_input_tokens
      ) {
        throw new RangeError("pricing tier thresholds must be unique");
      }
      if (tier.pricing.currency !== fields.base.currency) {
        throw new RangeError("pricing schedule currencies must match");
      }
    }
    const scope = fields.scope ?? new PricingScope();
    if (scope.basis !== "request_input_tokens") {
      throw new RangeError("unsupported pricing scope basis");
    }
    this.base = fields.base;
    this.tiers = Object.freeze(tiers);
    this.scope = scope;
    Object.freeze(this);
  }

  /** Return the selected price row and its inclusive threshold, if tiered. */
  resolve(inputTokens: number): {
    pricing: Pricing;
    tier_min_input_tokens: number | null;
  } {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
      throw new RangeError("input_tokens must be a non-negative safe integer");
    }
    let pricing = this.base;
    let threshold: number | null = null;
    for (const tier of this.tiers) {
      if (inputTokens < tier.min_input_tokens) {
        break;
      }
      pricing = tier.pricing;
      threshold = tier.min_input_tokens;
    }
    return { pricing, tier_min_input_tokens: threshold };
  }

  /** Python API parity: selected price and inclusive tier threshold. */
  priceFor(inputTokens: number): readonly [Pricing, number | null] {
    const resolved = this.resolve(inputTokens);
    return [resolved.pricing, resolved.tier_min_input_tokens] as const;
  }

  toDict(): PricingScheduleDict {
    return {
      base: this.base.toDict(),
      tiers: this.tiers.map((tier) => tier.toDict()),
      scope: this.scope.toDict(),
    };
  }

  toJSON(): PricingScheduleDict {
    return this.toDict();
  }

  static fromDict(dict: object): PricingSchedule {
    const d = dict as Record<string, unknown>;
    const base = nonEmptyDict(d["base"]);
    if (base === null) {
      throw new TypeError("pricing schedule requires a base pricing object");
    }
    const rawTiers = d["tiers"] === undefined ? [] : d["tiers"];
    if (!Array.isArray(rawTiers)) {
      throw new TypeError("pricing schedule tiers must be an array");
    }
    const rawScope = d["scope"] === undefined ? {} : d["scope"];
    if (
      rawScope === null ||
      typeof rawScope !== "object" ||
      Array.isArray(rawScope)
    ) {
      throw new TypeError("pricing schedule scope must be an object");
    }
    return new PricingSchedule({
      base: Pricing.fromDict(base),
      tiers: rawTiers.map((tier) => PricingTier.fromDict(tier as object)),
      scope: PricingScope.fromDict(rawScope as object),
    });
  }
}

export interface CostQuoteDict {
  model_id: string;
  tier_basis_tokens: number;
  tier_min_input_tokens: number | null;
  pricing: PricingDict;
  input_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  output_cost: number;
  reasoning_cost: number;
  total_cost: number;
  currency: string;
  as_of: string | null;
  source: string;
}

/** Exact category-level cost of one exclusive normalized usage record. */
export class CostQuote {
  readonly model_id: string;
  readonly tier_basis_tokens: number;
  readonly tier_min_input_tokens: number | null;
  readonly pricing: Pricing;
  readonly input_cost: number;
  readonly cache_read_cost: number;
  readonly cache_write_cost: number;
  readonly output_cost: number;
  readonly reasoning_cost: number;
  readonly total_cost: number;
  readonly currency: string;
  readonly as_of: string | null;
  readonly source: string;

  constructor(
    fields: Omit<CostQuoteDict, "pricing"> & {
      pricing: Pricing | PricingDict;
    }
  ) {
    this.model_id = fields.model_id;
    this.tier_basis_tokens = fields.tier_basis_tokens;
    this.tier_min_input_tokens = fields.tier_min_input_tokens;
    this.pricing =
      fields.pricing instanceof Pricing
        ? fields.pricing
        : Pricing.fromDict(fields.pricing);
    this.input_cost = fields.input_cost;
    this.cache_read_cost = fields.cache_read_cost;
    this.cache_write_cost = fields.cache_write_cost;
    this.output_cost = fields.output_cost;
    this.reasoning_cost = fields.reasoning_cost;
    this.total_cost = fields.total_cost;
    this.currency = fields.currency;
    this.as_of = fields.as_of;
    this.source = fields.source;
    Object.freeze(this);
  }

  toDict(): CostQuoteDict {
    return {
      model_id: this.model_id,
      tier_basis_tokens: this.tier_basis_tokens,
      tier_min_input_tokens: this.tier_min_input_tokens,
      pricing: this.pricing.toDict(),
      input_cost: this.input_cost,
      cache_read_cost: this.cache_read_cost,
      cache_write_cost: this.cache_write_cost,
      output_cost: this.output_cost,
      reasoning_cost: this.reasoning_cost,
      total_cost: this.total_cost,
      currency: this.currency,
      as_of: this.as_of,
      source: this.source,
    };
  }

  toJSON(): CostQuoteDict {
    return this.toDict();
  }

  static fromDict(dict: object): CostQuote {
    const d = dict as Record<string, unknown>;
    const pricing = nonEmptyDict(d["pricing"]);
    if (pricing === null) {
      throw new TypeError("pricing is required");
    }
    return new CostQuote({
      model_id: reqString(d["model_id"], "model_id"),
      tier_basis_tokens: asInt(d["tier_basis_tokens"], "tier_basis_tokens"),
      tier_min_input_tokens:
        d["tier_min_input_tokens"] === null ||
        d["tier_min_input_tokens"] === undefined
          ? null
          : asInt(d["tier_min_input_tokens"], "tier_min_input_tokens"),
      pricing: Pricing.fromDict(pricing),
      input_cost: asFloat(d["input_cost"], "input_cost"),
      cache_read_cost: asFloat(d["cache_read_cost"], "cache_read_cost"),
      cache_write_cost: asFloat(d["cache_write_cost"], "cache_write_cost"),
      output_cost: asFloat(d["output_cost"], "output_cost"),
      reasoning_cost: asFloat(d["reasoning_cost"], "reasoning_cost"),
      total_cost: asFloat(d["total_cost"], "total_cost"),
      currency: reqString(d["currency"], "currency"),
      as_of: optString(d["as_of"]),
      source: reqString(d["source"], "source"),
    });
  }
}

export interface CostEstimateDict {
  model_id: string;
  tier_basis_tokens: number;
  tier_min_input_tokens: number | null;
  pricing: PricingDict;
  input_tokens: number;
  reserved_output_tokens: number;
  input_rate_kind: string;
  input_rate: number;
  output_rate: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  currency: string;
  as_of: string | null;
  source: string;
  conservative: boolean;
  assumptions: string[];
}

/** Conservative request-cost reservation with explicit assumptions. */
export class CostEstimate {
  readonly model_id: string;
  readonly tier_basis_tokens: number;
  readonly tier_min_input_tokens: number | null;
  readonly pricing: Pricing;
  readonly input_tokens: number;
  readonly reserved_output_tokens: number;
  readonly input_rate_kind: string;
  readonly input_rate: number;
  readonly output_rate: number;
  readonly input_cost: number;
  readonly output_cost: number;
  readonly total_cost: number;
  readonly currency: string;
  readonly as_of: string | null;
  readonly source: string;
  readonly conservative: boolean;
  readonly assumptions: readonly string[];

  constructor(
    fields: Omit<CostEstimateDict, "pricing"> & {
      pricing: Pricing | PricingDict;
    }
  ) {
    this.model_id = fields.model_id;
    this.tier_basis_tokens = fields.tier_basis_tokens;
    this.tier_min_input_tokens = fields.tier_min_input_tokens;
    this.pricing =
      fields.pricing instanceof Pricing
        ? fields.pricing
        : Pricing.fromDict(fields.pricing);
    this.input_tokens = fields.input_tokens;
    this.reserved_output_tokens = fields.reserved_output_tokens;
    this.input_rate_kind = fields.input_rate_kind;
    this.input_rate = fields.input_rate;
    this.output_rate = fields.output_rate;
    this.input_cost = fields.input_cost;
    this.output_cost = fields.output_cost;
    this.total_cost = fields.total_cost;
    this.currency = fields.currency;
    this.as_of = fields.as_of;
    this.source = fields.source;
    this.conservative = fields.conservative;
    this.assumptions = Object.freeze([...fields.assumptions]);
    Object.freeze(this);
  }

  toDict(): CostEstimateDict {
    return {
      model_id: this.model_id,
      tier_basis_tokens: this.tier_basis_tokens,
      tier_min_input_tokens: this.tier_min_input_tokens,
      pricing: this.pricing.toDict(),
      input_tokens: this.input_tokens,
      reserved_output_tokens: this.reserved_output_tokens,
      input_rate_kind: this.input_rate_kind,
      input_rate: this.input_rate,
      output_rate: this.output_rate,
      input_cost: this.input_cost,
      output_cost: this.output_cost,
      total_cost: this.total_cost,
      currency: this.currency,
      as_of: this.as_of,
      source: this.source,
      conservative: this.conservative,
      assumptions: [...this.assumptions],
    };
  }

  toJSON(): CostEstimateDict {
    return this.toDict();
  }

  static fromDict(dict: object): CostEstimate {
    const d = dict as Record<string, unknown>;
    const pricing = nonEmptyDict(d["pricing"]);
    if (pricing === null) {
      throw new TypeError("pricing is required");
    }
    if (typeof d["conservative"] !== "boolean") {
      throw new TypeError("conservative must be a bool");
    }
    if (!Array.isArray(d["assumptions"])) {
      throw new TypeError("assumptions must be an array");
    }
    return new CostEstimate({
      model_id: reqString(d["model_id"], "model_id"),
      tier_basis_tokens: asInt(d["tier_basis_tokens"], "tier_basis_tokens"),
      tier_min_input_tokens:
        d["tier_min_input_tokens"] === null ||
        d["tier_min_input_tokens"] === undefined
          ? null
          : asInt(d["tier_min_input_tokens"], "tier_min_input_tokens"),
      pricing: Pricing.fromDict(pricing),
      input_tokens: asInt(d["input_tokens"], "input_tokens"),
      reserved_output_tokens: asInt(
        d["reserved_output_tokens"],
        "reserved_output_tokens"
      ),
      input_rate_kind: reqString(d["input_rate_kind"], "input_rate_kind"),
      input_rate: asFloat(d["input_rate"], "input_rate"),
      output_rate: asFloat(d["output_rate"], "output_rate"),
      input_cost: asFloat(d["input_cost"], "input_cost"),
      output_cost: asFloat(d["output_cost"], "output_cost"),
      total_cost: asFloat(d["total_cost"], "total_cost"),
      currency: reqString(d["currency"], "currency"),
      as_of: optString(d["as_of"]),
      source: reqString(d["source"], "source"),
      conservative: d["conservative"],
      assumptions: d["assumptions"].map((value) => String(value)),
    });
  }
}

export type CapacityKind = "nominal" | "effective";

export interface LimitCheckDict {
  model_id: string;
  capacity_kind: CapacityKind;
  capacity: number;
  input_tokens: number;
  requested_output_tokens: number | null;
  reserved_output_tokens: number;
  context_output_tokens: number;
  context_tokens: number;
  max_input_tokens: number;
  max_output_tokens: number | null;
  input_exceeded: boolean;
  context_exceeded: boolean;
  output_exceeded: boolean;
  allowed: boolean;
  violations: string[];
}

/** Deterministic request check against one model profile's capacities. */
export class LimitCheck {
  readonly model_id: string;
  readonly capacity_kind: CapacityKind;
  readonly capacity: number;
  readonly input_tokens: number;
  readonly requested_output_tokens: number | null;
  readonly reserved_output_tokens: number;
  readonly context_output_tokens: number;
  readonly context_tokens: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number | null;
  readonly input_exceeded: boolean;
  readonly context_exceeded: boolean;
  readonly output_exceeded: boolean;
  readonly allowed: boolean;
  readonly violations: readonly string[];

  constructor(fields: LimitCheckDict) {
    this.model_id = fields.model_id;
    this.capacity_kind = fields.capacity_kind;
    this.capacity = fields.capacity;
    this.input_tokens = fields.input_tokens;
    this.requested_output_tokens = fields.requested_output_tokens;
    this.reserved_output_tokens = fields.reserved_output_tokens;
    this.context_output_tokens = fields.context_output_tokens;
    this.context_tokens = fields.context_tokens;
    this.max_input_tokens = fields.max_input_tokens;
    this.max_output_tokens = fields.max_output_tokens;
    this.input_exceeded = fields.input_exceeded;
    this.context_exceeded = fields.context_exceeded;
    this.output_exceeded = fields.output_exceeded;
    this.allowed = fields.allowed;
    this.violations = Object.freeze([...fields.violations]);
    Object.freeze(this);
  }

  toDict(): LimitCheckDict {
    return {
      model_id: this.model_id,
      capacity_kind: this.capacity_kind,
      capacity: this.capacity,
      input_tokens: this.input_tokens,
      requested_output_tokens: this.requested_output_tokens,
      reserved_output_tokens: this.reserved_output_tokens,
      context_output_tokens: this.context_output_tokens,
      context_tokens: this.context_tokens,
      max_input_tokens: this.max_input_tokens,
      max_output_tokens: this.max_output_tokens,
      input_exceeded: this.input_exceeded,
      context_exceeded: this.context_exceeded,
      output_exceeded: this.output_exceeded,
      allowed: this.allowed,
      violations: [...this.violations],
    };
  }

  toJSON(): LimitCheckDict {
    return this.toDict();
  }

  static fromDict(dict: object): LimitCheck {
    const d = dict as Record<string, unknown>;
    const capacityKind = reqString(d["capacity_kind"], "capacity_kind");
    if (capacityKind !== "nominal" && capacityKind !== "effective") {
      throw new RangeError("capacity_kind must be 'nominal' or 'effective'");
    }
    return new LimitCheck({
      model_id: reqString(d["model_id"], "model_id"),
      capacity_kind: capacityKind,
      capacity: asInt(d["capacity"], "capacity"),
      input_tokens: asInt(d["input_tokens"], "input_tokens"),
      requested_output_tokens:
        d["requested_output_tokens"] === null ||
        d["requested_output_tokens"] === undefined
          ? null
          : asInt(d["requested_output_tokens"], "requested_output_tokens"),
      reserved_output_tokens: asInt(
        d["reserved_output_tokens"],
        "reserved_output_tokens"
      ),
      context_output_tokens: asInt(
        d["context_output_tokens"],
        "context_output_tokens"
      ),
      context_tokens: asInt(d["context_tokens"], "context_tokens"),
      max_input_tokens: asInt(d["max_input_tokens"], "max_input_tokens"),
      max_output_tokens:
        d["max_output_tokens"] === null ||
        d["max_output_tokens"] === undefined
          ? null
          : asInt(d["max_output_tokens"], "max_output_tokens"),
      input_exceeded: Boolean(d["input_exceeded"]),
      context_exceeded: Boolean(d["context_exceeded"]),
      output_exceeded: Boolean(d["output_exceeded"]),
      allowed: Boolean(d["allowed"]),
      violations: Array.isArray(d["violations"])
        ? d["violations"].map((value) => String(value))
        : [],
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
