"""Searchable extras for the Aito board search (services/aito_search.py)."""

import json
from types import SimpleNamespace

from backend.app.services.aito_search import (
    DOCUMENT_NUMBERS_LIMIT,
    SEARCH_TEXT_LIMIT,
    document_numbers_of,
    remember_document_numbers,
    task_search_text,
)


def _task(**fields):
    base = {
        "title": None,
        "impression_color": None,
        "scan_description": None,
        "modelisation_description": None,
        "impression_description": None,
        "usinage_description": None,
        "maindoeuvre_description": None,
    }
    base.update(fields)
    return SimpleNamespace(**base)


def test_task_search_text_joins_titles_colour_and_notes_in_order():
    tasks = [
        _task(title="Support GoPro", impression_color="Bleu", impression_description="PETG 0.2"),
        _task(title="Plaque", scan_description="Scan recto"),
    ]
    assert task_search_text(tasks) == "Support GoPro\nBleu\nPETG 0.2\nPlaque\nScan recto"


def test_task_search_text_skips_blank_values_and_handles_no_tasks():
    assert task_search_text([]) == ""
    assert task_search_text([_task(title="  ", scan_description="")]) == ""


def test_task_search_text_is_capped():
    text = task_search_text([_task(title="x" * (SEARCH_TEXT_LIMIT + 500))])
    assert len(text) == SEARCH_TEXT_LIMIT


def test_document_numbers_of_tolerates_null_and_garbage():
    assert document_numbers_of(SimpleNamespace(document_numbers=None)) == []
    assert document_numbers_of(SimpleNamespace(document_numbers="not json")) == []
    assert document_numbers_of(SimpleNamespace(document_numbers='{"a": 1}')) == []
    assert document_numbers_of(SimpleNamespace(document_numbers='["INV-1", 3, ""]')) == ["INV-1"]


def test_remember_document_numbers_dedupes_and_ignores_empty():
    project = SimpleNamespace(document_numbers=None)
    remember_document_numbers(project, "INV-0001", "", None, "RET-7")
    remember_document_numbers(project, "INV-0001")
    assert json.loads(project.document_numbers) == ["INV-0001", "RET-7"]


def test_remember_document_numbers_leaves_the_column_alone_when_nothing_is_new():
    project = SimpleNamespace(document_numbers=None)
    remember_document_numbers(project, "", None)
    assert project.document_numbers is None


def test_remember_document_numbers_keeps_the_newest_twenty():
    project = SimpleNamespace(document_numbers=None)
    remember_document_numbers(project, *[f"INV-{i}" for i in range(DOCUMENT_NUMBERS_LIMIT + 5)])
    kept = json.loads(project.document_numbers)
    assert len(kept) == DOCUMENT_NUMBERS_LIMIT
    assert kept[0] == "INV-5" and kept[-1] == f"INV-{DOCUMENT_NUMBERS_LIMIT + 4}"
