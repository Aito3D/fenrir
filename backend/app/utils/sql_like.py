"""Helpers for building SQL ``LIKE`` patterns."""


def escape_like(value: str) -> str:
    """Escape LIKE wildcards so user input matches literally (escape char is ``\\``)."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
