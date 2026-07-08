// Live demo: a simulated agent conversation driving the context gauge.
//
// Run from the repository root:
//
//     node .\js\ctxmaster\examples\demo.mjs
//
// Simulates an accelerating agent against claude-haiku-4-5 (200K window)
// and updates the gauge in place until the meter crosses into the critical
// zone.
import { Meter } from "tokenmaster";
import { ContextGauge } from "ctxmaster";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const meter = Meter.forModel("claude-haiku-4-5");
const gauge = new ContextGauge({ bar_width: 50 });

let total = 8_000;
const live = gauge.live(meter);
try {
  for (let i = 0; i < 20; i++) {
    meter.record({ input_tokens: total, output_tokens: 1_500 });
    if (meter.state().fill_effective >= 1.0) {
      break;
    }
    await sleep(600);
    total = Math.trunc(total * 1.35) + 3_000;
  }
} finally {
  live.stop();
}

console.log(`\nfinal zone: ${meter.state().zone}`);
console.log(`events emitted: ${meter.events().length}`);
