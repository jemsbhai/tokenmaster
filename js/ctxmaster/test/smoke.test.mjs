import test from "node:test";
import assert from "node:assert/strict";

import { ContextGauge, about, VERSION } from "../dist/esm/index.js";

test("ESM build exposes the gauge and links against the core", () => {
  assert.equal(typeof ContextGauge, "function");
  assert.equal(about().core_schema, "0.1");
  assert.equal(about().version, VERSION);
});
