"""Pins the status_code/detail exceptions of the Projects-PDM services (T-036).

ProjectFilesError, LinkError and PrintTraceError share one base; each keeps its own
type, its MRO roots (PrintTraceError stays a ValueError, the other two do not), and
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
    assert repr(exc) == f"{cls.__name__}('already linked')"


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
    for cls in CLASSES:
        others = tuple(c for c in CLASSES if c is not cls)
        assert not issubclass(cls, others)
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


def test_shared_base_and_mro():
    from backend.app.services.http_status_error import HttpStatusError

    for cls in CLASSES:
        assert issubclass(cls, HttpStatusError)
        assert cls.__init__ is HttpStatusError.__init__
    assert not issubclass(HttpStatusError, ValueError)
    assert ProjectFilesError.__mro__ == (ProjectFilesError, HttpStatusError, Exception, BaseException, object)
    assert LinkError.__mro__ == (LinkError, HttpStatusError, Exception, BaseException, object)
    assert PrintTraceError.__mro__ == (PrintTraceError, HttpStatusError, ValueError, Exception, BaseException, object)
    base = HttpStatusError(500, "boom")
    assert (base.status_code, base.detail, str(base), base.args) == (500, "boom", "boom", ("boom",))
