from dataclasses import dataclass

from backend.app.services.revenue.config import REVENUE_PASSAGE_CUSTOMER_IDS, REVENUE_PASSAGE_CUSTOMER_NAMES
from backend.app.services.revenue.scope import fold

CUSTOMER_SEGMENTS = ("pro", "particulier", "passage", "inconnu")
SEGMENT_LABEL = {"pro": "Pro", "particulier": "Particuliers", "passage": "Passage", "inconnu": "Non identifié"}

_PASSAGE_IDS = frozenset(REVENUE_PASSAGE_CUSTOMER_IDS)
_PASSAGE_NAMES = frozenset(REVENUE_PASSAGE_CUSTOMER_NAMES)


@dataclass(frozen=True)
class RevenueCustomerFacts:
    customer_id: str
    name: str | None = None
    company_name: str | None = None
    sub_type: str | None = None


def segment_of(customer_id: str | None, facts: RevenueCustomerFacts | None) -> str:
    if not customer_id:
        return "inconnu"
    if customer_id in _PASSAGE_IDS or fold(facts.name if facts else None) in _PASSAGE_NAMES:
        return "passage"
    sub_type = facts.sub_type if facts else None
    if sub_type == "business":
        return "pro"
    if sub_type == "individual":
        return "particulier"
    return "inconnu"


def customer_display_name(customer_id: str, facts: RevenueCustomerFacts | None) -> str:
    if not customer_id:
        return SEGMENT_LABEL["inconnu"]
    return ((facts.name or "").strip() or (facts.company_name or "").strip() or customer_id) if facts else customer_id
