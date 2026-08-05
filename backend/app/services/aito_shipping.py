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

import math
import unicodedata
from dataclasses import dataclass

SERVICE_KEYS: tuple[str, ...] = ("societe", "tuamotu", "marquises", "australes", "gambier")

# The Books item names, spelled exactly as the catalogue does — these strings
# are what `merge_shipping_catalogue` matches Zoho's `/items` response against.
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


@dataclass(frozen=True)
class ShippingItem:
    """One resolved Books item. ``rate`` is None when Zoho gave no price —
    the drawer then requires the operator to type one."""

    item_id: str
    name: str
    rate: float | None


_BY_SERVICE_LABEL: dict[str, str] = {_fold(label): key for key, label in SERVICE_LABELS.items()}


def merge_shipping_catalogue(cached: dict[str, dict], items: list[dict]) -> dict[str, dict]:
    """Fold a fresh ``/items`` response onto what is already cached.

    Two rules, and the first is load-bearing:

    - **An item id is never forgotten.** A service present in ``cached`` but
      absent from ``items`` survives untouched. ``Catalogue.item_ids()`` is
      what tells ``aito_quote_export.is_foreign`` that a line is ours, so a
      forgotten id would make the shipping line we wrote last push classify as
      FOREIGN — preserved by ``line_item_id`` *and* re-emitted fresh from the
      project — duplicating itself a little more on every sync. This is the
      exact failure the item-id check in ``is_foreign`` exists to prevent for
      the four service items.
    - **A rate is only overwritten by a real one.** An item echoed back
      without a price — or with one Books sent malformed (``""``, a
      non-numeric string, or a non-finite one: ``NaN``/``Infinity``) — keeps
      the price we already knew, rather than dropping to None and forcing
      manual entry, or raising and losing the whole cache, for no reason. A
      NaN is not merely a bad rate: ``json.dumps`` serialises it as the bare
      token ``NaN``, which is NOT valid JSON — ``JSON.parse`` on the frontend
      rejects the whole ``/aito/shipping/services`` response for it, emptying
      the island picker, and the bad value then sits in the settings row
      until a refresh happens to overwrite it with a finite one.

    A name Zoho reports that matches no service is simply not a shipping item
    and is ignored. Matching is case- and accent-insensitive because the search
    is by name and Books normalises nothing.

    The stored ``name`` is always our own ``SERVICE_LABELS`` spelling, never
    whatever string Books echoed back — so "LIVRAISON AVION SOCIETE" is stored
    (and later printed on the estimate) as "Livraison Avion Société".
    """
    merged = {key: dict(value) for key, value in (cached or {}).items()}
    for item in items or []:
        service = _BY_SERVICE_LABEL.get(_fold(str(item.get("name") or "")))
        if service is None:
            continue
        item_id = str(item.get("item_id") or "").strip()
        if not item_id:
            continue
        raw_rate = item.get("rate")
        entry = merged.get(service, {})
        try:
            rate = float(raw_rate) if raw_rate is not None else entry.get("rate")
        except (TypeError, ValueError):
            # Books has been seen to send "" for an empty numeric field; a
            # value that won't parse is no reason to forget a price we
            # already knew.
            rate = entry.get("rate")
        else:
            if rate is not None and not math.isfinite(rate):
                # float("nan") / float("inf") parse cleanly but are not a
                # rate — and a NaN in particular breaks JSON for every caller
                # (see the docstring above). Same fallback as the parse
                # failure above: keep the cached price.
                rate = entry.get("rate")
        merged[service] = {
            "item_id": item_id,
            "name": SERVICE_LABELS[service],
            "rate": rate,
        }
    return merged
