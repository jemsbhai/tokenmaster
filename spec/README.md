# tokenmaster conformance vectors

This directory is the executable cross-language specification (contract
section 9). Each JSON file under `vectors/` maps one ModelProfile, one Meter
configuration, and one TurnUsage sequence to the exact MeterState after every
turn and the exact event sequence. An implementation (Python, JavaScript,
Rust) is conformant when it reproduces every vector under the comparison
rules below.

Status: the Python reference, the JavaScript port (npm 0.1.0, repository
tag js-v0.1.0), and the Rust port (crates.io 0.1.0, repository tag
rust-v0.1.0) reproduce every vector.

## Vector format

    {
      "schema_version": "0.1",
      "vector_id": "...",
      "description": "...",
      "profile": { ModelProfile },
      "config": { reserved_output, alpha, caution, critical,
                  velocity_shift_factor },
      "turns": [ TurnUsage, ... ],
      "expected": {
        "states": [ MeterState after turn 1, after turn 2, ... ],
        "events": [ { "event_type", "turn_id", ...essentials }, ... ]
      }
    }

## Comparison rules (normative)

1. Timestamps are excluded from comparison everywhere. Input turns carry
   fixed timestamps only so the fixtures are byte-stable.
2. Floating-point fields compare within 1e-9 (absolute or relative,
   whichever is looser). Integers, strings, booleans, and nulls compare
   exactly.
3. Provenance strings are normative: implementations must produce the same
   reason texts, since visualizers render them.
4. Event order is normative and per turn is: turn_recorded, zone_changed,
   velocity_shift, model_changed (each only when emitted).
5. A turn_recorded event's payload must structurally equal the recorded turn
   and the state after that turn; vectors therefore store it slim (type and
   turn_id only). Other event entries carry their payload essentials:
   zone_changed (from_zone, to_zone, fill_effective), velocity_shift
   (previous, current), model_changed (previous_model_id, new_model_id).

## Regeneration

Vectors are generated from the Python reference implementation and
committed after human review:

    python spec/generate_vectors.py

Regenerating and diffing is the intended way to see whether a change to the
core is behavior-preserving. Advisor and fidelity vectors are the next
planned addition.
