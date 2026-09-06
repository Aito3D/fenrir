"""Shared fake stand-ins for ``httpx.AsyncClient``/``httpx.Response`` as
``backend/app/services/openrouter.py``'s ``_chat`` consumes them.

``test_openrouter_service.py`` and ``test_openrouter_proofread.py`` each used
to carry their own byte-identical ``_FakeResponse``/``_FakeClient`` pair —
same ``__init__``/``__aenter__``/``__aexit__``/``post`` bodies, only the
canned reply (and proofread's optional ``finish_reason``) differed. This
module is the one copy; each test file subclasses ``FakeOpenRouterClient``
and sets the class-level ``reply``/``finish_reason``/``status_code``/
``raw_json`` attributes exactly as it used to set them on its own local
class, then hands the (sub)class to
``monkeypatch.setattr(openrouter.httpx, "AsyncClient", ...)``.

A ``post()`` override still belongs in the test file for anything that isn't
a "return a response built from these fields" fake — a client whose
``post()`` raises an ``httpx`` transport error, for instance.
"""


class FakeOpenRouterResponse:
    """A stand-in for ``httpx.Response``, covering everything ``_chat``
    reads: ``.status_code`` and ``.json()``.

    ``raw_json``, when given, replaces the payload wholesale (malformed or
    error-body fixtures); otherwise the payload is built the same way both
    original per-file fakes built it, with ``finish_reason`` folded into the
    choice only when it is not ``None`` — omitting the key entirely, not
    just leaving it ``None``, mirrors what a real truthy response omits.
    """

    def __init__(self, content=None, finish_reason=None, status_code=200, raw_json=None, text=None):
        self.status_code = status_code
        self.text = text
        self._content = content
        self._finish_reason = finish_reason
        self._raw_json = raw_json

    def json(self):
        if self._raw_json is not None:
            return self._raw_json
        message = {"content": self._content}
        choice = {"message": message}
        if self._finish_reason is not None:
            choice["finish_reason"] = self._finish_reason
        return {"choices": [choice]}


class FakeOpenRouterClient:
    """A stand-in for ``httpx.AsyncClient`` as ``_chat`` uses it: constructed
    with kwargs, used once as an async context manager, one ``.post()`` call.

    Configure the canned reply via the class attributes below — set on a
    subclass (each test file keeps its own, so state never leaks between
    files) or directly on an instance's class before monkeypatching. ``post``
    records the last request (``last_json``, ``last_headers``, ``last_url``)
    on the class and returns the response built from the current class
    attributes.
    """

    reply = None
    finish_reason = None
    status_code = 200
    raw_json = None
    text = None

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        type(self).last_url = url
        type(self).last_headers = headers
        type(self).last_json = json
        return FakeOpenRouterResponse(
            content=type(self).reply,
            finish_reason=type(self).finish_reason,
            status_code=type(self).status_code,
            raw_json=type(self).raw_json,
            text=type(self).text,
        )
