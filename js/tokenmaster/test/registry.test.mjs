// Mirrors python/tokenmaster/tests/test_registry.py, plus the R4 sync test
// pinning the embedded snapshot to the canonical Python models.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  Meter,
  ModelProfile,
  Registry,
  UnknownModelError,
  defaultRegistry,
} from "../dist/esm/index.js";
import { MODELS_DATA } from "../dist/esm/models-data.js";

const CANONICAL_MODELS_JSON = new URL(
  "../../../python/tokenmaster/src/tokenmaster/data/models.json",
  import.meta.url
);

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("embedded snapshot is JSON-equal to the canonical Python models.json", () => {
  const canonical = JSON.parse(readFileSync(CANONICAL_MODELS_JSON, "utf8"));
  assert.deepEqual(MODELS_DATA, canonical);
});

test("bundled snapshot integrity", () => {
  const reg = defaultRegistry();
  assert.notEqual(reg.snapshot_date, null);
  assert.ok(reg.profiles.length >= 10);
  for (const profile of reg.profiles) {
    assert.ok(profile.window_nominal > 0);
    assert.ok(profile.model_id.includes(":"));
    if (profile.pricing !== null) {
      assert.notEqual(profile.pricing.as_of, null);
      assert.ok(profile.pricing.input > 0);
      assert.ok(profile.pricing.output > 0);
    }
  }
});

test("lookup canonical id", () => {
  const p = defaultRegistry().get("anthropic:claude-sonnet-4-6");
  assert.equal(p.window_nominal, 1_000_000);
  assert.equal(p.pricing.input, 3.0);
});

test("lookup bare name", () => {
  const p = defaultRegistry().get("claude-haiku-4-5");
  assert.equal(p.model_id, "anthropic:claude-haiku-4-5");
  assert.equal(p.window_nominal, 200_000);
});

test("lookup is case-insensitive", () => {
  const p = defaultRegistry().get("Anthropic:Claude-Fable-5");
  assert.equal(p.model_id, "anthropic:claude-fable-5");
});

test("lookup dated snapshot suffix", () => {
  const p = defaultRegistry().get("claude-haiku-4-5-20251001");
  assert.equal(p.model_id, "anthropic:claude-haiku-4-5");
  const q = defaultRegistry().get("openai:gpt-5.5-2026-04-14");
  assert.equal(q.model_id, "openai:gpt-5.5");
});

test("lookup alias", () => {
  const p = defaultRegistry().get("gemini-3.1-pro-preview");
  assert.equal(p.model_id, "google:gemini-3.1-pro");
});

test("unknown model raises with suggestions", () => {
  assert.throws(
    () => defaultRegistry().get("claude-sonet-4-6"),
    (error) =>
      error instanceof UnknownModelError &&
      error.message.includes("claude-sonnet-4-6")
  );
});

test("register override wins without touching the default registry", () => {
  const reg = Registry.bundled();
  const custom = new ModelProfile({
    model_id: "anthropic:claude-haiku-4-5",
    provider: "anthropic",
    window_nominal: 123_456,
    source: "user override",
  });
  reg.register(custom);
  assert.equal(reg.get("claude-haiku-4-5").window_nominal, 123_456);
  // the process-wide default registry is untouched
  assert.equal(
    defaultRegistry().get("claude-haiku-4-5").window_nominal,
    200_000
  );
});

test("forModel end to end", () => {
  const m = Meter.forModel("claude-haiku-4-5");
  m.record({ input_tokens: 50_000 });
  const s = m.state();
  assert.equal(s.window_nominal, 200_000);
  assertClose(s.fill_nominal, 0.25);
  assert.equal(s.model_id, "anthropic:claude-haiku-4-5");
});
