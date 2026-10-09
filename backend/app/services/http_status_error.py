"""Shared base for service errors that carry an HTTP status and a detail message."""


class HttpStatusError(Exception):
    """``str(exc)`` and ``exc.args`` are the detail; routes map it to an HTTPException."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
