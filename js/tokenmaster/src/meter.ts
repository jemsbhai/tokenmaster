/**
 * Meter: turn ingestion, MeterState computation, and event emission.
 *
 * Port of the Python reference (python/tokenmaster/src/tokenmaster/meter.py),
 * which defines the semantics for the golden vectors:
 *
 * - used_tokens: contextTotal() of the latest turn (full prompt of that
 *   request plus its response), not a sum over turns.
 * - growth: g_t = used_t - used_(t-1), defined from the second turn onward.
 * - velocity: exponentially weighted moving average of g_t with smoothing
 *   factor alpha (contract decision D2: alpha 0.3), exposed once at least
 *   three turns are recorded; before that it is null with a provenance
 *   reason.
 * - velocity_std: square root of the exponentially weighted variance
 *   maintained incrementally alongside the mean.
 * - eta_turns.expected = headroom_effective / velocity;
 *   eta_turns.conservative = headroom_effective / (velocity + velocity_std).
 * - zone: keyed to fill_effective with thresholds caution 0.70 and critical
 *   0.85 (contract decision D1, provisional pending experiment E2).
 *
 * Event emission per recorded turn, in this deterministic order (section 4):
 * TurnRecorded, then ZoneChanged (on boundary crossing), then VelocityShift
 * (when exposed velocity moves by more than velocity_shift_factor,
 * provisional default 1.5), then ModelChanged (when the turn's model_id
 * differs from the previous one). Subscriber callbacks are synchronous and
 * exceptions propagate to the caller of record(): a subscriber that throws
 * is a bug worth hearing about, and consumers that disagree can wrap their
 * own callbacks. The event history kept for events() is unbounded in 0.1.
 * Persistence via fromDict/fromJSON replays turns, so event timestamps are
 * regenerated on restore; MeterState round-trips exactly, the event log does
 * not claim to.
 *
 * JS surface notes: events() returns a snapshot array (arrays are iterable,
 * so for..of reads exactly like the reference's iterator); toJSON() returns
 * the plain object per the platform convention, so JSON.stringify(meter) is
 * the string form.
 */

import {
  SCHEMA_VERSION,
  CacheState,
  EtaEstimate,
  MeterState,
  ModelProfile,
  TurnUsage,
  Zone,
  ModelProfileDict,
  TurnUsageDict,
} from "./types.js";
import {
  AdvisorRecommendation,
  Event,
  EventCallback,
  HandoffEvaluated,
  ModelChanged,
  TurnRecorded,
  VelocityShift,
  ZoneChanged,
} from "./events.js";
import {
  Policy,
  Recommendation,
  TaskContext,
  ThresholdPolicy,
} from "./advisor.js";
import { getProfile } from "./registry.js";
import { FidelityReport } from "./fidelity.js";

const COLD_START_TURNS = 3;

function utcnow(): string {
  return new Date().toISOString();
}

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

/**
 * Format a float the way Python's str() renders the values this module
 * interpolates into provenance strings (which the conformance vectors
 * compare character for character). Alpha lives in (0, 1], where the only
 * divergence between Python str() and JS String() is the integral case:
 * Python renders 1.0 as "1.0", JS as "1". (Python also switches to
 * scientific notation below 1e-4 where JS switches lower; such alphas are
 * outside any sane configuration and no vector uses them.)
 */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

function isVelocityShift(
  previous: number,
  current: number,
  factor: number
): boolean {
  if (previous === 0.0 && current === 0.0) {
    return false;
  }
  if (previous === 0.0 || current === 0.0) {
    return true;
  }
  if (previous > 0.0 !== current > 0.0) {
    return true;
  }
  const ratio = Math.abs(current) / Math.abs(previous);
  return ratio >= factor || 1.0 / ratio >= factor;
}

export interface MeterConfigDict {
  reserved_output: number;
  alpha: number;
  caution: number;
  critical: number;
  velocity_shift_factor: number;
}

export interface MeterDict {
  schema_version: string;
  profile: ModelProfileDict;
  config: MeterConfigDict;
  turns: TurnUsageDict[];
}

export interface MeterOptions {
  reserved_output?: number;
  alpha?: number;
  caution?: number;
  critical?: number;
  velocity_shift_factor?: number;
}

/** Context-budget meter for one conversation against one model profile. */
export class Meter {
  readonly profile: ModelProfile;
  readonly reserved_output: number;
  readonly alpha: number;
  readonly caution: number;
  readonly critical: number;
  readonly velocity_shift_factor: number;

  private readonly _turns: TurnUsage[] = [];
  private _ewMean: number | null = null;
  private _ewVar = 0.0;
  private readonly _events: Event[] = [];
  private readonly _subscribers: EventCallback[] = [];
  private _currentModel: string;

  constructor(profile: ModelProfile, options: MeterOptions = {}) {
    const reserved_output = options.reserved_output ?? 0;
    const alpha = options.alpha ?? 0.3;
    const caution = options.caution ?? 0.7;
    const critical = options.critical ?? 0.85;
    const velocity_shift_factor = options.velocity_shift_factor ?? 1.5;
    if (!(alpha > 0.0 && alpha <= 1.0)) {
      throw new RangeError("alpha must be in (0, 1]");
    }
    if (!(caution > 0.0 && caution < critical && critical <= 1.0)) {
      throw new RangeError(
        "thresholds must satisfy 0 < caution < critical <= 1"
      );
    }
    if (reserved_output < 0) {
      throw new RangeError("reserved_output must be non-negative");
    }
    if (velocity_shift_factor <= 1.0) {
      throw new RangeError("velocity_shift_factor must be greater than 1");
    }
    this.profile = profile;
    this.reserved_output = reserved_output;
    this.alpha = alpha;
    this.caution = caution;
    this.critical = critical;
    this.velocity_shift_factor = velocity_shift_factor;
    this._currentModel = profile.model_id;
  }

  // ------------------------------------------------------------------ //
  // construction from the registry

  /**
   * Construct a Meter from the bundled registry, zero configuration.
   *
   * Accepts canonical ids, bare names, aliases, and dated snapshot
   * suffixes; throws UnknownModelError with close-match suggestions
   * otherwise.
   */
  static forModel(modelId: string, options: MeterOptions = {}): Meter {
    return new Meter(getProfile(modelId), options);
  }

  // ------------------------------------------------------------------ //
  // ingestion

  /**
   * Record one turn. Accepts a TurnUsage or a canonical plain object.
   *
   * turn_id and timestamp are filled in when absent. Emits events in the
   * documented order and returns the stored TurnUsage.
   */
  record(usage: TurnUsage | object): TurnUsage {
    const nextId = this._turns.length + 1;
    let turn: TurnUsage;
    if (usage instanceof TurnUsage) {
      turn =
        usage.turn_id === nextId
          ? usage
          : TurnUsage.fromDict(usage.toDict(), nextId);
    } else {
      const d: Record<string, unknown> = { ...(usage as Record<string, unknown>) };
      if (d["model_id"] === undefined) {
        d["model_id"] = this.profile.model_id;
      }
      if (d["timestamp"] === undefined) {
        d["timestamp"] = utcnow();
      }
      turn = TurnUsage.fromDict(d, nextId);
    }

    const preState = this.state();
    const prevZone = preState.zone;
    const prevVelocity = preState.velocity;

    const prevTotal =
      this._turns.length > 0
        ? this._turns[this._turns.length - 1].contextTotal()
        : null;
    this._turns.push(turn);
    if (prevTotal !== null) {
      const growth = turn.contextTotal() - prevTotal;
      this._updateEwma(growth);
    }

    const state = this.state();
    this._emit(new TurnRecorded({ turn_id: turn.turn_id, turn, state }));
    if (state.zone !== prevZone) {
      this._emit(
        new ZoneChanged({
          turn_id: turn.turn_id,
          from_zone: prevZone,
          to_zone: state.zone,
          fill_effective: state.fill_effective,
        })
      );
    }
    if (
      prevVelocity !== null &&
      state.velocity !== null &&
      isVelocityShift(prevVelocity, state.velocity, this.velocity_shift_factor)
    ) {
      this._emit(
        new VelocityShift({
          turn_id: turn.turn_id,
          previous: prevVelocity,
          current: state.velocity,
        })
      );
    }
    if (turn.model_id && turn.model_id !== this._currentModel) {
      this._emit(
        new ModelChanged({
          turn_id: turn.turn_id,
          previous_model_id: this._currentModel,
          new_model_id: turn.model_id,
        })
      );
      this._currentModel = turn.model_id;
    }
    return turn;
  }

  private _updateEwma(growth: number): void {
    if (this._ewMean === null) {
      this._ewMean = growth;
      this._ewVar = 0.0;
      return;
    }
    const diff = growth - this._ewMean;
    const incr = this.alpha * diff;
    this._ewMean = this._ewMean + incr;
    this._ewVar = (1.0 - this.alpha) * (this._ewVar + diff * incr);
  }

  // ------------------------------------------------------------------ //
  // events

  /** Register a synchronous event callback; returns an unsubscriber. */
  subscribe(callback: EventCallback): () => void {
    this._subscribers.push(callback);
    return () => {
      const index = this._subscribers.indexOf(callback);
      if (index !== -1) {
        this._subscribers.splice(index, 1);
      }
    };
  }

  /** All events emitted so far, in order, as a snapshot array. */
  events(): Event[] {
    return [...this._events];
  }

  private _emit(event: Event): void {
    this._events.push(event);
    for (const callback of [...this._subscribers]) {
      callback(event);
    }
  }

  // ------------------------------------------------------------------ //
  // advisor

  /**
   * Evaluate a policy against the current state and emit the result.
   *
   * The default policy is a ThresholdPolicy aligned to this meter's own
   * zone thresholds, so the gauge and the default advice cannot disagree.
   * Every call emits an AdvisorRecommendation event; the caller controls
   * the cadence.
   */
  advise(
    task: TaskContext | null = null,
    policy: Policy | null = null
  ): Recommendation {
    const chosen =
      policy ??
      new ThresholdPolicy({ warn_at: this.caution, compact_at: this.critical });
    const recommendation = chosen.evaluate(this.state(), task);
    this._emit(
      new AdvisorRecommendation({
        turn_id:
          this._turns.length > 0
            ? this._turns[this._turns.length - 1].turn_id
            : null,
        recommendation,
      })
    );
    return recommendation;
  }

  // ------------------------------------------------------------------ //
  // fidelity

  /**
   * Emit a HandoffEvaluated event carrying a fidelity report.
   *
   * The evaluation itself is meter-independent (see fidelity.ts); this
   * method exists so visualizers subscribed to the meter's stream see
   * handoff scores alongside everything else.
   */
  reportHandoff(report: FidelityReport): void {
    this._emit(
      new HandoffEvaluated({
        turn_id:
          this._turns.length > 0
            ? this._turns[this._turns.length - 1].turn_id
            : null,
        report,
      })
    );
  }

  // ------------------------------------------------------------------ //
  // state

  state(): MeterState {
    const used =
      this._turns.length > 0
        ? this._turns[this._turns.length - 1].contextTotal()
        : 0;
    const nominal = this.profile.window_nominal;
    const effective = this.profile.window_effective;
    const headroom_nominal = nominal - used - this.reserved_output;
    const headroom_effective = effective - used - this.reserved_output;
    const fill_nominal = used / nominal;
    const fill_effective = used / effective;

    const provenance: Record<string, string> = {
      window_effective: this.profile.effective_source,
    };
    if (this._turns.length > 0) {
      provenance["used_tokens"] = this._turns[this._turns.length - 1].source;
    }

    let velocity: number | null = null;
    let velocityStd: number | null = null;
    let eta: EtaEstimate | null = null;
    if (this._turns.length >= COLD_START_TURNS && this._ewMean !== null) {
      velocity = this._ewMean;
      velocityStd = Math.sqrt(this._ewVar);
      provenance["velocity"] = `derived (ewma alpha=${pyFloat(this.alpha)})`;
      if (headroom_effective <= 0) {
        provenance["eta_turns"] = "exhausted (no headroom remaining)";
      } else if (velocity > 0) {
        const expected = headroom_effective / velocity;
        const conservative = headroom_effective / (velocity + velocityStd);
        eta = new EtaEstimate({ expected, conservative });
        provenance["eta_turns"] = "derived";
      } else {
        provenance["eta_turns"] = "unavailable (velocity not positive)";
      }
    } else {
      provenance["velocity"] =
        `unavailable (cold start, needs ${COLD_START_TURNS} turns)`;
      provenance["eta_turns"] = provenance["velocity"];
    }

    let zone: Zone = Zone.GREEN;
    if (fill_effective >= this.critical) {
      zone = Zone.CRITICAL;
    } else if (fill_effective >= this.caution) {
      zone = Zone.CAUTION;
    }

    let hidden: number | null = null;
    let cache: CacheState | null = null;
    if (this._turns.length > 0) {
      const last = this._turns[this._turns.length - 1];
      if (last.breakdown !== null) {
        hidden = last.breakdown.system_prompt + last.breakdown.tool_schemas;
        provenance["hidden_overhead"] = last.source;
      }
      if (last.cache_read_tokens !== 0 || last.cache_write_tokens !== 0) {
        cache = new CacheState({
          stable_prefix_tokens:
            last.cache_read_tokens + last.cache_write_tokens,
          last_cache_read: last.cache_read_tokens,
          last_cache_write: last.cache_write_tokens,
        });
        provenance["cache"] = "estimated";
      }
    }

    return new MeterState({
      model_id: this.profile.model_id,
      turns: this._turns.length,
      used_tokens: used,
      window_nominal: nominal,
      window_effective: effective,
      effective_source: this.profile.effective_source,
      reserved_output: this.reserved_output,
      headroom_nominal,
      headroom_effective,
      fill_nominal,
      fill_effective,
      velocity,
      velocity_std: velocityStd,
      eta_turns: eta,
      zone,
      hidden_overhead: hidden,
      cache,
      provenance,
    });
  }

  // ------------------------------------------------------------------ //
  // introspection and persistence

  get turns(): readonly TurnUsage[] {
    return [...this._turns];
  }

  toDict(): MeterDict {
    return {
      schema_version: SCHEMA_VERSION,
      profile: this.profile.toDict(),
      config: {
        reserved_output: this.reserved_output,
        alpha: this.alpha,
        caution: this.caution,
        critical: this.critical,
        velocity_shift_factor: this.velocity_shift_factor,
      },
      turns: this._turns.map((t) => t.toDict()),
    };
  }

  toJSON(): MeterDict {
    return this.toDict();
  }

  static fromDict(dict: object): Meter {
    const d = dict as Record<string, unknown>;
    const profileDict = d["profile"];
    if (
      profileDict === null ||
      profileDict === undefined ||
      typeof profileDict !== "object"
    ) {
      throw new TypeError("profile is required");
    }
    const config = (d["config"] ?? {}) as Record<string, unknown>;
    const meter = new Meter(
      ModelProfile.fromDict(profileDict as Record<string, unknown>),
      {
        reserved_output:
          config["reserved_output"] === null ||
          config["reserved_output"] === undefined
            ? 0
            : asInt(config["reserved_output"], "reserved_output"),
        alpha:
          config["alpha"] === null || config["alpha"] === undefined
            ? 0.3
            : asFloat(config["alpha"], "alpha"),
        caution:
          config["caution"] === null || config["caution"] === undefined
            ? 0.7
            : asFloat(config["caution"], "caution"),
        critical:
          config["critical"] === null || config["critical"] === undefined
            ? 0.85
            : asFloat(config["critical"], "critical"),
        velocity_shift_factor:
          config["velocity_shift_factor"] === null ||
          config["velocity_shift_factor"] === undefined
            ? 1.5
            : asFloat(config["velocity_shift_factor"], "velocity_shift_factor"),
      }
    );
    const turns = (d["turns"] ?? []) as Record<string, unknown>[];
    for (const turnDict of turns) {
      meter.record(TurnUsage.fromDict(turnDict));
    }
    return meter;
  }

  static fromJSON(blob: string): Meter {
    return Meter.fromDict(JSON.parse(blob) as Record<string, unknown>);
  }
}
