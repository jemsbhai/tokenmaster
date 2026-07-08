/**
 * Advisor: policies, recommendations, and rationale traces (contract
 * section 5). Port of python/tokenmaster/src/tokenmaster/advisor.py.
 *
 * Judgment lives here; measurement lives in the Meter. Every recommendation
 * ships with the arithmetic that produced it (principle P4: no silent
 * thresholds), and effect estimates a policy cannot honestly make stay null
 * rather than being invented.
 *
 * ThresholdPolicy is the deliberate baseline: it reproduces current practice
 * (fixed fill fractions, as in tokenlens, Inspect AI, and agent frameworks)
 * and estimates no effects, because a threshold knows nothing about costs.
 * That blindness is the point of comparison for the policies that follow.
 *
 * Comparison strings interpolate numbers with Python's fixed-point
 * formatting (round half to even); see pyFixed below. All arithmetic keeps
 * the reference's expression order so doubles match bit for bit.
 */

import {
  SCHEMA_VERSION,
  MeterState,
  ModelProfile,
  Pricing,
} from "./types.js";

// ---------------------------------------------------------------------------
// coercion and formatting helpers

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

/**
 * Python format(x, ".Nf") emulation: fixed decimals with round half to
 * even, where JS toFixed rounds half away from zero. A tie only exists when
 * the double's decimal expansion terminates exactly at the half digit;
 * toFixed(30) exposes the expansion far past any tie reachable at the
 * magnitudes this module formats (double spacing makes near-ties visibly
 * nonzero well before digit 30). Negative zero formats as "+0...." here
 * where Python writes "-0...."; no reference string produces negative zero.
 */
function pyFixed(x: number, digits: number, plusSign = false): string {
  const negative = x < 0;
  const abs = Math.abs(x);
  const expanded = abs.toFixed(30);
  const dot = expanded.indexOf(".");
  const intPart = expanded.slice(0, dot);
  const fracPart = expanded.slice(dot + 1);
  let digitsArr = (intPart + fracPart.slice(0, digits)).split("").map(Number);
  const nextDigit = Number(fracPart[digits]);
  const restNonZero = /[1-9]/.test(fracPart.slice(digits + 1));
  let roundUp = false;
  if (nextDigit > 5 || (nextDigit === 5 && restNonZero)) {
    roundUp = true;
  } else if (nextDigit === 5 && !restNonZero) {
    roundUp = digitsArr[digitsArr.length - 1] % 2 === 1;
  }
  if (roundUp) {
    let i = digitsArr.length - 1;
    while (i >= 0) {
      if (digitsArr[i] === 9) {
        digitsArr[i] = 0;
        i -= 1;
      } else {
        digitsArr[i] += 1;
        break;
      }
    }
    if (i < 0) {
      digitsArr = [1, ...digitsArr];
    }
  }
  const joined = digitsArr.join("");
  const cut = joined.length - digits;
  const body =
    digits > 0 ? `${joined.slice(0, cut)}.${joined.slice(cut)}` : joined;
  const sign = negative ? "-" : plusSign ? "+" : "";
  return sign + body;
}

// ---------------------------------------------------------------------------
// enums

export const Action = {
  CONTINUE: "continue",
  COMPACT: "compact",
  HANDOFF: "handoff",
} as const;
export type Action = (typeof Action)[keyof typeof Action];

const ACTION_VALUES = new Set<string>(Object.values(Action));

export function asAction(value: unknown): Action {
  if (typeof value === "string" && ACTION_VALUES.has(value)) {
    return value as Action;
  }
  throw new RangeError(`'${String(value)}' is not a valid Action`);
}

export const Urgency = {
  NONE: "none",
  SOON: "soon",
  NOW: "now",
} as const;
export type Urgency = (typeof Urgency)[keyof typeof Urgency];

const URGENCY_VALUES = new Set<string>(Object.values(Urgency));

export function asUrgency(value: unknown): Urgency {
  if (typeof value === "string" && URGENCY_VALUES.has(value)) {
    return value as Urgency;
  }
  throw new RangeError(`'${String(value)}' is not a valid Urgency`);
}

export const TaskCriticality = {
  LOW: "low",
  NORMAL: "normal",
  HIGH: "high",
} as const;
export type TaskCriticality =
  (typeof TaskCriticality)[keyof typeof TaskCriticality];

const TASK_CRITICALITY_VALUES = new Set<string>(
  Object.values(TaskCriticality)
);

export function asTaskCriticality(value: unknown): TaskCriticality {
  if (typeof value === "string" && TASK_CRITICALITY_VALUES.has(value)) {
    return value as TaskCriticality;
  }
  throw new RangeError(`'${String(value)}' is not a valid TaskCriticality`);
}

// ---------------------------------------------------------------------------
// data model

export interface TaskContextDict {
  expected_remaining_turns: number | null;
  task_criticality: TaskCriticality;
}

/** Minimal task hints (contract decision D6). */
export class TaskContext {
  readonly expected_remaining_turns: number | null;
  readonly task_criticality: TaskCriticality;

  constructor(
    fields: {
      expected_remaining_turns?: number | null;
      task_criticality?: TaskCriticality;
    } = {}
  ) {
    this.expected_remaining_turns = fields.expected_remaining_turns ?? null;
    this.task_criticality = fields.task_criticality ?? TaskCriticality.NORMAL;
    Object.freeze(this);
  }

  toDict(): TaskContextDict {
    return {
      expected_remaining_turns: this.expected_remaining_turns,
      task_criticality: this.task_criticality,
    };
  }

  toJSON(): TaskContextDict {
    return this.toDict();
  }

  static fromDict(dict: object): TaskContext {
    const d = dict as Record<string, unknown>;
    return new TaskContext({
      expected_remaining_turns:
        d["expected_remaining_turns"] === null ||
        d["expected_remaining_turns"] === undefined
          ? null
          : asInt(d["expected_remaining_turns"], "expected_remaining_turns"),
      task_criticality: asTaskCriticality(d["task_criticality"] ?? "normal"),
    });
  }
}

export interface RationaleTraceDict {
  inputs: Record<string, unknown>;
  derived: Record<string, unknown>;
  comparison: string;
}

/** The arithmetic behind a recommendation: inputs, derived values, verdict. */
export class RationaleTrace {
  readonly inputs: Record<string, unknown>;
  readonly derived: Record<string, unknown>;
  readonly comparison: string;

  constructor(
    fields: {
      inputs?: Record<string, unknown>;
      derived?: Record<string, unknown>;
      comparison?: string;
    } = {}
  ) {
    this.inputs = fields.inputs ?? {};
    this.derived = fields.derived ?? {};
    this.comparison = fields.comparison ?? "";
    Object.freeze(this);
  }

  toDict(): RationaleTraceDict {
    return {
      inputs: { ...this.inputs },
      derived: { ...this.derived },
      comparison: this.comparison,
    };
  }

  toJSON(): RationaleTraceDict {
    return this.toDict();
  }

  static fromDict(dict: object): RationaleTrace {
    const d = dict as Record<string, unknown>;
    return new RationaleTrace({
      inputs: { ...((d["inputs"] as Record<string, unknown>) ?? {}) },
      derived: { ...((d["derived"] as Record<string, unknown>) ?? {}) },
      comparison: String(d["comparison"] ?? ""),
    });
  }
}

export interface EffectEstimateDict {
  tokens_spent: number | null;
  tokens_freed: number | null;
  cost_delta: number | null;
  fidelity_risk: number | null;
}

/** Expected consequences of following the recommendation. null = unknown. */
export class EffectEstimate {
  readonly tokens_spent: number | null;
  readonly tokens_freed: number | null;
  readonly cost_delta: number | null;
  readonly fidelity_risk: number | null;

  constructor(
    fields: {
      tokens_spent?: number | null;
      tokens_freed?: number | null;
      cost_delta?: number | null;
      fidelity_risk?: number | null;
    } = {}
  ) {
    this.tokens_spent = fields.tokens_spent ?? null;
    this.tokens_freed = fields.tokens_freed ?? null;
    this.cost_delta = fields.cost_delta ?? null;
    this.fidelity_risk = fields.fidelity_risk ?? null;
    Object.freeze(this);
  }

  toDict(): EffectEstimateDict {
    return {
      tokens_spent: this.tokens_spent,
      tokens_freed: this.tokens_freed,
      cost_delta: this.cost_delta,
      fidelity_risk: this.fidelity_risk,
    };
  }

  toJSON(): EffectEstimateDict {
    return this.toDict();
  }

  static fromDict(dict: object): EffectEstimate {
    const d = dict as Record<string, unknown>;
    return new EffectEstimate({
      tokens_spent:
        d["tokens_spent"] === null || d["tokens_spent"] === undefined
          ? null
          : asInt(d["tokens_spent"], "tokens_spent"),
      tokens_freed:
        d["tokens_freed"] === null || d["tokens_freed"] === undefined
          ? null
          : asInt(d["tokens_freed"], "tokens_freed"),
      cost_delta:
        d["cost_delta"] === null || d["cost_delta"] === undefined
          ? null
          : asFloat(d["cost_delta"], "cost_delta"),
      fidelity_risk:
        d["fidelity_risk"] === null || d["fidelity_risk"] === undefined
          ? null
          : asFloat(d["fidelity_risk"], "fidelity_risk"),
    });
  }
}

export interface RecommendationDict {
  action: Action;
  urgency: Urgency;
  rationale: RationaleTraceDict;
  expected: EffectEstimateDict;
  policy_id: string;
  schema_version: string;
}

export class Recommendation {
  readonly action: Action;
  readonly urgency: Urgency;
  readonly rationale: RationaleTrace;
  readonly expected: EffectEstimate;
  readonly policy_id: string;
  readonly schema_version: string;

  constructor(fields: {
    action: Action;
    urgency: Urgency;
    rationale: RationaleTrace;
    expected: EffectEstimate;
    policy_id: string;
    schema_version?: string;
  }) {
    this.action = fields.action;
    this.urgency = fields.urgency;
    this.rationale = fields.rationale;
    this.expected = fields.expected;
    this.policy_id = fields.policy_id;
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    Object.freeze(this);
  }

  toDict(): RecommendationDict {
    return {
      action: this.action,
      urgency: this.urgency,
      rationale: this.rationale.toDict(),
      expected: this.expected.toDict(),
      policy_id: this.policy_id,
      schema_version: this.schema_version,
    };
  }

  toJSON(): RecommendationDict {
    return this.toDict();
  }

  static fromDict(dict: object): Recommendation {
    const d = dict as Record<string, unknown>;
    return new Recommendation({
      action: asAction(d["action"]),
      urgency: asUrgency(d["urgency"]),
      rationale: RationaleTrace.fromDict(
        (d["rationale"] as Record<string, unknown>) ?? {}
      ),
      expected: EffectEstimate.fromDict(
        (d["expected"] as Record<string, unknown>) ?? {}
      ),
      policy_id: reqString(d["policy_id"], "policy_id"),
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}

/** A policy consumes measurement and optional task context, returns judgment. */
export interface Policy {
  policy_id: string;
  evaluate(state: MeterState, task?: TaskContext | null): Recommendation;
}

// ---------------------------------------------------------------------------
// ThresholdPolicy

/**
 * Baseline: recommend compaction when fill_effective crosses a fraction.
 *
 * Below warn_at: continue. In [warn_at, compact_at): compact soon (start
 * planning). At or above compact_at, or with no headroom left: compact now.
 * Never recommends handoff; a threshold has no concept of one.
 */
export class ThresholdPolicy implements Policy {
  readonly warn_at: number;
  readonly compact_at: number;
  readonly policy_id = "threshold";

  constructor(options: { warn_at?: number; compact_at?: number } = {}) {
    const warn_at = options.warn_at ?? 0.7;
    const compact_at = options.compact_at ?? 0.85;
    if (!(warn_at > 0.0 && warn_at < compact_at && compact_at <= 1.0)) {
      throw new RangeError(
        "thresholds must satisfy 0 < warn_at < compact_at <= 1"
      );
    }
    this.warn_at = warn_at;
    this.compact_at = compact_at;
  }

  evaluate(
    state: MeterState,
    task: TaskContext | null = null
  ): Recommendation {
    const fill = state.fill_effective;
    const headroom = state.headroom_effective;
    const inputs: Record<string, unknown> = {
      fill_effective: fill,
      headroom_effective: headroom,
      warn_at: this.warn_at,
      compact_at: this.compact_at,
      expected_remaining_turns: task ? task.expected_remaining_turns : null,
    };

    let action: Action;
    let urgency: Urgency;
    let comparison: string;
    if (headroom <= 0) {
      action = Action.COMPACT;
      urgency = Urgency.NOW;
      comparison = `headroom_effective ${headroom} <= 0 (exhausted)`;
    } else if (fill >= this.compact_at) {
      action = Action.COMPACT;
      urgency = Urgency.NOW;
      comparison = `fill ${pyFixed(fill, 3)} >= compact_at ${pyFixed(this.compact_at, 2)}`;
    } else if (fill >= this.warn_at) {
      action = Action.COMPACT;
      urgency = Urgency.SOON;
      comparison =
        `warn_at ${pyFixed(this.warn_at, 2)} <= fill ${pyFixed(fill, 3)} ` +
        `< compact_at ${pyFixed(this.compact_at, 2)}`;
    } else {
      action = Action.CONTINUE;
      urgency = Urgency.NONE;
      comparison = `fill ${pyFixed(fill, 3)} < warn_at ${pyFixed(this.warn_at, 2)}`;
    }

    return new Recommendation({
      action,
      urgency,
      rationale: new RationaleTrace({
        inputs,
        derived: { note: "threshold baseline estimates no effects" },
        comparison,
      }),
      expected: new EffectEstimate(),
      policy_id: this.policy_id,
    });
  }
}

// ---------------------------------------------------------------------------
// PredictivePolicy

/**
 * Fuel-gauge policy: act when projected range no longer covers the task.
 *
 * Compares eta_turns.conservative against the task horizon
 * (expected_remaining_turns) plus a safety buffer. Without a horizon it
 * guards the buffer alone: running within buffer_turns of exhaustion is
 * act-now territory regardless of the task. When no prediction exists
 * (cold start, non-positive velocity) it delegates to a fallback policy,
 * ThresholdPolicy by default, and says so in the rationale.
 *
 * buffer_turns (provisional default 3) and soon_factor (provisional
 * default 2.0) await measurement; task_criticality is recorded in the
 * rationale but not yet weighted, deliberately, until experiments say how.
 * Like the baseline, this policy knows when to act, not what acting costs,
 * so every effect estimate stays null; costing is CostModelPolicy's job.
 */
export class PredictivePolicy implements Policy {
  readonly buffer_turns: number;
  readonly soon_factor: number;
  readonly fallback: Policy;
  readonly policy_id = "predictive";

  constructor(
    options: {
      buffer_turns?: number;
      soon_factor?: number;
      fallback?: Policy | null;
    } = {}
  ) {
    const buffer_turns = options.buffer_turns ?? 3;
    const soon_factor = options.soon_factor ?? 2.0;
    if (buffer_turns < 0) {
      throw new RangeError("buffer_turns must be non-negative");
    }
    if (soon_factor < 1.0) {
      throw new RangeError("soon_factor must be at least 1");
    }
    this.buffer_turns = buffer_turns;
    this.soon_factor = soon_factor;
    this.fallback = options.fallback ?? new ThresholdPolicy();
  }

  evaluate(
    state: MeterState,
    task: TaskContext | null = null
  ): Recommendation {
    const eta = state.eta_turns;
    const horizon = task ? task.expected_remaining_turns : null;
    const inputs: Record<string, unknown> = {
      fill_effective: state.fill_effective,
      headroom_effective: state.headroom_effective,
      conservative_eta: eta ? eta.conservative : null,
      expected_eta: eta ? eta.expected : null,
      horizon,
      buffer_turns: this.buffer_turns,
      soon_factor: this.soon_factor,
      task_criticality: task ? task.task_criticality : null,
    };

    if (state.headroom_effective <= 0) {
      return new Recommendation({
        action: Action.COMPACT,
        urgency: Urgency.NOW,
        rationale: new RationaleTrace({
          inputs,
          comparison: `headroom_effective ${state.headroom_effective} <= 0 (exhausted)`,
        }),
        expected: new EffectEstimate(),
        policy_id: this.policy_id,
      });
    }

    if (eta === null) {
      const reason = state.provenance["eta_turns"] ?? "eta unavailable";
      const base = this.fallback.evaluate(state, task);
      return new Recommendation({
        action: base.action,
        urgency: base.urgency,
        rationale: new RationaleTrace({
          inputs,
          derived: {
            delegated_to: this.fallback.policy_id,
            reason,
            fallback_comparison: base.rationale.comparison,
          },
          comparison:
            `prediction unavailable (${reason}); ` +
            `delegated to ${this.fallback.policy_id}`,
        }),
        expected: base.expected,
        policy_id: this.policy_id,
      });
    }

    const conservative = eta.conservative;
    const derived: Record<string, unknown> = {};
    if (horizon !== null && state.velocity !== null) {
      derived["projected_used_at_horizon"] = Math.trunc(
        state.used_tokens + horizon * state.velocity
      );
    }

    let action: Action;
    let urgency: Urgency;
    let comparison: string;
    if (horizon !== null) {
      const required = horizon + this.buffer_turns;
      derived["required_turns"] = required;
      if (conservative < horizon) {
        action = Action.COMPACT;
        urgency = Urgency.NOW;
        comparison = `conservative eta ${pyFixed(conservative, 1)} < horizon ${horizon}`;
      } else if (conservative < required) {
        action = Action.COMPACT;
        urgency = Urgency.SOON;
        comparison =
          `conservative eta ${pyFixed(conservative, 1)} < horizon ${horizon} ` +
          `+ buffer ${this.buffer_turns}`;
      } else {
        action = Action.CONTINUE;
        urgency = Urgency.NONE;
        comparison =
          `conservative eta ${pyFixed(conservative, 1)} covers horizon ` +
          `${horizon} + buffer ${this.buffer_turns}`;
      }
    } else {
      const soonBand = this.buffer_turns * this.soon_factor;
      if (conservative <= this.buffer_turns) {
        action = Action.COMPACT;
        urgency = Urgency.NOW;
        comparison =
          `conservative eta ${pyFixed(conservative, 1)} <= buffer ` +
          `${this.buffer_turns} (horizon unknown)`;
      } else if (conservative <= soonBand) {
        action = Action.COMPACT;
        urgency = Urgency.SOON;
        comparison =
          `conservative eta ${pyFixed(conservative, 1)} <= buffer band ` +
          `${pyFixed(soonBand, 1)} (horizon unknown)`;
      } else {
        action = Action.CONTINUE;
        urgency = Urgency.NONE;
        comparison =
          `conservative eta ${pyFixed(conservative, 1)} exceeds buffer band ` +
          `${pyFixed(soonBand, 1)} (horizon unknown)`;
      }
    }

    return new Recommendation({
      action,
      urgency,
      rationale: new RationaleTrace({ inputs, derived, comparison }),
      expected: new EffectEstimate(),
      policy_id: this.policy_id,
    });
  }
}

// ---------------------------------------------------------------------------
// CostModelPolicy

const UNIT_PRICES: readonly [number, number, number, number] = [
  1.0, 5.0, 0.1, 1.25,
]; // in, out, cache_read, cache_write

export interface CostModelPolicyOptions {
  pricing?: Pricing | null;
  compaction_ratio?: number;
  summary_output_ratio?: number;
  handoff_prompt_ratio?: number;
  expected_compaction_loss?: number;
  expected_handoff_loss?: number;
  human_friction?: number;
  default_horizon?: number;
  fallback?: Policy | null;
}

/**
 * Choose the action minimizing expected cost (contract section 5.2).
 *
 * Computes net costs of compact and handoff relative to continuing over a
 * horizon of k turns, including the cache economics of the aftermath: the
 * one-time summary generation and prefix rewrite versus the per-turn
 * cache-read savings of a smaller prefix. The break-even horizon
 *
 *     k* = (T_sum*p_out + T_post*(p_cw - p_cr)) / ((T_pre - T_post)*p_cr)
 *
 * is reported in every rationale; below k* remaining turns, compaction
 * loses money before information loss is even counted. Per-turn context
 * growth cancels between branches (both paths grow identically), so the
 * savings term is exact under the equal-growth assumption.
 *
 * Prices come from a Pricing (per-Mtok, converted internally to per-token)
 * or, when absent, from provisional unit ratios (in 1.0, out 5.0, cache
 * read 0.1, cache write 1.25 per token) with the ledger unit reported as
 * "token-units" instead of a currency. All ratios and loss parameters are
 * provisional pending experiments E3 and E4 and are recorded in the
 * rationale inputs. With no prediction available (cold start), the policy
 * delegates to a fallback and says so; with no headroom, it picks the
 * cheaper of compact and handoff at urgency now.
 */
export class CostModelPolicy implements Policy {
  readonly pricing: Pricing | null;
  readonly compaction_ratio: number;
  readonly summary_output_ratio: number;
  readonly handoff_prompt_ratio: number;
  readonly expected_compaction_loss: number;
  readonly expected_handoff_loss: number;
  readonly human_friction: number;
  readonly default_horizon: number;
  readonly fallback: Policy;
  readonly policy_id = "cost-model";

  constructor(options: CostModelPolicyOptions = {}) {
    const compaction_ratio = options.compaction_ratio ?? 0.15;
    const summary_output_ratio = options.summary_output_ratio ?? 0.1;
    const handoff_prompt_ratio = options.handoff_prompt_ratio ?? 0.05;
    const expected_compaction_loss = options.expected_compaction_loss ?? 0.1;
    const expected_handoff_loss = options.expected_handoff_loss ?? 0.2;
    const human_friction = options.human_friction ?? 0.0;
    const default_horizon = options.default_horizon ?? 10;
    for (const [name, value] of [
      ["compaction_ratio", compaction_ratio],
      ["summary_output_ratio", summary_output_ratio],
      ["handoff_prompt_ratio", handoff_prompt_ratio],
    ] as const) {
      if (!(value > 0.0 && value < 1.0)) {
        throw new RangeError(`${name} must be in (0, 1)`);
      }
    }
    for (const [name, value] of [
      ["expected_compaction_loss", expected_compaction_loss],
      ["expected_handoff_loss", expected_handoff_loss],
    ] as const) {
      if (!(value >= 0.0 && value <= 1.0)) {
        throw new RangeError(`${name} must be in [0, 1]`);
      }
    }
    if (human_friction < 0) {
      throw new RangeError("human_friction must be non-negative");
    }
    if (default_horizon < 1) {
      throw new RangeError("default_horizon must be at least 1");
    }
    this.pricing = options.pricing ?? null;
    this.compaction_ratio = compaction_ratio;
    this.summary_output_ratio = summary_output_ratio;
    this.handoff_prompt_ratio = handoff_prompt_ratio;
    this.expected_compaction_loss = expected_compaction_loss;
    this.expected_handoff_loss = expected_handoff_loss;
    this.human_friction = human_friction;
    this.default_horizon = default_horizon;
    this.fallback = options.fallback ?? new ThresholdPolicy();
  }

  /** Construct with the profile's dated pricing (null degrades to units). */
  static forProfile(
    profile: ModelProfile,
    options: Omit<CostModelPolicyOptions, "pricing"> = {}
  ): CostModelPolicy {
    return new CostModelPolicy({ ...options, pricing: profile.pricing });
  }

  private _perTokenPrices(): [number, number, number, number, string] {
    if (this.pricing !== null) {
      const p = this.pricing;
      return [
        p.input / 1e6,
        p.output / 1e6,
        p.cache_read / 1e6,
        p.cache_write / 1e6,
        p.currency,
      ];
    }
    const [i, o, cr, cw] = UNIT_PRICES;
    return [i, o, cr, cw, "token-units"];
  }

  evaluate(
    state: MeterState,
    task: TaskContext | null = null
  ): Recommendation {
    const [pIn, pOut, pCr, pCw, unit] = this._perTokenPrices();
    const horizon = task ? task.expected_remaining_turns : null;
    const horizonSource = horizon !== null ? "task" : "default";
    const k = horizon !== null ? horizon : this.default_horizon;

    const tPre = state.used_tokens;
    const tPost = Math.trunc(tPre * this.compaction_ratio);
    const tSum = Math.trunc(tPre * this.summary_output_ratio);
    const tHand = Math.trunc(tPre * this.handoff_prompt_ratio);

    const inputs: Record<string, unknown> = {
      t_pre: tPre,
      velocity: state.velocity,
      horizon: k,
      horizon_source: horizonSource,
      prices_per_mtok: this.pricing
        ? this.pricing.toDict()
        : "unit ratios (provisional)",
      compaction_ratio: this.compaction_ratio,
      summary_output_ratio: this.summary_output_ratio,
      handoff_prompt_ratio: this.handoff_prompt_ratio,
      expected_compaction_loss: this.expected_compaction_loss,
      expected_handoff_loss: this.expected_handoff_loss,
      human_friction: this.human_friction,
      task_criticality: task ? task.task_criticality : null,
    };

    const exhausted = state.headroom_effective <= 0;
    if (state.eta_turns === null && !exhausted) {
      const reason = state.provenance["eta_turns"] ?? "eta unavailable";
      const base = this.fallback.evaluate(state, task);
      return new Recommendation({
        action: base.action,
        urgency: base.urgency,
        rationale: new RationaleTrace({
          inputs,
          derived: {
            delegated_to: this.fallback.policy_id,
            reason,
            fallback_comparison: base.rationale.comparison,
          },
          comparison:
            `prediction unavailable (${reason}); ` +
            `delegated to ${this.fallback.policy_id}`,
        }),
        expected: base.expected,
        policy_id: this.policy_id,
      });
    }

    const savingPerTurnCompact = (tPre - tPost) * pCr;
    const savingPerTurnHandoff = (tPre - tHand) * pCr;
    const oneTimeCompact = tSum * pOut + tPost * (pCw - pCr);
    const oneTimeHandoff = tHand * pOut + tHand * (pCw - pCr);
    const infoCompact = this.expected_compaction_loss * tPre * pIn;
    const infoHandoff = this.expected_handoff_loss * tPre * pIn;

    const kStar =
      savingPerTurnCompact > 0 ? oneTimeCompact / savingPerTurnCompact : null;
    const kStarWithInfo =
      savingPerTurnCompact > 0
        ? (oneTimeCompact + infoCompact) / savingPerTurnCompact
        : null;

    const netCompact = oneTimeCompact + infoCompact - k * savingPerTurnCompact;
    const netHandoff =
      oneTimeHandoff +
      infoHandoff +
      this.human_friction -
      k * savingPerTurnHandoff;

    const overflow =
      !exhausted && state.eta_turns !== null && state.eta_turns.expected < k;
    const continueFeasible = !exhausted && !overflow;
    const netContinue = continueFeasible ? 0.0 : null;

    const candidates: [Action, number][] = [
      [Action.COMPACT, netCompact],
      [Action.HANDOFF, netHandoff],
    ];
    if (continueFeasible) {
      candidates.push([Action.CONTINUE, 0.0]);
    }
    let action = candidates[0][0];
    let chosenNet = candidates[0][1];
    for (const [candidate, net] of candidates.slice(1)) {
      if (net < chosenNet) {
        action = candidate;
        chosenNet = net;
      }
    }

    let urgency: Urgency;
    let expected: EffectEstimate;
    if (action === Action.CONTINUE) {
      urgency = Urgency.NONE;
      expected = new EffectEstimate({
        tokens_spent: 0,
        tokens_freed: 0,
        cost_delta: 0.0,
        fidelity_risk: 0.0,
      });
    } else {
      urgency = !continueFeasible ? Urgency.NOW : Urgency.SOON;
      if (action === Action.COMPACT) {
        expected = new EffectEstimate({
          tokens_spent: tSum,
          tokens_freed: tPre - tPost,
          cost_delta: chosenNet,
          fidelity_risk: this.expected_compaction_loss,
        });
      } else {
        expected = new EffectEstimate({
          tokens_spent: tHand,
          tokens_freed: tPre - tHand,
          cost_delta: chosenNet,
          fidelity_risk: this.expected_handoff_loss,
        });
      }
    }

    const continueText =
      netContinue !== null ? pyFixed(netContinue, 4, true) : "infeasible";
    const comparison =
      `min over k=${k}: continue ${continueText}, ` +
      `compact ${pyFixed(netCompact, 4, true)}, handoff ${pyFixed(netHandoff, 4, true)} ${unit} ` +
      `-> ${action}`;

    return new Recommendation({
      action,
      urgency,
      rationale: new RationaleTrace({
        inputs,
        derived: {
          ledger_unit: unit,
          k_star: kStar,
          k_star_with_info: kStarWithInfo,
          net_compact: netCompact,
          net_handoff: netHandoff,
          one_time_compact: oneTimeCompact,
          one_time_handoff: oneTimeHandoff,
          saving_per_turn_compact: savingPerTurnCompact,
          overflow_within_horizon: overflow,
          exhausted,
          t_post: tPost,
          t_sum: tSum,
          t_hand: tHand,
        },
        comparison,
      }),
      expected,
      policy_id: this.policy_id,
    });
  }
}
