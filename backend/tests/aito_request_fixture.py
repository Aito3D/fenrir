"""A bare HTTP `Request` for the Aito tests that call a route function
directly rather than through the client.

`create_project` takes the request for the OpenRouter budget check behind
`regenerate_description` (see routes/aito.py:_create_description). A direct
call that never sets that flag never reads it, but FastAPI's signature still
requires one — and the bucket key falls back to `request.client.host` for an
anonymous principal, so the scope carries a client rather than leaving the
attribute to blow up the first time a test does set the flag.

Kept as a standalone module for the same reason `aito_card_fixture.py` is:
three test files need it purely incidentally, and none should be the others'
"source" for it.
"""

from fastapi import Request


def direct_request() -> Request:
    return Request(
        {"type": "http", "method": "POST", "path": "/api/v1/aito/", "headers": [], "client": ("testclient", 0)}
    )
