/**
 * Prove that the publishable ctxmaster tarball works with the publishable
 * Tokenmaster 0.2.0 tarball without requiring either package on npm.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ctxmasterRoot = resolve(here, "..");
const tokenmasterRoot = resolve(ctxmasterRoot, "..", "tokenmaster");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedCoreVersion = "0.2.0";

function packageVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function pack(root, destination) {
  const output = execFileSync(
    npm,
    ["pack", "--json", "--pack-destination", destination],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const result = JSON.parse(output);
  assert.equal(result.length, 1, `expected one packed artifact for ${root}`);
  return join(destination, result[0].filename);
}

const sandbox = mkdtempSync(join(tmpdir(), "ctxmaster-packed-test-"));

try {
  assert.equal(
    packageVersion(tokenmasterRoot),
    expectedCoreVersion,
    "ctxmaster compatibility tests must track the local Tokenmaster 0.2.0 release",
  );

  const coreTarball = pack(tokenmasterRoot, sandbox);
  const companionTarball = pack(ctxmasterRoot, sandbox);

  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({ name: "ctxmaster-packed-test", private: true }),
  );
  execFileSync(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      coreTarball,
      companionTarball,
    ],
    { cwd: sandbox, stdio: "inherit" },
  );

  writeFileSync(
    join(sandbox, "smoke.mjs"),
    `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { Meter, ModelProfile } from "tokenmaster";
      import { ContextGauge, about } from "ctxmaster";

      const require = createRequire(import.meta.url);
      assert.equal(require("tokenmaster/package.json").version, "${expectedCoreVersion}");
      const profile = new ModelProfile({
        model_id: "test:packed",
        provider: "test",
        window_nominal: 100_000,
      });
      const meter = new Meter(profile);
      meter.record({ input_tokens: 25_000, output_tokens: 500 });
      const panel = new ContextGauge({ colors: false }).render(meter.state());
      assert.match(panel, /25,500/);
      assert.equal(about().core_schema, "0.1");
    `,
  );
  execFileSync(process.execPath, [join(sandbox, "smoke.mjs")], {
    cwd: sandbox,
    stdio: "inherit",
  });
  process.stdout.write(
    `packed compatibility passed: tokenmaster ${expectedCoreVersion} + ctxmaster ${packageVersion(ctxmasterRoot)}\n`,
  );
} finally {
  rmSync(sandbox, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
