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

from dataclasses import dataclass

from backend.app.services.aito_quote_import import service_for_sku

# Canonical service order — the same order the board renders badges in and the
# order lines are emitted within a task. Mirrors SERVICE_RANK in
# aito_quote_import and _SERVICE_COLUMNS in api/routes/aito.py.
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
    description: str | None
    scan_cost: float | None
    modelisation_cost: float | None
    usinage_cost: float | None
    impression_cost: float | None
    impression_quantity: int | None
    impression_weight_g: float | None
    impression_time_min: int | None
    impression_color: str | None
    material: str | None


def cost_of(task: ExportTask, service: str) -> float | None:
    """The task's cost for one service. NULL means the service is disabled;
    0 stays meaningful as 'free', so callers must test for None, not falsiness."""
    return {
        "scan": task.scan_cost,
        "modelisation": task.modelisation_cost,
        "impression": task.impression_cost,
        "usinage": task.usinage_cost,
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
    """(label, value) pairs for a service line, in catalogue-template order."""
    if service in ("scan", "modelisation"):
        return [("Info", task.title)]
    if service == "usinage":
        return [("Usinage", task.title)]
    return [
        ("Projet", task.title),
        ("Matériau", task.material),
        ("Poids", format_weight(task.impression_weight_g)),
        ("Temps", format_time(task.impression_time_min)),
        ("Couleur", task.impression_color),
    ]


def build_description(service: str, task: ExportTask, *, include_free_text: bool) -> str:
    """The catalogue template with its placeholders filled.

    A row whose value is empty is dropped whole rather than emitted as a bare
    ``Poids:`` — and the unfilled markers themselves ([TITLE], [MATERIAL], ...)
    are never written, because the importer treats them as absent data. So an
    empty field round-trips to an empty field either way; dropping the row is
    simply what a human would have typed.
    """
    lines = [f"{label}: {value.strip()}" for label, value in _rows(service, task) if value and str(value).strip()]
    if service in ("scan", "modelisation"):
        lines.append(_FICHIER_NON_CEDE)
    if include_free_text and task.description and task.description.strip():
        lines.append(task.description.strip())
    return "\n".join(lines)


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

    def item_id(self, service: str) -> str:
        return {
            "scan": self.scan_item_id,
            "modelisation": self.modelisation_item_id,
            "impression": self.impression_item_id,
            "usinage": self.usinage_item_id,
        }[service]


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


def is_foreign(line: dict) -> bool:
    """True for a line this app does not own: not a header, and not one of the
    four AITO service SKUs. Retail items, laser cuts, delivery fees.

    A header row is deliberately NOT foreign. Headers are positional and carry
    no identity, so one typed by hand in Books is indistinguishable from one we
    wrote; both are re-derived on every push. That is a known limit of the
    format, not an oversight.
    """
    if line.get("line_item_category") == "header":
        return False
    return service_for_sku(line.get("sku")) is None


def build_line_items(
    tasks: list[ExportTask],
    existing_line_items: list[dict],
    catalogue: Catalogue,
) -> list[dict]:
    """The full ``line_items`` array for a create or update.

    Tasks first, in board order, each preceded by a header naming it when the
    project has more than one task — a header over the only thing on the quote
    is noise on the PDF. Then every foreign line, echoed as a bare
    ``line_item_id``, which Books expands back into the untouched original.
    Omitting a line deletes it, so anything not returned here is gone.
    """
    lines: list[dict] = []
    emitted = [t for t in tasks if enabled_services(t)]
    for task_row in emitted:
        services = enabled_services(task_row)
        if len(tasks) > 1 and task_row.title and task_row.title.strip():
            lines.append({"line_item_category": "header", "name": task_row.title.strip()[:_TITLE_MAX]})
        for index, service in enumerate(services):
            if service == "impression":
                rate, quantity = impression_rate_quantity(task_row)
            else:
                rate, quantity = cost_of(task_row, service), 1
            lines.append(
                {
                    "item_id": catalogue.item_id(service),
                    "tax_id": catalogue.tax_id,
                    "unit": "Projet",
                    "rate": rate,
                    "quantity": quantity,
                    # The task's own free text belongs on the line a reader
                    # meets first, once — not repeated under all four services.
                    "description": build_description(service, task_row, include_free_text=index == 0),
                }
            )
    for line in sorted(existing_line_items, key=lambda item: item.get("item_order") or 0):
        if is_foreign(line) and line.get("line_item_id"):
            lines.append({"line_item_id": line["line_item_id"]})
    for position, line in enumerate(lines, start=1):
        line["item_order"] = position
    return lines
