"""The Order Board's local catalogue copy: the pass's sweep and the "add an item" search over it."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_actions as actions, order_board_sync as sync
from backend.app.services.order_board_sync import _catalog
from backend.app.services.zoho import ZohoRateLimited, ZohoUnreachable, zoho_service
from backend.tests.unit.test_order_board_sync import no_back_off_left_over, zoho  # noqa: F401


@pytest.fixture(autouse=True)
def fresh_cache():
    _catalog._cache = None
    yield
    _catalog._cache = None


def _goods(item_id, name, sku="", stock=0.0, **extra):
    return {
        "item_id": item_id,
        "name": name,
        "sku": sku,
        "rate": 1000,
        "stock_on_hand": stock,
        "product_type": "goods",
        "status": "active",
        **extra,
    }


async def _seed(db, items, loaded_at=None):
    db.add(
        OrderBoardDoc(
            kind="state",
            zoho_id="board",
            header={},
            detail={"catalog_loaded_at": loaded_at or datetime.now(timezone.utc).isoformat()},
        )
    )
    db.add_all(OrderBoardDoc(kind="catalog", zoho_id=i["item_id"], header=i) for i in items)
    await db.commit()


async def _ids(db, query):
    return [i["id"] for i in await actions.search_items(db, query)]


@pytest.mark.asyncio
async def test_words_match_in_any_order_regardless_of_accents_and_case(db_session, monkeypatch):
    async def never(*a):
        raise AssertionError("the local copy answers without Books")

    monkeypatch.setattr(zoho_service, "list_items", never)
    await _seed(
        db_session,
        [
            _goods("y", "Bambu Lab - PETG HF - Jaune - 1kg", stock=2),
            _goods("b", "Bambu Lab - PETG HF - Bleu - 1kg", stock=2),
            _goods("e", "Écran Bambu", stock=1),
        ],
    )
    assert await _ids(db_session, "jaun PETG") == ["y"]
    assert await _ids(db_session, "ecran") == ["e"]


@pytest.mark.asyncio
async def test_in_stock_first_then_a_typo_only_when_exact_words_run_short(db_session):
    await _seed(
        db_session,
        [
            _goods("out", "PETG Jaune", stock=0),
            _goods("in", "PETG Jaune Citron", stock=3),
            _goods("typo", "PETG Jeune", stock=9),
        ],
    )
    assert await _ids(db_session, "petg jaune") == ["in", "out", "typo"]  # two exact hits < 8: the typo is added last
    assert await _ids(db_session, "petg jaine") == ["in", "out"]  # one letter off "jaune", two off "jeune"


@pytest.mark.asyncio
async def test_an_exact_sku_comes_first_and_open_order_stock_wins(db_session):
    await _seed(db_session, [_goods("a", "Buse 0.4 ABC", sku="X1", stock=5), _goods("b", "Buse X1", sku="NZ", stock=0)])
    db_session.add(OrderBoardDoc(kind="item", zoho_id="b", header={"item_id": "b", "stock_on_hand": 7}))
    await db_session.commit()
    found = await actions.search_items(db_session, "x1")
    assert [i["id"] for i in found] == ["a", "b"]
    assert found[1]["stock_on_hand"] == 7.0


@pytest.mark.asyncio
async def test_available_is_stock_minus_committed_and_it_ranks(db_session):
    await _seed(
        db_session,
        [
            _goods("held", "PETG Jaune A", stock=50, available_for_sale=-3),  # over-committed: shown as 0
            _goods("free", "PETG Jaune B", stock=5, available_for_sale=5),
        ],
    )
    # The open-order re-read wins; actual_available_stock ignores commitments (49 on hand, 1 on another order).
    db_session.add(
        OrderBoardDoc(
            kind="item",
            zoho_id="free",
            header={"item_id": "free", "stock_on_hand": 5, "available_for_sale": 2, "actual_available_stock": 5},
        )
    )
    await db_session.commit()
    found = await actions.search_items(db_session, "petg jaune")
    assert [(i["id"], i["stock_on_hand"], i["available"]) for i in found] == [("free", 5.0, 2.0), ("held", 50.0, 0.0)]


@pytest.mark.asyncio
async def test_an_item_in_the_filaments_category_is_a_filament(db_session):
    await _seed(
        db_session,
        [
            _goods("f", "PETG Jaune", cf_nature_du_produit="Filaments"),
            _goods("p", "PETG nozzle", cf_nature_du_produit="3D Printer Replacement Parts"),
        ],
    )
    assert {i["id"]: i["filament"] for i in await actions.search_items(db_session, "petg")} == {"f": True, "p": False}


@pytest.mark.asyncio
async def test_every_code_finds_its_item_and_an_exact_one_comes_first(db_session):
    await _seed(
        db_session,
        [
            _goods("near", "Plateau REF-12 compatible", stock=9),
            _goods("ref", "Plateau PEI", cf_r_f_rence="REF-12"),
            _goods("pn", "Buse", part_number="FAL-0.4-HS"),
            _goods("ean", "Spatule", ean="3760123456789"),
        ],
    )
    assert await _ids(db_session, "ref-12") == ["ref", "near"]
    assert await _ids(db_session, "fal-0.4") == ["pn"]
    assert await _ids(db_session, "3760123456789") == ["ean"]


@pytest.mark.asyncio
async def test_a_filament_diameter_in_the_name_makes_a_filament_without_the_category(db_session):
    await _seed(
        db_session, [_goods("bl", "Bambu Lab - PETG HF - Jaune (Yellow) - 1.75mm - 1kg"), _goods("n", "Buse 1.75")]
    )
    assert {i["id"]: i["filament"] for i in await actions.search_items(db_session, "jaune")} == {"bl": True}
    assert {i["id"]: i["filament"] for i in await actions.search_items(db_session, "buse")} == {"n": False}


@pytest.mark.asyncio
async def test_without_a_copy_or_for_an_unknown_barcode_books_is_asked(db_session, monkeypatch):
    asked = []

    async def list_items(db, text):
        asked.append(text)
        return [_goods("z", "From Books")]

    async def by_code(db, code):
        return []

    monkeypatch.setattr(zoho_service, "list_items", list_items)
    monkeypatch.setattr(zoho_service, "list_items_by_code", by_code)
    assert await _ids(db_session, "books") == ["z"]
    await _seed(db_session, [_goods("a", "Buse")])
    assert await _ids(db_session, "37601234") == ["z"]
    assert await _ids(db_session, "nothing") == []
    assert asked == ["books", "37601234"]


@pytest.mark.asyncio
async def test_the_pass_sweeps_a_stale_copy_keeping_active_goods_only(db_session, zoho):  # noqa: F811
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await _seed(db_session, [_goods("gone", "Old item")], loaded_at=old)
    zoho.catalog = [
        _goods("a", "Kept"),
        _goods("svc", "Labour", product_type="service"),
        _goods("off", "Retired", status="inactive"),
        _goods("b", "Also kept"),
        _goods("c", "Third page"),
    ]
    await sync.run_pass(db_session)
    ids = (await db_session.execute(select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == "catalog"))).scalars()
    assert sorted(ids) == ["a", "b", "c"]
    assert zoho.calls["catalog"] == 3
    await sync.run_pass(db_session)
    assert zoho.calls["catalog"] == 3  # fresh now: no second sweep


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [ZohoRateLimited("slow down"), ZohoUnreachable("down")])
async def test_a_failed_sweep_keeps_the_old_copy_and_the_board(db_session, zoho, monkeypatch, error):  # noqa: F811
    old = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    await _seed(db_session, [_goods("keep", "Old item")], loaded_at=old)

    async def boom(db, page):
        raise error

    monkeypatch.setattr(zoho_service, "list_items_page_all", boom)
    await sync.run_pass(db_session)
    ids = (await db_session.execute(select(OrderBoardDoc.zoho_id).where(OrderBoardDoc.kind == "catalog"))).scalars()
    assert list(ids) == ["keep"]
    state = await sync._find_state(db_session)
    assert state.detail.get("last_error") is None
