const test = require("node:test");
const assert = require("node:assert/strict");

const { CORE_SCHEMA } = require("../dist/cjs/index.js");

test("CJS build links against the published tokenmaster core", () => {
  assert.equal(CORE_SCHEMA, "0.1");
});
