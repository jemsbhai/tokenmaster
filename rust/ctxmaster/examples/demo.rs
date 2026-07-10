//! Live demo: a simulated agent conversation driving the context gauge.
//!
//! Run from the repository's rust/ directory:
//!
//!     cargo run --example demo -p ctxmaster
//!
//! Simulates an accelerating agent against claude-haiku-4-5 (200K window)
//! and updates the gauge in place until the meter crosses into the critical
//! zone.

use std::thread;
use std::time::Duration;

use ctxmaster::ContextGauge;
use tokenmaster::{Meter, TurnUsage};

fn main() {
    let mut meter = Meter::for_model("claude-haiku-4-5").expect("bundled model resolves");
    let gauge = ContextGauge::new();

    let mut total: i64 = 8_000;
    let live = gauge.live(&mut meter);
    for _ in 0..20 {
        let mut turn = TurnUsage::new(0);
        turn.input_tokens = total;
        turn.output_tokens = 1_500;
        meter.record(turn).expect("turn records");
        if meter.state().fill_effective >= 1.0 {
            break;
        }
        thread::sleep(Duration::from_millis(600));
        total = (total as f64 * 1.35) as i64 + 3_000;
    }
    meter.unsubscribe(live);

    let state = meter.state();
    println!("\nfinal zone: {}", state.zone.as_str());
    println!("events emitted: {}", meter.events().len());
}
