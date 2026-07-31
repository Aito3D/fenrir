"""The committed contract fixture must match the current Python.

Reads only — never writes — so it is safe under `pytest -n 30`. When this
fails, the rules changed and the fixture is stale:

    ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py

That regeneration will in turn fail the TypeScript mirror's test until
frontend/src/utils/aitoBoardRules.ts is brought back in line. That chain is
the whole point: neither language can change the rules alone.
"""

import json
from pathlib import Path

from backend.tests.aito_rules_fixture import build_fixture

FIXTURE = (
    Path(__file__).resolve().parents[3] / "frontend" / "src" / "__tests__" / "fixtures" / "aitoBoardRules.cases.json"
)


def test_fixture_matches_the_current_rules():
    assert FIXTURE.exists(), f"missing {FIXTURE}; run scripts/gen_aito_board_rules_fixture.py"
    committed = json.loads(FIXTURE.read_text())
    assert committed == build_fixture(), (
        "The board rules changed but the contract fixture was not regenerated. Run:\n"
        "  ./venv/bin/python3 scripts/gen_aito_board_rules_fixture.py"
    )


def test_evaluate_cases_cover_the_full_product():
    """A generator that silently stopped enumerating would let the mirror pass
    on a subset. Pin the size too."""
    committed = json.loads(FIXTURE.read_text())
    assert len(committed["evaluate"]) == 8 * 7 * 16
