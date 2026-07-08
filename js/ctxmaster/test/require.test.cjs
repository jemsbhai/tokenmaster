const test = require("node:test");
const assert = require("node:assert/strict");

const { ContextGauge, about, VERSION } = require("../dist/cjs/index.js");

test("CJS build exposes the gauge and links against the core", () => {
  assert.equal(typeof ContextGauge, "function");
  assert.equal(about().core_schema, "0.1");
  assert.equal(about().version, VERSION);
});
