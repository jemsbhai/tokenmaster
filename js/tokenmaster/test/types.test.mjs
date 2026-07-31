// Mirrors python/tokenmaster/tests/test_types.py, plus JS-specific checks:
// explicit nulls in serialized output, the toJSON convention, Python
// dict-truthiness parity at fromDict boundaries, and frozen instances.
import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  Zone,
  UsageSource,
  asZone,
  Pricing,
  PricingScope,
  PricingTier,
  PricingSchedule,
  CostEstimate,
  CostQuote,
  LimitCheck,
  CalibrationRecord,
  ModelProfile,
  Breakdown,
  TurnUsage,
  EtaEstimate,
  CacheState,
  MeterState,
} from "../dist/esm/index.js";

function makeProfile(overrides = {}) {
  return new ModelProfile({
    model_id: "test:model",
    provider: "test",
    window_nominal: 10_000,
    max_output: 1_000,
    pricing: new Pricing({
      input: 3.0,
      output: 15.0,
      cache_read: 0.3,
      cache_write: 3.75,
      as_of: "2026-07-07",
    }),
    ...overrides,
  });
}

function makeState(overrides = {}) {
  return new MeterState({
    model_id: "test:model",
    turns: 2,
    used_tokens: 400,
    window_nominal: 10_000,
    window_effective: 8_000,
    effective_source: "nominal (uncalibrated)",
    reserved_output: 0,
    headroom_nominal: 9_600,
    headroom_effective: 7_600,
    fill_nominal: 0.04,
    fill_effective: 0.05,
    velocity: null,
    velocity_std: null,
    eta_turns: null,
    zone: Zone.GREEN,
    hidden_overhead: null,
    cache: null,
    provenance: { velocity: "unavailable (cold start, needs 3 turns)" },
    ...overrides,
  });
}

test("context total sums all five categories", () => {
  const turn = new TurnUsage({
    turn_id: 1,
    input_tokens: 100,
    cache_read_tokens: 200,
    cache_write_tokens: 50,
    output_tokens: 30,
    reasoning_tokens: 20,
  });
  assert.equal(turn.contextTotal(), 400);
});

test("turn usage rejects negative counts", () => {
  assert.throws(() => new TurnUsage({ turn_id: 1, input_tokens: -1 }), {
    name: "RangeError",
    message: "input_tokens must be non-negative",
  });
});

test("turn usage fromDict ignores unknown keys and defaults missing", () => {
  const turn = TurnUsage.fromDict(
    { input_tokens: 10, provider_specific_junk: 999 },
    1
  );
  assert.equal(turn.turn_id, 1);
  assert.equal(turn.input_tokens, 10);
  assert.equal(turn.output_tokens, 0);
  assert.equal(turn.source, UsageSource.REPORTED);
  assert.equal("provider_specific_junk" in turn, false);
});

test("turn usage fromDict turnId argument overrides an embedded turn_id", () => {
  const turn = TurnUsage.fromDict({ turn_id: 9, input_tokens: 1 }, 2);
  assert.equal(turn.turn_id, 2);
});

test("turn usage round trip", () => {
  const turn = new TurnUsage({
    turn_id: 3,
    input_tokens: 10,
    output_tokens: 5,
    breakdown: new Breakdown({ system_prompt: 4, tool_schemas: 2 }),
    source: UsageSource.MIXED,
    raw: { anything: 1 },
  });
  const back = TurnUsage.fromDict(turn.toDict());
  assert.deepEqual(back, turn);
});

test("turn usage fromDict copies raw instead of holding the caller's object", () => {
  const raw = { a: 1 };
  const turn = TurnUsage.fromDict({ turn_id: 1, raw });
  raw.a = 2;
  assert.equal(turn.raw.a, 1);
});

test("empty breakdown dict maps to null (Python dict-truthiness parity)", () => {
  const turn = TurnUsage.fromDict({ turn_id: 1, breakdown: {} });
  assert.equal(turn.breakdown, null);
});

test("profile effective defaults to nominal with honest provenance", () => {
  const profile = makeProfile();
  assert.equal(profile.window_effective, 10_000);
  assert.equal(profile.effective_source, "nominal (uncalibrated)");
});

test("profile calibration overrides effective", () => {
  const cal = new CalibrationRecord({
    model_id: "test:model",
    effective_context: 8_000,
    method: "probe-kit",
    source: "local run",
    measured_at: "2026-07-01",
  });
  const profile = makeProfile({ effective: cal });
  assert.equal(profile.window_effective, 8_000);
  assert.equal(profile.effective_source, "calibration:probe-kit (local run)");
});

test("profile round trip with nested types", () => {
  const cal = new CalibrationRecord({
    model_id: "test:model",
    effective_context: 8_000,
    method: "probe-kit",
    source: "local run",
  });
  const profile = makeProfile({ effective: cal });
  const back = ModelProfile.fromDict(profile.toDict());
  assert.deepEqual(back, profile);
});

test("profile rejects nonpositive window", () => {
  assert.throws(() => makeProfile({ window_nominal: 0 }), {
    name: "RangeError",
    message: "window_nominal must be positive",
  });
});

test("profile rejects nonpositive calibrated effective context", () => {
  const cal = new CalibrationRecord({
    model_id: "test:model",
    effective_context: 0,
    method: "probe-kit",
    source: "local run",
  });
  assert.throws(() => makeProfile({ effective: cal }), {
    name: "RangeError",
    message: "effective_context must be positive",
  });
});

test("pricing defaults and round trip", () => {
  const pricing = new Pricing({ input: 3.0, output: 15.0 });
  assert.equal(pricing.cache_read, 0.0);
  assert.equal(pricing.cache_write, 0.0);
  assert.equal(pricing.currency, "USD");
  assert.equal(pricing.as_of, null);
  assert.deepEqual(Pricing.fromDict(pricing.toDict()), pricing);
});

test("tiered pricing types round trip and use inclusive thresholds", () => {
  const base = new Pricing({ input: 5, output: 30, cache_read: 0.5, cache_write: 6.25 });
  const long = new Pricing({ input: 10, output: 45, cache_read: 1, cache_write: 12.5 });
  const schedule = new PricingSchedule({
    base,
    tiers: [new PricingTier({ min_input_tokens: 272_001, pricing: long })],
    scope: new PricingScope({
      service_tier: "standard",
      region: "global",
      basis: "request_input_tokens",
    }),
  });

  assert.equal(schedule.resolve(272_000).pricing, base);
  assert.equal(schedule.resolve(272_000).tier_min_input_tokens, null);
  assert.equal(schedule.resolve(272_001).pricing, long);
  assert.equal(schedule.resolve(272_001).tier_min_input_tokens, 272_001);
  assert.deepEqual(PricingSchedule.fromDict(schedule.toDict()), schedule);
  assert.equal(
    Object.hasOwn(schedule.scope.toDict(), "unpriced_usage_categories"),
    false
  );
  assert.ok(Object.isFrozen(schedule));
  assert.ok(Object.isFrozen(schedule.tiers));
});

test("pricing scope preserves unpriced categories and omits an empty marker", () => {
  const scope = new PricingScope({
    unpriced_usage_categories: ["cache_write_tokens"],
  });
  assert.deepEqual(scope.toDict(), {
    service_tier: "standard",
    region: "global",
    basis: "request_input_tokens",
    unpriced_usage_categories: ["cache_write_tokens"],
  });
  assert.deepEqual(PricingScope.fromDict(scope.toDict()), scope);
  assert.ok(Object.isFrozen(scope.unpriced_usage_categories));

  assert.throws(
    () =>
      new PricingScope({
        unpriced_usage_categories: ["cache_write_tokens", "cache_write_tokens"],
      }),
    /duplicate unpriced usage category/
  );
  assert.throws(
    () => new PricingScope({ unpriced_usage_categories: ["token_hours"] }),
    /unsupported unpriced usage category/
  );
  assert.throws(
    () => PricingScope.fromDict({ unpriced_usage_categories: "cache_write_tokens" }),
    /must be an array/
  );
});

test("pricing schedules reject duplicate thresholds and mixed currencies", () => {
  const usd = new Pricing({ input: 1, output: 2 });
  const eur = new Pricing({ input: 1, output: 2, currency: "EUR" });
  assert.throws(
    () => new PricingSchedule({
      base: usd,
      tiers: [
        new PricingTier({ min_input_tokens: 10, pricing: usd }),
        new PricingTier({ min_input_tokens: 10, pricing: usd }),
      ],
    }),
    /thresholds must be unique/
  );
  assert.throws(
    () => new PricingSchedule({
      base: usd,
      tiers: [new PricingTier({ min_input_tokens: 10, pricing: eur })],
    }),
    /currencies must match/
  );
  assert.throws(
    () => new PricingSchedule({
      base: usd,
      scope: new PricingScope({ basis: "total_tokens" }),
    }),
    /unsupported pricing scope basis/
  );
  assert.throws(
    () => PricingSchedule.fromDict({ base: usd.toDict(), tiers: null }),
    /tiers must be an array/
  );
  assert.throws(
    () => PricingSchedule.fromDict({ base: usd.toDict(), scope: null }),
    /scope must be an object/
  );
});

test("cost quote and limit check preserve their wire shapes", () => {
  const pricing = new Pricing({ input: 5, output: 30 });
  const quote = new CostQuote({
    model_id: "openai:gpt-test",
    tier_basis_tokens: 100,
    tier_min_input_tokens: null,
    pricing,
    input_cost: 0.0005,
    cache_read_cost: 0,
    cache_write_cost: 0,
    output_cost: 0.0003,
    reasoning_cost: 0.0006,
    total_cost: 0.0014,
    currency: "USD",
    as_of: null,
    source: "test",
  });
  const quoteDict = quote.toDict();
  assert.deepEqual(Object.keys(quoteDict).sort(), [
    "as_of",
    "cache_read_cost",
    "cache_write_cost",
    "currency",
    "input_cost",
    "model_id",
    "output_cost",
    "pricing",
    "reasoning_cost",
    "source",
    "tier_basis_tokens",
    "tier_min_input_tokens",
    "total_cost",
  ]);
  assert.deepEqual(CostQuote.fromDict(quoteDict), quote);

  const check = new LimitCheck({
    model_id: "openai:gpt-test",
    capacity_kind: "nominal",
    capacity: 1_000,
    input_tokens: 900,
    requested_output_tokens: 200,
    reserved_output_tokens: 0,
    context_output_tokens: 200,
    context_tokens: 1_100,
    max_input_tokens: 800,
    max_output_tokens: 200,
    input_exceeded: true,
    context_exceeded: true,
    output_exceeded: false,
    allowed: false,
    violations: ["input_tokens", "context_tokens"],
  });
  const checkDict = check.toDict();
  assert.deepEqual(Object.keys(checkDict).sort(), [
    "allowed",
    "capacity",
    "capacity_kind",
    "context_exceeded",
    "context_output_tokens",
    "context_tokens",
    "input_exceeded",
    "input_tokens",
    "max_input_tokens",
    "max_output_tokens",
    "model_id",
    "output_exceeded",
    "requested_output_tokens",
    "reserved_output_tokens",
    "violations",
  ]);
  assert.deepEqual(LimitCheck.fromDict(checkDict), check);
  assert.ok(Object.isFrozen(check.violations));
});

test("cost estimate preserves its exact wire shape and assumptions", () => {
  const pricing = new Pricing({
    input: 5,
    output: 30,
    cache_read: 0.5,
    cache_write: 6.25,
    as_of: "2026-07-31",
  });
  const estimate = new CostEstimate({
    model_id: "openai:gpt-test",
    tier_basis_tokens: 272_000,
    tier_min_input_tokens: null,
    pricing,
    input_tokens: 272_000,
    reserved_output_tokens: 1_000,
    input_rate_kind: "cache_write",
    input_rate: 6.25,
    output_rate: 30,
    input_cost: 1.7,
    output_cost: 0.03,
    total_cost: 1.73,
    currency: "USD",
    as_of: "2026-07-31",
    source: "test",
    conservative: true,
    assumptions: [
      "estimated input uses the highest selected-tier input-category rate",
      "reserved output uses the selected-tier output rate",
    ],
  });
  const dict = estimate.toDict();
  assert.deepEqual(Object.keys(dict).sort(), [
    "as_of",
    "assumptions",
    "conservative",
    "currency",
    "input_cost",
    "input_rate",
    "input_rate_kind",
    "input_tokens",
    "model_id",
    "output_cost",
    "output_rate",
    "pricing",
    "reserved_output_tokens",
    "source",
    "tier_basis_tokens",
    "tier_min_input_tokens",
    "total_cost",
  ]);
  assert.deepEqual(CostEstimate.fromDict(dict), estimate);
  assert.ok(Object.isFrozen(estimate));
  assert.ok(Object.isFrozen(estimate.assumptions));
});

test("breakdown defaults to zeros and round trips", () => {
  const breakdown = new Breakdown();
  assert.deepEqual(breakdown.toDict(), {
    system_prompt: 0,
    tool_schemas: 0,
    history: 0,
    attachments: 0,
    query: 0,
  });
  const full = new Breakdown({ system_prompt: 4, query: 7 });
  assert.deepEqual(Breakdown.fromDict(full.toDict()), full);
});

test("eta estimate and cache state round trip", () => {
  const eta = new EtaEstimate({ expected: 26.5, conservative: 24.7 });
  assert.deepEqual(EtaEstimate.fromDict(eta.toDict()), eta);
  const cache = new CacheState({
    stable_prefix_tokens: 900,
    last_cache_read: 800,
    last_cache_write: 100,
  });
  assert.deepEqual(CacheState.fromDict(cache.toDict()), cache);
});

test("meter state round trip via dict", () => {
  const state = makeState();
  const back = MeterState.fromDict(state.toDict());
  assert.deepEqual(back, state);
  assert.equal(back.schema_version, SCHEMA_VERSION);
});

test("meter state round trip with populated eta and cache", () => {
  const state = makeState({
    velocity: 355.5,
    velocity_std: 64.7,
    eta_turns: new EtaEstimate({ expected: 22.2, conservative: 18.7 }),
    zone: Zone.CAUTION,
    cache: new CacheState({
      stable_prefix_tokens: 900,
      last_cache_read: 800,
      last_cache_write: 100,
    }),
  });
  const back = MeterState.fromDict(state.toDict());
  assert.deepEqual(back, state);
});

test("serialized state carries explicit nulls, never omitted keys", () => {
  const dict = makeState().toDict();
  for (const key of ["velocity", "velocity_std", "eta_turns", "hidden_overhead", "cache"]) {
    assert.equal(Object.hasOwn(dict, key), true, `missing key: ${key}`);
    assert.equal(dict[key], null, `expected null for: ${key}`);
  }
  assert.match(JSON.stringify(dict), /"velocity":null/);
});

test("toJSON returns the plain object so JSON.stringify serializes directly", () => {
  const state = makeState();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state.toDict());
});

test("asZone rejects invalid values with the reference message", () => {
  assert.throws(() => asZone("purple"), {
    name: "RangeError",
    message: "'purple' is not a valid Zone",
  });
});

test("instances are frozen after construction", () => {
  const pricing = new Pricing({ input: 3.0, output: 15.0 });
  assert.throws(() => {
    pricing.currency = "EUR";
  }, TypeError);
});
