const test = require("node:test");
const assert = require("node:assert/strict");

const { SCHEMA_VERSION } = require("../dist/cjs/index.js");

test("CJS build loads and exposes SCHEMA_VERSION", () => {
  assert.equal(SCHEMA_VERSION, "0.1");
});
