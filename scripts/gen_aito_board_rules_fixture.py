#!/usr/bin/env python3
"""Regenerate the Aito board-rules contract fixture.

Run from the project root after changing ``evaluate`` or ``summarise`` in
``backend/app/services/aito_board_rules.py``:

    ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py

Then update ``frontend/src/utils/aitoBoardRules.ts`` until the frontend suite
passes again. See backend/tests/aito_rules_fixture.py for why.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.tests.aito_rules_fixture import build_fixture  # noqa: E402

FIXTURE = ROOT / "frontend" / "src" / "__tests__" / "fixtures" / "aitoBoardRules.cases.json"


def main() -> None:
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    # sort_keys + trailing newline so a regeneration that changes nothing
    # produces a byte-identical file and an empty diff.
    FIXTURE.write_text(json.dumps(build_fixture(), indent=2, sort_keys=True) + "\n")
    print(f"wrote {FIXTURE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
