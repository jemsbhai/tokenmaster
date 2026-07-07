"""tokenmaster: core context-budget metering and decision engine for LLM applications.

Placeholder release (0.0.1) reserving the package name while the core API is
designed. Do not build against this version.
"""

__version__ = "0.0.1"

__all__ = ["about", "__version__"]


def about() -> dict:
    """Return basic project metadata for this placeholder release."""
    return {
        "name": "tokenmaster",
        "version": __version__,
        "summary": (
            "Core context-budget metering and decision engine for "
            "LLM applications."
        ),
        "companion": "ctxmaster (visualization layer)",
        "repository": "https://github.com/jemsbhai/tokenmaster",
        "status": "placeholder",
    }
