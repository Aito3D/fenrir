"""Which Zoho shipping service reaches which island.

Air Tahiti's scheduled freight network, grouped into the five "Livraison
Avion" items the shop's Books catalogue carries. This is the ONLY copy of the
table: the frontend receives it over the wire from
``GET /aito/shipping/services`` rather than mirroring it, so the two can never
disagree.

Excluded on purpose, and each exclusion is a decision rather than an
oversight (see the design doc):
  - Tahiti, the shop's own island. Nothing is flown to it.
  - Islands with no airstrip: Taha'a (served via Raiatea), Fatu Hiva and
    Tahuata (boat from Hiva Oa), Rapa (ship only), Maiao.
  - Charter-only Tuamotu atolls (Marokau, Nengonengo, Hereheretue,
    Manuhangi, Anuanuraro, Rekareka, Tepoto) and Tetiaroa's private strip.

The island KEY is what the database stores; the label is presentation and may
be respelled without orphaning a project.
"""

import unicodedata

SERVICE_KEYS: tuple[str, ...] = ("societe", "tuamotu", "marquises", "australes", "gambier")

# The Books item names, spelled exactly as the catalogue does — these strings
# are what `resolve_shipping_items` matches Zoho's `/items` response against.
SERVICE_LABELS: dict[str, str] = {
    "societe": "Livraison Avion Société",
    "tuamotu": "Livraison Avion Tuamotu",
    "marquises": "Livraison Avion Marquises",
    "australes": "Livraison Avion Australes",
    "gambier": "Livraison Avion Gambier",
}

# (island key, display label, service key)
ISLANDS: tuple[tuple[str, str, str], ...] = (
    # --- Société ---
    ("moorea", "Moorea", "societe"),
    ("huahine", "Huahine", "societe"),
    ("raiatea", "Raiatea", "societe"),
    ("bora-bora", "Bora Bora", "societe"),
    ("maupiti", "Maupiti", "societe"),
    # --- Tuamotu ---
    ("ahe", "Ahe", "tuamotu"),
    ("anaa", "Anaa", "tuamotu"),
    ("apataki", "Apataki", "tuamotu"),
    ("aratika", "Aratika", "tuamotu"),
    ("arutua", "Arutua", "tuamotu"),
    ("faaite", "Faaite", "tuamotu"),
    ("fakahina", "Fakahina", "tuamotu"),
    ("fakarava", "Fakarava", "tuamotu"),
    ("fangatau", "Fangatau", "tuamotu"),
    ("hao", "Hao", "tuamotu"),
    ("hikueru", "Hikueru", "tuamotu"),
    ("katiu", "Katiu", "tuamotu"),
    ("kauehi", "Kauehi", "tuamotu"),
    ("kaukura", "Kaukura", "tuamotu"),
    ("makemo", "Makemo", "tuamotu"),
    ("manihi", "Manihi", "tuamotu"),
    ("mataiva", "Mataiva", "tuamotu"),
    ("napuka", "Napuka", "tuamotu"),
    ("niau", "Niau", "tuamotu"),
    ("nukutavake", "Nukutavake", "tuamotu"),
    ("puka-puka", "Puka Puka", "tuamotu"),
    ("rangiroa", "Rangiroa", "tuamotu"),
    ("raroia", "Raroia", "tuamotu"),
    ("reao", "Reao", "tuamotu"),
    ("takapoto", "Takapoto", "tuamotu"),
    ("takaroa", "Takaroa", "tuamotu"),
    ("takume", "Takume", "tuamotu"),
    ("tatakoto", "Tatakoto", "tuamotu"),
    ("tikehau", "Tikehau", "tuamotu"),
    ("tureia", "Tureia", "tuamotu"),
    ("vahitahi", "Vahitahi", "tuamotu"),
    # --- Marquises ---
    ("nuku-hiva", "Nuku Hiva", "marquises"),
    ("hiva-oa", "Hiva Oa", "marquises"),
    ("ua-pou", "Ua Pou", "marquises"),
    ("ua-huka", "Ua Huka", "marquises"),
    # --- Australes ---
    ("rurutu", "Rurutu", "australes"),
    ("tubuai", "Tubuai", "australes"),
    ("rimatara", "Rimatara", "australes"),
    ("raivavae", "Raivavae", "australes"),
    # --- Gambier ---
    ("mangareva", "Mangareva (Rikitea)", "gambier"),
)

_BY_KEY: dict[str, tuple[str, str]] = {key: (label, service) for key, label, service in ISLANDS}


def _fold(value: str) -> str:
    """Case- and accent-insensitive comparison key. Same idea as the
    importer's own `_fold`: a label read back out of a quote may have been
    retyped by a human in Books."""
    stripped = unicodedata.normalize("NFKD", (value or "").strip().lower())
    return "".join(char for char in stripped if not unicodedata.combining(char))


_BY_LABEL: dict[str, str] = {_fold(label): key for key, label, _ in ISLANDS}


def service_for_island(island: str | None) -> str | None:
    entry = _BY_KEY.get(island or "")
    return entry[1] if entry else None


def island_label(island: str | None) -> str | None:
    entry = _BY_KEY.get(island or "")
    return entry[0] if entry else None


def island_for_label(label: str | None) -> str | None:
    """The island key a display label came from, or None. Used by the importer
    to read an `Île:` row back off a quote line."""
    return _BY_LABEL.get(_fold(label or ""))


def grouped_islands() -> list[tuple[str, list[tuple[str, str]]]]:
    """Islands per service, in SERVICE_KEYS order — the shape the picker
    renders as option groups."""
    return [(service, [(key, label) for key, label, owner in ISLANDS if owner == service]) for service in SERVICE_KEYS]
