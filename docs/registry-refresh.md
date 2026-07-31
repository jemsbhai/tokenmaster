# Model registry maintenance

Tokenmaster's runtime is offline by design. Registry updates happen only
when a maintainer explicitly invokes the Python 0.2 maintenance command:

```console
tokenmaster-models check --registry python/tokenmaster/src/tokenmaster/data/models.json --repo-root .
tokenmaster-models discover --registry python/tokenmaster/src/tokenmaster/data/models.json
tokenmaster-models propose --registry python/tokenmaster/src/tokenmaster/data/models.json --output models.proposed.json
tokenmaster-models apply --registry python/tokenmaster/src/tokenmaster/data/models.json --repo-root .
```

`check` is read-only and exits nonzero when tracked values or committed
generated copies drift. `discover` reports official catalog models that also
have Standard token-pricing rows but does not add profiles. The registry keeps
a reviewed discovery baseline, so a newly priced model makes the next check
fail for review. `propose` writes a
complete candidate registry for review. `apply` is the only mutating command,
requires an explicit registry path, writes atomically, and can regenerate the
JavaScript and Rust copies.

## OpenAI source policy

The built-in adapter accepts HTTPS documents from
`developers.openai.com` only. It combines:

- the full model catalog, for discovery;
- the named Standard table on the central pricing page; and
- each tracked model's Markdown page, for canonical ID, context capacity,
  output cap, direct token prices, tier threshold, and cache-write policy.

Central and per-model prices must agree. Redirect hosts, response type, UTF-8
decoding, document size, model-page identity, capacity arithmetic, and
cache-write multipliers are validated before a proposal can be written.
Every report records parser version, source URLs, and SHA-256 document hashes.
Named pricing columns are mapped by header rather than position. Missing
tracked limits, partial prices, parser drift, source disagreement, malformed
or non-finite registry values, and discovery removals all fail closed or mark
the report as requiring review.

Aliases, new models, and removals are never applied automatically. Missing
prices are not converted to zero. A reviewed zero cache-write policy may be
preserved for an already tracked model when both Standard table cells remain
explicitly unpriced; this does not apply to discovered models.

## Scheduled drift detection

`.github/workflows/registry-refresh.yml` runs `check` weekly and on manual
dispatch, then uploads the JSON report. It has read-only repository
permissions. It neither commits nor opens a pull request, and it never
publishes a package. A maintainer reviews a proposal, runs all three language
suites, and deliberately applies it.

The workflow first runs offline parser and fault-injection fixtures. Even a
network or parser failure emits a structured error report. GitHub-maintained
actions are pinned to immutable commits. Applying with `--repo-root` stages
all three registry payloads before replacement and rolls them back together
if a later replacement fails; generated files are byte-deterministic across
the Python and npm generators.

The first provider adapter is OpenAI because its official Markdown catalog,
model pages, and central pricing table expose the required facts. The parser
and proposal API use an injected fetcher, so additional authoritative
provider adapters and fully offline fixture checks can be added without
changing the normal Tokenmaster runtime.
