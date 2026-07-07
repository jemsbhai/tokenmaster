"""Print tokenmaster placeholder metadata."""

import tokenmaster


if __name__ == "__main__":
    for key, value in tokenmaster.about().items():
        print(f"{key}: {value}")
