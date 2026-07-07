"""ctxmaster: visualization layer for tokenmaster.

Pre-release: the terminal context gauge (hero surface per contract decision
D10) is implemented; CLI and dashboard surfaces land in subsequent versions.
The public surface may still shift before 0.1.0.
"""

import tokenmaster

from .gauge import ContextGauge

__version__ = "0.0.1"

__all__ = ["ContextGauge", "about", "__version__"]


def about() -> dict:
    """Return basic project metadata."""
    return {
        "name": "ctxmaster",
        "version": __version__,
        "summary": (
            "Visualization layer for tokenmaster: CLI, terminal gauge, "
            "and dashboard renderers."
        ),
        "core": f"tokenmaster {tokenmaster.__version__}",
        "repository": "https://github.com/jemsbhai/tokenmaster",
        "status": "pre-release",
    }
