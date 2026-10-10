from backend.app.utils.sql_like import escape_like


def test_escape_like_escapes_backslash_percent_underscore():
    assert escape_like("a\\b%c_d") == "a\\\\b\\%c\\_d"


def test_escape_like_plain_text_unchanged():
    assert escape_like("plain text 123") == "plain text 123"
