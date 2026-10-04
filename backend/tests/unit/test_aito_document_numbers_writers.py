"""`_retainer_numbers`: which retainer numbers a quote's card remembers."""

from backend.app.services.aito_quote_sync import _retainer_numbers


def test_retainer_numbers_takes_attached_and_referenced_rows():
    estimate = {"retainerinvoices": [{"retainerinvoice_id": "R1", "retainerinvoice_number": "RET-00001"}]}
    retainers = [
        {"retainerinvoice_id": "R2", "retainerinvoice_number": "RET-00002", "reference_number": "DEV26-12"},
        {"retainerinvoice_id": "R3", "retainerinvoice_number": "RET-00003", "reference_number": "DEV26-99"},
    ]
    assert _retainer_numbers(estimate, retainers, "DEV26-12") == ["RET-00001", "RET-00002"]


def test_retainer_numbers_tolerates_missing_lists_and_numbers():
    assert _retainer_numbers({}, None, None) == []
    assert _retainer_numbers({"retainerinvoices": [{"retainerinvoice_id": "R1"}]}, [], "X") == []
