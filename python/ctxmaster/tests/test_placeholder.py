"""Placeholder-release tests: import, version, dependency, and metadata sanity."""

import ctxmaster
import tokenmaster


def test_version_matches_placeholder():
    assert ctxmaster.__version__ == "0.1.0"


def test_about_reports_core_version():
    info = ctxmaster.about()
    assert info["name"] == "ctxmaster"
    assert tokenmaster.__version__ in info["core"]
    assert info["status"] == "alpha"
