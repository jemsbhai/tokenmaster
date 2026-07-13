"""Package sanity tests: import, version, and metadata."""

import re
from pathlib import Path

import tokenmaster

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_version_matches_pyproject():
    text = _PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match is not None, "no version field in pyproject.toml"
    assert tokenmaster.__version__ == match.group(1)


def test_about_returns_expected_metadata():
    info = tokenmaster.about()
    assert info["name"] == "tokenmaster"
    assert info["version"] == tokenmaster.__version__
    assert info["status"] == "alpha"
    assert "ctxmaster" in info["companion"]
