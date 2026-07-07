"""Bundled model registry: capacities and dated pricing, offline by design.

The snapshot ships inside the package (contract P6: nothing phones home;
refresh mechanisms will be explicit adapters). Lookup accepts canonical ids
("anthropic:claude-sonnet-4-6"), bare names ("claude-sonnet-4-6"), registered
aliases, and dated snapshot suffixes ("claude-haiku-4-5-20251001",
"openai:gpt-5.5-2026-04-14"). User-registered profiles override bundled ones.
"""

from __future__ import annotations

import difflib
import json
from importlib import resources
from typing import Any, Iterable, Mapping

from .types import ModelProfile

_BUNDLE_PATH = "data/models.json"


class UnknownModelError(LookupError):
    """Raised when a model id cannot be resolved by the registry."""

    def __init__(self, model_id: str, suggestions: list[str]) -> None:
        self.model_id = model_id
        self.suggestions = suggestions
        hint = ""
        if suggestions:
            hint = " Close matches: " + ", ".join(suggestions)
        super().__init__(
            f"Unknown model {model_id!r}; not in the registry."
            + hint
            + " Register it with Registry.register(ModelProfile(...))."
        )


def _norm(s: str) -> str:
    return s.strip().lower()


def _is_dated_suffix(s: str) -> bool:
    """True for version/date tails like '20251001' or '2026-04-14'."""
    return (
        len(s) >= 4
        and any(c.isdigit() for c in s)
        and all(c.isdigit() or c in "-." for c in s)
    )


class Registry:
    """Model profiles keyed by canonical id, with alias resolution."""

    def __init__(self, snapshot_date: str | None = None) -> None:
        self.snapshot_date = snapshot_date
        self._profiles: dict[str, ModelProfile] = {}
        self._alias: dict[str, str] = {}

    # ------------------------------------------------------------------ #
    # construction

    def register(
        self, profile: ModelProfile, aliases: Iterable[str] = ()
    ) -> ModelProfile:
        """Add or override a profile. Later registrations win."""
        canonical = _norm(profile.model_id)
        self._profiles[canonical] = profile
        self._alias[canonical] = canonical
        if ":" in canonical:
            bare = canonical.split(":", 1)[1]
            self._alias.setdefault(bare, canonical)
        for alias in aliases:
            a = _norm(alias)
            self._alias[a] = canonical
            if ":" not in a:
                self._alias.setdefault(f"{profile.provider}:{a}", canonical)
        return profile

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Registry":
        reg = cls(snapshot_date=d.get("snapshot_date"))
        for entry in d.get("models", []):
            entry = dict(entry)
            aliases = entry.pop("aliases", [])
            reg.register(ModelProfile.from_dict(entry), aliases=aliases)
        return reg

    @classmethod
    def bundled(cls) -> "Registry":
        blob = (
            resources.files(__package__).joinpath(_BUNDLE_PATH).read_text("utf-8")
        )
        return cls.from_dict(json.loads(blob))

    # ------------------------------------------------------------------ #
    # lookup

    def get(self, model_id: str) -> ModelProfile:
        key = _norm(model_id)
        hit = self._alias.get(key)
        if hit is not None:
            return self._profiles[hit]

        # dated snapshot suffixes: longest known base wins
        best: str | None = None
        for base, canonical in self._alias.items():
            if key.startswith(base + "-") and _is_dated_suffix(key[len(base) + 1 :]):
                if best is None or len(base) > len(best):
                    best = base
        if best is not None:
            return self._profiles[self._alias[best]]

        suggestions = difflib.get_close_matches(key, self._alias.keys(), n=3)
        raise UnknownModelError(model_id, suggestions)

    def __contains__(self, model_id: str) -> bool:
        try:
            self.get(model_id)
            return True
        except UnknownModelError:
            return False

    @property
    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._profiles))

    @property
    def profiles(self) -> tuple[ModelProfile, ...]:
        return tuple(self._profiles[k] for k in sorted(self._profiles))


_default: Registry | None = None


def default_registry() -> Registry:
    """The bundled registry, loaded once per process."""
    global _default
    if _default is None:
        _default = Registry.bundled()
    return _default


def get_profile(model_id: str) -> ModelProfile:
    """Resolve against the default registry."""
    return default_registry().get(model_id)


__all__ = ["Registry", "UnknownModelError", "default_registry", "get_profile"]
