"""Live demo: a simulated agent conversation driving the context gauge.

Run from the repository root:

    python .\\python\\ctxmaster\\examples\\demo_gauge.py

Simulates an accelerating agent against claude-haiku-4-5 (200K window) and
updates the gauge in place until the meter crosses into the critical zone.
"""

import time

from ctxmaster import ContextGauge
from tokenmaster import Meter


def main() -> None:
    meter = Meter.for_model("claude-haiku-4-5")
    gauge = ContextGauge(bar_width=50)

    total = 8_000
    with gauge.live(meter):
        for _ in range(20):
            meter.record({"input_tokens": total, "output_tokens": 1_500})
            if meter.state().fill_effective >= 1.0:
                break
            time.sleep(0.6)
            total = int(total * 1.35) + 3_000

    events = list(meter.events())
    print(f"\nfinal zone: {meter.state().zone.value}")
    print(f"events emitted: {len(events)}")


if __name__ == "__main__":
    main()
