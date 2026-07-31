// Mirrors python/tokenmaster/tests/test_registry.py, plus the R4 sync test
// pinning the embedded snapshot to the canonical Python models.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  Meter,
  CalibrationRecord,
  ModelProfile,
  Pricing,
  PricingSchedule,
  PricingScope,
  PricingTier,
  Registry,
  UnknownModelError,
  checkRequestLimits,
  defaultRegistry,
  getProfile,
  getPricingSchedule,
  quoteEstimate,
  quoteUsage,
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
  assert.equal(getProfile("gemini-3.1-pro-preview-customtools"), p);
  assert.equal(getProfile("google:gemini-3.1-pro-preview-customtools"), p);
});

test("GPT-5.6 family profiles and aliases", () => {
  const sol = getProfile("openai:gpt-5.6-sol");
  for (const modelId of [
    "gpt-5.6-sol",
    "openai:gpt-5.6",
    "gpt-5.6",
  ]) {
    assert.equal(getProfile(modelId), sol);
  }
  assert.equal(sol.window_nominal, 1_050_000);
  assert.equal(sol.max_output, 128_000);
  assert.equal(sol.pricing.input, 5.0);
  assert.equal(sol.pricing.cache_read, 0.5);
  assert.equal(sol.pricing.cache_write, 6.25);
  assert.equal(sol.pricing.output, 30.0);
  assert.equal(sol.pricing.as_of, "2026-07-31");
  assert.ok(sol.source.includes("/gpt-5.6-sol"));

  const terra = getProfile("gpt-5.6-terra");
  assert.equal(terra.model_id, "openai:gpt-5.6-terra");
  assert.equal(terra.window_nominal, 1_050_000);
  assert.equal(terra.max_output, 128_000);
  assert.equal(terra.pricing.input, 2.0);
  assert.equal(terra.pricing.cache_read, 0.2);
  assert.equal(terra.pricing.cache_write, 2.5);
  assert.equal(terra.pricing.output, 12.0);
  assert.equal(terra.pricing.as_of, "2026-07-31");
  assert.ok(terra.source.includes("/gpt-5.6-terra"));
  const terraSchedule = getPricingSchedule("gpt-5.6-terra");
  assert.equal(terraSchedule.tiers[0].min_input_tokens, 272_001);
  assert.equal(terraSchedule.tiers[0].pricing.input, 4.0);
  assert.equal(terraSchedule.tiers[0].pricing.cache_read, 0.4);
  assert.equal(terraSchedule.tiers[0].pricing.cache_write, 5.0);
  assert.equal(terraSchedule.tiers[0].pricing.output, 18.0);

  const luna = getProfile("gpt-5.6-luna");
  assert.equal(luna.model_id, "openai:gpt-5.6-luna");
  assert.equal(luna.window_nominal, 1_050_000);
  assert.equal(luna.max_output, 128_000);
  assert.equal(luna.pricing.input, 0.2);
  assert.equal(luna.pricing.cache_read, 0.02);
  assert.equal(luna.pricing.cache_write, 0.25);
  assert.equal(luna.pricing.output, 1.2);
  assert.equal(luna.pricing.as_of, "2026-07-31");
  assert.ok(luna.source.includes("/gpt-5.6-luna"));
  const lunaSchedule = getPricingSchedule("gpt-5.6-luna");
  assert.equal(lunaSchedule.tiers[0].min_input_tokens, 272_001);
  assert.equal(lunaSchedule.tiers[0].pricing.input, 0.4);
  assert.equal(lunaSchedule.tiers[0].pricing.cache_read, 0.04);
  assert.equal(lunaSchedule.tiers[0].pricing.cache_write, 0.5);
  assert.equal(lunaSchedule.tiers[0].pricing.output, 1.8);

  const solSchedule = getPricingSchedule("gpt-5.6");
  assert.notEqual(solSchedule, null);
  assert.equal(solSchedule.scope.basis, "request_input_tokens");
  assert.equal(solSchedule.tiers.length, 1);
  assert.equal(solSchedule.tiers[0].min_input_tokens, 272_001);
  assert.equal(solSchedule.tiers[0].pricing.input, 10.0);
  assert.equal(solSchedule.tiers[0].pricing.output, 45.0);
});

test("GPT-5.4 mini profile uses the verified output cap", () => {
  const profile = getProfile("openai:gpt-5.4-mini");
  assert.equal(profile.max_output, 128_000);
  assert.equal(profile.pricing.as_of, "2026-07-31");
  assert.ok(profile.source.includes("/gpt-5.4-mini"));
});

test("Gemini 3.1 Pro bundles the verified 200K pricing tier", () => {
  const profile = getProfile("gemini-3.1-pro-preview");
  assert.equal(profile.window_nominal, 1_048_576);
  assert.equal(profile.max_output, 65_536);
  assert.ok(profile.source.includes("/models/gemini-3.1-pro-preview"));
  const schedule = getPricingSchedule("gemini-3.1-pro-preview");
  assert.ok(schedule);
  assert.deepEqual(schedule.scope.unpriced_usage_categories, [
    "cache_write_tokens",
  ]);
  assert.deepEqual(
    getPricingSchedule("gemini-3.5-flash").scope.unpriced_usage_categories,
    ["cache_write_tokens"]
  );
  const flash = getProfile("gemini-3.5-flash");
  assert.equal(flash.window_nominal, 1_048_576);
  assert.equal(flash.max_output, 65_536);
  assert.ok(flash.source.includes("/models/gemini-3.5-flash"));
  const [short, shortMin] = schedule.priceFor(200_000);
  const [long, longMin] = schedule.priceFor(200_001);
  assert.equal(shortMin, null);
  assert.equal(short.input, 2.0);
  assert.equal(short.cache_read, 0.2);
  assert.equal(short.output, 12.0);
  assert.equal(longMin, 200_001);
  assert.equal(long.input, 4.0);
  assert.equal(long.cache_read, 0.4);
  assert.equal(long.output, 18.0);
  assert.throws(
    () => quoteUsage("gemini-3.1-pro-preview", { cache_write_tokens: 1 }),
    /unpriced usage categories: cache_write_tokens/
  );
  assert.throws(
    () => quoteEstimate("gemini-3.1-pro-preview", { input_tokens: 1 }),
    /cannot produce a conservative estimate.*cache_write_tokens/
  );

  assert.equal(
    checkRequestLimits("gemini-3.1-pro-preview", {
      input_tokens: 1,
      requested_output_tokens: 65_536,
    }).allowed,
    true
  );
  assert.equal(
    checkRequestLimits("gemini-3.1-pro-preview", {
      input_tokens: 1,
      requested_output_tokens: 65_537,
    }).output_exceeded,
    true
  );
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

function tieredProfile() {
  return new ModelProfile({
    model_id: "openai:gpt-tiered-test",
    provider: "openai",
    window_nominal: 1_050_000,
    max_output: 128_000,
    pricing: new Pricing({
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
      as_of: "2026-07-31",
    }),
    source: "test schedule",
  });
}

function tieredSchedule(profile) {
  return new PricingSchedule({
    base: profile.pricing,
    tiers: [
      new PricingTier({
        min_input_tokens: 272_001,
        pricing: new Pricing({
          input: 10,
          output: 45,
          cache_read: 1,
          cache_write: 12.5,
          as_of: "2026-07-31",
        }),
      }),
    ],
    scope: new PricingScope(),
  });
}

test("registry parses, resolves, overrides, and clears pricing schedules", () => {
  const profile = tieredProfile();
  const schedule = tieredSchedule(profile);
  const reg = Registry.fromDict({
    snapshot_date: "2026-07-31",
    models: [
      {
        ...profile.toDict(),
        aliases: ["tiered-test"],
        pricing_tiers: schedule.tiers.map((tier) => tier.toDict()),
        pricing_scope: schedule.scope.toDict(),
      },
    ],
  });
  assert.deepEqual(reg.getPricingSchedule("tiered-test"), schedule);
  assert.deepEqual(reg.pricingSchedule("openai:tiered-test"), schedule);

  const override = new ModelProfile({
    model_id: profile.model_id,
    provider: "openai",
    window_nominal: 10_000,
  });
  reg.register(override);
  assert.equal(reg.getPricingSchedule(profile.model_id), null);
  reg.register(profile, ["tiered-test"]);
  assert.deepEqual(
    reg.getPricingSchedule("tiered-test"),
    new PricingSchedule({ base: profile.pricing })
  );
  reg.registerWithSchedule(profile, schedule, ["tiered-test"]);
  assert.equal(reg.getPricingSchedule("tiered-test"), schedule);
});

test("registry rejects a schedule whose base differs from profile pricing", () => {
  const profile = tieredProfile();
  const schedule = new PricingSchedule({
    base: new Pricing({ input: 1, output: 2 }),
  });
  assert.throws(
    () => new Registry().registerWithSchedule(profile, schedule),
    /base must equal profile\.pricing/
  );
});

test("quoteUsage applies exclusive category math at the inclusive tier boundary", () => {
  const profile = tieredProfile();
  const schedule = tieredSchedule(profile);
  const reg = new Registry();
  reg.registerWithSchedule(profile, schedule, ["tiered-test"]);

  const below = quoteUsage(
    "tiered-test",
    {
      input_tokens: 200_000,
      cache_read_tokens: 50_000,
      cache_write_tokens: 22_000,
      output_tokens: 10,
      reasoning_tokens: 20,
    },
    reg
  );
  assert.equal(below.tier_basis_tokens, 272_000);
  assert.equal(below.tier_min_input_tokens, null);
  assertClose(below.input_cost, 1);
  assertClose(below.cache_read_cost, 0.025);
  assertClose(below.cache_write_cost, 0.1375);
  assertClose(below.output_cost, 0.0003);
  assertClose(below.reasoning_cost, 0.0006);
  assertClose(
    below.total_cost,
    below.input_cost + below.cache_read_cost + below.cache_write_cost +
      below.output_cost + below.reasoning_cost
  );

  const at = quoteUsage(
    profile,
    {
      input_tokens: 200_001,
      cache_read_tokens: 50_000,
      cache_write_tokens: 22_000,
    },
    reg,
    schedule
  );
  assert.equal(at.tier_basis_tokens, 272_001);
  assert.equal(at.tier_min_input_tokens, 272_001);
  assert.equal(at.pricing.input, 10);
  assertClose(at.input_cost, 2.00001);
});

test("bundled GPT-5.6 quote switches from short to long pricing at 272001", () => {
  const below = quoteUsage("gpt-5.6", {
    input_tokens: 272_000,
    output_tokens: 100,
    reasoning_tokens: 50,
  });
  assert.equal(below.model_id, "openai:gpt-5.6-sol");
  assert.equal(below.tier_min_input_tokens, null);
  assert.equal(below.pricing.input, 5);
  assertClose(below.input_cost, 1.36);
  assertClose(below.output_cost, 0.003);
  assertClose(below.reasoning_cost, 0.0015);
  assertClose(below.total_cost, 1.3645);

  const at = quoteUsage("openai:gpt-5.6", {
    input_tokens: 272_001,
    output_tokens: 100,
    reasoning_tokens: 50,
  });
  assert.equal(at.tier_min_input_tokens, 272_001);
  assert.equal(at.pricing.input, 10);
  assertClose(at.input_cost, 2.72001);
  assertClose(at.output_cost, 0.0045);
  assertClose(at.reasoning_cost, 0.00225);
  assertClose(at.total_cost, 2.72676);
});

test("unpriced cache writes fail exact and conservative quotes closed", () => {
  const profile = tieredProfile();
  const schedule = new PricingSchedule({
    base: profile.pricing,
    scope: new PricingScope({
      unpriced_usage_categories: ["cache_write_tokens"],
    }),
  });
  const registry = new Registry();
  registry.registerWithSchedule(profile, schedule, ["unpriced-cache-test"]);

  const exactWithoutWrite = quoteUsage(
    "unpriced-cache-test",
    { input_tokens: 10, cache_read_tokens: 5, output_tokens: 2 },
    registry
  );
  assert.equal(exactWithoutWrite.cache_write_cost, 0);
  assertClose(exactWithoutWrite.total_cost, 0.0001125);

  assert.throws(
    () =>
      quoteUsage(
        "unpriced-cache-test",
        { input_tokens: 10, cache_write_tokens: 1 },
        registry
      ),
    /cannot quote unpriced usage categories: cache_write_tokens/
  );
  assert.throws(
    () =>
      quoteEstimate(
        "unpriced-cache-test",
        { input_tokens: 10, conservative: true },
        registry
      ),
    /cannot produce a conservative estimate.*cache_write_tokens/
  );
  const zeroInput = quoteEstimate(
    "unpriced-cache-test",
    { input_tokens: 0, reserved_output_tokens: 1, conservative: true },
    registry
  );
  assertClose(zeroInput.total_cost, 0.00003);

  const uncached = quoteEstimate(
    "unpriced-cache-test",
    { input_tokens: 10, conservative: false },
    registry
  );
  assert.equal(uncached.input_rate_kind, "input");
  assert.ok(
    uncached.assumptions.includes(
      "unpriced cache-write storage is excluded; valid only when no explicit cache is created"
    )
  );

  const unpricedOutput = new PricingSchedule({
    base: profile.pricing,
    scope: new PricingScope({
      unpriced_usage_categories: ["output_tokens", "reasoning_tokens"],
    }),
  });
  assert.throws(
    () =>
      quoteEstimate(
        profile,
        { input_tokens: 0, reserved_output_tokens: 1 },
        undefined,
        unpricedOutput
      ),
    /cannot quote unpriced usage categories: output_tokens, reasoning_tokens/
  );
});

test("quoteEstimate reserves the highest input-category rate at tier boundaries", () => {
  const profile = tieredProfile();
  const schedule = tieredSchedule(profile);
  const reg = new Registry();
  reg.registerWithSchedule(profile, schedule, ["tiered-test"]);

  const short = quoteEstimate(
    "tiered-test",
    { input_tokens: 272_000, reserved_output_tokens: 1_000 },
    reg
  );
  assert.equal(short.tier_basis_tokens, 272_000);
  assert.equal(short.tier_min_input_tokens, null);
  assert.equal(short.input_rate_kind, "cache_write");
  assert.equal(short.input_rate, 6.25);
  assert.equal(short.output_rate, 30);
  assertClose(short.input_cost, 1.7);
  assertClose(short.output_cost, 0.03);
  assertClose(short.total_cost, 1.73);
  assert.equal(short.conservative, true);
  assert.deepEqual(short.assumptions, [
    "estimated input uses the highest selected-tier input-category rate",
    "reserved output uses the selected-tier output rate",
  ]);

  const long = quoteEstimate(
    "tiered-test",
    { input_tokens: 272_001, reserved_output_tokens: 1_000 },
    reg
  );
  assert.equal(long.tier_min_input_tokens, 272_001);
  assert.equal(long.input_rate_kind, "cache_write");
  assert.equal(long.input_rate, 12.5);
  assert.equal(long.output_rate, 45);
  assertClose(long.total_cost, 3.4450125);
});

test("quoteEstimate supports uncached estimates and validates inputs", () => {
  const profile = tieredProfile();
  const schedule = tieredSchedule(profile);
  const estimate = quoteEstimate(
    profile,
    {
      input_tokens: 272_000,
      reserved_output_tokens: 1_000,
      conservative: false,
    },
    undefined,
    schedule
  );
  assert.equal(estimate.input_rate_kind, "input");
  assert.equal(estimate.input_rate, 5);
  assertClose(estimate.total_cost, 1.39);
  assert.equal(estimate.conservative, false);
  assert.deepEqual(estimate.assumptions, [
    "estimated input is treated as uncached input",
    "reserved output uses the selected-tier output rate",
  ]);

  for (const value of [-1, true, 1.5, "1", null]) {
    assert.throws(
      () => quoteEstimate(profile, { input_tokens: value }),
      /non-negative safe integer/
    );
  }
  for (const reserved_output_tokens of [-1, true, 1.5, "1", null]) {
    assert.throws(
      () =>
        quoteEstimate(profile, {
          input_tokens: 1,
          reserved_output_tokens,
        }),
      /reserved_output_tokens/
    );
  }
  for (const conservative of ["yes", null, 1]) {
    assert.throws(
      () => quoteEstimate(profile, { input_tokens: 1, conservative }),
      /conservative must be a bool/
    );
  }
  assert.throws(
    () =>
      quoteEstimate(
        profile,
        { input_tokens: 1 },
        undefined,
        new PricingSchedule({
          base: new Pricing({ input: 1, output: 2 }),
        })
      ),
    /base must equal profile\.pricing/
  );

  const tiedPricing = new Pricing({
    input: 5,
    output: 30,
    cache_read: 5,
    cache_write: 5,
  });
  const tiedProfile = new ModelProfile({
    model_id: "test:tied-rates",
    provider: "test",
    window_nominal: 1_000,
    pricing: tiedPricing,
  });
  const tied = quoteEstimate(tiedProfile, { input_tokens: 1 });
  assert.equal(tied.input_rate_kind, "input");
  assert.equal(tied.input_rate, 5);
});

test("checkRequestLimits enforces fixed input, context, and explicit output separately", () => {
  const profile = tieredProfile();
  const reg = new Registry();
  reg.register(profile, ["tiered-test"]);

  const allowed = checkRequestLimits(
    "tiered-test",
    {
      input_tokens: 900_000,
      requested_output_tokens: 100_000,
      reserved_output_tokens: 80_000,
    },
    reg
  );
  assert.equal(allowed.max_input_tokens, 922_000);
  assert.equal(allowed.context_output_tokens, 100_000);
  assert.equal(allowed.context_tokens, 1_000_000);
  assert.equal(allowed.allowed, true);

  const denied = checkRequestLimits(
    profile,
    {
      input_tokens: 922_001,
      requested_output_tokens: 128_001,
      reserved_output_tokens: 130_000,
    },
    reg
  );
  assert.equal(denied.input_exceeded, true);
  assert.equal(denied.context_exceeded, true);
  assert.equal(denied.output_exceeded, true);
  assert.equal(denied.allowed, false);
  assert.equal(denied.violations.length, 3);
});

test("checkRequestLimits supports effective capacity and rejects negative counts", () => {
  const base = tieredProfile();
  const profile = new ModelProfile({
    ...base.toDict(),
    pricing: base.pricing,
    effective: new CalibrationRecord({
      model_id: base.model_id,
      effective_context: 900_000,
      method: "probe",
      source: "test",
    }),
  });
  const check = checkRequestLimits(profile, {
    input_tokens: 772_001,
    capacity: "effective",
  });
  assert.equal(check.capacity, 900_000);
  assert.equal(check.max_input_tokens, 772_000);
  assert.equal(check.input_exceeded, true);

  const fallback = checkRequestLimits(base, {
    input_tokens: 922_000,
    capacity: "effective",
  });
  assert.equal(fallback.capacity_kind, "effective");
  assert.equal(fallback.capacity, 1_050_000);
  assert.equal(fallback.max_input_tokens, 922_000);
  assert.equal(fallback.allowed, true);
  assert.throws(
    () => checkRequestLimits(profile, { input_tokens: -1 }),
    /non-negative safe integer/
  );
});

test("0.2 APIs are present in both generated TypeScript declaration surfaces", () => {
  for (const format of ["cjs", "esm"]) {
    const index = readFileSync(
      new URL(`../dist/${format}/index.d.ts`, import.meta.url),
      "utf8"
    );
    const types = readFileSync(
      new URL(`../dist/${format}/types.d.ts`, import.meta.url),
      "utf8"
    );
    const registry = readFileSync(
      new URL(`../dist/${format}/registry.d.ts`, import.meta.url),
      "utf8"
    );
    const advisor = readFileSync(
      new URL(`../dist/${format}/advisor.d.ts`, import.meta.url),
      "utf8"
    );

    for (const name of [
      "PricingScope",
      "PricingTier",
      "PricingSchedule",
      "CostEstimate",
      "CostQuote",
      "LimitCheck",
    ]) {
      assert.match(index, new RegExp(`\\b${name}\\b`));
      assert.match(types, new RegExp(`class ${name}\\b`));
    }
    for (const name of [
      "getPricingSchedule",
      "quoteEstimate",
      "quoteUsage",
      "checkRequestLimits",
    ]) {
      assert.match(index, new RegExp(`\\b${name}\\b`));
      assert.match(registry, new RegExp(`function ${name}\\b`));
    }
    assert.match(index, /\bCostEstimateOptions\b/);
    assert.match(registry, /interface CostEstimateOptions\b/);
    assert.match(
      types,
      /readonly unpriced_usage_categories: readonly string\[\]/
    );
    assert.match(types, /unpriced_usage_categories\?: string\[\]/);
    assert.match(advisor, /pricing_schedule\?: PricingSchedule \| null/);
    assert.match(advisor, /static forModel\(/);
  }
});

test("forModel end to end", () => {
  const m = Meter.forModel("claude-haiku-4-5");
  m.record({ input_tokens: 50_000 });
  const s = m.state();
  assert.equal(s.window_nominal, 200_000);
  assertClose(s.fill_nominal, 0.25);
  assert.equal(s.model_id, "anthropic:claude-haiku-4-5");
});
