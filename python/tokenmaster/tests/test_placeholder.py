"""Placeholder-release tests: import, version, and metadata sanity."""

import tokenmaster


def test_version_matches_placeholder():
    assert tokenmaster.__version__ == "0.0.1"


def test_about_returns_expected_metadata():
    info = tokenmaster.about()
    assert info["name"] == "tokenmaster"
    assert info["version"] == tokenmaster.__version__
    assert info["status"] == "pre-release"
    assert "ctxmaster" in info["companion"]
