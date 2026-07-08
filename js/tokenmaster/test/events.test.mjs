// Mirrors python/tokenmaster/tests/test_events.py: wire-level tests for the
// envelope plus emission rules, ordering, delivery, and round trips driven
// through the Meter.
//
// VelocityShift reference numbers, alpha = 0.3, factor = 1.5, context totals
// 1000, 1100, 1200, 1300, 1800:
//
//   g = 100, 100, 100 -> mean stays 100.0 (velocity exposed from turn 3)
//   g5 = 500 -> diff = 400, incr = 120, mean = 220.0
//   ratio 220 / 100 = 2.2 >= 1.5 -> VelocityShift(previous=100, current=220)
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  Zone,
  TurnUsage,
  MeterState,
  ModelProfile,
  Meter,
  TurnRecorded,
  ZoneChanged,
  VelocityShift,
  ModelChanged,
  eventFromDict,
} from "../dist/esm/index.js";

function profile(window = 10_000) {
  return new ModelProfile({
    model_id: "test:model",
    provider: "test",
    window_nominal: window,
  });
}

function collect(meter) {
  const seen = [];
  meter.subscribe((event) => seen.push(event));
  return seen;
}

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

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

// ---------------------------------------------------------------------------
// wire level

test("envelope defaults: null turn_id, generated timestamp, schema version", () => {
  const ev = new VelocityShift({ previous: 100.0, current: 220.0 });
  assert.equal(ev.turn_id, null);
  assert.equal(ev.schema_version, SCHEMA_VERSION);
  assert.equal(ev.event_type, "velocity_shift");
  assert.equal(Number.isNaN(Date.parse(ev.timestamp)), false);
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
    assert.deepEqual(
      JSON.parse(JSON.stringify(ev)),
      JSON.parse(JSON.stringify(ev.toDict()))
    );
  }
});

test("event instances are frozen after construction", () => {
  const ev = new VelocityShift({ previous: 100.0, current: 220.0 });
  assert.throws(() => {
    ev.previous = 999;
  }, TypeError);
});

// ---------------------------------------------------------------------------
// emission through the Meter

test("turn recorded carries the turn and the resulting state", () => {
  const m = new Meter(profile());
  const seen = collect(m);
  m.record({ input_tokens: 500 });
  assert.equal(seen.length, 1);
  const ev = seen[0];
  assert.ok(ev instanceof TurnRecorded);
  assert.equal(ev.turn_id, 1);
  assert.equal(ev.turn.input_tokens, 500);
  assert.deepEqual(ev.state, m.state());
});

test("zone changed emitted only on crossing", () => {
  const m = new Meter(profile(1_000));
  const seen = collect(m);
  m.record({ input_tokens: 500 }); // green, no crossing
  m.record({ input_tokens: 720 }); // green -> caution
  m.record({ input_tokens: 730 }); // still caution, no event
  m.record({ input_tokens: 860 }); // caution -> critical
  const zoneEvents = seen.filter((e) => e instanceof ZoneChanged);
  assert.deepEqual(
    zoneEvents.map((e) => [e.from_zone, e.to_zone]),
    [
      [Zone.GREEN, Zone.CAUTION],
      [Zone.CAUTION, Zone.CRITICAL],
    ]
  );
  assert.equal(zoneEvents[0].turn_id, 2);
  assert.equal(zoneEvents[1].turn_id, 4);
});

test("velocity shift on factor breach", () => {
  const m = new Meter(profile(100_000));
  const seen = collect(m);
  for (const total of [1_000, 1_100, 1_200, 1_300, 1_800]) {
    m.record({ input_tokens: total });
  }
  const shifts = seen.filter((e) => e instanceof VelocityShift);
  assert.equal(shifts.length, 1);
  assertClose(shifts[0].previous, 100.0);
  assertClose(shifts[0].current, 220.0);
  assert.equal(shifts[0].turn_id, 5);
});

test("no velocity shift on steady growth", () => {
  const m = new Meter(profile(100_000));
  const seen = collect(m);
  for (const total of [1_000, 1_100, 1_200, 1_300, 1_400, 1_500]) {
    m.record({ input_tokens: total });
  }
  assert.equal(seen.filter((e) => e instanceof VelocityShift).length, 0);
});

test("model changed on mid-conversation switch", () => {
  const m = new Meter(profile());
  const seen = collect(m);
  m.record({ input_tokens: 100 });
  m.record({ input_tokens: 200, model_id: "test:other-model" });
  m.record({ input_tokens: 300, model_id: "test:other-model" });
  const switches = seen.filter((e) => e instanceof ModelChanged);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].previous_model_id, "test:model");
  assert.equal(switches[0].new_model_id, "test:other-model");
  assert.equal(switches[0].turn_id, 2);
});

test("event order is deterministic", () => {
  const m = new Meter(profile(1_000));
  const seen = collect(m);
  m.record({ input_tokens: 500 });
  m.record({ input_tokens: 900, model_id: "test:other-model" });
  const secondTurn = seen.filter((e) => e.turn_id === 2);
  assert.deepEqual(
    secondTurn.map((e) => e.constructor),
    [TurnRecorded, ZoneChanged, ModelChanged]
  );
});

test("unsubscribe stops delivery", () => {
  const m = new Meter(profile());
  const seen = [];
  const unsubscribe = m.subscribe((event) => seen.push(event));
  m.record({ input_tokens: 100 });
  unsubscribe();
  m.record({ input_tokens: 200 });
  assert.equal(seen.length, 1);
});

test("events() replays all in order", () => {
  const m = new Meter(profile(1_000));
  m.record({ input_tokens: 500 });
  m.record({ input_tokens: 720 });
  const log = m.events();
  assert.deepEqual(
    log.map((e) => e.constructor),
    [TurnRecorded, TurnRecorded, ZoneChanged]
  );
});

test("subscriber exceptions propagate", () => {
  const m = new Meter(profile());
  m.subscribe(() => {
    throw new Error("visualizer bug");
  });
  assert.throws(() => m.record({ input_tokens: 100 }), {
    message: "visualizer bug",
  });
});
