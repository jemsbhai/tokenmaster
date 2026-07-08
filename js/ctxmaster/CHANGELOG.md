# Changelog

All notable changes to the ctxmaster npm package are documented in this
file.

## 0.1.0 (2026-07-08)

- ContextGauge, the hero surface (contract decision D10), ported from the
  Python wrapper: zone-colored fill bar against the effective window with
  threshold ticks, plus ancillary rows for context accounting, capacity
  provenance, velocity, eta with conservative bound, zone, reserved output,
  hidden overhead, and cache prefix.
- Delivery three ways: pure render(state) returning a string, attach(meter)
  printing per recorded turn, and live(meter) in-place terminal updates with
  a stop() handle that is also disposable on runtimes with Symbol.dispose.
- Raw ANSI rendering with zero runtime dependencies beyond the core; color
  detection honors NO_COLOR, FORCE_COLOR, TERM, and TTY state, with explicit
  overrides and a pluggable write sink.
- Depends on tokenmaster >=0.1.0 <0.2.0. Dual ESM and CommonJS builds with
  bundled TypeScript declarations.

## 0.0.1 (2026-07-07)

- Placeholder release reserving the package name on npm. Declared the
  dependency on tokenmaster; exposed about() only. No functional API.
