"""ctxmaster: visualization layer for tokenmaster.

0.1.x alpha: the terminal context gauge (hero surface per contract decision
D10) with per-turn and live in-place rendering. The advice panel, CLI, and
dashboard surfaces are planned; the public surface may still shift before
0.2.
"""

import tokenmaster

from .gauge import ContextGauge

__version__ = "0.1.1"

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
        "status": "alpha",
    }
