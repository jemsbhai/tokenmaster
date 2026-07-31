/**
 * Bundled model registry: capacities and dated pricing, offline by design.
 *
 * The snapshot is embedded at build time from the canonical
 * python/tokenmaster/src/tokenmaster/data/models.json (contract P6: nothing
 * phones home; refresh mechanisms will be explicit adapters). Embedding
 * keeps the package free of filesystem access, so the core runs in browsers
 * and bundlers unchanged. Lookup accepts canonical ids
 * ("anthropic:claude-sonnet-4-6"), bare names ("claude-sonnet-4-6"),
 * registered aliases, and dated snapshot suffixes
 * ("claude-haiku-4-5-20251001", "openai:gpt-5.5-2026-04-14").
 * User-registered profiles override bundled ones.
 *
 * Close-match suggestions port difflib.get_close_matches faithfully
 * (Ratcliff/Obershelp ratio via the same greedy longest-match recursion,
 * cutoff 0.6, top 3), so both languages suggest the same corrections. The
 * junk and autojunk heuristics never engage below 200 characters and are
 * omitted.
 */

import {
  CostEstimate,
  CostQuote,
  LimitCheck,
  ModelProfile,
  PricingSchedule,
  PricingScope,
  PricingTier,
  TurnUsage,
} from "./types.js";
import type { CapacityKind } from "./types.js";
import { MODELS_DATA } from "./models-data.js";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** True for version/date tails like "20251001" or "2026-04-14". */
function isDatedSuffix(s: string): boolean {
  return s.length >= 4 && /[0-9]/.test(s) && /^[0-9.\-]+$/.test(s);
}

// ---------------------------------------------------------------------------
// difflib.get_close_matches port

/**
 * Sum of matching-block sizes exactly as CPython's SequenceMatcher computes
 * them: divide and conquer around the greedy longest match, earliest match
 * winning ties.
 */
function matchTotal(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const ch = b[j];
    const list = b2j.get(ch);
    if (list === undefined) {
      b2j.set(ch, [j]);
    } else {
      list.push(j);
    }
  }

  function findLongest(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number
  ): [number, number, number] {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newJ2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices !== undefined) {
        for (const j of indices) {
          if (j < blo) {
            continue;
          }
          if (j >= bhi) {
            break;
          }
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newJ2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newJ2len;
    }
    return [besti, bestj, bestsize];
  }

  let total = 0;
  const queue: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k > 0) {
      total += k;
      if (alo < i && blo < j) {
        queue.push([alo, i, blo, j]);
      }
      if (i + k < ahi && j + k < bhi) {
        queue.push([i + k, ahi, j + k, bhi]);
      }
    }
  }
  return total;
}

function ratio(a: string, b: string): number {
  const length = a.length + b.length;
  if (length === 0) {
    return 1.0;
  }
  return (2.0 * matchTotal(a, b)) / length;
}

function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6
): string[] {
  const scored: { score: number; value: string }[] = [];
  for (const candidate of possibilities) {
    // a = candidate, b = word, matching difflib's sequence assignment.
    const r = ratio(candidate, word);
    if (r >= cutoff) {
      scored.push({ score: r, value: candidate });
    }
  }
  // heapq.nlargest on (score, value) pairs: score descending, then value
  // descending for ties.
  scored.sort((p, q) =>
    q.score !== p.score
      ? q.score - p.score
      : q.value < p.value
        ? -1
        : q.value > p.value
          ? 1
          : 0
  );
  return scored.slice(0, n).map((entry) => entry.value);
}

// ---------------------------------------------------------------------------
// errors

/** Thrown when a model id cannot be resolved by the registry. */
export class UnknownModelError extends Error {
  readonly model_id: string;
  readonly suggestions: readonly string[];

  constructor(modelId: string, suggestions: string[]) {
    const hint =
      suggestions.length > 0
        ? " Close matches: " + suggestions.join(", ")
        : "";
    super(
      `Unknown model '${modelId}'; not in the registry.` +
        hint +
        " Register it with Registry.register(ModelProfile(...))."
    );
    this.name = "UnknownModelError";
    this.model_id = modelId;
    this.suggestions = suggestions;
  }
}

// ---------------------------------------------------------------------------
// registry

/** Model profiles keyed by canonical id, with alias resolution. */
export class Registry {
  readonly snapshot_date: string | null;
  private readonly _profiles = new Map<string, ModelProfile>();
  private readonly _pricingSchedules = new Map<string, PricingSchedule>();
  private readonly _alias = new Map<string, string>();

  constructor(snapshotDate: string | null = null) {
    this.snapshot_date = snapshotDate;
  }

  // ------------------------------------------------------------------ //
  // construction

  /** Add or override a profile. Later registrations win. */
  register(
    profile: ModelProfile,
    aliases: Iterable<string> = []
  ): ModelProfile {
    const canonical = norm(profile.model_id);
    this._profiles.set(canonical, profile);
    this._pricingSchedules.delete(canonical);
    this._alias.set(canonical, canonical);
    if (canonical.includes(":")) {
      const bare = canonical.slice(canonical.indexOf(":") + 1);
      if (!this._alias.has(bare)) {
        this._alias.set(bare, canonical);
      }
    }
    for (const alias of aliases) {
      const a = norm(alias);
      this._alias.set(a, canonical);
      if (!a.includes(":")) {
        const qualified = `${profile.provider}:${a}`;
        if (!this._alias.has(qualified)) {
          this._alias.set(qualified, canonical);
        }
      }
    }
    return profile;
  }

  /** Register a profile and an explicit tiered schedule as one override. */
  registerWithSchedule(
    profile: ModelProfile,
    pricingSchedule: PricingSchedule,
    aliases: Iterable<string> = []
  ): ModelProfile {
    if (profile.pricing === null) {
      throw new RangeError("a scheduled profile must have base pricing");
    }
    if (
      JSON.stringify(profile.pricing.toDict()) !==
      JSON.stringify(pricingSchedule.base.toDict())
    ) {
      throw new RangeError("pricing schedule base must equal profile.pricing");
    }
    const registered = this.register(profile, aliases);
    this._pricingSchedules.set(norm(profile.model_id), pricingSchedule);
    return registered;
  }

  static fromDict(dict: object): Registry {
    const d = dict as Record<string, unknown>;
    const reg = new Registry((d["snapshot_date"] ?? null) as string | null);
    const models = (d["models"] ?? []) as Record<string, unknown>[];
    for (const entry of models) {
      const copy: Record<string, unknown> = { ...entry };
      const aliases = (copy["aliases"] ?? []) as string[];
      const pricingTierValue = copy["pricing_tiers"];
      const pricingScopeValue = copy["pricing_scope"];
      delete copy["aliases"];
      delete copy["pricing_tiers"];
      delete copy["pricing_scope"];
      const profile = ModelProfile.fromDict(copy);
      if (
        (pricingTierValue === null || pricingTierValue === undefined) &&
        (pricingScopeValue === null || pricingScopeValue === undefined)
      ) {
        reg.register(profile, aliases);
        continue;
      }
      if (profile.pricing === null) {
        throw new RangeError("pricing tiers require base profile pricing");
      }
      const pricingTierValues = pricingTierValue ?? [];
      if (!Array.isArray(pricingTierValues)) {
        throw new TypeError("pricing_tiers must be an array");
      }
      const pricingScope = pricingScopeValue ?? {};
      if (typeof pricingScope !== "object" || Array.isArray(pricingScope)) {
        throw new TypeError("pricing_scope must be an object");
      }
      const pricingSchedule = new PricingSchedule({
        base: profile.pricing,
        tiers: pricingTierValues.map((tier) =>
          PricingTier.fromDict(tier as object)
        ),
        scope: PricingScope.fromDict(pricingScope as object),
      });
      reg.registerWithSchedule(profile, pricingSchedule, aliases);
    }
    return reg;
  }

  /** A fresh registry from the embedded snapshot. */
  static bundled(): Registry {
    return Registry.fromDict(MODELS_DATA as Record<string, unknown>);
  }

  // ------------------------------------------------------------------ //
  // lookup

  get(modelId: string): ModelProfile {
    const key = norm(modelId);
    const hit = this._alias.get(key);
    if (hit !== undefined) {
      return this._profiles.get(hit)!;
    }

    // dated snapshot suffixes: longest known base wins
    let best: string | null = null;
    for (const base of this._alias.keys()) {
      if (
        key.startsWith(base + "-") &&
        isDatedSuffix(key.slice(base.length + 1))
      ) {
        if (best === null || base.length > best.length) {
          best = base;
        }
      }
    }
    if (best !== null) {
      return this._profiles.get(this._alias.get(best)!)!;
    }

    const suggestions = getCloseMatches(key, this._alias.keys());
    throw new UnknownModelError(modelId, suggestions);
  }

  /** Resolve the pricing schedule tied to a profile, if pricing is known. */
  getPricingSchedule(modelId: string): PricingSchedule | null {
    const profile = this.get(modelId);
    const schedule = this._pricingSchedules.get(norm(profile.model_id));
    if (schedule !== undefined) {
      return schedule;
    }
    return profile.pricing === null
      ? null
      : new PricingSchedule({ base: profile.pricing });
  }

  /** Python-name parity alias for callers treating the registry as a catalog. */
  pricingSchedule(modelId: string): PricingSchedule | null {
    return this.getPricingSchedule(modelId);
  }

  /** Whether the id resolves (Python: `model_id in registry`). */
  has(modelId: string): boolean {
    try {
      this.get(modelId);
      return true;
    } catch (error) {
      if (error instanceof UnknownModelError) {
        return false;
      }
      throw error;
    }
  }

  get ids(): readonly string[] {
    return [...this._profiles.keys()].sort();
  }

  get profiles(): readonly ModelProfile[] {
    return [...this._profiles.keys()]
      .sort()
      .map((key) => this._profiles.get(key)!);
  }
}

// ---------------------------------------------------------------------------
// process-wide default

let _default: Registry | null = null;

/** The bundled registry, loaded once per process. */
export function defaultRegistry(): Registry {
  if (_default === null) {
    _default = Registry.bundled();
  }
  return _default;
}

/** Resolve against the default registry. */
export function getProfile(modelId: string): ModelProfile {
  return defaultRegistry().get(modelId);
}

/** Resolve a model's pricing schedule against the default registry. */
export function getPricingSchedule(modelId: string): PricingSchedule | null {
  return defaultRegistry().getPricingSchedule(modelId);
}

// ---------------------------------------------------------------------------
// exact pricing and request-limit helpers

export type ModelOrProfile = string | ModelProfile;
export type UsageLike = TurnUsage | Record<string, unknown>;

export interface RequestLimitOptions {
  input_tokens: number;
  requested_output_tokens?: number | null;
  reserved_output_tokens?: number;
  capacity?: CapacityKind;
}

export interface CostEstimateOptions {
  input_tokens: number;
  reserved_output_tokens?: number;
  conservative?: boolean;
}

function nonNegativeTokens(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function resolveProfile(
  modelOrProfile: ModelOrProfile,
  registry: Registry
): ModelProfile {
  return typeof modelOrProfile === "string"
    ? registry.get(modelOrProfile)
    : modelOrProfile;
}

function scheduleFor(
  profile: ModelProfile,
  registry: Registry,
  explicit: PricingSchedule | null | undefined
): PricingSchedule {
  if (explicit !== null && explicit !== undefined) {
    if (
      profile.pricing !== null &&
      JSON.stringify(explicit.base.toDict()) !==
        JSON.stringify(profile.pricing.toDict())
    ) {
      throw new RangeError("pricing schedule base must equal profile.pricing");
    }
    return explicit;
  }
  try {
    const registered = registry.getPricingSchedule(profile.model_id);
    if (
      registered !== null &&
      profile.pricing !== null &&
      JSON.stringify(registered.base.toDict()) ===
        JSON.stringify(profile.pricing.toDict())
    ) {
      return registered;
    }
  } catch (error) {
    if (!(error instanceof UnknownModelError)) {
      throw error;
    }
  }
  if (profile.pricing === null) {
    throw new RangeError(`model '${profile.model_id}' has no pricing`);
  }
  return new PricingSchedule({ base: profile.pricing });
}

function usageCounts(usage: UsageLike): {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
} {
  const value = usage as unknown as Record<string, unknown>;
  return {
    input_tokens: nonNegativeTokens(value["input_tokens"] ?? 0, "input_tokens"),
    cache_read_tokens: nonNegativeTokens(
      value["cache_read_tokens"] ?? 0,
      "cache_read_tokens"
    ),
    cache_write_tokens: nonNegativeTokens(
      value["cache_write_tokens"] ?? 0,
      "cache_write_tokens"
    ),
    output_tokens: nonNegativeTokens(
      value["output_tokens"] ?? 0,
      "output_tokens"
    ),
    reasoning_tokens: nonNegativeTokens(
      value["reasoning_tokens"] ?? 0,
      "reasoning_tokens"
    ),
  };
}

const ESTIMATE_INPUT_CATEGORIES = new Set([
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
]);

function nonzeroUnpricedCategories(
  schedule: PricingSchedule,
  counts: ReturnType<typeof usageCounts>
): string[] {
  return schedule.scope.unpriced_usage_categories.filter(
    (category) => counts[category as keyof typeof counts] > 0
  );
}

function unpricedInputCategories(schedule: PricingSchedule): string[] {
  return schedule.scope.unpriced_usage_categories.filter((category) =>
    ESTIMATE_INPUT_CATEGORIES.has(category)
  );
}

function unpricedQuoteError(modelId: string, categories: readonly string[]): RangeError {
  return new RangeError(
    `model '${modelId}' cannot quote unpriced usage categories: ${categories.join(", ")}`
  );
}

/** Quote one exclusive normalized usage record at the applicable input tier. */
export function quoteUsage(
  modelOrProfile: ModelOrProfile,
  usage: UsageLike,
  registry: Registry = defaultRegistry(),
  schedule?: PricingSchedule | null
): CostQuote {
  const profile = resolveProfile(modelOrProfile, registry);
  const selectedSchedule = scheduleFor(
    profile,
    registry,
    schedule
  );
  const counts = usageCounts(usage);
  const unpriced = nonzeroUnpricedCategories(selectedSchedule, counts);
  if (unpriced.length > 0) {
    throw unpricedQuoteError(profile.model_id, unpriced);
  }
  const tierBasis =
    counts.input_tokens +
    counts.cache_read_tokens +
    counts.cache_write_tokens;
  const resolved = selectedSchedule.resolve(tierBasis);
  const pricing = resolved.pricing;
  const million = 1_000_000;
  const inputCost = (counts.input_tokens * pricing.input) / million;
  const cacheReadCost =
    (counts.cache_read_tokens * pricing.cache_read) / million;
  const cacheWriteCost =
    (counts.cache_write_tokens * pricing.cache_write) / million;
  const outputCost = (counts.output_tokens * pricing.output) / million;
  const reasoningCost =
    (counts.reasoning_tokens * pricing.output) / million;
  return new CostQuote({
    model_id: profile.model_id,
    tier_basis_tokens: tierBasis,
    tier_min_input_tokens: resolved.tier_min_input_tokens,
    pricing,
    input_cost: inputCost,
    cache_read_cost: cacheReadCost,
    cache_write_cost: cacheWriteCost,
    output_cost: outputCost,
    reasoning_cost: reasoningCost,
    total_cost:
      inputCost +
      cacheReadCost +
      cacheWriteCost +
      outputCost +
      reasoningCost,
    currency: pricing.currency,
    as_of: pricing.as_of,
    source: profile.source,
  });
}

/** Reserve estimated request cost without guessing input cache composition. */
export function quoteEstimate(
  modelOrProfile: ModelOrProfile,
  options: CostEstimateOptions,
  registry: Registry = defaultRegistry(),
  schedule?: PricingSchedule | null
): CostEstimate {
  const inputTokens = nonNegativeTokens(options.input_tokens, "input_tokens");
  const reservedOutputTokens = nonNegativeTokens(
    options.reserved_output_tokens === undefined
      ? 0
      : options.reserved_output_tokens,
    "reserved_output_tokens"
  );
  const conservative =
    options.conservative === undefined ? true : options.conservative;
  if (typeof conservative !== "boolean") {
    throw new RangeError("conservative must be a bool");
  }

  const profile = resolveProfile(modelOrProfile, registry);
  const selectedSchedule = scheduleFor(profile, registry, schedule);
  const unpricedInput = unpricedInputCategories(selectedSchedule);
  if (conservative && inputTokens > 0 && unpricedInput.length > 0) {
    throw new RangeError(
      `model '${profile.model_id}' cannot produce a conservative estimate; ` +
        `unpriced input categories: ${unpricedInput.join(", ")}`
    );
  }
  if (
    !conservative &&
    inputTokens > 0 &&
    unpricedInput.includes("input_tokens")
  ) {
    throw unpricedQuoteError(profile.model_id, ["input_tokens"]);
  }
  const unpricedOutput =
    selectedSchedule.scope.unpriced_usage_categories.filter(
      (category) =>
        category === "output_tokens" || category === "reasoning_tokens"
    );
  if (reservedOutputTokens > 0 && unpricedOutput.length > 0) {
    throw unpricedQuoteError(profile.model_id, unpricedOutput);
  }
  const resolved = selectedSchedule.resolve(inputTokens);
  const pricing = resolved.pricing;
  const rates = [
    ["input", pricing.input],
    ["cache_read", pricing.cache_read],
    ["cache_write", pricing.cache_write],
  ] as const;
  let inputRateKind: (typeof rates)[number][0] = rates[0][0];
  let inputRate = rates[0][1];
  if (conservative) {
    for (const [kind, rate] of rates.slice(1)) {
      if (rate > inputRate) {
        inputRateKind = kind;
        inputRate = rate;
      }
    }
  }
  const assumptions: string[] = conservative
    ? [
        "estimated input uses the highest selected-tier input-category rate",
        "reserved output uses the selected-tier output rate",
      ]
    : [
        "estimated input is treated as uncached input",
        "reserved output uses the selected-tier output rate",
      ];
  if (
    !conservative &&
    unpricedInput.includes("cache_write_tokens")
  ) {
    assumptions.push(
      "unpriced cache-write storage is excluded; valid only when no explicit cache is created"
    );
  }
  const million = 1_000_000;
  const inputCost = (inputTokens * inputRate) / million;
  const outputCost = (reservedOutputTokens * pricing.output) / million;
  return new CostEstimate({
    model_id: profile.model_id,
    tier_basis_tokens: inputTokens,
    tier_min_input_tokens: resolved.tier_min_input_tokens,
    pricing,
    input_tokens: inputTokens,
    reserved_output_tokens: reservedOutputTokens,
    input_rate_kind: inputRateKind,
    input_rate: inputRate,
    output_rate: pricing.output,
    input_cost: inputCost,
    output_cost: outputCost,
    total_cost: inputCost + outputCost,
    currency: pricing.currency,
    as_of: pricing.as_of,
    source: profile.source,
    conservative,
    assumptions,
  });
}

/** Check one request against nominal or calibrated effective capacity. */
export function checkRequestLimits(
  modelOrProfile: ModelOrProfile,
  options: RequestLimitOptions,
  registry: Registry = defaultRegistry()
): LimitCheck {
  const profile = resolveProfile(modelOrProfile, registry);
  const inputTokens = nonNegativeTokens(options.input_tokens, "input_tokens");
  const requestedOutput =
    options.requested_output_tokens === null ||
    options.requested_output_tokens === undefined
      ? null
      : nonNegativeTokens(
          options.requested_output_tokens,
          "requested_output_tokens"
        );
  const reservedOutput = nonNegativeTokens(
    options.reserved_output_tokens ?? 0,
    "reserved_output_tokens"
  );
  const capacityKind = options.capacity ?? "nominal";
  if (capacityKind !== "nominal" && capacityKind !== "effective") {
    throw new RangeError("capacity must be 'nominal' or 'effective'");
  }
  const capacity =
    capacityKind === "effective"
      ? profile.window_effective
      : profile.window_nominal;
  const maxOutput = profile.max_output;
  const maxInput =
    maxOutput === null ? capacity : Math.max(0, capacity - maxOutput);
  const contextOutput = Math.max(reservedOutput, requestedOutput ?? 0);
  const contextTokens = inputTokens + contextOutput;
  if (!Number.isSafeInteger(contextTokens)) {
    throw new RangeError("context_tokens must be a non-negative safe integer");
  }
  const inputExceeded = inputTokens > maxInput;
  const contextExceeded = contextTokens > capacity;
  const outputExceeded =
    requestedOutput !== null &&
    maxOutput !== null &&
    requestedOutput > maxOutput;
  const violations: string[] = [];
  if (inputExceeded) {
    violations.push("input_tokens");
  }
  if (contextExceeded) {
    violations.push("context_tokens");
  }
  if (outputExceeded) {
    violations.push("requested_output_tokens");
  }
  return new LimitCheck({
    model_id: profile.model_id,
    capacity_kind: capacityKind,
    capacity,
    input_tokens: inputTokens,
    requested_output_tokens: requestedOutput,
    reserved_output_tokens: reservedOutput,
    context_output_tokens: contextOutput,
    context_tokens: contextTokens,
    max_input_tokens: maxInput,
    max_output_tokens: maxOutput,
    input_exceeded: inputExceeded,
    context_exceeded: contextExceeded,
    output_exceeded: outputExceeded,
    allowed: violations.length === 0,
    violations,
  });
}
