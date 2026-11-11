from backend.app.services.order_board_events import kinds_for_depth, record


async def test_record_stores_row(db_session):
    ev = await record(
        db_session, "SO1", "package.created", actor_class="user", actor_name="Marie", detail={"package": "PKG-00087"}
    )
    await db_session.commit()
    assert ev.id and ev.salesorder_id == "SO1" and ev.detail == {"package": "PKG-00087"}


async def test_record_refuses_unknown_kind(db_session):
    assert await record(db_session, "SO1", "nope", actor_class="system") is None


def test_depths_nest():
    assert set(kinds_for_depth("story")) < set(kinds_for_depth("detail")) < set(kinds_for_depth("everything"))
    assert "zoho.edited" in kinds_for_depth("everything") and "zoho.edited" not in kinds_for_depth("detail")
