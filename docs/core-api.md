# tokenmaster core API contract

Version: 0.1 (2026-07-07)
Status: accepted 2026-07-07; resolved decisions recorded in section 11.
Implemented by the Python reference (PyPI 0.1.0) and the JavaScript port
(npm 0.1.0), both reproducing the conformance vectors under spec/; the Rust
implementation is pending. This contract
governs the Python, JavaScript, and Rust implementations equally. Divergence
between an implementation and this document is a bug in the implementation or
a change request against this document, never a silent fork.

## 1. Purpose and scope

tokenmaster is the computational core of a context-budget instrument for LLM
applications. It answers, continuously and for any provider:

1. How much context has been consumed, and by what.
2. How much usable budget remains, measured against calibrated effective
   capacity rather than the advertised window.
3. How many turns remain at the current consumption rate.
4. Whether the conversation should continue, be compacted, or be handed off to
   a fresh session, and what each option is expected to cost.

Non-goals for the 0.x series: tokenmaster is not an observability or billing
platform (no server, no storage backend, no telemetry), not a proxy, not a
summarizer or compactor (it decides when and measures how well; the rewriting
itself is delegated through adapters), and it renders nothing. All user-facing
surfaces live in ctxmaster or in third-party visualizers.

## 2. Design principles

P1. Provenance on every number. Each quantity carries where it came from:
    reported by a provider, estimated by a tokenizer, derived, or defaulted.
    A gauge that cannot say how it knows is a decoration.

P2. Computational core, zero hard dependencies. Provider SDKs, tokenizers,
    and anything that touches the network are optional adapters.

P3. One schema, three languages. Wire types are defined once, versioned, and
    enforced by shared golden test vectors that every implementation must
    reproduce exactly.

P4. Decisions with visible arithmetic. Any recommendation ships with the
    numbers that produced it. No silent thresholds.

P5. Honest defaults. Where a parameter has not yet been measured, the default
    is labeled provisional and points at the experiment that will replace it.

P6. Nothing phones home. Registry refreshes happen only on explicit call.

## 3. Data model

All types serialize to JSON. Every top-level object carries
`schema_version` (string, currently "0.1").

### 3.1 ModelProfile

Identity and capacities for one model.

| field | type | notes |
|---|---|---|
| model_id | string | canonical form `provider:model`, aliases resolved |
| provider | string | e.g. anthropic, openai, local |
| window_nominal | int | advertised context window, tokens |
| max_output | int or null | per-response output cap |
| pricing | Pricing or null | per-Mtok: input, output, cache_read, cache_write; carries `as_of` date |
| tokenizer_hint | string or null | for estimation adapters |
| effective | CalibrationRecord or null | see 3.4 |
| source | string | bundled snapshot date, user override, or fetched |

The registry ships as a bundled snapshot (works offline), accepts user
overrides, and can refresh explicitly. Pricing is optional and dated because
it goes stale; capacities are the load-bearing fields.

### 3.2 TurnUsage

One normalized accounting record per model response.

| field | type | notes |
|---|---|---|
| turn_id | int | monotonically increasing |
| timestamp | string | ISO 8601 |
| model_id | string | may change mid-conversation |
| input_tokens | int | uncached input |
| cache_read_tokens | int | default 0 |
| cache_write_tokens | int | default 0 |
| output_tokens | int | visible output |
| reasoning_tokens | int | thinking tokens; consume window and money while invisible in message text; default 0 |
| breakdown | Breakdown or null | optional estimate: system_prompt, tool_schemas, history, attachments, query |
| source | enum | reported, estimated, mixed |
| raw | object or null | provider payload passthrough for audit |

`context_total(turn)` is derived: input_tokens + cache_read_tokens +
cache_write_tokens + output_tokens + reasoning_tokens. The hidden consumers
(system prompt, tool schemas, reasoning) are first-class citizens of the
accounting because "where did my context go" is the question users actually
ask.

### 3.3 MeterState

The gauge cluster: a pure function of the profile, the turn history, and
configuration. Measurement only; judgment lives in the Advisor (section 5).

| field | type | notes |
|---|---|---|
| schema_version | string | |
| model_id | string | |
| turns | int | |
| used_tokens | int | context occupied after latest turn |
| window_nominal | int | |
| window_effective | int | equals nominal when uncalibrated |
| effective_source | string | calibration id, or "nominal (uncalibrated)" |
| reserved_output | int | held back for the next response |
| headroom_nominal | int | window_nominal - used - reserved |
| headroom_effective | int | window_effective - used - reserved |
| fill_nominal | float | used / window_nominal |
| fill_effective | float | used / window_effective |
| velocity | float or null | EWMA of per-turn context growth, tokens/turn |
| velocity_std | float or null | dispersion of the same |
| eta_turns | EtaEstimate or null | expected and conservative turns to exhaustion |
| zone | enum | green, caution, critical |
| hidden_overhead | int or null | estimated standing overhead (system + tools) |
| cache | CacheState or null | estimated stable prefix length, last read/write |
| provenance | map | field name to provenance tag |

Definitions. Per-turn growth g_t = used_t - used_(t-1). Velocity is the
exponentially weighted moving average of g_t with smoothing factor alpha
(provisional default 0.3, experiment E1). eta_turns.expected =
headroom_effective / velocity; eta_turns.conservative uses velocity plus one
standard deviation. Until three turns have been recorded, velocity and
eta_turns are null with an explanatory reason rather than a fabricated value.

Zones are keyed to fill_effective. Provisional defaults: caution at 0.70,
critical at 0.85 (experiment E2 replaces these with measured degradation
knees). For comparison, tokenlens hard-codes 0.75/0.85 against the nominal
window and Inspect AI defaults to 0.90; keying to the effective window means
the same zone fires earlier on models whose usable capacity falls short of
the advertised one, which is the point.

### 3.4 CalibrationRecord

| field | type | notes |
|---|---|---|
| model_id | string | |
| effective_context | int | tokens |
| method | string | e.g. published long-context evaluation, local probe kit |
| source | string | citation or artifact reference |
| measured_at | string | date |
| confidence | string | free-form qualifier for now |

Uncalibrated models use nominal capacity and say so. Bundled records cite
their sources; a later probe kit lets users measure their own models.

## 4. Event stream

Renderers and loggers subscribe to a typed event stream. v0.1 delivery is
synchronous callbacks plus an iterator; async delivery is a 0.2 candidate.
Every event carries schema_version, timestamp, turn_id, and a payload:

- TurnRecorded: the TurnUsage plus the resulting MeterState.
- ZoneChanged: from, to, fill_effective at crossing.
- VelocityShift: previous and new velocity when the change exceeds a
  configurable factor (provisional 1.5x).
- AdvisorRecommendation: full Recommendation (section 5).
- HandoffEvaluated: FidelityReport (section 6).
- ModelChanged: old and new model_id, capacity implications.
- CalibrationLoaded: CalibrationRecord applied.

CalibrationLoaded is defined here but not yet emitted by any 0.1
implementation: nothing loads calibrations dynamically yet, and no event
type exists in code before something emits it.

This stream is the entire contract between tokenmaster and ctxmaster. If a
visualizer needs data that is not in an event or in MeterState, that is a
change request against this document.

## 5. Advisor

### 5.1 Interface

A policy consumes measurement and optional task context, returns a
recommendation:

    Policy.evaluate(state: MeterState, task: TaskContext | null) -> Recommendation

TaskContext (v0.1, minimal): expected_remaining_turns (int or null),
task_criticality (low, normal, high). Richer task models are deliberately
deferred.

Recommendation:

| field | type | notes |
|---|---|---|
| action | enum | continue, compact, handoff |
| urgency | enum | none, soon, now |
| rationale | RationaleTrace | the arithmetic: inputs, intermediate values, comparison outcome |
| expected | EffectEstimate | tokens_spent, tokens_freed, cost_delta, fidelity_risk |
| policy_id | string | which policy produced this |

### 5.2 Built-in policies

ThresholdPolicy. Recommend compaction when fill crosses a fraction.
Reproduces current practice (tokenlens, Inspect, Claude Code style) and
exists as the baseline every evaluation compares against.

PredictivePolicy. Compare eta_turns.conservative with
expected_remaining_turns plus a buffer. Act when the projected range no
longer covers the task. This is the fuel-gauge policy: it reacts to
consumption rate, not just level.

CostModelPolicy. Choose the action minimizing expected cost. Definitions,
with all parameters provisional pending experiments E3 and E4:

Symbols: T_pre context size before action; T_post after compaction; T_sum
summary tokens generated; p_in, p_out, p_cr, p_cw prices for input, output,
cache read, cache write; k the expected remaining horizon in turns; L the
information-loss penalty, priced by lambda.

Cost of compacting now:

    C_compact = T_sum * p_out + T_post * p_cw + lambda * E[L]

Cache economics of the aftermath: before compaction each turn reads the
stable prefix at p_cr; after compaction the first turn rewrites the new
prefix at p_cw and later turns read the smaller prefix at p_cr. The
break-even horizon is

    k* = (T_sum * p_out + T_post * (p_cw - p_cr)) / ((T_pre - T_post) * p_cr)

Below k* remaining turns, compaction loses money even before counting
information loss. No existing tool accounts for this; production compaction
can and does raise cost while claiming to save it.

Cost of continuing is the degradation and overflow risk accumulated over the
horizon, using the calibrated effective-capacity curve. Cost of handoff adds
continuation-prompt generation and the measured fidelity risk (section 6)
plus a human-friction constant for interactive settings.

The ledger is kept dual-unit: tokens and currency both, since some users
optimize spend and others optimize context.

## 6. Handoff fidelity protocol

The question "was that continuation prompt any good" becomes measurable.

Inputs: the source context, the handoff artifact (continuation prompt or
compaction summary), a probe budget N, and adapter configuration.

Procedure:
1. Probe generation. Derive N question-answer pairs from the source context,
   stratified across categories: objective, decisions made, constraints,
   current state, artifacts and references. Probes come from an LLM adapter
   or are supplied by the user (fully offline mode).
2. Probing. A model receives only the handoff artifact (plus the standing
   system prompt) and answers each probe.
3. Scoring. Each probe is scored answerable/correct by exact match or judge
   adapter. Fidelity is the weighted mean in [0, 1], reported overall and per
   category.

Output FidelityReport: score, per_category scores, the probe set with
outcomes, method, judge configuration, seeds, and caveats. Seeds and model
identifiers are captured so a report is reproducible. The protocol lives in
the core as data structures and orchestration; every LLM touchpoint is an
adapter, so the core stays offline-capable.

## 7. Ingestion and lifecycle (Python surface; JS and Rust mirror it)

    from tokenmaster import Meter

    m = Meter.for_model("anthropic:claude-sonnet-4-6")   # registry lookup
    m.record(response.usage)                              # dict or adapter object
    s = m.state()                                         # MeterState
    r = m.advise(task=None)                               # Recommendation
    m.subscribe(on_event)                                 # event callbacks
    m.to_json(); Meter.from_json(blob)                    # persistence

    Meter.from_transcript(messages, model_id=..., tokenizer=...)  # offline estimation

Usability bar: one line to attach, zero configuration for known models,
plain dicts accepted everywhere, and nothing imports outside the standard
library unless an adapter is explicitly requested.

JavaScript surface (informative, 0.1). The JS port mirrors this surface
under platform conventions: wire data fields are snake_case exactly as the
schema; methods are camelCase (Meter.forModel, m.state(), m.advise(task,
policy), Meter.fromJSON). toJSON() returns the plain object per the JS
platform convention, so JSON.stringify(meter) is the string form and
fromJSON(blob) parses it back. events() returns a snapshot array, which is
iterable like the reference's iterator. Event timestamps carry a Z suffix
where Python emits +00:00; comparison rule 1 in spec/README.md makes the
format non-normative. Meter.from_transcript above is not implemented in any
language at 0.1 and is tracked as planned work.

## 8. Adapters and extension points

Optional extras, never hard dependencies: provider normalizers (Anthropic,
OpenAI, LiteLLM passthrough, local runtimes), tokenizer estimators (tiktoken,
HF tokenizers), probe generators and judges for the fidelity protocol, and
continuation-prompt generators. Third parties extend by implementing Policy,
by consuming the event stream, or by shipping adapters; none of these require
touching the core.

## 9. Versioning and conformance

schema_version follows compatibility semantics: minor versions may add
optional fields, major versions may break the wire format. The repository
carries golden vectors under spec/vectors: JSON fixtures mapping a
ModelProfile plus a TurnUsage sequence to the exact expected MeterState
values (to stated precision) and event sequence. An implementation is
conformant when it reproduces every vector. The vectors are the
cross-language specification made executable, and they are a citable
artifact for the paper.

## 10. Position against prior art

| capability | tokenlens (npm) | platform compaction (Anthropic/OpenAI) | SelfCompact and kin | tokenmaster |
|---|---|---|---|---|
| cross-provider usage normalization | yes | no | no | yes |
| remaining vs nominal window | yes | model-internal | no | yes |
| calibrated effective capacity | heuristic only | no | no | yes |
| turns-to-exhaustion prediction | no | no | no | yes |
| provenance on every number | no | no | no | yes |
| decision rationale exposed | boolean | silent | model judgment | full arithmetic |
| cache-aware compaction economics | no | no | no | yes |
| handoff fidelity measurement | no | no | no | yes |
| one schema across py/js/rust | no | n/a | n/a | yes |

The honest caveats: tokenlens is shipped and popular while this is a draft;
platform compaction executes the rewrite itself, which tokenmaster
deliberately does not; SelfCompact addresses when-to-compact inside an agent
by delegating to the model, which is a different answer to the same question
and must be a baseline in the paper.

## 11. Resolved decisions (2026-07-07)

D1. Zones: caution 0.70, critical 0.85 on fill_effective, provisional until
    experiment E2.
D2. Velocity: EWMA alpha 0.3, three-turn cold start.
D3. Cost ledger: dual-unit, tokens and currency.
D4. Fidelity protocol: core module; every LLM touchpoint is an adapter extra.
D5. Events: synchronous callbacks plus iterator in 0.1; async revisited at
    0.2.
D6. TaskContext: minimal (expected_remaining_turns, task_criticality).
D7. Serialization: to_json round-trips within a minor version; the stability
    commitment across versions begins at 0.2.
D8. Class name: Meter.
D9. Registry: bundles capacities and dated pricing.
D10. ctxmaster presentation ruling: the token usage meter is the hero
    surface; advice, events, and fidelity reporting are ancillary panels
    around it. Recorded here because it constrains the core: MeterState must
    always be renderable standalone, without consulting the event history.
