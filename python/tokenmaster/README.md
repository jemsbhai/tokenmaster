# tokenmaster

Core context-budget metering and decision engine for LLM applications.

tokenmaster answers four questions for any model, provider, and conversation:

1. How much context has been used, and on what (messages, system prompt, tool
   schemas, reasoning tokens, cache reads)?
2. How much usable budget remains, measured against calibrated effective
   capacity rather than the advertised window?
3. How many turns remain until exhaustion at the current token velocity?
4. Should this conversation be compacted or handed off now, and what would
   that decision cost?

## Install

    pip install tokenmaster

## Quickstart

```python
from tokenmaster import CostModelPolicy, Meter, TaskContext

meter = Meter.for_model("anthropic:claude-sonnet-4-6")

# after each model response, feed it the usage numbers
meter.record({
    "input_tokens": 52_000,
    "cache_read_tokens": 118_000,
    "output_tokens": 1_800,
    "reasoning_tokens": 3_200,
})

state = meter.state()
state.fill_effective   # fraction of usable budget consumed
state.eta_turns        # projected turns to exhaustion (needs 3 turns of data)
state.zone             # green / caution / critical
state.provenance       # where every number came from

# judgment, with the arithmetic attached
rec = meter.advise(TaskContext(expected_remaining_turns=12))
rec.action, rec.urgency        # continue / compact / handoff
rec.rationale.comparison       # the comparison that produced the verdict

# the cost model prices compact vs handoff vs continue, cache economics included
policy = CostModelPolicy.for_profile(meter.profile)
meter.advise(TaskContext(expected_remaining_turns=40), policy=policy)
```

## Models outside the registry

Any model works; the bundled registry is a convenience, not a gate. For an
id the snapshot does not know (an OpenRouter route, a local runtime, a
private deployment), build a ModelProfile and either pass it straight to
Meter or register it once per process:

```python
from tokenmaster import Meter, ModelProfile, default_registry

profile = ModelProfile(
    model_id="openrouter:z-ai/glm-5.2",   # canonical form: provider:model
    provider="openrouter",
    window_nominal=200_000,
)

meter = Meter(profile)   # this meter only

default_registry().register(profile, aliases=["glm-5.2"])
meter = Meter.for_model("z-ai/glm-5.2")   # resolves process-wide now
```

The part after the colon resolves as a bare name automatically, so the
verbatim OpenRouter id works once the profile is registered; extra
spellings go in aliases. Later registrations win, which makes the same
call the way to override a bundled model's capacities or pricing. Only
window_nominal is load-bearing; pricing is optional and feeds the
cost-model policy. Without a CalibrationRecord the gauges run against the
nominal window and the provenance says so: "nominal (uncalibrated)".

## What is in 0.1.0

- Normalized TurnUsage accounting, with the hidden consumers (reasoning
  tokens, cache reads and writes, system prompt and tool-schema overhead) as
  first-class categories and a provenance tag on every number.
- MeterState gauges: effective versus nominal budget, EWMA token velocity,
  turns-to-exhaustion with a conservative bound, zone classification.
- A bundled model registry (12 models with dated, cited pricing), alias and
  dated-suffix resolution, user overrides, and `Meter.for_model` for
  zero-configuration attachment.
- A typed event stream (six event types with exact wire round-trips): the
  contract that visualizers such as ctxmaster, or your own, build on.
- Three advisor policies: a threshold baseline that reproduces current
  practice, a predictive policy that compares conservative ETA against the
  task horizon, and a cost model that prices continue, compact, and handoff,
  including the cache break-even horizon k* that compaction must clear
  before it saves money.
- A handoff fidelity protocol (probe question answering) that makes "was
  that continuation prompt any good" measurable, with every LLM touchpoint
  behind an adapter so the protocol runs fully offline.
- Conformance vectors under `spec/` in the repository: the executable
  cross-language specification the JavaScript and Rust ports must match.

## Not yet included (planned)

Provider adapters (Anthropic and OpenAI usage normalizers), tokenizer
estimators, LLM-backed probe generators and judges, calibrated
effective-capacity data (defaults equal the nominal window, and the
provenance says so), async event delivery, and tiered long-context pricing
in the registry. The JavaScript port (npm) and the Rust port (crates.io)
are both live at 0.1.0, tokenmaster and ctxmaster alike, and conformant
against the vectors.

## Design

The core has zero hard dependencies and never touches the network. Every
quantity carries its provenance; every recommendation ships the arithmetic
that produced it; parameters that have not been measured yet are labeled
provisional. The full contract lives at `docs/core-api.md` in the
repository: https://github.com/jemsbhai/tokenmaster

The companion package [ctxmaster](https://pypi.org/project/ctxmaster/)
provides the terminal gauge and other visual surfaces on top of the event
stream.

## License

MIT
