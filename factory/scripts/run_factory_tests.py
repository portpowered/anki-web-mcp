"""Run the focused factory-script suite used by local and CI checks."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> int:
    sys.path.insert(0, str(REPO_ROOT))
    modules = sys.argv[1:]
    if not modules:
        print(
            "test-factory-scripts selected zero tests from .",
            file=sys.stderr,
        )
        return 2

    print("==> test-factory-scripts modules:", " ".join(modules), flush=True)
    suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        print(
            "test-factory-scripts failed while loading or executing",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
