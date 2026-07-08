// Conformance: replay every committed vector and match states and events.
//
// JS mirror of python/tokenmaster/tests/test_vectors.py; spec/README.md
// defines the normative comparison rules: timestamps excluded everywhere,
// floats within 1e-9 (math.isclose semantics, rel and abs), provenance
// strings character for character, and every turn_recorded payload must
// structurally equal the recorded turn and resulting state.
//
// One JSON-boundary note: the reference applies isclose only where the
// expected value parsed as a Python float. JSON's int/float distinction is
// invisible after JS parsing, so integer-valued expectations here compare
// strictly instead. That is equal to or stricter than the reference, and
// the port satisfies it by computing bit-identical doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  Meter,
  ModelProfile,
  TurnUsage,
  TurnRecorded,
  ZoneChanged,
  VelocityShift,
  ModelChanged,
} from "../dist/esm/index.js";

const VECTORS_DIR = fileURLToPath(
  new URL("../../../spec/vectors/", import.meta.url)
);
const SKIP_KEYS = new Set(["timestamp"]);
const FLOAT_TOL = 1e-9;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertMatches(actual, expected, atPath) {
  if (isPlainObject(expected)) {
    assert.ok(isPlainObject(actual), `${atPath}: expected dict`);
    for (const [key, value] of Object.entries(expected)) {
      if (SKIP_KEYS.has(key)) {
        continue;
      }
      assert.ok(key in actual, `${atPath}.${key}: missing`);
      assertMatches(actual[key], value, `${atPath}.${key}`);
    }
    const extra = Object.keys(actual).filter(
      (key) => !(key in expected) && !SKIP_KEYS.has(key)
    );
    assert.ok(
      extra.length === 0,
      `${atPath}: unexpected keys ${extra.join(", ")}`
    );
  } else if (Array.isArray(expected)) {
    assert.ok(
      Array.isArray(actual) && actual.length === expected.length,
      `${atPath}: length ${Array.isArray(actual) ? actual.length : "n/a"} != ${expected.length}`
    );
    for (let i = 0; i < expected.length; i++) {
      assertMatches(actual[i], expected[i], `${atPath}[${i}]`);
    }
  } else if (typeof expected === "number" && !Number.isInteger(expected)) {
    assert.ok(typeof actual === "number", `${atPath}: expected number`);
    const close =
      Math.abs(actual - expected) <=
      Math.max(
        FLOAT_TOL * Math.max(Math.abs(actual), Math.abs(expected)),
        FLOAT_TOL
      );
    assert.ok(close, `${atPath}: ${actual} != ${expected}`);
  } else {
    assert.ok(
      actual === expected,
      `${atPath}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
    );
  }
}

function slimEvent(event) {
  const entry = { event_type: event.event_type, turn_id: event.turn_id };
  if (event instanceof ZoneChanged) {
    entry.from_zone = event.from_zone;
    entry.to_zone = event.to_zone;
    entry.fill_effective = event.fill_effective;
  } else if (event instanceof VelocityShift) {
    entry.previous = event.previous;
    entry.current = event.current;
  } else if (event instanceof ModelChanged) {
    entry.previous_model_id = event.previous_model_id;
    entry.new_model_id = event.new_model_id;
  }
  return entry;
}

const vectorFiles = readdirSync(VECTORS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

assert.ok(
  vectorFiles.length > 0,
  "no committed vectors; run spec/generate_vectors.py"
);

for (const name of vectorFiles) {
  const stem = name.replace(/\.json$/, "");
  test(`vector conformance: ${stem}`, () => {
    const vector = JSON.parse(
      readFileSync(path.join(VECTORS_DIR, name), "utf8")
    );
    const meter = new Meter(ModelProfile.fromDict(vector.profile), {
      reserved_output: vector.config.reserved_output,
      alpha: vector.config.alpha,
      caution: vector.config.caution,
      critical: vector.config.critical,
      velocity_shift_factor: vector.config.velocity_shift_factor,
    });
    const events = [];
    meter.subscribe((event) => events.push(event));

    const states = [];
    for (const turnDict of vector.turns) {
      const turn = TurnUsage.fromDict(turnDict);
      const recorded = meter.record(turn);
      // structural rule for turn_recorded payloads
      const turnRecordedEvents = events.filter(
        (e) => e instanceof TurnRecorded
      );
      const latest = turnRecordedEvents[turnRecordedEvents.length - 1];
      assert.deepEqual(latest.turn, recorded);
      assert.deepEqual(latest.state, meter.state());
      states.push(meter.state().toDict());
    }

    assertMatches(states, vector.expected.states, "states");
    assertMatches(events.map(slimEvent), vector.expected.events, "events");
  });
}
