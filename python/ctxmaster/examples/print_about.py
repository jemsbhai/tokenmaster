"""Print ctxmaster placeholder metadata."""

import ctxmaster


if __name__ == "__main__":
    for key, value in ctxmaster.about().items():
        print(f"{key}: {value}")
