"""DuplicateSendGuard's mechanics, independent of the three call sites
(pickup SMS, quote/invoice email, manual payments) whose own suites pin the
keep/release decisions."""

from backend.app.services.aito_send_guard import DuplicateSendGuard


def test_armed_key_is_recent_inside_the_window_and_pruned_at_its_edge():
    guard = DuplicateSendGuard(60.0)
    assert guard.is_recent("k", 100.0) is False
    guard.arm("k", 100.0)
    assert guard.is_recent("k", 159.9) is True
    # now - at == window counts as stale, exactly as the inline loops did.
    assert guard.is_recent("k", 160.0) is False
    assert guard.entries == {}


def test_prune_drops_every_stale_key_not_just_the_one_checked():
    guard = DuplicateSendGuard(60.0)
    guard.arm("old", 0.0)
    guard.arm("fresh", 50.0)
    assert guard.is_recent("other", 70.0) is False
    assert guard.entries == {"fresh": 50.0}


def test_release_and_clear():
    guard = DuplicateSendGuard(60.0)
    guard.arm("a", 1.0)
    guard.arm("b", 1.0)
    guard.release("a")
    guard.release("never-armed")  # no KeyError
    assert guard.entries == {"b": 1.0}
    entries = guard.entries
    guard.clear()
    assert entries == {} and guard.entries is entries  # aliases stay valid
