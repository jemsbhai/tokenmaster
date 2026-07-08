// Mirrors python/ctxmaster/tests/test_gauge.py: rendered output captured
// through a sink and asserted on content, plus JS-specific coverage for
// color emission and the live in-place redraw.
import test from "node:test";
import assert from "node:assert/strict";

import { Meter, ModelProfile, CalibrationRecord } from "tokenmaster";
import { ContextGauge } from "../dist/esm/index.js";

function profile({ window = 100_000, effective = null } = {}) {
  return new ModelProfile({
    model_id: "test:model",
    provider: "test",
    window_nominal: window,
    effective,
  });
}

function makeGauge(options = {}) {
  const chunks = [];
  const gauge = new ContextGauge({
    write: (text) => chunks.push(text),
    bar_width: 30,
    ...options,
  });
  return [gauge, chunks];
}

test("render shows usage numbers and percent", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 100_000 }));
  m.record({ input_tokens: 50_000 });
  gauge.print(m.state());
  const text = chunks.join("");
  assert.ok(text.includes("50,000"));
  assert.ok(text.includes("100,000"));
  assert.ok(text.includes("50.0%"));
  assert.ok(text.includes("test:model"));
});

test("cold start reason is shown", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile());
  m.record({ input_tokens: 1_000 });
  gauge.print(m.state());
  assert.ok(chunks.join("").includes("cold start"));
});

test("uncalibrated capacity is labeled", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile());
  m.record({ input_tokens: 1_000 });
  gauge.print(m.state());
  assert.ok(chunks.join("").includes("uncalibrated"));
});

test("calibrated capacity shows source and effective window", () => {
  const cal = new CalibrationRecord({
    model_id: "test:model",
    effective_context: 80_000,
    method: "probe-kit",
    source: "local run",
  });
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 100_000, effective: cal }));
  m.record({ input_tokens: 40_000 });
  gauge.print(m.state());
  const text = chunks.join("");
  assert.ok(text.includes("80,000"));
  assert.ok(text.includes("probe-kit"));
  assert.ok(!text.includes("uncalibrated"));
});

test("zone label rendered for critical fill", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 1_000 }));
  m.record({ input_tokens: 900 });
  gauge.print(m.state());
  assert.ok(chunks.join("").includes("CRITICAL"));
});

test("eta rendered with conservative bound", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 100_000 }));
  for (const total of [1_000, 1_300, 1_650, 2_100]) {
    m.record({ input_tokens: total });
  }
  gauge.print(m.state());
  const text = chunks.join("");
  assert.ok(text.includes("eta"));
  assert.ok(text.includes("conservative"));
});

test("attach prints on record and unsubscribe stops", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile());
  const unsubscribe = gauge.attach(m);
  m.record({ input_tokens: 12_345 });
  unsubscribe();
  m.record({ input_tokens: 20_000 });
  const text = chunks.join("");
  assert.ok(text.includes("12,345"));
  assert.equal((text.match(/ctxmaster/g) ?? []).length, 1);
});

test("render smoke at minimum bar width", () => {
  const [gauge, chunks] = makeGauge({ bar_width: 5 });
  const m = new Meter(profile());
  m.record({ input_tokens: 50_000 });
  gauge.print(m.state());
  assert.ok(chunks.join("").includes("50,000"));
});

test("bar width validation", () => {
  assert.throws(() => new ContextGauge({ bar_width: 3 }), {
    name: "RangeError",
    message: "bar_width must be at least 5",
  });
});

test("optional rows render reserved output, overhead, and cache", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 100_000 }), { reserved_output: 2_000 });
  m.record({
    input_tokens: 10_000,
    cache_read_tokens: 8_000,
    cache_write_tokens: 500,
    breakdown: { system_prompt: 3_000, tool_schemas: 1_200 },
  });
  gauge.print(m.state());
  const text = chunks.join("");
  assert.ok(text.includes("2,000 tok output"));
  assert.ok(text.includes("4,200 tok (system prompt + tool schemas)"));
  assert.ok(text.includes("~8,500 tok stable prefix"));
});

test("custom sink defaults to plain text; explicit colors emit ANSI", () => {
  const m = new Meter(profile({ window: 100_000 }));
  m.record({ input_tokens: 50_000 });

  const [plainGauge, plainChunks] = makeGauge();
  plainGauge.print(m.state());
  assert.ok(!plainChunks.join("").includes("\u001b["));

  const [colorGauge, colorChunks] = makeGauge({ colors: true });
  colorGauge.print(m.state());
  assert.ok(colorChunks.join("").includes("\u001b["));
});

test("live draws immediately, redraws in place, and stop detaches", () => {
  const [gauge, chunks] = makeGauge();
  const m = new Meter(profile({ window: 100_000 }));
  const handle = gauge.live(m);
  assert.equal((chunks.join("").match(/ctxmaster/g) ?? []).length, 1);

  m.record({ input_tokens: 25_000 });
  let text = chunks.join("");
  assert.equal((text.match(/ctxmaster/g) ?? []).length, 2);
  assert.ok(/\u001b\[\d+A/.test(text), "expected a cursor-up sequence");
  assert.ok(text.includes("25,000"));

  handle.stop();
  m.record({ input_tokens: 50_000 });
  text = chunks.join("");
  assert.equal((text.match(/ctxmaster/g) ?? []).length, 2);
  assert.equal(typeof handle.stop, "function");
});
