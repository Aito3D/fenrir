"""Shared actor helpers (T-196): the id, name and class recorded on PDM events."""

from backend.app.models.user import User
from backend.app.services.actor import actor_class, actor_name, actor_user_id


def test_no_user_is_anonymous_system():
    assert actor_user_id(None) is None
    assert actor_name(None) is None
    assert actor_class(None) == "system"


def test_a_user_gives_its_id_and_username():
    user = User(id=7, username="ana")
    assert actor_user_id(user) == 7
    assert actor_name(user) == "ana"
    assert actor_class(actor_name(user)) == "user"


def test_an_empty_actor_name_is_system():
    assert actor_class("") == "system"
    assert actor_class("ana") == "user"
