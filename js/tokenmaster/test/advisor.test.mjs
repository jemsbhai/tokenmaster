// Mirrors python/tokenmaster/tests/test_advisor.py.
//
// CostModelPolicy reference numbers. Pricing per Mtok: in 2.0, out 10.0,
// cache_read 0.2, cache_write 2.5 (per token: 2e-6, 1e-5, 2e-7, 2.5e-6).
// Meter: window 1,000,000; totals 97k, 98k, 99k, 100k -> velocity 1,000,
// used T_pre = 100,000, eta expected = 900.
// Ratios (defaults): T_post 15,000; T_sum 10,000; T_hand 5,000.
//
//   one_time_compact = 10,000*1e-5 + 15,000*(2.5e-6 - 2e-7) = 0.1345
//   saving_per_turn  = 85,000*2e-7 = 0.017
//   k*               = 0.1345 / 0.017 = 7.9118
//   info_compact     = 0.10*100,000*2e-6 = 0.02
//   net_compact(k)   = 0.1545 - 0.017k
//   one_time_handoff = 5,000*1e-5 + 5,000*2.3e-6 = 0.0615
//   info_handoff     = 0.20*100,000*2e-6 = 0.04
//   net_handoff(k)   = 0.1015 + friction - 0.019k
import test from "node:test";
import assert from "node:assert/strict";

import {
  Action,
  AdvisorRecommendation,
  CostModelPolicy,
  EffectEstimate,
  Meter,
  ModelProfile,
  PredictivePolicy,
  Pricing,
  RationaleTrace,
  Recommendation,
  TaskContext,
  TaskCriticality,
  ThresholdPolicy,
  Urgency,
  eventFromDict,
} from "../dist/esm/index.js";

function profile(window = 1_000) {
  return new ModelProfile({
    model_id: "test:model",
    provider: "test",
    window_nominal: window,
  });
}

function meterAt(total, window = 1_000) {
  const m = new Meter(profile(window));
  m.record({ input_tokens: total });
  return m;
}

function steadyMeter(totals, window = 100_000) {
  const m = new Meter(profile(window));
  for (const total of totals) {
    m.record({ input_tokens: total });
  }
  return m;
}

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

// ---------------------------------------------------------------------------
// ThresholdPolicy through Meter.advise

test("green fill recommends continue", () => {
  const rec = meterAt(300).advise();
  assert.equal(rec.action, Action.CONTINUE);
  assert.equal(rec.urgency, Urgency.NONE);
  assert.ok(rec.rationale.comparison.includes("fill 0.300"));
});

test("warn band recommends compact soon", () => {
  const rec = meterAt(750).advise();
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.SOON);
});

test("critical fill recommends compact now", () => {
  const rec = meterAt(900).advise();
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
});

test("exhausted headroom recommends compact now with reason", () => {
  const rec = meterAt(1_100).advise();
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.ok(rec.rationale.comparison.includes("exhausted"));
});

test("default policy aligns with meter thresholds", () => {
  const m = new Meter(profile(), { caution: 0.5, critical: 0.6 });
  m.record({ input_tokens: 550 });
  const rec = m.advise();
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.SOON);
  assert.equal(rec.rationale.inputs.warn_at, 0.5);
  assert.equal(rec.rationale.inputs.compact_at, 0.6);
});

test("baseline estimates no effects", () => {
  const expected = meterAt(900).advise().expected;
  assert.equal(expected.tokens_spent, null);
  assert.equal(expected.tokens_freed, null);
  assert.equal(expected.cost_delta, null);
  assert.equal(expected.fidelity_risk, null);
});

test("advise emits an event with wire round trip", () => {
  const m = meterAt(900);
  const seen = [];
  m.subscribe((event) => seen.push(event));
  const rec = m.advise();
  const events = seen.filter((e) => e instanceof AdvisorRecommendation);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].recommendation, rec);
  assert.equal(events[0].turn_id, 1);
  const back = eventFromDict(events[0].toDict());
  assert.deepEqual(back, events[0]);
});

test("task context appears in rationale and round trips", () => {
  const task = new TaskContext({
    expected_remaining_turns: 7,
    task_criticality: TaskCriticality.HIGH,
  });
  const rec = meterAt(300).advise(task);
  assert.equal(rec.rationale.inputs.expected_remaining_turns, 7);
  assert.deepEqual(TaskContext.fromDict(task.toDict()), task);
});

test("custom policy injection", () => {
  const alwaysHandoff = {
    policy_id: "always-handoff",
    evaluate() {
      return new Recommendation({
        action: Action.HANDOFF,
        urgency: Urgency.NOW,
        rationale: new RationaleTrace({ comparison: "stub" }),
        expected: new EffectEstimate(),
        policy_id: "always-handoff",
      });
    },
  };
  const rec = meterAt(100).advise(null, alwaysHandoff);
  assert.equal(rec.action, Action.HANDOFF);
  assert.equal(rec.policy_id, "always-handoff");
});

test("threshold policy validation", () => {
  assert.throws(
    () => new ThresholdPolicy({ warn_at: 0.9, compact_at: 0.8 }),
    RangeError
  );
});

// ---------------------------------------------------------------------------
// PredictivePolicy

test("predictive continue when coverage ample", () => {
  // velocity 100, used 1300, headroom 98700 -> conservative eta 987
  const m = steadyMeter([1_000, 1_100, 1_200, 1_300]);
  const rec = m.advise(
    new TaskContext({ expected_remaining_turns: 10 }),
    new PredictivePolicy()
  );
  assert.equal(rec.action, Action.CONTINUE);
  assert.equal(rec.urgency, Urgency.NONE);
  assert.ok(rec.rationale.comparison.includes("covers horizon 10"));
  assert.equal(rec.rationale.derived.required_turns, 13);
  assert.equal(rec.rationale.derived.projected_used_at_horizon, 2_300);
});

test("predictive acts now when eta below horizon", () => {
  const m = steadyMeter([1_000, 1_100, 1_200, 1_300]);
  const rec = m.advise(
    new TaskContext({ expected_remaining_turns: 2_000 }),
    new PredictivePolicy()
  );
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.ok(rec.rationale.comparison.includes("< horizon 2000"));
});

test("predictive soon when buffer margin eaten", () => {
  // conservative eta 987.0; horizon 985 -> covers task, eats the buffer
  const m = steadyMeter([1_000, 1_100, 1_200, 1_300]);
  const rec = m.advise(
    new TaskContext({ expected_remaining_turns: 985 }),
    new PredictivePolicy({ buffer_turns: 3 })
  );
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.SOON);
});

test("predictive without horizon guards the buffer", () => {
  // velocity 200, used 800, headroom 200 -> conservative eta 1.0
  const m = steadyMeter([400, 600, 800], 1_000);
  const rec = m.advise(null, new PredictivePolicy({ buffer_turns: 3 }));
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.ok(rec.rationale.comparison.includes("horizon unknown"));
});

test("predictive cold start delegates to fallback", () => {
  const m = new Meter(profile(1_000));
  m.record({ input_tokens: 900 });
  const rec = m.advise(null, new PredictivePolicy());
  assert.equal(rec.policy_id, "predictive");
  assert.equal(rec.rationale.derived.delegated_to, "threshold");
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.ok(rec.rationale.comparison.includes("delegated to threshold"));
});

test("predictive exhausted headroom acts now", () => {
  const m = steadyMeter([400, 700, 1_100], 1_000);
  const rec = m.advise(null, new PredictivePolicy());
  assert.equal(rec.action, Action.COMPACT);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.ok(rec.rationale.comparison.includes("exhausted"));
});

test("predictive parameter validation", () => {
  assert.throws(() => new PredictivePolicy({ buffer_turns: -1 }), RangeError);
  assert.throws(() => new PredictivePolicy({ soon_factor: 0.5 }), RangeError);
});

// ---------------------------------------------------------------------------
// CostModelPolicy

const PRICING = new Pricing({
  input: 2.0,
  output: 10.0,
  cache_read: 0.2,
  cache_write: 2.5,
  as_of: "2026-07-07",
});

function costMeter(window = 1_000_000) {
  const m = new Meter(profile(window));
  for (const total of [97_000, 98_000, 99_000, 100_000]) {
    m.record({ input_tokens: total });
  }
  return m;
}

test("cost model k* matches the contract formula", () => {
  const rec = costMeter().advise(
    new TaskContext({ expected_remaining_turns: 3 }),
    new CostModelPolicy({ pricing: PRICING })
  );
  assertClose(rec.rationale.derived.k_star, 0.1345 / 0.017);
  assertClose(rec.rationale.derived.k_star_with_info, 0.1545 / 0.017);
});

test("cost model continues below break-even", () => {
  const rec = costMeter().advise(
    new TaskContext({ expected_remaining_turns: 3 }),
    new CostModelPolicy({ pricing: PRICING })
  );
  assert.equal(rec.action, Action.CONTINUE);
  assert.equal(rec.urgency, Urgency.NONE);
  assert.equal(rec.expected.cost_delta, 0.0);
  assertClose(rec.rationale.derived.net_compact, 0.1545 - 3 * 0.017);
});

test("cost model handoff wins at long horizon with zero friction", () => {
  const rec = costMeter().advise(
    new TaskContext({ expected_remaining_turns: 20 }),
    new CostModelPolicy({ pricing: PRICING })
  );
  assert.equal(rec.action, Action.HANDOFF);
  assert.equal(rec.urgency, Urgency.SOON);
  assertClose(rec.expected.cost_delta, 0.1015 - 20 * 0.019);
  assertClose(rec.expected.fidelity_risk, 0.2);
  assert.equal(rec.expected.tokens_freed, 95_000);
});

test("cost model friction flips the choice to compact", () => {
  const rec = costMeter().advise(
    new TaskContext({ expected_remaining_turns: 20 }),
    new CostModelPolicy({ pricing: PRICING, human_friction: 0.5 })
  );
  assert.equal(rec.action, Action.COMPACT);
  assertClose(rec.expected.cost_delta, 0.1545 - 20 * 0.017);
  assert.equal(rec.expected.tokens_spent, 10_000);
  assert.equal(rec.expected.tokens_freed, 85_000);
  assertClose(rec.expected.fidelity_risk, 0.1);
});

test("cost model overflow within horizon forces action now", () => {
  // window 105,000 -> headroom 5,000, eta expected 5 < k=20
  const rec = costMeter(105_000).advise(
    new TaskContext({ expected_remaining_turns: 20 }),
    new CostModelPolicy({ pricing: PRICING })
  );
  assert.notEqual(rec.action, Action.CONTINUE);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.equal(rec.rationale.derived.overflow_within_horizon, true);
  assert.ok(rec.rationale.comparison.includes("infeasible"));
});

test("cost model exhausted picks the cheaper action now", () => {
  const rec = costMeter(90_000).advise(
    null,
    new CostModelPolicy({ pricing: PRICING })
  );
  assert.notEqual(rec.action, Action.CONTINUE);
  assert.equal(rec.urgency, Urgency.NOW);
  assert.equal(rec.rationale.derived.exhausted, true);
});

test("cost model without pricing uses the unit ledger", () => {
  const rec = costMeter().advise(
    new TaskContext({ expected_remaining_turns: 20 }),
    new CostModelPolicy()
  );
  assert.equal(rec.rationale.derived.ledger_unit, "token-units");
  assert.ok(rec.rationale.comparison.includes("token-units"));
  assert.notEqual(rec.action, null);
});

test("cost model cold start delegates", () => {
  const m = new Meter(profile(1_000));
  m.record({ input_tokens: 900 });
  const rec = m.advise(null, new CostModelPolicy({ pricing: PRICING }));
  assert.equal(rec.policy_id, "cost-model");
  assert.equal(rec.rationale.derived.delegated_to, "threshold");
  assert.equal(rec.action, Action.COMPACT);
});

test("cost model parameter validation", () => {
  assert.throws(
    () => new CostModelPolicy({ compaction_ratio: 0.0 }),
    RangeError
  );
  assert.throws(
    () => new CostModelPolicy({ expected_handoff_loss: 1.5 }),
    RangeError
  );
  assert.throws(
    () => new CostModelPolicy({ human_friction: -0.1 }),
    RangeError
  );
  assert.throws(() => new CostModelPolicy({ default_horizon: 0 }), RangeError);
});
