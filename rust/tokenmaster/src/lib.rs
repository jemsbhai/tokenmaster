//! tokenmaster: core context-budget metering and decision engine for LLM
//! applications.
//!
//! Computation only: normalized token accounting (TurnUsage), calibrated
//! effective-budget gauges (MeterState), turns-to-exhaustion prediction, and
//! compaction/handoff decision policies. Rendering lives in the companion
//! ctxmaster crate. This crate is the Rust implementation of the
//! cross-language contract in docs/core-api.md; the conformance vectors
//! under spec/vectors are the executable specification, and divergence from
//! the Python reference on any vector is a bug here.

pub mod events;
pub mod meter;
pub mod types;

pub use events::{Event, EventKind};
pub use meter::{Meter, MeterConfig, SubscriptionId};
pub use types::{
    Breakdown, CacheState, CalibrationRecord, Error, EtaEstimate, MeterState, ModelProfile,
    Pricing, TurnUsage, UsageSource, Zone, SCHEMA_VERSION,
};
