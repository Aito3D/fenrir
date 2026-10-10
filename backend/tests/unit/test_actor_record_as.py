import pytest

from backend.app.services import actor as actor_module, aito_events


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor", "expected_class"),
    [("paul", "user"), (None, "system"), ("", "system")],
)
async def test_record_as_forwards_actor_pair_and_kwargs(monkeypatch, actor, expected_class):
    calls = []
    sentinel = object()

    async def fake_record(db, order_id, kind, **kwargs):
        calls.append((db, order_id, kind, kwargs))
        return sentinel

    monkeypatch.setattr(aito_events, "record", fake_record)
    db = object()

    result = await actor_module.record_as(db, 7, "task.project_linked", actor, subject_label="Support", detail={"a": 1})

    assert result is sentinel
    assert calls == [
        (
            db,
            7,
            "task.project_linked",
            {"actor_class": expected_class, "actor_name": actor, "subject_label": "Support", "detail": {"a": 1}},
        )
    ]
