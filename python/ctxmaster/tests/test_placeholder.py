"""Package sanity tests: import, version, dependency, and metadata."""

import re
from pathlib import Path

import ctxmaster
import tokenmaster

_PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_version_matches_pyproject():
    text = _PYPROJECT.read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert match is not None, "no version field in pyproject.toml"
    assert ctxmaster.__version__ == match.group(1)


def test_about_reports_core_version():
    info = ctxmaster.about()
    assert info["name"] == "ctxmaster"
    assert tokenmaster.__version__ in info["core"]
    assert info["status"] == "alpha"
