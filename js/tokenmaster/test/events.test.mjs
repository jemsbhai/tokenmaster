// Wire-level tests for the event envelope and the four meter-emitted events.
// The emission-behavior tests from python/tokenmaster/tests/test_events.py
// (zone crossings, velocity shifts, ordering, subscribe/unsubscribe) require
// the Meter and join this file in the meter step.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  Zone,
  TurnUsage,
  MeterState,
  TurnRecorded,
  ZoneChanged,
  VelocityShift,
  ModelChanged,
  eventFromDict,
} from "../dist/esm/index.js";

function makeState() {
  return new MeterState({
    model_id: "test:model",
    turns: 1,
    used_tokens: 500,
    window_nominal: 10_000,
    window_effective: 10_000,
    effective_source: "nominal (uncalibrated)",
    reserved_output: 0,
    headroom_nominal: 9_500,
    headroom_effective: 9_500,
    fill_nominal: 0.05,
    fill_effective: 0.05,
    velocity: null,
    velocity_std: null,
    eta_turns: null,
    zone: Zone.GREEN,
    hidden_overhead: null,
    cache: null,
    provenance: { used_tokens: "reported" },
  });
}

function sampleEvents() {
  const turn = new TurnUsage({ turn_id: 1, input_tokens: 500 });
  return [
    new TurnRecorded({ turn_id: 1, turn, state: makeState() }),
    new ZoneChanged({
      turn_id: 2,
      from_zone: Zone.GREEN,
      to_zone: Zone.CAUTION,
      fill_effective: 0.7,
    }),
    new VelocityShift({ turn_id: 5, previous: 100.0, current: 220.0 }),
    new ModelChanged({
      turn_id: 2,
      previous_model_id: "test:model",
      new_model_id: "test:other-model",
    }),
  ];
}

test("envelope defaults: null turn_id, generated timestamp, schema version", () => {
  const ev = new VelocityShift({ previous: 100.0, current: 220.0 });
  assert.equal(ev.turn_id, null);
  assert.equal(ev.schema_version, SCHEMA_VERSION);
  assert.equal(ev.event_type, "velocity_shift");
  assert.equal(Number.isNaN(Date.parse(ev.timestamp)), false);
});

test("turn recorded carries the turn and the resulting state in its payload", () => {
  const turn = new TurnUsage({ turn_id: 1, input_tokens: 500 });
  const state = makeState();
  const dict = new TurnRecorded({ turn_id: 1, turn, state }).toDict();
  assert.equal(dict.event_type, "turn_recorded");
  assert.equal(dict.turn_id, 1);
  assert.deepEqual(dict.payload.turn, turn.toDict());
  assert.deepEqual(dict.payload.state, state.toDict());
});

test("zone changed payload carries the crossing essentials", () => {
  const dict = new ZoneChanged({
    turn_id: 2,
    from_zone: Zone.GREEN,
    to_zone: Zone.CAUTION,
    fill_effective: 0.7,
  }).toDict();
  assert.deepEqual(dict.payload, {
    from_zone: "green",
    to_zone: "caution",
    fill_effective: 0.7,
  });
});

test("model changed payload carries both model ids", () => {
  const dict = new ModelChanged({
    turn_id: 2,
    previous_model_id: "test:model",
    new_model_id: "test:other-model",
  }).toDict();
  assert.deepEqual(dict.payload, {
    previous_model_id: "test:model",
    new_model_id: "test:other-model",
  });
});

test("event wire round trip for every implemented type", () => {
  for (const ev of sampleEvents()) {
    const back = eventFromDict(ev.toDict());
    assert.deepEqual(back, ev);
    assert.equal(back.constructor, ev.constructor);
  }
});

test("unknown event_type is rejected with the reference message", () => {
  assert.throws(
    () =>
      eventFromDict({
        event_type: "bogus",
        timestamp: "2026-07-08T00:00:00Z",
      }),
    { name: "RangeError", message: "Unknown event_type: 'bogus'" }
  );
});

test("toJSON returns the plain object so JSON.stringify serializes directly", () => {
  for (const ev of sampleEvents()) {
    assert.deepEqual(JSON.parse(JSON.stringify(ev)), JSON.parse(JSON.stringify(ev.toDict())));
  }
});

test("event instances are frozen after construction", () => {
  const ev = new VelocityShift({ previous: 100.0, current: 220.0 });
  assert.throws(() => {
    ev.previous = 999;
  }, TypeError);
});
