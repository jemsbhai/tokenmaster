# Changelog

All notable changes to the ctxmaster Rust crate are documented here.

## 0.1.1 (2026-07-31)

- Widened the compatible Tokenmaster range to `>=0.1.0, <0.3.0` so the
  terminal gauge can be installed with Tokenmaster 0.2.0. No gauge or wire
  behavior changed.
- Set the minimum supported Rust version to 1.71 and retain a Cargo v3
  lockfile so the declared toolchain can parse and test the workspace.

## 0.1.0 (2026-07-08)

- Initial raw-ANSI terminal context gauge, conformant with the Python and
  JavaScript companion packages.
