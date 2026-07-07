# Changelog

All notable changes to ctxmaster are documented in this file.

## 0.1.0 (2026-07-07)

- ContextGauge, the hero surface (contract decision D10): zone-colored fill
  bar against the effective window with threshold ticks, plus ancillary
  rows for context accounting, capacity provenance, velocity, eta with
  conservative bound, zone, reserved output, hidden overhead, and cache
  prefix.
- Delivery three ways: pure `render(state)`, `attach(meter)` printing per
  recorded turn, and `live(meter)` in-place terminal updates.
- Depends on tokenmaster >=0.1.0,<0.2 and rich >=13.

## 0.0.1 (2026-07-07)

- Placeholder release reserving the package name on PyPI.
- Declares the dependency on tokenmaster; exposes `__version__` and `about()`
  only. No functional API yet.
