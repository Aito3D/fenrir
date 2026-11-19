from dataclasses import dataclass

REVENUE_HISTORY_START = "2024-01-01"
REVENUE_LINE_FORMAT = 2
ORG_TIME_ZONE = "Pacific/Tahiti"

REVENUE_PASSAGE_CUSTOMER_IDS = ["66407000001237340"]
REVENUE_PASSAGE_CUSTOMER_NAMES = ["client de passage"]

REVENUE_NATURES = [
    "3D Printers",
    "3D Printer Accessories",
    "3D Printer Replacement Parts",
    "3D Printer Adhesives",
    "Filaments",
]

REVENUE_BRANDS = [
    "Aito3D",
    "Bambu Lab",
    "eSUN",
    "SUNLU",
    "Polymaker",
    "Inslogic",
    "Magigoo",
    "Ultimaker",
    "R3D",
    "Rosa3D",
]

REVENUE_GRANULARITIES = ("day", "week", "month", "year")


@dataclass(frozen=True)
class SyncConfig:
    day_batch_size: int = 10
    batch_pause_s: int = 3
    idle_interval_s: int = 60
    error_backoff_s: int = 120
    idle_after_s: int = 1800
    live_ttl_s: int = 60
    recent_days: int = 7
    recent_ttl_s: int = 43200
    customer_lookups: int = 5
    items_ttl_s: int = 600
    min_call_gap_s: float = 0.7
    call_ceiling: int = 20  # Order Board stops at 30; staying below keeps its lane fed during a back-fill
    daily_budget_floor: int = 5000


SYNC = SyncConfig()
