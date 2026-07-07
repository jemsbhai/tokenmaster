"""ctxmaster: visualization layer for tokenmaster.

Placeholder release (0.0.1) reserving the package name while the core API is
designed. Do not build against this version.
"""

import tokenmaster

__version__ = "0.0.1"

__all__ = ["about", "__version__"]


def about() -> dict:
    """Return basic project metadata for this placeholder release."""
    return {
        "name": "ctxmaster",
        "version": __version__,
        "summary": (
            "Visualization layer for tokenmaster: CLI, terminal gauge, "
            "and dashboard renderers."
        ),
        "core": f"tokenmaster {tokenmaster.__version__}",
        "repository": "https://github.com/jemsbhai/tokenmaster",
        "status": "placeholder",
    }
