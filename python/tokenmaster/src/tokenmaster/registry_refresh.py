"""Explicit, reviewable refreshes of Tokenmaster's bundled model registry.

The runtime registry is deliberately offline.  This module is maintainer
tooling: it reads official provider documentation only when a caller invokes
``check``, ``propose``, ``discover``, or ``apply``.

OpenAI is the first built-in provider adapter because its documentation has
stable Markdown endpoints for the model catalog, model details, and pricing.
The public parser/proposal functions accept an injected fetcher so CI and
downstream tools can run deterministically without network access.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import stat
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlparse
from urllib.request import Request, urlopen

PARSER_VERSION = "1"
OPENAI_DOCS_ORIGIN = "https://developers.openai.com"
OPENAI_PRICING_URL = f"{OPENAI_DOCS_ORIGIN}/api/docs/pricing.md"
OPENAI_CATALOG_URL = f"{OPENAI_DOCS_ORIGIN}/api/docs/models/all.md"
OPENAI_MODEL_URL = f"{OPENAI_DOCS_ORIGIN}/api/docs/models/{{model_id}}.md"
DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_DOCUMENT_BYTES = 2_000_000

Fetcher = Callable[[str], str]

__all__ = [
    "PARSER_VERSION",
    "OPENAI_PRICING_URL",
    "OPENAI_CATALOG_URL",
    "OPENAI_MODEL_URL",
    "RegistryRefreshError",
    "PricingRow",
    "ModelDetails",
    "RefreshChange",
    "SourceDocument",
    "RefreshReport",
    "fetch_official_document",
    "parse_openai_standard_pricing",
    "parse_openai_catalog",
    "parse_openai_model_page",
    "propose_registry_refresh",
    "validate_registry_data",
    "write_registry",
    "sync_repository_copies",
    "apply_registry_update",
    "repository_copies_match",
    "main",
]


class RegistryRefreshError(RuntimeError):
    """Raised when official data is incomplete, inconsistent, or unsafe."""


@dataclass(frozen=True)
class PricingRow:
    """One row from OpenAI's Standard token-pricing table."""

    model_id: str
    short_input: float
    short_cache_read: float | None
    short_cache_write: float | None
    short_output: float
    long_input: float | None
    long_cache_read: float | None
    long_cache_write: float | None
    long_output: float | None


@dataclass(frozen=True)
class ModelDetails:
    """Capacity and pricing facts parsed from one official model page."""

    model_id: str
    window_nominal: int
    max_input: int | None
    max_output: int
    input_price: float
    cache_read_price: float | None
    output_price: float
    long_context_min_input: int | None
    cache_write_multiplier: float | None
    aliases: tuple[str, ...]


@dataclass(frozen=True)
class RefreshChange:
    model_id: str
    field: str
    before: Any
    after: Any
    source: str


@dataclass(frozen=True)
class SourceDocument:
    url: str
    sha256: str


@dataclass
class _StagedWrite:
    path: Path
    temporary: Path
    original: bytes | None
    mode: int


@dataclass(frozen=True)
class RefreshReport:
    """Auditable result of a refresh proposal."""

    parser_version: str
    checked_at: str
    tracked_models: int
    changes: tuple[RefreshChange, ...]
    discovered_models: tuple[str, ...]
    new_models: tuple[str, ...]
    missing_discovery_models: tuple[str, ...]
    alias_suggestions: Mapping[str, tuple[str, ...]]
    warnings: tuple[str, ...]
    sources: tuple[SourceDocument, ...]

    @property
    def has_drift(self) -> bool:
        return bool(
            self.changes
            or self.alias_suggestions
            or self.missing_discovery_models
            or self.warnings
        )

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["status"] = "ok"
        payload["has_drift"] = self.has_drift
        return payload


def fetch_official_document(
    url: str,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    max_bytes: int = MAX_DOCUMENT_BYTES,
) -> str:
    """Fetch one allow-listed official Markdown document.

    Redirect targets are checked as well as the requested URL.  A size limit
    prevents an unexpected response from consuming unbounded memory.
    """

    _require_official_url(url)
    request = Request(
        url,
        headers={"User-Agent": "tokenmaster-registry-refresh/0.2"},
    )
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - allow-listed HTTPS
        final_url = response.geturl()
        _require_official_url(final_url)
        raw = response.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise RegistryRefreshError(
                f"official document exceeds {max_bytes} bytes: {final_url}"
            )
        content_type = response.headers.get_content_type()
        if content_type not in {"text/plain", "text/markdown"}:
            raise RegistryRefreshError(
                f"unexpected content type {content_type!r} for {final_url}"
            )
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RegistryRefreshError(
            f"official document is not valid UTF-8: {final_url}"
        ) from exc


def parse_openai_standard_pricing(markdown: str) -> dict[str, PricingRow]:
    """Parse the named Standard table, ignoring Batch/Flex/Fast tables."""

    marker = "### Standard pricing data"
    start = markdown.find(marker)
    if start < 0:
        raise RegistryRefreshError("OpenAI pricing page has no Standard pricing table")
    section = markdown[start + len(marker) :]
    next_heading = re.search(r"\n###\s+", section)
    if next_heading:
        section = section[: next_heading.start()]

    expected_headers = (
        "model",
        "short context input",
        "short context cached input",
        "short context cache writes",
        "short context output",
        "long context input",
        "long context cached input",
        "long context cache writes",
        "long context output",
    )
    header_index: dict[str, int] | None = None
    rows: dict[str, PricingRow] = {}
    for line in section.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        normalized = tuple(" ".join(cell.lower().split()) for cell in cells)
        if normalized and normalized[0] == "model":
            if len(normalized) != len(set(normalized)):
                raise RegistryRefreshError("OpenAI Standard pricing has duplicate columns")
            if set(normalized) != set(expected_headers):
                missing = sorted(set(expected_headers) - set(normalized))
                unexpected = sorted(set(normalized) - set(expected_headers))
                raise RegistryRefreshError(
                    "OpenAI Standard pricing columns changed; "
                    f"missing={missing}, unexpected={unexpected}"
                )
            header_index = {name: normalized.index(name) for name in expected_headers}
            continue
        if cells and set(cells[0]) <= {"-", ":", " "}:
            continue
        if header_index is None:
            continue
        if len(cells) != len(expected_headers):
            raise RegistryRefreshError(
                f"OpenAI Standard pricing row has {len(cells)} columns; "
                f"expected {len(expected_headers)}"
            )
        model_cell = cells[header_index["model"]]
        model_id = re.sub(r"\s+\([^)]*\)\s*$", "", model_cell).strip(" `")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", model_id):
            raise RegistryRefreshError(f"unsafe model id in pricing table: {model_id!r}")
        prices = {
            name: _parse_price(cells[index])
            for name, index in header_index.items()
            if name != "model"
        }
        if prices["short context input"] is None or prices["short context output"] is None:
            raise RegistryRefreshError(
                f"standard pricing lacks required input/output values for {model_id}"
            )
        if model_id in rows:
            raise RegistryRefreshError(f"duplicate Standard pricing row for {model_id}")
        rows[model_id] = PricingRow(
            model_id=model_id,
            short_input=prices["short context input"],
            short_cache_read=prices["short context cached input"],
            short_cache_write=prices["short context cache writes"],
            short_output=prices["short context output"],
            long_input=prices["long context input"],
            long_cache_read=prices["long context cached input"],
            long_cache_write=prices["long context cache writes"],
            long_output=prices["long context output"],
        )
    if header_index is None:
        raise RegistryRefreshError("OpenAI Standard pricing table has no header")
    if not rows:
        raise RegistryRefreshError("OpenAI Standard pricing table parsed no rows")
    return rows


def parse_openai_catalog(markdown: str) -> set[str]:
    """Return canonical slugs linked from the official full catalog."""

    models = set(
        re.findall(r"\(/api/docs/models/([a-z0-9][a-z0-9._-]*)\.md\)", markdown)
    )
    if not models:
        raise RegistryRefreshError("OpenAI model catalog parsed no model links")
    return models


def parse_openai_model_page(markdown: str) -> ModelDetails:
    """Parse a model page and reject partial capacity/pricing data."""

    model_id = _required_group(markdown, r"Model ID:\s*`([^`]+)`", "Model ID")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", model_id):
        raise RegistryRefreshError(f"unsafe Model ID on model page: {model_id!r}")
    window = _parse_token_count(
        _required_group(markdown, r"-\s*([\d,]+)\s+context window", "context window")
    )
    max_input_match = re.search(r"-\s*Maximum input tokens:\s*([\d,]+)", markdown)
    max_input = (
        _parse_token_count(max_input_match.group(1)) if max_input_match else None
    )
    max_output = _parse_token_count(
        _required_group(
            markdown,
            r"-\s*([\d,]+)\s+max output tokens",
            "max output tokens",
        )
    )
    if window <= 0 or max_output <= 0 or max_output > window:
        raise RegistryRefreshError(
            f"invalid capacity values for {model_id}: window={window}, "
            f"max_output={max_output}"
        )
    metrics = _parse_model_price_metrics(markdown)
    if "Input" not in metrics or "Output" not in metrics:
        raise RegistryRefreshError(f"model page lacks token pricing for {model_id}")

    threshold_match = re.search(
        r">\s*([\d,.]+)\s*([KkMm]?)\s+input tokens", markdown
    )
    threshold = None
    if threshold_match:
        threshold = _scaled_integer(threshold_match.group(1), threshold_match.group(2)) + 1
    multiplier_match = re.search(
        r"Cache writes are billed at\s*([\d.]+)x", markdown, re.IGNORECASE
    )
    multiplier = float(multiplier_match.group(1)) if multiplier_match else None
    aliases = tuple(
        sorted(
            set(
                re.findall(
                    r"The\s+`([^`]+)`\s+alias routes requests to", markdown,
                    re.IGNORECASE,
                )
            )
        )
    )
    return ModelDetails(
        model_id=model_id,
        window_nominal=window,
        max_input=max_input,
        max_output=max_output,
        input_price=metrics["Input"],
        cache_read_price=metrics.get("Cached input"),
        output_price=metrics["Output"],
        long_context_min_input=threshold,
        cache_write_multiplier=multiplier,
        aliases=aliases,
    )


def propose_registry_refresh(
    registry_data: Mapping[str, Any],
    *,
    fetcher: Fetcher = fetch_official_document,
    as_of: date | None = None,
    include_discovery: bool = True,
) -> tuple[dict[str, Any], RefreshReport]:
    """Build, but do not write, a validated registry refresh proposal."""

    candidate = copy.deepcopy(dict(registry_data))
    validate_registry_data(candidate)
    models = candidate.get("models")
    if not isinstance(models, list):
        raise RegistryRefreshError("registry must contain a models array")
    refresh_date = as_of or datetime.now(timezone.utc).date()
    checked_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    fetched: dict[str, str] = {}

    def read(url: str) -> str:
        if url not in fetched:
            fetched[url] = fetcher(url)
        return fetched[url]

    pricing_rows = parse_openai_standard_pricing(read(OPENAI_PRICING_URL))
    catalog = parse_openai_catalog(read(OPENAI_CATALOG_URL))
    changes: list[RefreshChange] = []
    warnings: list[str] = []
    alias_suggestions: dict[str, tuple[str, ...]] = {}
    tracked_ids: set[str] = set()

    def replace(model: dict[str, Any], field: str, value: Any, source: str) -> None:
        before = model.get(field)
        if before != value:
            changes.append(
                RefreshChange(
                    model_id=str(model["model_id"]),
                    field=field,
                    before=before,
                    after=value,
                    source=source,
                )
            )
            model[field] = value

    for raw_model in models:
        if not isinstance(raw_model, dict) or raw_model.get("provider") != "openai":
            continue
        canonical = raw_model.get("model_id")
        if not isinstance(canonical, str) or not canonical.startswith("openai:"):
            raise RegistryRefreshError(f"invalid OpenAI canonical model id: {canonical!r}")
        slug = canonical.split(":", 1)[1]
        tracked_ids.add(slug)
        if slug not in catalog:
            raise RegistryRefreshError(
                f"tracked model {slug} is absent from the official model catalog"
            )
        row = pricing_rows.get(slug)
        if row is None:
            raise RegistryRefreshError(
                f"tracked model {slug} is absent from Standard pricing"
            )
        model_url = OPENAI_MODEL_URL.format(model_id=slug)
        details = parse_openai_model_page(read(model_url))
        if details.model_id != slug:
            raise RegistryRefreshError(
                f"model page mismatch: expected {slug}, found {details.model_id}"
            )
        _cross_check_pricing(row, details)
        if details.max_input is not None:
            derived = details.window_nominal - details.max_output
            if derived != details.max_input:
                raise RegistryRefreshError(
                    f"{slug} maximum input {details.max_input} cannot be represented "
                    f"by window {details.window_nominal} - max output {details.max_output}"
                )

        replace(raw_model, "window_nominal", details.window_nominal, model_url)
        replace(raw_model, "max_output", details.max_output, model_url)
        pricing = raw_model.get("pricing")
        if not isinstance(pricing, dict):
            raise RegistryRefreshError(f"tracked OpenAI model {slug} has no pricing object")
        revised_pricing = dict(pricing)
        revised_pricing["input"] = row.short_input
        revised_pricing["output"] = row.short_output
        if row.short_cache_read is None or details.cache_read_price is None:
            raise RegistryRefreshError(f"{slug} has no authoritative cache-read price")
        revised_pricing["cache_read"] = row.short_cache_read
        if row.short_cache_write is not None:
            if details.cache_write_multiplier is None:
                raise RegistryRefreshError(
                    f"{slug} has a central cache-write price but its model page "
                    "no longer documents the cache-write policy"
                )
            revised_pricing["cache_write"] = row.short_cache_write
        elif pricing.get("cache_write") == 0 and details.cache_write_multiplier is None:
            revised_pricing["cache_write"] = 0.0
        else:
            raise RegistryRefreshError(
                f"{slug} lost its authoritative cache-write price or policy"
            )
        revised_pricing["currency"] = "USD"
        price_fields = ("input", "output", "cache_read", "cache_write", "currency")
        if any(pricing.get(key) != revised_pricing.get(key) for key in price_fields):
            revised_pricing["as_of"] = refresh_date.isoformat()
        replace(raw_model, "pricing", revised_pricing, OPENAI_PRICING_URL)

        # A dash is not blindly converted to zero.  For an already reviewed
        # tracked profile whose base cache-write policy is explicitly zero,
        # however, matching dashes in both Standard columns preserve that
        # policy in the long tier.  New models remain report-only and never
        # receive an inferred rate.
        long_cache_write = row.long_cache_write
        if (
            long_cache_write is None
            and row.short_cache_write is None
            and details.cache_write_multiplier is None
            and revised_pricing.get("cache_write") == 0
            and any(
                value is not None
                for value in (row.long_input, row.long_cache_read, row.long_output)
            )
        ):
            long_cache_write = 0.0
        long_values = (
            row.long_input,
            row.long_cache_read,
            long_cache_write,
            row.long_output,
        )
        if all(value is not None for value in long_values):
            if details.long_context_min_input is None:
                raise RegistryRefreshError(
                    f"{slug} has long prices but no threshold on its model page"
                )
            long_pricing = {
                "input": row.long_input,
                "output": row.long_output,
                "cache_read": row.long_cache_read,
                "cache_write": long_cache_write,
                "currency": "USD",
                "as_of": refresh_date.isoformat(),
            }
            expected_scope = {
                "service_tier": "standard",
                "region": "global",
                "basis": "request_input_tokens",
            }
            old_tiers = raw_model.get("pricing_tiers", [])
            old_long = None
            matching_tiers = [
                tier
                for tier in old_tiers
                if tier["min_input_tokens"] == details.long_context_min_input
            ]
            if len(matching_tiers) > 1:
                raise RegistryRefreshError(
                    f"{slug} has ambiguous pricing tiers at "
                    f"{details.long_context_min_input}"
                )
            if matching_tiers:
                old_long = matching_tiers[0]["pricing"]
            elif old_tiers:
                # A moved provider threshold must replace the provider-owned
                # tier instead of leaving a stale tier behind.  We can only
                # establish that ownership when there is one existing tier
                # under the exact Standard/global/request-input scope.  More
                # than one tier could include a maintainer-reviewed override,
                # so require manual review rather than guessing.
                if raw_model.get("pricing_scope") != expected_scope:
                    raise RegistryRefreshError(
                        f"{slug} has pricing tiers with no uniquely owned "
                        "Standard provider tier"
                    )
                if len(old_tiers) != 1:
                    raise RegistryRefreshError(
                        f"{slug} has ambiguous existing pricing tiers while "
                        "the official threshold changed"
                    )
                old_long = old_tiers[0]["pricing"]
            if isinstance(old_long, dict) and all(
                old_long.get(key) == long_pricing.get(key) for key in price_fields
            ):
                long_pricing["as_of"] = old_long.get("as_of", refresh_date.isoformat())
            replacement_tier = {
                "min_input_tokens": details.long_context_min_input,
                "pricing": long_pricing,
            }
            tiers: list[dict[str, Any]] = [
                dict(replacement_tier)
                if tier["min_input_tokens"] == details.long_context_min_input
                else dict(tier)
                for tier in old_tiers
            ]
            if not matching_tiers:
                if old_tiers:
                    tiers = [replacement_tier]
                else:
                    tiers.append(replacement_tier)
            tiers.sort(key=lambda tier: int(tier["min_input_tokens"]))
            replace(raw_model, "pricing_tiers", tiers, OPENAI_PRICING_URL)
            old_scope = raw_model.get("pricing_scope")
            if old_scope is not None and old_scope != expected_scope:
                raise RegistryRefreshError(
                    f"{slug} has a non-Standard pricing scope; refusing to replace it"
                )
            replace(
                raw_model,
                "pricing_scope",
                expected_scope,
                OPENAI_PRICING_URL,
            )
        elif any(value is not None for value in long_values):
            raise RegistryRefreshError(
                f"{slug} has partial long-context pricing; no missing component "
                "will be inferred as zero"
            )
        elif raw_model.get("pricing_tiers"):
            warnings.append(
                f"{slug}: bundled pricing tiers were preserved because automatic "
                "deletion requires maintainer review"
            )

        current_aliases = set(raw_model.get("aliases") or ())
        suggested = tuple(alias for alias in details.aliases if alias not in current_aliases)
        if suggested:
            alias_suggestions[canonical] = suggested

    discovered: tuple[str, ...] = ()
    new_models: tuple[str, ...] = ()
    missing_discovery_models: tuple[str, ...] = ()
    if include_discovery:
        discovered = tuple(
            f"openai:{slug}"
            for slug in sorted((catalog & pricing_rows.keys()) - tracked_ids)
        )
        raw_discovery = candidate.get("provider_discovery", {})
        if not isinstance(raw_discovery, dict):
            raise RegistryRefreshError("provider_discovery must be an object")
        raw_openai_discovery = raw_discovery.get("openai", {})
        if not isinstance(raw_openai_discovery, dict):
            raise RegistryRefreshError("provider_discovery.openai must be an object")
        raw_known = raw_openai_discovery.get("known_unregistered_models", [])
        if not isinstance(raw_known, list) or not all(
            isinstance(item, str) for item in raw_known
        ):
            raise RegistryRefreshError(
                "known_unregistered_models must be an array of strings"
            )
        known = set(raw_known)
        current = set(discovered)
        new_models = tuple(sorted(current - known))
        missing_discovery_models = tuple(sorted(known - current))
        if new_models:
            revised_known = sorted(known | current)
            revised_openai = dict(raw_openai_discovery)
            revised_openai.update(
                {
                    "catalog_source": OPENAI_CATALOG_URL,
                    "pricing_source": OPENAI_PRICING_URL,
                    "known_unregistered_models": revised_known,
                }
            )
            revised_discovery = dict(raw_discovery)
            revised_discovery["openai"] = revised_openai
            changes.append(
                RefreshChange(
                    model_id="<discovery:openai>",
                    field="known_unregistered_models",
                    before=sorted(known),
                    after=revised_known,
                    source=OPENAI_CATALOG_URL,
                )
            )
            candidate["provider_discovery"] = revised_discovery
        if missing_discovery_models:
            warnings.append(
                "OpenAI discovery entries disappeared from the current priced "
                "catalog and were preserved for manual review: "
                + ", ".join(missing_discovery_models)
            )
    if changes:
        old_snapshot = candidate.get("snapshot_date")
        new_snapshot = refresh_date.isoformat()
        if old_snapshot != new_snapshot:
            changes.append(
                RefreshChange(
                    model_id="<registry>",
                    field="snapshot_date",
                    before=old_snapshot,
                    after=new_snapshot,
                    source=OPENAI_DOCS_ORIGIN,
                )
            )
            candidate["snapshot_date"] = new_snapshot

    validate_registry_data(candidate)
    source_documents = tuple(
        SourceDocument(url=url, sha256=hashlib.sha256(text.encode()).hexdigest())
        for url, text in sorted(fetched.items())
    )
    report = RefreshReport(
        parser_version=PARSER_VERSION,
        checked_at=checked_at,
        tracked_models=len(tracked_ids),
        changes=tuple(changes),
        discovered_models=discovered,
        new_models=new_models,
        missing_discovery_models=missing_discovery_models,
        alias_suggestions=alias_suggestions,
        warnings=tuple(warnings),
        sources=source_documents,
    )
    return candidate, report


def validate_registry_data(registry_data: Mapping[str, Any]) -> None:
    """Validate the complete cross-language registry before any write."""

    if not isinstance(registry_data, Mapping):
        raise RegistryRefreshError("registry must be an object")
    models = registry_data.get("models")
    if not isinstance(models, list):
        raise RegistryRefreshError("registry must contain a models array")
    seen_ids: set[str] = set()
    alias_owners: dict[str, str] = {}

    def claim_alias(alias: str, canonical: str) -> None:
        normalized = alias.strip().lower()
        if not normalized:
            raise RegistryRefreshError(f"{canonical} contains an empty alias")
        owner = alias_owners.get(normalized)
        if owner is not None and owner != canonical:
            raise RegistryRefreshError(
                f"alias collision for {alias!r}: {owner} and {canonical}"
            )
        alias_owners[normalized] = canonical

    for index, raw_model in enumerate(models):
        if not isinstance(raw_model, Mapping):
            raise RegistryRefreshError(f"models[{index}] must be an object")
        canonical = raw_model.get("model_id")
        provider = raw_model.get("provider")
        if (
            not isinstance(canonical, str)
            or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*:[^\s:]+", canonical)
        ):
            raise RegistryRefreshError(f"models[{index}] has invalid model_id")
        if canonical in seen_ids:
            raise RegistryRefreshError(f"duplicate model_id: {canonical}")
        seen_ids.add(canonical)
        canonical_provider, bare = canonical.split(":", 1)
        if provider != canonical_provider:
            raise RegistryRefreshError(
                f"{canonical} provider {provider!r} does not match its canonical id"
            )
        _require_positive_int(raw_model.get("window_nominal"), f"{canonical}.window_nominal")
        max_output = raw_model.get("max_output")
        if max_output is not None:
            _require_positive_int(max_output, f"{canonical}.max_output")
            max_output_value = int(max_output)
            if max_output_value > raw_model["window_nominal"]:
                raise RegistryRefreshError(f"{canonical}.max_output exceeds its window")

        pricing = raw_model.get("pricing")
        if pricing is not None:
            _validate_pricing(pricing, f"{canonical}.pricing")
        raw_tiers = raw_model.get("pricing_tiers", [])
        if not isinstance(raw_tiers, list):
            raise RegistryRefreshError(f"{canonical}.pricing_tiers must be an array")
        if raw_tiers and pricing is None:
            raise RegistryRefreshError(f"{canonical} has tiers without base pricing")
        previous_threshold = 0
        base_currency = pricing.get("currency", "USD") if isinstance(pricing, Mapping) else None
        for tier_index, tier in enumerate(raw_tiers):
            if not isinstance(tier, Mapping):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_tiers[{tier_index}] must be an object"
                )
            threshold = tier.get("min_input_tokens")
            if (
                isinstance(threshold, bool)
                or not isinstance(threshold, int)
                or threshold <= 0
            ):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_tiers[{tier_index}].min_input_tokens "
                    "must be a positive integer"
                )
            threshold_value = threshold
            if threshold_value <= previous_threshold:
                raise RegistryRefreshError(
                    f"{canonical}.pricing_tiers must be strictly increasing"
                )
            previous_threshold = threshold_value
            tier_pricing = tier.get("pricing")
            if not isinstance(tier_pricing, Mapping):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_tiers[{tier_index}].pricing must be an object"
                )
            _validate_pricing(
                tier_pricing,
                f"{canonical}.pricing_tiers[{tier_index}].pricing",
            )
            if tier_pricing.get("currency", "USD") != base_currency:
                raise RegistryRefreshError(
                    f"{canonical}.pricing_tiers[{tier_index}] currency differs from base"
                )
        raw_scope = raw_model.get("pricing_scope")
        if raw_tiers and not isinstance(raw_scope, Mapping):
            raise RegistryRefreshError(f"{canonical} tiers require pricing_scope")
        if raw_scope is not None:
            if not isinstance(raw_scope, Mapping):
                raise RegistryRefreshError(f"{canonical}.pricing_scope must be an object")
            for field in ("service_tier", "region", "basis"):
                if not isinstance(raw_scope.get(field), str) or not raw_scope[field].strip():
                    raise RegistryRefreshError(
                        f"{canonical}.pricing_scope.{field} must be a non-empty string"
                    )
            if raw_scope["basis"] != "request_input_tokens":
                raise RegistryRefreshError(
                    f"{canonical}.pricing_scope.basis is unsupported"
                )
            raw_unpriced = raw_scope.get("unpriced_usage_categories", [])
            allowed_unpriced = {
                "input_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
                "output_tokens",
                "reasoning_tokens",
            }
            if not isinstance(raw_unpriced, list) or not all(
                isinstance(category, str) for category in raw_unpriced
            ):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_scope.unpriced_usage_categories "
                    "must be an array of strings"
                )
            if len(set(raw_unpriced)) != len(raw_unpriced):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_scope.unpriced_usage_categories "
                    "must be unique"
                )
            if any(category not in allowed_unpriced for category in raw_unpriced):
                raise RegistryRefreshError(
                    f"{canonical}.pricing_scope contains an unsupported "
                    "unpriced usage category"
                )

        aliases = raw_model.get("aliases", [])
        if not isinstance(aliases, list) or not all(
            isinstance(alias, str) for alias in aliases
        ):
            raise RegistryRefreshError(f"{canonical}.aliases must be an array of strings")
        claim_alias(canonical, canonical)
        claim_alias(bare, canonical)
        for alias in aliases:
            claim_alias(alias, canonical)
            if ":" not in alias:
                claim_alias(f"{provider}:{alias}", canonical)

    raw_discovery = registry_data.get("provider_discovery")
    if raw_discovery is not None:
        if not isinstance(raw_discovery, Mapping):
            raise RegistryRefreshError("provider_discovery must be an object")
        for provider, provider_data in raw_discovery.items():
            if not isinstance(provider, str) or not isinstance(provider_data, Mapping):
                raise RegistryRefreshError("provider_discovery entries must be objects")
            known = provider_data.get("known_unregistered_models", [])
            if not isinstance(known, list) or not all(
                isinstance(item, str) for item in known
            ):
                raise RegistryRefreshError(
                    f"provider_discovery.{provider}.known_unregistered_models "
                    "must be an array of strings"
                )
            if known != sorted(set(known)):
                raise RegistryRefreshError(
                    f"provider_discovery.{provider}.known_unregistered_models "
                    "must be sorted and unique"
                )

    try:
        from .registry import Registry

        Registry.from_dict(registry_data)
    except (KeyError, TypeError, ValueError) as exc:
        raise RegistryRefreshError(f"core registry validation failed: {exc}") from exc


def _validate_pricing(value: Any, label: str) -> None:
    if not isinstance(value, Mapping):
        raise RegistryRefreshError(f"{label} must be an object")
    for field in ("input", "output", "cache_read", "cache_write"):
        rate = value.get(field, 0.0 if field.startswith("cache_") else None)
        if isinstance(rate, bool) or not isinstance(rate, (int, float)):
            raise RegistryRefreshError(f"{label}.{field} must be numeric")
        if not math.isfinite(rate) or rate < 0:
            raise RegistryRefreshError(f"{label}.{field} must be finite and non-negative")
        if field in {"input", "output"} and rate <= 0:
            raise RegistryRefreshError(f"{label}.{field} must be positive")
    currency = value.get("currency", "USD")
    if not isinstance(currency, str) or not currency.strip():
        raise RegistryRefreshError(f"{label}.currency must be a non-empty string")
    as_of = value.get("as_of")
    if as_of is not None and not isinstance(as_of, str):
        raise RegistryRefreshError(f"{label}.as_of must be a string or null")


def _require_positive_int(value: Any, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise RegistryRefreshError(f"{label} must be a positive integer")


def _render_registry_json(registry_data: Mapping[str, Any]) -> str:
    validate_registry_data(registry_data)
    try:
        return (
            json.dumps(
                registry_data,
                indent=2,
                ensure_ascii=False,
                allow_nan=False,
            )
            + "\n"
        )
    except (TypeError, ValueError) as exc:
        raise RegistryRefreshError(f"registry is not strict JSON: {exc}") from exc


def _load_json_strict(text: str) -> Any:
    def reject_constant(value: str) -> None:
        raise RegistryRefreshError(f"invalid JSON numeric constant: {value}")

    return json.loads(text, parse_constant=reject_constant)


def write_registry(path: Path, registry_data: Mapping[str, Any]) -> None:
    """Atomically write deterministic canonical registry JSON."""

    payload = _render_registry_json(registry_data)
    _atomic_write(path, payload)


def sync_repository_copies(repo_root: Path, registry_data: Mapping[str, Any]) -> None:
    """Transactionally regenerate the JavaScript and Rust registry copies."""

    rust_path, js_path, _ = _repository_registry_paths(repo_root)
    canonical, js_payload = _render_registry_payloads(registry_data)
    _transactional_write_texts(
        {
            rust_path: canonical,
            js_path: js_payload,
        }
    )


def apply_registry_update(
    registry_path: Path,
    repo_root: Path,
    registry_data: Mapping[str, Any],
) -> None:
    """Apply canonical and generated files as one rollback-capable update."""

    rust_path, js_path, expected_registry = _repository_registry_paths(repo_root)
    supplied_registry = registry_path.resolve()
    if supplied_registry != expected_registry:
        raise RegistryRefreshError(
            "--registry must identify the canonical registry beneath --repo-root: "
            f"{expected_registry}"
        )
    canonical, js_payload = _render_registry_payloads(registry_data)
    _transactional_write_texts(
        {
            expected_registry: canonical,
            rust_path: canonical,
            js_path: js_payload,
        }
    )


def repository_copies_match(repo_root: Path, registry_data: Mapping[str, Any]) -> bool:
    """Return whether generated copies byte-match the canonical renderer."""

    try:
        rust_path, js_path, _ = _repository_registry_paths(repo_root)
        canonical, js_payload = _render_registry_payloads(registry_data)
        rust_text = rust_path.read_text(encoding="utf-8")
        js_text = js_path.read_text(encoding="utf-8")
    except (OSError, RegistryRefreshError):
        return False
    return rust_text == canonical and js_text == js_payload


def _render_registry_payloads(
    registry_data: Mapping[str, Any],
) -> tuple[str, str]:
    canonical = _render_registry_json(registry_data)
    banner = (
        "// Generated by scripts/embed-models.mjs. Do not edit by hand.\n"
        "// Canonical source: python/tokenmaster/src/tokenmaster/data/models.json\n"
        "// Regenerate with: npm run embed:models\n"
    )
    js_payload = (
        f"{banner}export const MODELS_DATA: unknown = {canonical.rstrip()};\n"
    )
    return canonical, js_payload


def _repository_registry_paths(repo_root: Path) -> tuple[Path, Path, Path]:
    try:
        root = repo_root.resolve(strict=True)
    except OSError as exc:
        raise RegistryRefreshError(f"repository root does not exist: {repo_root}") from exc
    if not root.is_dir():
        raise RegistryRefreshError(f"repository root is not a directory: {root}")

    def resolve_target(relative: str) -> Path:
        lexical = root / Path(relative)
        if lexical.is_symlink():
            raise RegistryRefreshError(f"repository target must not be a symlink: {lexical}")
        try:
            parent = lexical.parent.resolve(strict=True)
        except OSError as exc:
            raise RegistryRefreshError(
                f"repository layout missing: {lexical.parent}"
            ) from exc
        try:
            parent.relative_to(root)
        except ValueError as exc:
            raise RegistryRefreshError(
                f"repository target escapes --repo-root: {lexical}"
            ) from exc
        target = parent / lexical.name
        if target.exists():
            try:
                target.resolve(strict=True).relative_to(root)
            except (OSError, ValueError) as exc:
                raise RegistryRefreshError(
                    f"repository target escapes --repo-root: {target}"
                ) from exc
        return target

    rust_path = resolve_target("rust/tokenmaster/data/models.json")
    js_path = resolve_target("js/tokenmaster/src/models-data.ts")
    canonical_path = resolve_target(
        "python/tokenmaster/src/tokenmaster/data/models.json"
    )
    return rust_path, js_path, canonical_path


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point for explicit registry maintenance."""

    parser = argparse.ArgumentParser(
        prog="tokenmaster-models",
        description="Check, propose, discover, or apply official model-registry updates.",
    )
    parser.add_argument(
        "command", choices=("check", "propose", "discover", "apply")
    )
    parser.add_argument(
        "--registry",
        type=Path,
        help="canonical models.json path (required for apply)",
    )
    parser.add_argument("--report", type=Path, help="write the JSON audit report")
    parser.add_argument("--output", type=Path, help="proposal output path")
    parser.add_argument(
        "--repo-root",
        type=Path,
        help="verify or regenerate committed JavaScript and Rust copies",
    )
    parser.add_argument(
        "--as-of",
        type=date.fromisoformat,
        help="date assigned only to values that actually change (YYYY-MM-DD)",
    )
    args = parser.parse_args(argv)
    if args.command == "apply" and args.registry is None:
        parser.error("apply requires an explicit --registry path")
    registry_path = args.registry or (Path(__file__).with_name("data") / "models.json")
    fetched_documents: dict[str, str] = {}

    def cli_fetch(url: str) -> str:
        document = fetch_official_document(url)
        fetched_documents[url] = document
        return document

    try:
        registry_data = _load_json_strict(registry_path.read_text(encoding="utf-8"))
        if not isinstance(registry_data, Mapping):
            raise RegistryRefreshError("registry must be a JSON object")
        candidate, report = propose_registry_refresh(
            registry_data,
            fetcher=cli_fetch,
            as_of=args.as_of,
            include_discovery=True,
        )
        report_payload = (
            json.dumps(
                report.to_dict(),
                indent=2,
                ensure_ascii=False,
                allow_nan=False,
            )
            + "\n"
        )
        if args.report:
            _atomic_write(args.report, report_payload)
        elif args.command in {"check", "discover"}:
            sys.stdout.write(report_payload)

        if args.command == "discover":
            return 0
        if args.command == "propose":
            proposal = args.output or Path("models.proposed.json")
            write_registry(proposal, candidate)
            if not args.report:
                print(f"wrote proposal: {proposal}", file=sys.stderr)
            return 1 if report.has_drift else 0
        if args.command == "apply":
            if report.alias_suggestions or report.missing_discovery_models or report.warnings:
                raise RegistryRefreshError(
                    "apply refused because the report contains review-only findings"
                )
            if args.repo_root:
                apply_registry_update(registry_path, args.repo_root, candidate)
            else:
                write_registry(registry_path, candidate)
            if not args.report:
                sys.stdout.write(report_payload)
            return 0

        copies_drift = bool(
            args.repo_root and not repository_copies_match(args.repo_root, registry_data)
        )
        if copies_drift:
            print("generated registry copies differ from the canonical JSON", file=sys.stderr)
        return 1 if report.has_drift or copies_drift else 0
    except (
        OSError,
        json.JSONDecodeError,
        RegistryRefreshError,
        TypeError,
        ValueError,
    ) as exc:
        failure_payload = {
            "status": "error",
            "parser_version": PARSER_VERSION,
            "checked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "has_drift": True,
            "error_type": type(exc).__name__,
            "error": str(exc),
            "sources": [
                asdict(
                    SourceDocument(
                        url=url,
                        sha256=hashlib.sha256(document.encode()).hexdigest(),
                    )
                )
                for url, document in sorted(fetched_documents.items())
            ],
        }
        if args.report:
            try:
                _atomic_write(
                    args.report,
                    json.dumps(
                        failure_payload,
                        indent=2,
                        ensure_ascii=False,
                        allow_nan=False,
                    )
                    + "\n",
                )
            except OSError as report_exc:
                print(
                    f"tokenmaster-models: could not write failure report: {report_exc}",
                    file=sys.stderr,
                )
        print(f"tokenmaster-models: {exc}", file=sys.stderr)
        return 2


def _cross_check_pricing(row: PricingRow, details: ModelDetails) -> None:
    checks = (
        ("input", row.short_input, details.input_price),
        ("cached input", row.short_cache_read, details.cache_read_price),
        ("output", row.short_output, details.output_price),
    )
    for name, central, direct in checks:
        if central != direct:
            raise RegistryRefreshError(
                f"{row.model_id} {name} price disagrees between pricing page "
                f"({central}) and model page ({direct})"
            )
    if details.cache_write_multiplier is not None:
        expected = row.short_input * details.cache_write_multiplier
        if row.short_cache_write != expected:
            raise RegistryRefreshError(
                f"{row.model_id} cache-write price {row.short_cache_write} "
                f"does not match documented {details.cache_write_multiplier}x multiplier"
            )


def _parse_model_price_metrics(markdown: str) -> dict[str, float]:
    pricing_start = markdown.find("### Text tokens")
    if pricing_start < 0:
        return {}
    section = markdown[pricing_start:]
    end = re.search(r"\n##\s+", section)
    if end:
        section = section[: end.start()]
    metrics: dict[str, float] = {}
    for name, value in re.findall(
        r"^\|\s*(Input|Cached input|Output)\s*\|\s*\$([\d.]+)\s*\|",
        section,
        re.MULTILINE,
    ):
        metrics[name] = float(value)
    return metrics


def _parse_price(cell: str) -> float | None:
    cleaned = cell.strip()
    if cleaned in {"-", "—", "N/A", "n/a", ""}:
        return None
    match = re.fullmatch(r"\$([\d]+(?:\.\d+)?)", cleaned.replace(",", ""))
    if not match:
        raise RegistryRefreshError(f"unrecognized price cell: {cell!r}")
    return float(match.group(1))


def _parse_token_count(value: str) -> int:
    return int(value.replace(",", ""))


def _scaled_integer(value: str, suffix: str) -> int:
    number = float(value.replace(",", ""))
    multiplier = {"": 1, "k": 1_000, "m": 1_000_000}[suffix.lower()]
    scaled = number * multiplier
    if not scaled.is_integer():
        raise RegistryRefreshError(f"token threshold is not integral: {value}{suffix}")
    return int(scaled)


def _required_group(markdown: str, pattern: str, label: str) -> str:
    match = re.search(pattern, markdown, re.IGNORECASE)
    if not match:
        raise RegistryRefreshError(f"model page lacks {label}")
    return match.group(1)


def _require_official_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "developers.openai.com":
        raise RegistryRefreshError(f"refusing non-official URL: {url}")
    if parsed.username or parsed.password or parsed.port not in {None, 443}:
        raise RegistryRefreshError(f"refusing unsafe official URL: {url}")


def _atomic_write(path: Path, text: str) -> None:
    _transactional_write_texts({path: text})


def _transactional_write_texts(payloads: Mapping[Path, str]) -> None:
    """Stage every payload, then replace all targets with rollback on failure."""

    staged: list[_StagedWrite] = []
    resolved_targets: set[Path] = set()
    try:
        for supplied_path, text in payloads.items():
            if supplied_path.is_symlink():
                raise RegistryRefreshError(
                    f"refusing to replace symlink target: {supplied_path}"
                )
            supplied_path.parent.mkdir(parents=True, exist_ok=True)
            path = supplied_path.resolve()
            if path in resolved_targets:
                raise RegistryRefreshError(f"duplicate write target: {path}")
            resolved_targets.add(path)
            original = path.read_bytes() if path.exists() else None
            mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
            temporary = _stage_bytes(path, text.encode("utf-8"), mode)
            staged.append(
                _StagedWrite(
                    path=path,
                    temporary=temporary,
                    original=original,
                    mode=mode,
                )
            )
    except BaseException:
        for item in staged:
            item.temporary.unlink(missing_ok=True)
        raise

    replaced: list[_StagedWrite] = []
    try:
        for item in staged:
            os.replace(item.temporary, item.path)
            replaced.append(item)
    except BaseException as exc:
        rollback_errors: list[str] = []
        for item in reversed(replaced):
            try:
                if item.original is None:
                    item.path.unlink(missing_ok=True)
                else:
                    restoration = _stage_bytes(item.path, item.original, item.mode)
                    try:
                        os.replace(restoration, item.path)
                    finally:
                        restoration.unlink(missing_ok=True)
            except BaseException as rollback_exc:
                rollback_errors.append(f"{item.path}: {rollback_exc}")
        for item in staged:
            item.temporary.unlink(missing_ok=True)
        message = f"transactional registry write failed: {exc}"
        if rollback_errors:
            message += "; rollback failures: " + "; ".join(rollback_errors)
        raise RegistryRefreshError(message) from exc
    finally:
        for item in staged:
            item.temporary.unlink(missing_ok=True)


def _stage_bytes(path: Path, payload: bytes, mode: int) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


if __name__ == "__main__":  # pragma: no cover - exercised through main()
    raise SystemExit(main())
