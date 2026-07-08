/**
 * Typed event stream, per docs/core-api.md section 4.
 *
 * Wire shape for every event:
 *
 *     {"event_type": ..., "schema_version": ..., "timestamp": ...,
 *      "turn_id": ..., "payload": {...}}
 *
 * This stream is the entire contract between tokenmaster and any visualizer.
 * Every event type something can emit today is implemented here; only
 * CalibrationLoaded awaits its feature, so that no event type exists in code
 * before something emits it.
 *
 * Timestamps are ISO 8601 via Date.toISOString() ("Z" suffix); the Python
 * reference emits "+00:00". Conformance is unaffected: the spec excludes
 * timestamps from comparison everywhere, and wire round trips preserve the
 * stored string verbatim.
 */

import {
  SCHEMA_VERSION,
  MeterState,
  TurnUsage,
  Zone,
  asZone,
} from "./types.js";
import { Recommendation } from "./advisor.js";
import { FidelityReport } from "./fidelity.js";

function utcnow(): string {
  return new Date().toISOString();
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

// ---------------------------------------------------------------------------
// envelope

export interface EventDict {
  event_type: string;
  schema_version: string;
  timestamp: string;
  turn_id: number | null;
  payload: Record<string, unknown>;
}

/** Envelope fields shared by every event constructor. */
export interface EventInit {
  turn_id?: number | null;
  timestamp?: string;
  schema_version?: string;
}

export type EventCallback = (event: Event) => void;

/** Base envelope. Subclasses define EVENT_TYPE and payload fields. */
export abstract class Event {
  static readonly EVENT_TYPE: string = "event";

  readonly turn_id: number | null;
  readonly timestamp: string;
  readonly schema_version: string;

  constructor(fields: EventInit = {}) {
    this.turn_id = fields.turn_id ?? null;
    this.timestamp = fields.timestamp ?? utcnow();
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
  }

  get event_type(): string {
    return (this.constructor as typeof Event).EVENT_TYPE;
  }

  payload(): Record<string, unknown> {
    return {};
  }

  toDict(): EventDict {
    return {
      event_type: this.event_type,
      schema_version: this.schema_version,
      timestamp: this.timestamp,
      turn_id: this.turn_id,
      payload: this.payload(),
    };
  }

  toJSON(): EventDict {
    return this.toDict();
  }
}

// ---------------------------------------------------------------------------
// meter-emitted events

/** A turn was ingested; carries the turn and the resulting state. */
export class TurnRecorded extends Event {
  static readonly EVENT_TYPE = "turn_recorded";

  readonly turn: TurnUsage;
  readonly state: MeterState;

  constructor(fields: EventInit & { turn: TurnUsage; state: MeterState }) {
    super(fields);
    this.turn = fields.turn;
    this.state = fields.state;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return { turn: this.turn.toDict(), state: this.state.toDict() };
  }
}

/** fill_effective crossed a zone boundary. */
export class ZoneChanged extends Event {
  static readonly EVENT_TYPE = "zone_changed";

  readonly from_zone: Zone;
  readonly to_zone: Zone;
  readonly fill_effective: number;

  constructor(
    fields: EventInit & {
      from_zone: Zone;
      to_zone: Zone;
      fill_effective: number;
    }
  ) {
    super(fields);
    this.from_zone = fields.from_zone;
    this.to_zone = fields.to_zone;
    this.fill_effective = fields.fill_effective;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return {
      from_zone: this.from_zone,
      to_zone: this.to_zone,
      fill_effective: this.fill_effective,
    };
  }
}

/** Velocity moved by more than the configured factor between turns. */
export class VelocityShift extends Event {
  static readonly EVENT_TYPE = "velocity_shift";

  readonly previous: number;
  readonly current: number;

  constructor(fields: EventInit & { previous: number; current: number }) {
    super(fields);
    this.previous = fields.previous;
    this.current = fields.current;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return { previous: this.previous, current: this.current };
  }
}

/**
 * A recorded turn carried a different model_id than the previous one.
 *
 * The Meter keeps gauging against its constructed profile; this event only
 * reports the switch so consumers can decide what it means for them.
 */
export class ModelChanged extends Event {
  static readonly EVENT_TYPE = "model_changed";

  readonly previous_model_id: string;
  readonly new_model_id: string;

  constructor(
    fields: EventInit & { previous_model_id: string; new_model_id: string }
  ) {
    super(fields);
    this.previous_model_id = fields.previous_model_id;
    this.new_model_id = fields.new_model_id;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return {
      previous_model_id: this.previous_model_id,
      new_model_id: this.new_model_id,
    };
  }
}

// ---------------------------------------------------------------------------
// advisor events

/** A policy was evaluated; carries the full recommendation. */
export class AdvisorRecommendation extends Event {
  static readonly EVENT_TYPE = "advisor_recommendation";

  readonly recommendation: Recommendation;

  constructor(fields: EventInit & { recommendation: Recommendation }) {
    super(fields);
    this.recommendation = fields.recommendation;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return { recommendation: this.recommendation.toDict() };
  }
}

// ---------------------------------------------------------------------------
// fidelity events

/** A handoff artifact was scored; carries the full fidelity report. */
export class HandoffEvaluated extends Event {
  static readonly EVENT_TYPE = "handoff_evaluated";

  readonly report: FidelityReport;

  constructor(fields: EventInit & { report: FidelityReport }) {
    super(fields);
    this.report = fields.report;
    Object.freeze(this);
  }

  payload(): Record<string, unknown> {
    return { report: this.report.toDict() };
  }
}

// ---------------------------------------------------------------------------
// wire reconstruction

type EnvelopeFields = Required<EventInit>;

const EVENT_FACTORIES: Record<
  string,
  (envelope: EnvelopeFields, payload: Record<string, unknown>) => Event
> = {
  [TurnRecorded.EVENT_TYPE]: (envelope, payload) =>
    new TurnRecorded({
      ...envelope,
      turn: TurnUsage.fromDict(payload["turn"] as Record<string, unknown>),
      state: MeterState.fromDict(payload["state"] as Record<string, unknown>),
    }),
  [ZoneChanged.EVENT_TYPE]: (envelope, payload) =>
    new ZoneChanged({
      ...envelope,
      from_zone: asZone(payload["from_zone"]),
      to_zone: asZone(payload["to_zone"]),
      fill_effective: asFloat(payload["fill_effective"], "fill_effective"),
    }),
  [VelocityShift.EVENT_TYPE]: (envelope, payload) =>
    new VelocityShift({
      ...envelope,
      previous: asFloat(payload["previous"], "previous"),
      current: asFloat(payload["current"], "current"),
    }),
  [ModelChanged.EVENT_TYPE]: (envelope, payload) =>
    new ModelChanged({
      ...envelope,
      previous_model_id: reqString(
        payload["previous_model_id"],
        "previous_model_id"
      ),
      new_model_id: reqString(payload["new_model_id"], "new_model_id"),
    }),
  [AdvisorRecommendation.EVENT_TYPE]: (envelope, payload) =>
    new AdvisorRecommendation({
      ...envelope,
      recommendation: Recommendation.fromDict(
        (payload["recommendation"] as Record<string, unknown>) ?? {}
      ),
    }),
  [HandoffEvaluated.EVENT_TYPE]: (envelope, payload) =>
    new HandoffEvaluated({
      ...envelope,
      report: FidelityReport.fromDict(
        (payload["report"] as Record<string, unknown>) ?? {}
      ),
    }),
};

/** Reconstruct a typed event from its wire dictionary. */
export function eventFromDict(dict: object): Event {
  const d = dict as Record<string, unknown>;
  const eventType = d["event_type"];
  const factory =
    typeof eventType === "string" ? EVENT_FACTORIES[eventType] : undefined;
  if (factory === undefined) {
    throw new RangeError(`Unknown event_type: '${String(eventType)}'`);
  }
  return factory(
    {
      turn_id: (d["turn_id"] ?? null) as number | null,
      timestamp: reqString(d["timestamp"], "timestamp"),
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    },
    (d["payload"] ?? {}) as Record<string, unknown>
  );
}
