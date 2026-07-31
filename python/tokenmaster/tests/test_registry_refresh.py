"""Offline tests for the explicit official-registry refresh path."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

import tokenmaster.registry_refresh as refresh_module
from tokenmaster.registry_refresh import (
    OPENAI_CATALOG_URL,
    OPENAI_MODEL_URL,
    OPENAI_PRICING_URL,
    RegistryRefreshError,
    apply_registry_update,
    fetch_official_document,
    parse_openai_catalog,
    parse_openai_model_page,
    parse_openai_standard_pricing,
    propose_registry_refresh,
    repository_copies_match,
    sync_repository_copies,
    write_registry,
)


PRICING = """\
# Pricing

### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | $10.00 | $1.00 | $12.50 | $45.00 |
| gpt-5.7-new | $7.00 | $0.70 | $8.75 | $42.00 | - | - | - | - |

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $2.50 | $0.25 | $3.125 | $15.00 | $5.00 | $0.50 | $6.25 | $22.50 |
"""

CATALOG = """\
# Models

- [GPT-5.6 Sol](/api/docs/models/gpt-5.6-sol.md): Frontier model.
- [GPT-5.7 New](/api/docs/models/gpt-5.7-new.md): Candidate model.
"""

SOL_PAGE = """\
# GPT-5.6 Sol

Model ID: `gpt-5.6-sol`

The `gpt-5.6` alias routes requests to GPT-5.6 Sol.

## Model details

- 1,050,000 context window
- Maximum input tokens: 922,000
- 128,000 max output tokens

## Pricing

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $5 | 1M tokens |
| Cached input | $0.5 | 1M tokens |
| Output | $30 | 1M tokens |

- Prompts with >272K input tokens are priced at 2x input and 1.5x output.
- Cache writes are billed at 1.25x the uncached input token rate.

## Endpoints
"""


def _registry(*, current: bool = False):
    base_write = 6.25 if current else 0.0
    model = {
        "model_id": "openai:gpt-5.6-sol",
        "provider": "openai",
        "aliases": ["gpt-5.6"] if current else [],
        "window_nominal": 1_050_000 if current else 1_000_000,
        "max_output": 128_000,
        "pricing": {
            "input": 5.0,
            "output": 30.0,
            "cache_read": 0.5,
            "cache_write": base_write,
            "currency": "USD",
            "as_of": "2026-07-01",
        },
        "tokenizer_hint": None,
        "source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    }
    if current:
        model["pricing_tiers"] = [
            {
                "min_input_tokens": 272_001,
                "pricing": {
                    "input": 10.0,
                    "output": 45.0,
                    "cache_read": 1.0,
                    "cache_write": 12.5,
                    "currency": "USD",
                    "as_of": "2026-07-31",
                },
            }
        ]
        model["pricing_scope"] = {
            "service_tier": "standard",
            "region": "global",
            "basis": "request_input_tokens",
        }
        model["pricing"]["as_of"] = "2026-07-31"
    registry = {
        "schema_version": "0.1",
        "snapshot_date": "2026-07-31" if current else "2026-07-01",
        "models": [model],
    }
    if current:
        registry["provider_discovery"] = {
            "openai": {
                "catalog_source": OPENAI_CATALOG_URL,
                "pricing_source": OPENAI_PRICING_URL,
                "known_unregistered_models": ["openai:gpt-5.7-new"],
            }
        }
    return registry


def _fetcher(url: str) -> str:
    documents = {
        OPENAI_PRICING_URL: PRICING,
        OPENAI_CATALOG_URL: CATALOG,
        OPENAI_MODEL_URL.format(model_id="gpt-5.6-sol"): SOL_PAGE,
    }
    return documents[url]


def test_parsers_select_standard_prices_and_exact_limits():
    rows = parse_openai_standard_pricing(PRICING)
    assert rows["gpt-5.6-sol"].short_cache_write == 6.25
    assert rows["gpt-5.6-sol"].long_output == 45.0
    assert parse_openai_catalog(CATALOG) == {"gpt-5.6-sol", "gpt-5.7-new"}

    details = parse_openai_model_page(SOL_PAGE)
    assert details.model_id == "gpt-5.6-sol"
    assert details.window_nominal == 1_050_000
    assert details.max_input == 922_000
    assert details.max_output == 128_000
    assert details.long_context_min_input == 272_001
    assert details.cache_write_multiplier == 1.25
    assert details.aliases == ("gpt-5.6",)


def test_proposal_updates_tracked_values_but_never_auto_adds_models_or_aliases():
    candidate, report = propose_registry_refresh(
        _registry(), fetcher=_fetcher, as_of=date(2026, 7, 31)
    )
    model = candidate["models"][0]
    assert model["window_nominal"] == 1_050_000
    assert model["pricing"]["cache_write"] == 6.25
    assert model["pricing"]["as_of"] == "2026-07-31"
    assert model["pricing_tiers"][0]["min_input_tokens"] == 272_001
    assert model["pricing_tiers"][0]["pricing"]["output"] == 45.0
    assert model["aliases"] == []
    assert report.alias_suggestions == {"openai:gpt-5.6-sol": ("gpt-5.6",)}
    assert report.discovered_models == ("openai:gpt-5.7-new",)
    assert report.new_models == ("openai:gpt-5.7-new",)
    assert report.missing_discovery_models == ()
    assert candidate["provider_discovery"]["openai"][
        "known_unregistered_models"
    ] == ["openai:gpt-5.7-new"]
    assert [item["model_id"] for item in candidate["models"]] == [
        "openai:gpt-5.6-sol"
    ]
    assert report.has_drift
    assert len(report.sources) == 3
    assert all(len(source.sha256) == 64 for source in report.sources)


def test_unchanged_values_keep_their_as_of_dates():
    candidate, report = propose_registry_refresh(
        _registry(current=True), fetcher=_fetcher, as_of=date(2026, 8, 1)
    )
    model = candidate["models"][0]
    assert model["pricing"]["as_of"] == "2026-07-31"
    assert model["pricing_tiers"][0]["pricing"]["as_of"] == "2026-07-31"
    assert not report.has_drift


def test_source_disagreement_fails_closed():
    mismatched = SOL_PAGE.replace("| Input | $5 |", "| Input | $6 |")

    def fetch(url: str) -> str:
        if url.endswith("gpt-5.6-sol.md"):
            return mismatched
        return _fetcher(url)

    with pytest.raises(RegistryRefreshError, match="disagrees"):
        propose_registry_refresh(_registry(), fetcher=fetch)


def test_partial_long_price_fails_closed_instead_of_inferring_zero():
    partial = PRICING.replace(
        "$10.00 | $1.00 | $12.50 | $45.00",
        "$10.00 | $1.00 | - | $45.00",
    )

    def fetch(url: str) -> str:
        if url == OPENAI_PRICING_URL:
            return partial
        return _fetcher(url)

    with pytest.raises(RegistryRefreshError, match="partial long-context"):
        propose_registry_refresh(
            _registry(), fetcher=fetch, as_of=date(2026, 7, 31)
        )


def test_sync_repository_copies_are_semantically_equal(tmp_path):
    (tmp_path / "rust" / "tokenmaster" / "data").mkdir(parents=True)
    (tmp_path / "js" / "tokenmaster" / "src").mkdir(parents=True)
    registry = _registry(current=True)
    canonical = tmp_path / "python/tokenmaster/src/tokenmaster/data/models.json"
    canonical.parent.mkdir(parents=True)
    write_registry(canonical, registry)
    assert json.loads(canonical.read_text(encoding="utf-8")) == registry
    sync_repository_copies(tmp_path, registry)
    assert repository_copies_match(tmp_path, registry)
    canonical_text = canonical.read_text(encoding="utf-8")
    assert (tmp_path / "rust/tokenmaster/data/models.json").read_text(
        encoding="utf-8"
    ) == canonical_text
    assert canonical_text.rstrip() in (
        tmp_path / "js/tokenmaster/src/models-data.ts"
    ).read_text(encoding="utf-8")


def test_network_fetch_rejects_non_official_hosts_before_io():
    with pytest.raises(RegistryRefreshError, match="non-official"):
        fetch_official_document("https://example.com/models.md")


def test_missing_or_renamed_output_cap_fails_closed():
    missing = SOL_PAGE.replace("- 128,000 max output tokens\n", "")
    with pytest.raises(RegistryRefreshError, match="max output tokens"):
        parse_openai_model_page(missing)

    renamed = SOL_PAGE.replace("max output tokens", "maximum generated tokens")
    with pytest.raises(RegistryRefreshError, match="max output tokens"):
        parse_openai_model_page(renamed)


def test_reordered_pricing_columns_are_mapped_by_header_name():
    lines = PRICING.splitlines()
    table_rows = [index for index, line in enumerate(lines) if line.startswith("|")]
    header_index, separator_index, sol_index, new_index = table_rows[:4]
    order = [0, 8, 7, 6, 5, 4, 3, 2, 1]

    def reordered(line: str) -> str:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        return "| " + " | ".join(cells[index] for index in order) + " |"

    lines[header_index] = reordered(lines[header_index])
    lines[separator_index] = reordered(lines[separator_index])
    lines[sol_index] = reordered(lines[sol_index])
    lines[new_index] = reordered(lines[new_index])
    rows = parse_openai_standard_pricing("\n".join(lines))
    sol = rows["gpt-5.6-sol"]
    assert sol.long_input == 10.0
    assert sol.long_cache_read == 1.0
    assert sol.long_cache_write == 12.5
    assert sol.long_output == 45.0


def test_renamed_or_duplicate_pricing_columns_fail_closed():
    renamed = PRICING.replace("Long context output", "Extended output", 1)
    with pytest.raises(RegistryRefreshError, match="columns changed"):
        parse_openai_standard_pricing(renamed)

    duplicate = PRICING.replace(
        "Long context output",
        "Long context cache writes",
        1,
    )
    with pytest.raises(RegistryRefreshError, match="duplicate columns"):
        parse_openai_standard_pricing(duplicate)


def test_lost_cache_write_policy_fails_instead_of_preserving_stale_rate():
    missing_prices = PRICING.replace("$6.25", "-", 1).replace("$12.50", "-", 1)
    missing_policy = SOL_PAGE.replace(
        "- Cache writes are billed at 1.25x the uncached input token rate.\n",
        "",
    )

    def fetch(url: str) -> str:
        if url == OPENAI_PRICING_URL:
            return missing_prices
        if url.endswith("gpt-5.6-sol.md"):
            return missing_policy
        return _fetcher(url)

    with pytest.raises(RegistryRefreshError, match="cache-write"):
        propose_registry_refresh(_registry(current=True), fetcher=fetch)


def test_missing_discovery_entries_require_review_and_are_not_deleted():
    registry = _registry(current=True)
    registry["provider_discovery"]["openai"]["known_unregistered_models"].append(
        "openai:gpt-removed"
    )
    candidate, report = propose_registry_refresh(registry, fetcher=_fetcher)
    assert report.missing_discovery_models == ("openai:gpt-removed",)
    assert report.has_drift
    assert "openai:gpt-removed" in candidate["provider_discovery"]["openai"][
        "known_unregistered_models"
    ]


def test_discovery_only_update_advances_snapshot_date():
    registry = _registry(current=True)
    registry["snapshot_date"] = "2026-07-31"
    registry["provider_discovery"]["openai"]["known_unregistered_models"] = []
    candidate, report = propose_registry_refresh(
        registry,
        fetcher=_fetcher,
        as_of=date(2026, 8, 1),
    )
    assert report.new_models == ("openai:gpt-5.7-new",)
    assert candidate["snapshot_date"] == "2026-08-01"


def test_existing_additional_tiers_are_preserved():
    registry = _registry(current=True)
    registry["models"][0]["pricing_tiers"].append(
        {
            "min_input_tokens": 500_000,
            "pricing": {
                "input": 20.0,
                "output": 90.0,
                "cache_read": 2.0,
                "cache_write": 25.0,
                "currency": "USD",
                "as_of": "2026-07-31",
            },
        }
    )
    candidate, _ = propose_registry_refresh(registry, fetcher=_fetcher)
    assert [
        tier["min_input_tokens"]
        for tier in candidate["models"][0]["pricing_tiers"]
    ] == [272_001, 500_000]


def test_moved_official_threshold_replaces_unique_standard_provider_tier():
    registry = _registry(current=True)

    def fetcher(url: str) -> str:
        if url == OPENAI_MODEL_URL.format(model_id="gpt-5.6-sol"):
            return SOL_PAGE.replace(">272K", ">300K")
        return _fetcher(url)

    candidate, _ = propose_registry_refresh(registry, fetcher=fetcher)
    assert [
        tier["min_input_tokens"]
        for tier in candidate["models"][0]["pricing_tiers"]
    ] == [300_001]


def test_moved_official_threshold_fails_closed_when_tier_ownership_is_ambiguous():
    registry = _registry(current=True)
    registry["models"][0]["pricing_tiers"].append(
        {
            "min_input_tokens": 500_000,
            "pricing": {
                "input": 20.0,
                "output": 90.0,
                "cache_read": 2.0,
                "cache_write": 25.0,
                "currency": "USD",
                "as_of": "2026-07-31",
            },
        }
    )

    def fetcher(url: str) -> str:
        if url == OPENAI_MODEL_URL.format(model_id="gpt-5.6-sol"):
            return SOL_PAGE.replace(">272K", ">300K")
        return _fetcher(url)

    with pytest.raises(RegistryRefreshError, match="ambiguous existing pricing tiers"):
        propose_registry_refresh(registry, fetcher=fetcher)


def test_malformed_tier_and_nonfinite_price_are_rejected():
    malformed = _registry(current=True)
    malformed["models"][0]["pricing_tiers"] = [None]
    with pytest.raises(RegistryRefreshError, match="must be an object"):
        propose_registry_refresh(malformed, fetcher=_fetcher)

    nonfinite = _registry(current=True)
    nonfinite["models"][0]["pricing"]["input"] = float("nan")
    with pytest.raises(RegistryRefreshError, match="finite"):
        write_registry(Path("unused.json"), nonfinite)


@pytest.mark.parametrize(
    "value, message",
    [
        ("cache_write_tokens", "array of strings"),
        (["storage_tokens"], "unsupported unpriced usage category"),
        (
            ["cache_write_tokens", "cache_write_tokens"],
            "must be unique",
        ),
    ],
)
def test_unpriced_usage_categories_are_strictly_validated(value, message):
    registry = _registry(current=True)
    registry["models"][0]["pricing_scope"]["unpriced_usage_categories"] = value
    with pytest.raises(RegistryRefreshError, match=message):
        propose_registry_refresh(registry, fetcher=_fetcher)


@pytest.mark.parametrize("failure_number", [2, 3])
def test_apply_rolls_back_all_files_when_a_later_replace_fails(
    tmp_path, monkeypatch, failure_number
):
    canonical = tmp_path / "python/tokenmaster/src/tokenmaster/data/models.json"
    rust = tmp_path / "rust/tokenmaster/data/models.json"
    js = tmp_path / "js/tokenmaster/src/models-data.ts"
    for path, payload in (
        (canonical, "old canonical\n"),
        (rust, "old rust\n"),
        (js, "old js\n"),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
    originals = {path: path.read_bytes() for path in (canonical, rust, js)}
    real_replace = refresh_module.os.replace
    calls = 0

    def fail_once(source, target):
        nonlocal calls
        calls += 1
        if calls == failure_number:
            raise OSError("injected replacement failure")
        return real_replace(source, target)

    monkeypatch.setattr(refresh_module.os, "replace", fail_once)
    with pytest.raises(RegistryRefreshError, match="transactional"):
        apply_registry_update(canonical, tmp_path, _registry(current=True))
    assert {path: path.read_bytes() for path in (canonical, rust, js)} == originals


def test_cli_accepts_registry_equals_syntax_and_writes_failure_reports(
    tmp_path, monkeypatch
):
    canonical = tmp_path / "python/tokenmaster/src/tokenmaster/data/models.json"
    (tmp_path / "rust/tokenmaster/data").mkdir(parents=True)
    (tmp_path / "js/tokenmaster/src").mkdir(parents=True)
    canonical.parent.mkdir(parents=True)
    write_registry(canonical, _registry(current=True))
    (tmp_path / "rust/tokenmaster/data/models.json").write_text("old\n")
    (tmp_path / "js/tokenmaster/src/models-data.ts").write_text("old\n")
    monkeypatch.setattr(refresh_module, "fetch_official_document", _fetcher)

    assert refresh_module.main(
        [
            "apply",
            f"--registry={canonical}",
            "--repo-root",
            str(tmp_path),
        ]
    ) == 0
    assert repository_copies_match(tmp_path, _registry(current=True))

    def broken_fetch(_url: str) -> str:
        raise RegistryRefreshError("injected parser failure")

    monkeypatch.setattr(refresh_module, "fetch_official_document", broken_fetch)
    report_path = tmp_path / "failure.json"
    assert refresh_module.main(
        [
            "check",
            f"--registry={canonical}",
            "--report",
            str(report_path),
        ]
    ) == 2
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "error"
    assert report["has_drift"] is True
    assert "injected parser failure" in report["error"]
