"""Convert an Aito project's tasks into Zoho Books estimate line items.

The mirror of ``aito_quote_import``. Every function here is pure: no database,
no HTTP. The caller resolves the filament to a material string and hands over
plain ``ExportTask`` values, which keeps the whole formatting surface — the
fiddliest part — testable without fixtures of live payloads.

Governing rule: whatever this module writes, ``aito_quote_import`` must read
back unchanged. The formatters below are written against ``parse_weight_g``
and ``parse_time_min`` for exactly that reason, and the round-trip tests are
the guard.
"""

from dataclasses import dataclass, field

from backend.app.services.aito_quote_import import service_for_sku

# Canonical service order — the same order the board renders badges in and the
# order lines are emitted within a task. Mirrors SERVICE_RANK in
# aito_quote_import and SERVICES in aito_board_rules.py.
SERVICES: tuple[str, ...] = ("scan", "modelisation", "impression", "usinage")

# The boilerplate row the scan and modelisation catalogue items carry. Written
# exactly as the catalogue spells it; the importer strips it case- and
# accent-insensitively, so it never round-trips into a task description.
_FICHIER_NON_CEDE = "*Fichier non cédé*"


@dataclass(frozen=True)
class ExportTask:
    """One Aito task, flattened for export.

    ``material`` is the filament's ``type`` (``PETG``, ``PLA``, ``ASA``),
    resolved by the caller — this module never touches the database. It is the
    bare type rather than the brand-prefixed inventory name because that is
    what the shop's real quotes say, and because the importer cannot map a
    brand back onto an inventory row.
    """

    title: str | None
    scan_cost: float | None
    modelisation_cost: float | None
    usinage_cost: float | None
    impression_cost: float | None
    impression_quantity: int | None
    impression_weight_g: float | None
    impression_time_min: int | None
    impression_color: str | None
    material: str | None
    # Percent, not amount — the shop's Books org discounts at item level and
    # stores "10.00%" on the line. None means no discount, and 0 is treated
    # the same: a literal "0%" would put a pointless discount column on the
    # PDF. Impression only; the other services have no discount concept.
    impression_discount_pct: float | None = None
    # Optional per-service free text, emitted as that line's leading `Info:`
    # row. None = no Info row at all. Defaults keep older call sites and test
    # helpers valid while the fields roll out.
    scan_description: str | None = None
    modelisation_description: str | None = None
    impression_description: str | None = None
    usinage_description: str | None = None


@dataclass(frozen=True)
class ExportShipping:
    """One project's air freight, flattened for export.

    ``island_label`` is the display label, not the key: it is what the quote
    prints and what ``aito_quote_import.island_for_label`` reads back.
    """

    service: str
    island_label: str
    first_name: str
    last_name: str
    phone: str
    price: float


def cost_of(task: ExportTask, service: str) -> float | None:
    """The task's cost for one service. NULL means the service is disabled;
    0 stays meaningful as 'free', so callers must test for None, not falsiness."""
    return {
        "scan": task.scan_cost,
        "modelisation": task.modelisation_cost,
        "impression": task.impression_cost,
        "usinage": task.usinage_cost,
    }[service]


def description_of(task: ExportTask, service: str) -> str | None:
    """The task's free text for one service — the line's `Info:` row."""
    return {
        "scan": task.scan_description,
        "modelisation": task.modelisation_description,
        "impression": task.impression_description,
        "usinage": task.usinage_description,
    }[service]


def enabled_services(task: ExportTask) -> tuple[str, ...]:
    return tuple(service for service in SERVICES if cost_of(task, service) is not None)


def format_weight(grams: float | None) -> str | None:
    """210 -> '210 gr', 1.5 -> '1.5 gr'. Read back by ``parse_weight_g``.

    A whole number drops the trailing '.0' so the common case reads like a
    human wrote it. A fractional value is rendered with ``repr()``, which is
    Python's shortest decimal string that round-trips back to the exact same
    float — unlike ``:g``, which caps at 6 significant digits and switches to
    scientific notation past 1e6, silently corrupting the round trip through
    ``_WEIGHT_RE`` (which has no exponent support at all).

    ``repr()`` itself only stays in plain decimal for
    ``0.0001 <= abs(grams) < 1e16``; outside that range it too turns
    exponential. That is a far wider domain than any real print weight, so it
    is not worth guarding against here.
    """
    if grams is None:
        return None
    grams = float(grams)
    if grams.is_integer():
        return f"{int(grams)} gr"
    return f"{grams!r} gr"


def format_time(minutes: int | None) -> str | None:
    """780 -> '13h', 26 -> '26min', 150 -> '2h30', 125 -> '2h05'.

    Read back by ``parse_time_min``, which accumulates tokens — so the
    zero-padded minutes in '2h05' sum to 120 + 5 rather than being misread.
    """
    if minutes is None:
        return None
    if minutes < 60:
        return f"{minutes}min"
    hours, remainder = divmod(minutes, 60)
    return f"{hours}h" if remainder == 0 else f"{hours}h{remainder:02d}"


def _rows(service: str, task: ExportTask) -> list[tuple[str, str | None]]:
    """(label, value) pairs for a service line: impression's print-parameter
    rows, then the optional `Info:` row carrying the service's own
    description. The other three services have nothing but that Info row. The
    task title is deliberately NOWHERE in here — it lives only in the header.

    Info comes LAST on impression on purpose, and that ordering is load-
    bearing. A description is free text that may itself contain a row like
    ``Poids: à définir``; only its first physical line sits behind the
    ``Info:`` prefix, so every continuation line is re-read as a top-level row
    on import. ``parse_description`` gives a label's FIRST occurrence the
    field, so the canonical rows must precede the block — otherwise a note
    would silently overwrite the real weight, time or colour, and the quote
    would not read back unchanged. The pre-rework format put its free text
    after the canonical rows for exactly this reason.
    """
    rows: list[tuple[str, str | None]] = []
    if service == "impression":
        rows += [
            ("Matériau", task.material),
            ("Poids", format_weight(task.impression_weight_g)),
            ("Temps", format_time(task.impression_time_min)),
            ("Couleur", task.impression_color),
        ]
    rows.append(("Info", description_of(task, service)))
    return rows


def build_description(service: str, task: ExportTask) -> str:
    """The service line's description: its canonical rows plus an Info row.

    A row whose value is empty is dropped whole rather than emitted as a bare
    ``Poids:`` — simply what a human would have typed, and it round-trips
    the same either way since the importer treats a missing label as absent
    data. A service with no description of its own therefore carries no
    ``Info:`` row at all. Scan and modelisation additionally always append
    the ``*Fichier non cédé*`` boilerplate line, even when they have no other
    rows.
    """
    lines = [f"{label}: {value.strip()}" for label, value in _rows(service, task) if value and str(value).strip()]
    if service in ("scan", "modelisation"):
        lines.append(_FICHIER_NON_CEDE)
    return "\n".join(lines)


def build_shipping_description(shipping: ExportShipping) -> str:
    """The shipping line's description, in the same ``Label: valeur`` row
    convention every other line uses — so ``parse_description`` reads it back
    with no new parser. Recipient first, because that is what the freight desk
    asks for; the island last, because it is the row the importer keys on and
    a first occurrence wins there."""
    name = f"{shipping.first_name} {shipping.last_name}".strip()
    return "\n".join(
        f"{label}: {value}"
        for label, value in (("Nom", name), ("Téléphone", shipping.phone), ("Île", shipping.island_label))
        if value
    )


_TITLE_MAX = 200


@dataclass(frozen=True)
class Catalogue:
    """The Books item ids the four services map onto, plus the services tax.

    Loaded from the settings table rather than hardcoded so a catalogue change
    in Books does not need a redeploy.
    """

    scan_item_id: str
    modelisation_item_id: str
    impression_item_id: str
    usinage_item_id: str
    tax_id: str
    # Service key -> Books item id for the five "Livraison Avion" items,
    # resolved from Books and cached (services/zoho.get_shipping_catalogue).
    # A default of {} keeps every existing construction valid; an EMPTY map
    # means the catalogue has never resolved, which callers must treat as
    # "cannot push" rather than "no shipping".
    shipping: dict[str, str] = field(default_factory=dict)

    def item_id(self, service: str) -> str:
        return {
            "scan": self.scan_item_id,
            "modelisation": self.modelisation_item_id,
            "impression": self.impression_item_id,
            "usinage": self.usinage_item_id,
        }[service]

    def shipping_item_id(self, service: str) -> str:
        """The Books item for one shipping service. Raises KeyError when the
        catalogue has not resolved it — the sync worker turns that into
        "leave the project pending" rather than pushing a quote with its
        shipping line missing."""
        return self.shipping[service]

    def item_ids(self) -> frozenset[str]:
        """Every catalogue id, for ownership checks that must not rely on SKU
        prefixes alone — see ``is_foreign``. The shipping ids are in here for
        exactly the same reason the four service ids are: without them our own
        shipping line reads as foreign, and a foreign line is BOTH preserved by
        line_item_id AND re-emitted from the project, duplicating a little more
        on every push."""
        return frozenset(
            {self.scan_item_id, self.modelisation_item_id, self.impression_item_id, self.usinage_item_id}
            | set(self.shipping.values())
        )


def impression_rate_quantity(task: ExportTask) -> tuple[float, int]:
    """(rate, quantity) for the Impression3D line.

    ``impression_cost`` is the total for ALL units (the calculator reports
    ``total_ttc_qty``), but a line item is ``rate x quantity`` at
    ``price_precision: 0``. So the rate is the rounded per-unit figure, and
    ``rate * quantity`` is the total the quote can actually express — which
    the caller writes back to the task so the two sides never disagree.
    """
    quantity = max(1, int(task.impression_quantity or 1))
    return round((task.impression_cost or 0) / quantity), quantity


def is_foreign(line: dict, catalogue: Catalogue) -> bool:
    """True for a line this app does not own: not a header, and not one of the
    four AITO service items. Retail items, laser cuts, delivery fees.

    Ownership is checked two ways, either of which is enough to claim the
    line: the catalogue's item id, or the SKU prefix. The item id check comes
    first and is what makes this safe against catalogue overrides — the four
    ``zoho_item_*_id`` settings are deliberately overridable to a Books item
    whose SKU does NOT start with the usual ``P3DIMP``-style prefix (that is
    the documented reason the setting exists). Without the id check, such an
    override would make our own emitted line — echoed back by Books with that
    same item id — classify as foreign, so it both survives the "keep foreign
    lines" pass below AND gets re-emitted fresh from the task, duplicating
    itself a little more on every single push.

    A header row is deliberately NOT foreign. Headers are positional and carry
    no identity, so one typed by hand in Books is indistinguishable from one we
    wrote; both are re-derived on every push. That is a known limit of the
    format, not an oversight.
    """
    if line.get("line_item_category") == "header":
        return False
    if line.get("item_id") in catalogue.item_ids():
        return False
    return service_for_sku(line.get("sku")) is None


def build_line_items(
    tasks: list[ExportTask],
    existing_line_items: list[dict],
    catalogue: Catalogue,
    shipping: ExportShipping | None = None,
) -> list[dict]:
    """The full ``line_items`` array for a create or update.

    Tasks first, in board order, each grouped under a header naming it —
    always, even when it is the only task on the quote. The header is the ONLY
    place the task title is written now, so dropping it for a lone task would
    leave that quote naming its job nowhere and re-import titleless. A task
    with no priced service emits no line at all, header included. Then every
    foreign line, echoed as a bare ``line_item_id``, which Books expands back
    into the untouched original. Omitting a line deletes it, so anything not
    returned here is gone.

    A header is ``header_name`` stamped on every one of the task's item lines
    — that is how Books itself stores one (reference: quote DEV26-2506, where
    each grouped line carries ``header_name`` plus a Books-generated
    ``header_id``). It is NOT a standalone ``line_item_category: "header"``
    row: Books accepts that shape but stores it as a broken, priceless ITEM
    line on the PDF — the bug this replaced. Known limit: Books matches
    headers by name, so two same-titled tasks render under one shared header.
    """
    lines: list[dict] = []
    emitted = [(t, s) for t, s in ((t, enabled_services(t)) for t in tasks) if s]
    for task_row, services in emitted:
        header = task_row.title.strip()[:_TITLE_MAX] if (task_row.title or "").strip() else None
        for service in services:
            discount = None
            if service == "impression":
                rate, quantity = impression_rate_quantity(task_row)
                # "10%" not "10.00%": Books accepts either and echoes back the
                # long form; `:g` drops a float's trailing zeros so a
                # round-tripped 10.0 does not drift to "10.0%".
                if task_row.impression_discount_pct:
                    discount = f"{task_row.impression_discount_pct:g}%"
            else:
                rate, quantity = cost_of(task_row, service), 1
            lines.append(
                {
                    "item_id": catalogue.item_id(service),
                    "tax_id": catalogue.tax_id,
                    "unit": "Projet",
                    "rate": rate,
                    "quantity": quantity,
                    "description": build_description(service, task_row),
                    **({"header_name": header} if header else {}),
                    **({"discount": discount} if discount else {}),
                }
            )
    if shipping is not None:
        lines.append(
            {
                "item_id": catalogue.shipping_item_id(shipping.service),
                "tax_id": catalogue.tax_id,
                "unit": "Projet",
                "rate": shipping.price,
                "quantity": 1,
                "description": build_shipping_description(shipping),
                # No header_name on purpose: the shipment belongs to no task,
                # and a header would file it under whichever task title
                # happened to precede it.
            }
        )
    shipping_ids = frozenset(catalogue.shipping.values())
    for line in sorted(existing_line_items, key=lambda item: item.get("item_order") or 0):
        if not line.get("line_item_id"):
            continue
        # A shipping line the project does not describe — imported from a quote
        # whose island we could not match, or typed by hand in Books. It is
        # OURS by item id, so `is_foreign` says no, and omitting it here would
        # DELETE it. Echo it instead. When the project does carry shipping the
        # line above already expresses it, so this must not also fire or the
        # quote would end up with two.
        if shipping is None and line.get("item_id") in shipping_ids:
            lines.append({"line_item_id": line["line_item_id"]})
            continue
        if is_foreign(line, catalogue):
            lines.append({"line_item_id": line["line_item_id"]})
    for position, line in enumerate(lines, start=1):
        line["item_order"] = position
    return lines
