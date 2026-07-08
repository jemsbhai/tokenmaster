import test from "node:test";
import assert from "node:assert/strict";

import { CORE_SCHEMA } from "../dist/esm/index.js";

test("ESM build links against the published tokenmaster core", () => {
  assert.equal(CORE_SCHEMA, "0.1");
});
