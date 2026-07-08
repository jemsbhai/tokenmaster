import test from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_VERSION } from "../dist/esm/index.js";

test("ESM build loads and exposes SCHEMA_VERSION", () => {
  assert.equal(SCHEMA_VERSION, "0.1");
});
