"""Scheme normalization on the archive schema's write path (ArchiveUpdate /
ArchiveBase.external_url) (#T-034 -- javascript:/data: URLs reaching the
frontend's window.open sink via archive.external_url or archive.makerworld_url).

Unlike ``ExternalLinkBase.validate_url`` (backend/app/schemas/external_link.py),
this validator never rejects a value: external_url is populated from
third-party 3MF metadata and GitHub backup restores as well as direct user
PATCH requests, so a strict reject would 422 payloads the API previously
accepted. It only prepends https:// to a genuinely scheme-less value on
input. Values that already carry any scheme -- including an unsafe one like
javascript: -- pass through unchanged; the frontend
(frontend/src/utils/safeExternalUrl.ts) is the actual boundary that refuses
to hand those to window.open.

``ArchiveResponse`` (the read path) does NOT apply this validator: the API
must return exactly what is stored, byte for byte, so a client that
reads-then-writes cannot silently mutate stored data. See
test_archive_response_returns_scheme_less_url_verbatim below -- it is the
regression guard for a prior bug where the response model rewrote
scheme-less URLs on the way out.
"""

from backend.app.schemas.archive import ArchiveResponse, ArchiveUpdate, normalize_link_scheme


def test_normalize_link_scheme_prepends_https_to_bare_domain():
    assert normalize_link_scheme("printables.com/model/12345") == "https://printables.com/model/12345"


def test_normalize_link_scheme_leaves_https_url_unchanged():
    assert normalize_link_scheme("https://printables.com/model/12345") == "https://printables.com/model/12345"


def test_normalize_link_scheme_leaves_http_url_unchanged():
    assert normalize_link_scheme("http://printables.com/model/12345") == "http://printables.com/model/12345"


def test_normalize_link_scheme_does_not_touch_javascript_scheme():
    """Not rejected, not rewritten -- passed straight through. The API must
    not 422 a value it previously accepted."""
    assert normalize_link_scheme("javascript:alert(1)") == "javascript:alert(1)"


def test_normalize_link_scheme_does_not_touch_data_scheme():
    assert (
        normalize_link_scheme("data:text/html,<script>alert(1)</script>") == "data:text/html,<script>alert(1)</script>"
    )


def test_normalize_link_scheme_none_passthrough():
    assert normalize_link_scheme(None) is None


def test_normalize_link_scheme_empty_string_passthrough():
    assert normalize_link_scheme("") == ""


def test_normalize_link_scheme_whitespace_only_does_not_raise():
    """Never rejects -- a whitespace-only value round-trips instead of 422ing."""
    assert normalize_link_scheme("   ") == "   "


def test_normalize_link_scheme_windows_path_does_not_raise():
    """A drive letter like "C:" matches the leading-scheme regex, so a
    Windows-style path is treated like any other value that already carries
    a scheme and passes through unchanged -- it must not raise."""
    assert normalize_link_scheme("C:\\models\\thing.3mf") == "C:\\models\\thing.3mf"


def test_normalize_link_scheme_embedded_newline_does_not_raise():
    """Never rejects -- embedded newlines pass through without raising, only
    gaining the https:// prefix like any other scheme-less value."""
    assert normalize_link_scheme("printables.com/model/1\nmore") == "https://printables.com/model/1\nmore"


def test_archive_update_normalizes_external_url():
    update = ArchiveUpdate(external_url="printables.com/model/12345")
    assert update.external_url == "https://printables.com/model/12345"


def test_archive_update_does_not_reject_javascript_external_url():
    """Round-trips unmodified -- proves the schema accepts what it always
    accepted (no new 422s) rather than rejecting like external_link.py does."""
    update = ArchiveUpdate(external_url="javascript:alert(document.cookie)")
    assert update.external_url == "javascript:alert(document.cookie)"


def _base_response_kwargs(**overrides):
    kwargs = {
        "id": 1,
        "printer_id": 1,
        "filename": "test.3mf",
        "file_path": "archives/test.3mf",
        "file_size": 100,
        "content_hash": None,
        "thumbnail_path": None,
        "timelapse_path": None,
        "object_count": None,
        "print_name": "Test",
        "print_time_seconds": None,
        "filament_used_grams": None,
        "filament_type": None,
        "filament_color": None,
        "layer_height": None,
        "nozzle_diameter": None,
        "bed_temperature": None,
        "nozzle_temperature": None,
        "status": "completed",
        "started_at": None,
        "completed_at": None,
        "extra_data": None,
        "makerworld_url": None,
        "designer": None,
        "external_url": None,
        "is_favorite": False,
        "tags": None,
        "notes": None,
        "cost": None,
        "photos": None,
        "failure_reason": None,
        "quantity": 1,
        "created_at": None,
    }
    kwargs.update(overrides)
    return kwargs


def test_archive_response_returns_scheme_less_url_verbatim():
    """Regression guard for T-034's read-path bug: ArchiveResponse must NOT
    apply normalize_link_scheme. A row stored scheme-less (e.g. because it
    predates the write-path normalizer, or was written by a path that
    bypasses ArchiveUpdate) must come back byte-for-byte identical -- not
    rewritten to https://... on the way out. Normalization belongs on input
    (ArchiveUpdate/ArchiveBase) and at the display sink
    (frontend/src/utils/safeExternalUrl.ts), not on output."""
    response = ArchiveResponse(**_base_response_kwargs(makerworld_url="makerworld.com/en/models/12345"))
    assert response.makerworld_url == "makerworld.com/en/models/12345"


def test_archive_response_leaves_valid_makerworld_url_unchanged():
    response = ArchiveResponse(**_base_response_kwargs(makerworld_url="https://makerworld.com/en/models/12345"))
    assert response.makerworld_url == "https://makerworld.com/en/models/12345"


def test_archive_response_does_not_reject_javascript_external_url():
    """A crafted value already stored in the DB (e.g. via a backup restore
    that bypasses ArchiveUpdate) must still serialize -- not 500."""
    response = ArchiveResponse(**_base_response_kwargs(external_url="javascript:alert(1)"))
    assert response.external_url == "javascript:alert(1)"
