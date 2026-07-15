"""Tests for the auth middleware's public-pattern matcher.

Regression guard: patterns ending in "/" carry their own segment boundary
(the dynamic tail is a filename/nonce/token). The boundary check must not
demand another "/" after them — that 401'd photos, plate thumbnails, slicer
/dl/ downloads, and Obico cached frames whenever auth was enabled, which
surfaced as the ML API returning 400 for every detection poll.
"""

from backend.app.main import PUBLIC_API_PATTERNS, _matches_public_pattern


class TestMatchesPublicPattern:
    def test_trailing_slash_pattern_matches_dynamic_tail(self):
        assert _matches_public_pattern(
            "/api/v1/obico/cached-frame/mqERJM_lyxrrGRKDIwUg8YkBZUi6VrYMIEONOZrjhy4",
            "/obico/cached-frame/",
        )
        assert _matches_public_pattern("/api/v1/archives/5/photos/finish.jpg", "/photos/")
        assert _matches_public_pattern("/api/v1/archives/5/plate-thumbnail/2", "/plate-thumbnail/")
        assert _matches_public_pattern("/api/v1/archives/5/dl/tok123/file.3mf", "/dl/")
        assert _matches_public_pattern("/api/v1/archives/5/project-image/covers/a.png", "/project-image/")

    def test_exact_suffix_pattern_matches_at_end(self):
        assert _matches_public_pattern("/api/v1/archives/5/thumbnail", "/thumbnail")
        assert _matches_public_pattern("/api/v1/printers/18/camera/snapshot", "/camera/snapshot")

    def test_suffix_pattern_requires_segment_boundary(self):
        # The hardening intent: "/thumbnail" must not leak onto sibling routes
        assert not _matches_public_pattern("/api/v1/archives/5/thumbnail-secret", "/thumbnail")
        assert not _matches_public_pattern("/api/v1/printers/18/camera/grid-stream", "/camera/stream")

    def test_missing_pattern_does_not_match(self):
        assert not _matches_public_pattern("/api/v1/settings", "/photos/")

    def test_every_configured_trailing_slash_pattern_accepts_a_tail(self):
        """No configured public pattern may 401 its own dynamic segment."""
        for pattern in PUBLIC_API_PATTERNS:
            if pattern.endswith("/"):
                assert _matches_public_pattern(f"/api/v1/x/1{pattern}tail-segment", pattern), pattern
