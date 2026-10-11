"""Pins the status_code/detail exceptions of the Projects-PDM services (T-036).

ProjectFilesError, LinkError and PrintTraceError share one base; each keeps its own
type, its ValueError-ness (PrintTraceError stays a ValueError, the other two do not), and
the same ``str``/``args``/``status_code``/``detail``.
"""

import pytest

from backend.app.services.aito_project_links import LinkError
from backend.app.services.project_files import ProjectFilesError
from backend.app.services.project_print_trace import PrintTraceError

CLASSES = [ProjectFilesError, LinkError, PrintTraceError]


@pytest.mark.parametrize("cls", CLASSES)
def test_fields_str_and_args(cls):
    exc = cls(409, "already linked")
    assert exc.status_code == 409
    assert exc.detail == "already linked"
    assert str(exc) == "already linked"
    assert exc.args == ("already linked",)
    # Logs print repr(), so it must name the concrete class and carry the detail.
    assert repr(exc).startswith(cls.__name__)
    assert repr(exc).endswith("('already linked')")


@pytest.mark.parametrize("cls", CLASSES)
def test_keyword_construction_and_raise(cls):
    with pytest.raises(cls) as caught:
        raise cls(status_code=404, detail="missing")
    assert (caught.value.status_code, caught.value.detail, caught.value.args) == (404, "missing", ("missing",))


@pytest.mark.parametrize("cls", CLASSES)
def test_both_arguments_are_required(cls):
    with pytest.raises(TypeError):
        cls(400)


def test_only_print_trace_error_is_a_value_error():
    assert issubclass(PrintTraceError, ValueError)
    assert not issubclass(ProjectFilesError, ValueError)
    assert not issubclass(LinkError, ValueError)
    for cls in CLASSES:
        assert issubclass(cls, Exception)


def test_the_three_types_stay_distinct():
    # except clauses for one service must not swallow another service's error
    for cls in CLASSES:
        exc = cls(400, "bad")
        for other in CLASSES:
            if other is not cls:
                assert not isinstance(exc, other)
    with pytest.raises(ValueError):
        raise PrintTraceError(400, "bad")


def test_link_error_translated_from_project_files_error_keeps_chain():
    try:
        try:
            raise ProjectFilesError(413, "too big")
        except ProjectFilesError as exc:
            raise LinkError(exc.status_code, exc.detail) from exc
    except LinkError as linked:
        assert (linked.status_code, linked.detail) == (413, "too big")
        assert isinstance(linked.__cause__, ProjectFilesError)


def test_shared_base_catches_all_three():
    from backend.app.services.http_status_error import HttpStatusError

    for cls in CLASSES:
        assert issubclass(cls, HttpStatusError)
        with pytest.raises(HttpStatusError) as caught:
            raise cls(418, "teapot")
        assert (caught.value.status_code, caught.value.detail) == (418, "teapot")
    assert not issubclass(HttpStatusError, ValueError)
    base = HttpStatusError(500, "boom")
    assert (base.status_code, base.detail, str(base), base.args) == (500, "boom", "boom", ("boom",))
