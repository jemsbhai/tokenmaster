// Mirrors python/tokenmaster/tests/test_fidelity.py: the handoff fidelity
// protocol, fully offline via stub adapters.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ExactMatchJudge,
  FidelityReport,
  HandoffEvaluated,
  Meter,
  ModelProfile,
  Probe,
  ProbeCategory,
  evaluateHandoff,
  eventFromDict,
} from "../dist/esm/index.js";

function probe(pid, category, question, gold, weight = 1.0) {
  return new Probe({
    id: pid,
    category,
    question,
    gold_answer: gold,
    weight,
  });
}

const PROBES = [
  probe("p1", ProbeCategory.OBJECTIVE, "What is being built?", "a tokenmeter"),
  probe("p2", ProbeCategory.DECISIONS, "Which license was chosen?", "MIT"),
  probe("p3", ProbeCategory.STATE, "How many tests pass?", "80"),
];

/** Answers from a fixed mapping; empty string for unknown questions. */
class ScriptedAnswerer {
  name = "scripted";

  constructor(answers) {
    this.answers = answers;
  }

  answer(handoffArtifact, question) {
    return this.answers[question] ?? "";
  }
}

function assertClose(actual, expected, eps = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`
  );
}

test("probe round trip and weight validation", () => {
  const p = PROBES[0];
  assert.deepEqual(Probe.fromDict(p.toDict()), p);
  assert.throws(
    () => probe("bad", ProbeCategory.STATE, "q", "a", 0),
    { name: "RangeError", message: "probe weight must be positive" }
  );
});

test("exact match judge is normalized containment", () => {
  const j = new ExactMatchJudge();
  assert.equal(j.judge("q", "MIT", "The license is   mit.")[0], true);
  assert.equal(j.judge("q", "42", "it is 42, confirmed")[0], true);
  assert.equal(j.judge("q", "MIT", "Apache-2.0")[0], false);
});

test("perfect handoff scores one", () => {
  const answerer = new ScriptedAnswerer({
    "What is being built?": "We are building a tokenmeter for LLMs.",
    "Which license was chosen?": "MIT",
    "How many tests pass?": "All 80 of them.",
  });
  const report = evaluateHandoff("artifact", { answerer, probes: PROBES });
  assertClose(report.score, 1.0);
  assert.deepEqual(report.per_category, {
    objective: 1.0,
    decisions: 1.0,
    state: 1.0,
  });
  assert.equal(report.answerer, "scripted");
  assert.equal(report.judge, "exact-match");
});

test("weighted partial score and per category", () => {
  const probes = [
    probe("a", ProbeCategory.OBJECTIVE, "Q1?", "alpha", 1.0),
    probe("b", ProbeCategory.DECISIONS, "Q2?", "beta", 3.0),
  ];
  const answerer = new ScriptedAnswerer({ "Q1?": "alpha", "Q2?": "wrong" });
  const report = evaluateHandoff("artifact", { answerer, probes });
  assertClose(report.score, 0.25);
  assertClose(report.per_category.objective, 1.0);
  assertClose(report.per_category.decisions, 0.0);
});

test("unanswerable probe counts zero and is flagged", () => {
  const answerer = new ScriptedAnswerer({
    "What is being built?": "a tokenmeter",
  });
  const report = evaluateHandoff("artifact", {
    answerer,
    probes: PROBES.slice(0, 2),
  });
  const outcomes = {};
  for (const o of report.outcomes) {
    outcomes[o.probe.id] = o;
  }
  assert.equal(outcomes.p2.answerable, false);
  assert.equal(outcomes.p2.correct, false);
  assert.equal(outcomes.p2.answer, null);
  assertClose(report.score, 0.5);
});

test("requires probes or a generator", () => {
  assert.throws(
    () => evaluateHandoff("artifact", { answerer: new ScriptedAnswerer({}) }),
    RangeError
  );
});

test("generator path records seed and name", () => {
  const stubGenerator = {
    name: "stub-generator",
    generate(sourceContext, n, seed) {
      assert.equal(sourceContext, "the source");
      assert.equal(seed, 1234);
      return PROBES.slice(0, n);
    },
  };
  const answerer = new ScriptedAnswerer({
    "What is being built?": "a tokenmeter",
    "Which license was chosen?": "MIT",
  });
  const report = evaluateHandoff("artifact", {
    answerer,
    source_context: "the source",
    probe_generator: stubGenerator,
    n: 2,
    seed: 1234,
  });
  assert.equal(report.generator, "stub-generator");
  assert.equal(report.seed, 1234);
  assert.equal(report.outcomes.length, 2);
});

test("caveats recorded for naive pieces", () => {
  const answerer = new ScriptedAnswerer({
    "What is being built?": "a tokenmeter",
  });
  const report = evaluateHandoff("artifact", {
    answerer,
    probes: PROBES.slice(0, 1),
  });
  const joined = report.caveats.join(" ");
  assert.ok(joined.includes("answerability"));
  assert.ok(joined.includes("containment"));
});

test("report JSON round trip", () => {
  const answerer = new ScriptedAnswerer({
    "What is being built?": "a tokenmeter",
  });
  const report = evaluateHandoff("artifact", {
    answerer,
    probes: PROBES.slice(0, 1),
  });
  const back = FidelityReport.fromDict(report.toDict());
  assert.deepEqual(back, report);
});

test("meter reportHandoff emits an event with wire round trip", () => {
  const m = new Meter(
    new ModelProfile({
      model_id: "test:model",
      provider: "test",
      window_nominal: 1_000,
    })
  );
  m.record({ input_tokens: 500 });
  const seen = [];
  m.subscribe((event) => seen.push(event));
  const answerer = new ScriptedAnswerer({
    "What is being built?": "a tokenmeter",
  });
  const report = evaluateHandoff("artifact", {
    answerer,
    probes: PROBES.slice(0, 1),
  });
  m.reportHandoff(report);
  const events = seen.filter((e) => e instanceof HandoffEvaluated);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].report, report);
  assert.equal(events[0].turn_id, 1);
  const back = eventFromDict(events[0].toDict());
  assert.deepEqual(back, events[0]);
});
