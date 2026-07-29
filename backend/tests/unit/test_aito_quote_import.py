"""Quote -> Aito project conversion. Fixtures mirror the live org's payload
shape and formatting quirks with invented customers."""

import json
from pathlib import Path

_FIXTURES = Path(__file__).parent.parent / "fixtures" / "zoho_estimates"


def load_estimate(name: str) -> dict:
    return json.loads((_FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def test_fixtures_load():
    assert load_estimate("dev-2461-three-services")["estimate_number"] == "DEV26-2461"
    assert len(load_estimate("dev-2462-two-tasks")["line_items"]) == 3
