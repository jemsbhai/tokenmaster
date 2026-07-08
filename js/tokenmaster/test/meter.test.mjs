// Mirrors python/tokenmaster/tests/test_meter.py.
//
// The EWMA reference sequence, alpha = 0.3, context totals 1000, 1300, 1650,
// 2100:
//
//   g2 = 300 -> mean = 300.0, var = 0.0
//   g3 = 350 -> diff = 50,  incr = 15.0,  mean = 315.0
//               var = 0.7 * (0 + 50 * 15.0) = 525.0
//   g4 = 450 -> diff = 135, incr = 40.5,  mean = 355.5
//               var = 0.7 * (525 + 135 * 40.5) = 4194.75
//
//   velocity = 355.5, velocity_std = sqrt(4194.75) = 64.76688...
//   headroom (nominal window 10000, reserve 0) = 10000 - 2100 = 7900
//   eta expected = 7900 / 355.5 = 22.22222...
//   eta conservative = 7900 / (355.5 + 64.76688) = 18.79285...
import test from "node:test";
import assert from "node:assert/strict";

import {
  Meter,
  Breakdown,
  CalibrationRecord,
  ModelProfile,
  TurnUsage,
  Zone,
} from "../dist/esm/index.js";

function profile({ window = 10_000, effective = null } = {}) {
  return new ModelProfile({
    model_id: "test:model",
    provider: "test",
    window_nominal: window,
    effective,
  });
}

/** A turn whose contextTotal equals `total` (all in input_tokens). */
function turnWithTotal(total) {
  return { input_tokens: total };
}

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("empty meter state", () => {
  const s = new Meter(profile()).state();
  assert.equal(s.turns, 0);
  assert.equal(s.used_tokens, 0);
  assert.equal(s.velocity, null);
  assert.equal(s.eta_turns, null);
  assert.equal(s.zone, Zone.GREEN);
  assert.match(s.provenance.velocity, /cold start/);
});

test("used_tokens is the latest context total, not a sum", () => {
  const m = new Meter(profile());
  m.record(turnWithTotal(1_000));
  m.record(turnWithTotal(1_300));
  assert.equal(m.state().used_tokens, 1_300);
});

test("cold start hides velocity until three turns", () => {
  const m = new Meter(profile());
  m.record(turnWithTotal(1_000));
  m.record(turnWithTotal(1_300));
  const s = m.state();
  assert.equal(s.turns, 2);
  assert.equal(s.velocity, null);
  assert.equal(s.eta_turns, null);
});

test("hand-computed EWMA velocity, std, and eta", () => {
  const m = new Meter(profile());
  for (const total of [1_000, 1_300, 1_650, 2_100]) {
    m.record(turnWithTotal(total));
  }
  const s = m.state();
  assertClose(s.velocity, 355.5);
  assertClose(s.velocity_std, Math.sqrt(4194.75));
  assert.equal(s.headroom_effective, 7_900);
  assertClose(s.eta_turns.expected, 7_900 / 355.5);
  assertClose(s.eta_turns.conservative, 7_900 / (355.5 + Math.sqrt(4194.75)));
  assert.match(s.provenance.velocity, /ewma alpha=0\.3/);
});

test("zero growth yields no eta with a reason", () => {
  const m = new Meter(profile());
  for (const total of [1_000, 1_000, 1_000]) {
    m.record(turnWithTotal(total));
  }
  const s = m.state();
  assertClose(s.velocity, 0.0);
  assert.equal(s.eta_turns, null);
  assert.match(s.provenance.eta_turns, /not positive/);
});

test("zone transitions on fill_effective", () => {
  const m = new Meter(profile({ window: 1_000 }));
  m.record(turnWithTotal(500));
  assert.equal(m.state().zone, Zone.GREEN);
  m.record(turnWithTotal(720));
  assert.equal(m.state().zone, Zone.CAUTION);
  m.record(turnWithTotal(860));
  assert.equal(m.state().zone, Zone.CRITICAL);
});

test("calibration shifts zones and headroom", () => {
  const cal = new CalibrationRecord({
    model_id: "test:model",
    effective_context: 800,
    method: "probe-kit",
    source: "local run",
  });
  const m = new Meter(profile({ window: 1_000, effective: cal }));
  m.record(turnWithTotal(700));
  const s = m.state();
  // 700 / 800 = 0.875 -> critical against effective capacity,
  // while 700 / 1000 = 0.70 would only be caution against nominal.
  assertClose(s.fill_effective, 0.875);
  assert.equal(s.zone, Zone.CRITICAL);
  assert.equal(s.headroom_effective, 100);
  assert.equal(s.headroom_nominal, 300);
});

test("reserved output subtracts from headroom", () => {
  const m = new Meter(profile({ window: 1_000 }), { reserved_output: 200 });
  m.record(turnWithTotal(300));
  const s = m.state();
  assert.equal(s.headroom_nominal, 500);
  assert.equal(s.headroom_effective, 500);
});

test("hidden overhead and cache come from the latest turn", () => {
  const m = new Meter(profile());
  m.record(
    new TurnUsage({
      turn_id: 1,
      input_tokens: 100,
      cache_read_tokens: 400,
      cache_write_tokens: 50,
      breakdown: new Breakdown({ system_prompt: 300, tool_schemas: 150 }),
    })
  );
  const s = m.state();
  assert.equal(s.hidden_overhead, 450);
  assert.equal(s.cache.stable_prefix_tokens, 450);
  assert.equal(s.cache.last_cache_read, 400);
  assert.equal(s.cache.last_cache_write, 50);
});

test("meter JSON round trip reproduces state", () => {
  const m = new Meter(profile(), { reserved_output: 100, alpha: 0.3 });
  for (const total of [1_000, 1_300, 1_650, 2_100]) {
    m.record(turnWithTotal(total));
  }
  const restored = Meter.fromJSON(JSON.stringify(m));
  assert.deepEqual(restored.state(), m.state());
});

test("record accepts a plain dict and fills identity", () => {
  const m = new Meter(profile());
  const stored = m.record({ input_tokens: 10, output_tokens: 5 });
  assert.equal(stored.turn_id, 1);
  assert.equal(stored.model_id, "test:model");
  assert.notEqual(stored.timestamp, null);
});

test("constructor validation", () => {
  assert.throws(() => new Meter(profile(), { alpha: 0.0 }), RangeError);
  assert.throws(
    () => new Meter(profile(), { caution: 0.9, critical: 0.8 }),
    RangeError
  );
  assert.throws(() => new Meter(profile(), { reserved_output: -1 }), RangeError);
  assert.throws(
    () => new Meter(profile(), { velocity_shift_factor: 1.0 }),
    RangeError
  );
});

test("exhausted headroom yields no eta with a reason", () => {
  const m = new Meter(profile({ window: 1_000 }));
  for (const total of [400, 700, 1_100]) {
    m.record(turnWithTotal(total));
  }
  const s = m.state();
  assert.notEqual(s.velocity, null);
  assert.equal(s.eta_turns, null);
  assert.match(s.provenance.eta_turns, /exhausted/);
  assert.ok(s.fill_effective > 1.0);
  assert.equal(s.zone, Zone.CRITICAL);
});
