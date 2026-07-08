/**
 * ctxmaster: visualization layer for tokenmaster.
 *
 * 0.1.x alpha: the terminal context gauge (hero surface per contract
 * decision D10) with per-turn and live in-place rendering, in raw ANSI
 * with zero runtime dependencies beyond the tokenmaster core. The advice
 * panel, CLI, and dashboard surfaces are planned; the public surface may
 * still shift before 0.2.
 */

import { SCHEMA_VERSION } from "tokenmaster";

export { ContextGauge, ZONE_STYLE } from "./gauge.js";
export type { GaugeOptions, LiveGauge } from "./gauge.js";

export const VERSION = "0.0.1";

/** Basic project metadata. */
export function about(): {
  name: string;
  version: string;
  summary: string;
  core_schema: string;
  repository: string;
  status: string;
} {
  return {
    name: "ctxmaster",
    version: VERSION,
    summary:
      "Visualization layer for tokenmaster: terminal gauge and future " +
      "CLI and dashboard renderers.",
    core_schema: SCHEMA_VERSION,
    repository: "https://github.com/jemsbhai/tokenmaster",
    status: "alpha",
  };
}
