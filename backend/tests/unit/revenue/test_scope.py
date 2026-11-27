from backend.app.services.revenue.config import REVENUE_SERVICE_ACCOUNT_ID as ACC
from backend.app.services.revenue.customers import RevenueCustomerFacts, customer_display_name, segment_of
from backend.app.services.revenue.scope import (
    RevenueDecision,
    ScopeItem,
    ScopeVerdict,
    build_review_list,
    classify_revenue_item,
    fold,
    is_service_item,
    item_display_name,
    service_nature,
    unit_cost_of,
)


def item(**over):
    return ScopeItem(**{"item_id": "i1", "name": "X", "tax_percentage": 16, **over})


def dec(item_id, included):
    return RevenueDecision(item_id, included, "2026-10-15T00:00:00.000Z")


def verdict(it, d=None):
    return classify_revenue_item(it, d)


def test_nature_in_the_3d_groups_is_in_scope_compared_trimmed_and_case_insensitively():
    assert verdict(item(nature="Filaments")) == ScopeVerdict(True, "nature")
    assert verdict(item(nature=" 3d printer replacement parts ")) == ScopeVerdict(True, "nature")


def test_a_marine_nature_with_no_3d_brand_is_unclassified_not_excluded():
    assert verdict(item(nature="Hobie Sailing", brand="Hobie")) == ScopeVerdict(False, "unclassified")


def test_brand_in_the_3d_list_is_in_scope_whatever_the_nature_case_insensitively():
    assert verdict(item(brand="Aito3D")) == ScopeVerdict(True, "brand")
    assert verdict(item(brand="ESUN")) == ScopeVerdict(True, "brand")
    assert verdict(item(brand="ultimaker", nature="")) == ScopeVerdict(True, "brand")


def test_nature_wins_the_reason_when_both_match():
    assert verdict(item(brand="SUNLU", nature="Filaments")).reason == "nature"


def test_a_decision_wins_over_both_rules_in_either_direction():
    assert verdict(item(brand="Hobie"), dec("i1", True)) == ScopeVerdict(True, "decision-include")
    assert verdict(item(brand="SUNLU", nature="Filaments"), dec("i1", False)) == ScopeVerdict(False, "decision-exclude")


def test_an_item_missing_from_the_substrate_is_unknown_item_unless_decided():
    assert verdict(None) == ScopeVerdict(False, "unknown-item")
    assert verdict(None, dec("gone", True)) == ScopeVerdict(True, "decision-include")


def test_unit_cost_is_the_prix_dealer_else_the_purchase_rate_else_null():
    assert [unit_cost_of(500, 800), unit_cost_of(500, 0), unit_cost_of(0, None)] == [800, 500, None]


TOTALS = [
    {
        "itemId": "snap",
        "name": "Snap Maker - Artisan",
        "sku": "",
        "totalHt": 596983,
        "quantity": 1,
        "lastDay": "2026-03-02",
    },
    {
        "itemId": "cowork",
        "name": "Co Working Bureau Privé",
        "sku": "",
        "totalHt": 481500,
        "quantity": 12,
        "lastDay": "2026-09-30",
    },
    {"itemId": "pla", "name": "SUNLU PLA", "sku": "SNL", "totalHt": 10785, "quantity": 3, "lastDay": "2026-10-01"},
    {"itemId": "refund", "name": "Old thing", "sku": "", "totalHt": -2000, "quantity": -1, "lastDay": "2026-01-05"},
    {"itemId": "gone", "name": "Deleted item", "sku": "", "totalHt": 999, "quantity": 1, "lastDay": "2025-06-01"},
]
ITEMS = {
    "snap": item(item_id="snap", name="Snap Maker - Artisan"),
    "cowork": item(item_id="cowork", name="Co Working Bureau Privé", tax_percentage=13),
    "pla": item(item_id="pla", name="SUNLU PLA", brand="SUNLU", nature="Filaments"),
    "refund": item(item_id="refund", name="Old thing"),
}


def test_lists_every_item_with_revenue_that_matches_no_rule_and_has_no_decision_by_total_descending():
    unclassified = build_review_list(TOTALS, ITEMS, [])["unclassified"]
    assert [r["itemId"] for r in unclassified] == ["snap", "cowork", "refund", "gone"]
    assert unclassified[3] == {
        "itemId": "gone", "name": "Deleted item", "sku": "", "totalHt": 999, "quantity": 1,
        "lastDay": "2025-06-01", "brand": None, "nature": None,
    }  # fmt: skip


def test_a_decided_item_leaves_the_unclassified_list_and_appears_in_the_decided_list_with_its_totals():
    out = build_review_list(TOTALS, ITEMS, [dec("snap", True), dec("pla", False)])
    assert [r["itemId"] for r in out["unclassified"]] == ["cowork", "refund", "gone"]
    assert [[r["itemId"], r["included"], r["totalHt"]] for r in out["decided"]] == [
        ["snap", True, 596983],
        ["pla", False, 10785],
    ]


def test_a_decided_item_with_no_revenue_at_all_still_appears_in_the_decided_list_with_a_0_total():
    assert build_review_list(TOTALS, ITEMS, [dec("nothing", False)])["decided"] == [
        {
            "itemId": "nothing", "name": "nothing", "sku": "", "totalHt": 0, "quantity": 0, "lastDay": "",
            "brand": None, "nature": None, "included": False, "decidedAt": "2026-10-15T00:00:00.000Z",
        }
    ]  # fmt: skip


def test_a_service_is_an_item_on_the_service_account_anything_else_reads_as_goods():
    assert is_service_item(item(account_id=ACC)) is True
    assert is_service_item(item(account_id="other")) is False
    assert is_service_item(item(account_id=None)) is False  # cached before the column existed
    assert is_service_item(None) is False


def test_the_items_name_when_known_else_the_fallback():
    assert item_display_name(item(name="Current"), "Old") == "Current"
    assert item_display_name(None, "Old") == "Old"


def test_orders_by_total_descending_a_negative_ranks_by_magnitude_then_by_name():
    totals = [
        {"itemId": n, "name": n, "sku": "", "totalHt": t, "quantity": 1, "lastDay": ""}
        for n, t in [("b", 100), ("a", -300), ("c", 300), ("a2", 100), ("z", 0)]
    ]
    assert [r["name"] for r in build_review_list(totals, {}, [])["unclassified"]] == ["a", "c", "a2", "b", "z"]


def test_fold_trims_casefolds_and_strips_accents():
    assert fold("  Éco Privé ") == "eco prive"
    assert fold(None) == ""


def facts(**over):
    return RevenueCustomerFacts(**{"customer_id": "x", "name": "N", **over})


def test_the_walk_in_account_id_is_passage_even_typed_business():
    assert segment_of("66407000001237340", facts(sub_type="business")) == "passage"


def test_the_walk_in_account_name_is_passage():
    assert segment_of("x", facts(name="Client de Passage")) == "passage"


def test_no_customer_id_is_inconnu():
    assert segment_of(None, None) == "inconnu"
    assert segment_of("", facts()) == "inconnu"


def test_individual_is_particulier_business_is_pro_unknown_contact_is_inconnu():
    assert segment_of("y", facts(sub_type="individual")) == "particulier"
    assert segment_of("y", facts(sub_type="business")) == "pro"
    assert segment_of("y", None) == "inconnu"


def test_customer_display_name_falls_back_name_company_id():
    assert customer_display_name("", None) == "Non identifié"
    assert customer_display_name("c1", facts(name=" ", company_name="Acme")) == "Acme"
    assert customer_display_name("c1", None) == "c1"


def test_service_nature_from_aito_service_name():
    assert service_nature('Impression3D - Prestation "AITO 3D"', ACC, None) == "Impression3D"
    assert service_nature('Découpe et Gravure Laser - Prestation "AITO 3D"', ACC, None) == "Découpe et Gravure Laser"
    assert service_nature('Usinage - Vente "AITO 3D"', ACC, None) == "Usinage"
    # A Zoho category wins; items off the account, and other names on it, are left alone.
    assert service_nature('Scan3D - Prestation "AITO 3D"', ACC, "Scan") == "Scan"
    assert service_nature('Scan3D - Prestation "AITO 3D"', "other", None) is None
    assert service_nature('Scan3D - Prestation "AITO 3D"', None, None) is None
    assert service_nature('Prestation "AITO 3D"', ACC, None) is None
    assert service_nature("Starlink - Support Mini", ACC, None) is None
