// Marks dist/esm as ES modules. The package root declares "type": "commonjs",
// so dist/cjs/*.js are CJS naturally; this stub flips the scope for dist/esm.
import { mkdirSync, writeFileSync } from "node:fs";

const dir = new URL("../dist/esm/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(
  new URL("package.json", dir),
  JSON.stringify({ type: "module" }, null, 2) + "\n"
);
