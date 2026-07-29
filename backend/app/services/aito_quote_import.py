"""Convert a Zoho Books estimate into an Aito project preview.

Every function here is pure: no database, no HTTP. The estimate and the
contact arrive as plain dicts, so the whole parsing surface — which is the
fiddliest part of the feature — is testable from captured fixtures.

Governing rule: any labelled value that fails to parse is preserved verbatim
in the task description. Nothing the quote said may vanish because a regex
did not match.
"""

import re
import unicodedata
from dataclasses import dataclass

# The four Aito services, in the canonical order the board renders badges in
# (mirrors _SERVICE_COLUMNS in backend/app/api/routes/aito.py).
SERVICE_RANK: dict[str, int] = {"scan": 0, "modelisation": 1, "impression": 2, "usinage": 3}

# The shop's own service names, written into an imported task's description as
# preserved quote wording. Deliberately NOT the translated UI labels (see
# frontend/src/components/aito/services.ts): this text is a record of what the
# quote said, and renaming it would make old and new imports read differently.
SERVICE_LABEL: dict[str, str] = {
    "scan": "Scan3D",
    "modelisation": "Modelisation3D",
    "impression": "Impression3D",
    "usinage": "Usinage",
}

# How each label is spelled back out when its value is preserved verbatim.
LABEL_DISPLAY: dict[str, str] = {
    "info": "Info",
    "projet": "Projet",
    "usinage": "Usinage",
    "materiau": "Matériau",
    "poids": "Poids",
    "temps": "Temps",
    "couleur": "Couleur",
    "dimensions": "Dimensions",
}

# Labels that can supply a task title, in the order they are tried.
TITLE_LABELS: tuple[str, ...] = ("projet", "info", "usinage")

# The order labels are emitted in when preserved.
LABEL_ORDER: tuple[str, ...] = ("info", "projet", "usinage", "materiau", "dimensions", "poids", "temps", "couleur")

_LABEL_RE = re.compile(r"^([A-Za-zÀ-ÿ]+)\s*:\s*(.*)$")
# Unfilled catalogue-template markers. These are placeholders, not data.
_PLACEHOLDER_RE = re.compile(r"\[(?:TITLE|MATERIAL|WEIGHT|TIME|COLOR)\]", re.IGNORECASE)
_BOILERPLATE = "*fichier non cede*"


def _fold(value: str) -> str:
    """Lowercase and strip accents: 'Matériau' -> 'materiau'."""
    decomposed = unicodedata.normalize("NFD", value)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()


def parse_description(text: str | None) -> tuple[dict[str, str], tuple[str, ...]]:
    """Split a line item's description into labelled values and free text.

    A row is a labelled value only when its prefix is one of the catalogue
    templates' known labels; 'Couleur Noir de face.' has no colon and
    'Note: x' has an unknown label, so both stay free text. When a label
    repeats, the first value wins.
    """
    labels: dict[str, str] = {}
    free: list[str] = []
    for raw_row in (text or "").split("\n"):
        row = _PLACEHOLDER_RE.sub("", raw_row).strip()
        if not row or _fold(row) == _BOILERPLATE:
            continue
        match = _LABEL_RE.match(row)
        if match and _fold(match.group(1)) in LABEL_DISPLAY:
            key = _fold(match.group(1))
            if key in labels:
                # First value already won the field; the losing row must
                # still survive somewhere rather than vanishing outright.
                free.append(row)
            else:
                labels[key] = match.group(2).strip()
            continue
        free.append(row)
    return labels, tuple(free)


_WEIGHT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(kgs?|grammes?|grams?|gr|g)?", re.IGNORECASE)


def parse_weight_g(value: str | None) -> float | None:
    """'210 gr' -> 210, '1,5 kg' -> 1500, a bare number -> grams.

    Returns None when there is no number at all — the caller then preserves
    the raw text in the task description rather than dropping it.
    """
    match = _WEIGHT_RE.search(value or "")
    if not match:
        return None
    number = float(match.group(1).replace(",", "."))
    unit = (match.group(2) or "g").lower()
    return number * 1000 if unit.startswith("kg") else number


_TIME_TOKEN_RE = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*(jours?|j|days?|d|heures?|hrs?|h|minutes?|mins?|min|m)?",
    re.IGNORECASE,
)


def parse_time_min(value: str | None) -> int | None:
    """'13h' -> 780, '2h30' -> 150, '1j 4h' -> 1680, a bare number -> minutes.

    Tokens accumulate, so mixed units work. Returns None when there is no
    number at all.
    """
    total = 0.0
    found = False
    for number_text, unit in _TIME_TOKEN_RE.findall(value or ""):
        number = float(number_text.replace(",", "."))
        lowered = unit.lower()
        if lowered.startswith(("j", "d")):
            total += number * 1440
        elif lowered.startswith("h"):
            total += number * 60
        else:  # 'min', 'm', or no unit at all
            total += number
        found = True
    return round(total) if found else None


# SKU prefixes, longest-discriminating first. The catalogue grows variants
# (U3DIMP-VENTE), so this matches on prefix rather than equality. L3DIMP
# (laser) and P3D2024 (legacy generic) deliberately match nothing: they have
# no Aito service, and a line that cannot be represented is reported as
# skipped rather than silently mapped onto the closest neighbour.
_SKU_PREFIXES: tuple[tuple[str, str], ...] = (
    ("P3DSCAN", "scan"),
    ("P3DMOD", "modelisation"),
    ("P3DIMP", "impression"),
    ("U3DIMP", "usinage"),
)


def service_for_sku(sku: str | None) -> str | None:
    normalized = (sku or "").strip().upper()
    if not normalized:
        return None
    for prefix, service in _SKU_PREFIXES:
        if normalized.startswith(prefix):
            return service
    return None


@dataclass(frozen=True)
class ParsedLine:
    """One recognised AITO 3D line, with its description already split."""

    service: str
    labels: dict[str, str]
    free_text: tuple[str, ...]
    amount: float
    quantity: float


def _line_amount(line: dict, *, inclusive: bool, precision: int) -> float:
    """The line's tax-inclusive total, which is what an Aito task stores.

    When the quote is tax-inclusive, `rate` is already the TTC unit price and
    `item_total` is the pre-tax figure — so the TTC total is rate x quantity.
    When it is tax-exclusive, `item_total` is the TTC-less total and the line's
    own taxes are added back.
    """
    quantity = float(line.get("quantity") or 0)
    if inclusive:
        amount = float(line.get("rate") or 0) * quantity
    else:
        taxes = sum(float(tax.get("tax_amount") or 0) for tax in (line.get("line_item_taxes") or []))
        amount = float(line.get("item_total") or 0) + taxes
    # Clamp: an Aito cost is validated ge=0, and a stray negative (a discount
    # line typed as a service) would otherwise 422 the create request.
    return round(max(0.0, amount), precision)


def parse_lines(estimate: dict) -> tuple[list[ParsedLine], list[dict]]:
    """Split an estimate's line items into recognised services and skipped rows."""
    inclusive = bool(estimate.get("is_inclusive_tax"))
    precision = int(estimate.get("price_precision") or 0)
    recognised: list[ParsedLine] = []
    skipped: list[dict] = []
    for line in sorted(estimate.get("line_items") or [], key=lambda item: item.get("item_order") or 0):
        amount = _line_amount(line, inclusive=inclusive, precision=precision)
        service = service_for_sku(line.get("sku"))
        if service is None:
            skipped.append({"sku": line.get("sku") or "", "name": line.get("name") or "", "amount": amount})
            continue
        labels, free_text = parse_description(line.get("description"))
        recognised.append(
            ParsedLine(
                service=service,
                labels=labels,
                free_text=free_text,
                amount=amount,
                quantity=float(line.get("quantity") or 0),
            )
        )
    return recognised, skipped


def group_lines(lines: list[ParsedLine]) -> list[list[ParsedLine]]:
    """Consecutive lines whose service rank strictly rises describe one job.

    A quote that walks scan -> model -> impression -> usinage is one physical part
    passing through four stations, and an Aito task carries several services.
    A rank that repeats or goes backwards means a new part, so it opens a new
    group. Gaps are fine: model -> usinage still rises.
    """
    groups: list[list[ParsedLine]] = []
    current: list[ParsedLine] = []
    seen: set[int] = set()
    for line in lines:
        rank = SERVICE_RANK[line.service]
        if current and any(rank <= previous for previous in seen):
            groups.append(current)
            current, seen = [], set()
        current.append(line)
        seen.add(rank)
    if current:
        groups.append(current)
    return groups


_TITLE_MAX = 200
_COLOR_MAX = 100
_COST_FIELD: dict[str, str] = {
    "scan": "scan_cost",
    "modelisation": "modelisation_cost",
    "impression": "impression_cost",
    "usinage": "usinage_cost",
}
# Labels the impression fields consume, so they are not repeated in the body.
_IMPRESSION_LABELS: tuple[str, ...] = ("poids", "temps", "couleur")


def _title_label(line: ParsedLine) -> str | None:
    """Which of this line's labels could supply a task title, if any."""
    for label in TITLE_LABELS:
        if line.labels.get(label, "").strip():
            return label
    return None


def _truncate_words(value: str, limit: int) -> tuple[str, bool]:
    """(title, was_truncated). Cuts at the last space before the limit."""
    if len(value) <= limit:
        return value, False
    head = value[:limit]
    cut = head.rfind(" ")
    return (head[:cut] if cut > 0 else head).rstrip(), True


def _dedupe(rows: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for row in rows:
        if row and row not in seen:
            seen.add(row)
            out.append(row)
    return out


def _fully_consumed(value: str, pattern: re.Pattern[str], count: int = 0) -> bool:
    """True when stripping the span(s) `pattern` matched leaves no letters or
    digits behind — i.e. the parser accounted for the whole row, not just a
    number embedded in a longer sentence ('210 gr par piece, 4 pieces') that
    must still be preserved verbatim alongside the parsed field.

    `count` must mirror how many matches the caller's own parse actually
    consumed: `parse_weight_g` uses `re.search` (one match), so `count=1`
    here — otherwise a second, unparsed token ('210 gr 50 gr') would be
    stripped by `sub` and silently judged "fully consumed" even though only
    the first token was ever parsed. `parse_time_min` uses `findall` and
    sums every token, so `count=0` (all) is correct for it.
    """
    remainder = pattern.sub("", value, count=count)
    return not any(ch.isalpha() or ch.isdigit() for ch in remainder)


def _build_task(group: list[ParsedLine]) -> dict:
    """One Aito task from one group of quote lines."""
    ordered = sorted(group, key=lambda line: SERVICE_RANK[line.service])
    impression = next((line for line in ordered if line.service == "impression"), None)

    # The impression line names the part being made, so its Projet: wins the
    # title; otherwise the first line in canonical order that has one.
    title_line: ParsedLine | None = None
    title_key: str | None = None
    if impression and impression.labels.get("projet", "").strip():
        title_line, title_key = impression, "projet"
    else:
        for line in ordered:
            key = _title_label(line)
            if key:
                title_line, title_key = line, key
                break
    raw_title = title_line.labels[title_key].strip() if title_line and title_key else ""
    title, truncated = _truncate_words(raw_title, _TITLE_MAX)

    poids_value = impression.labels.get("poids", "").strip() if impression else ""
    temps_value = impression.labels.get("temps", "").strip() if impression else ""
    weight = parse_weight_g(poids_value) if poids_value else None
    minutes = parse_time_min(temps_value) if temps_value else None
    color = (impression.labels.get("couleur", "").strip() or None) if impression else None
    # A field only absorbs the whole row when it accounts for the whole row —
    # a number found inside a longer sentence, or a colour longer than the
    # field allows, must still show up in the body alongside the field.
    weight_consumed = weight is not None and _fully_consumed(poids_value, _WEIGHT_RE, count=1)
    time_consumed = minutes is not None and _fully_consumed(temps_value, _TIME_TOKEN_RE, count=0)
    color_consumed = bool(color) and len(color) <= _COLOR_MAX

    rows: list[str] = []
    # A truncated title would otherwise lose its tail — keep the full line.
    if truncated:
        rows.append(raw_title)
    for line in ordered:
        for label in LABEL_ORDER:
            value = line.labels.get(label, "").strip()
            if not value:
                continue
            if line is title_line and label == title_key:
                continue  # became the task title
            if line is impression and label in _IMPRESSION_LABELS:
                # Consumed into a field — unless the value was only partially
                # parsed (or not at all), in which case it is preserved
                # rather than dropped or silently truncated.
                if (
                    (label == "couleur" and color_consumed)
                    or (label == "poids" and weight_consumed)
                    or (label == "temps" and time_consumed)
                ):
                    continue
            prefix = SERVICE_LABEL[line.service] if label in TITLE_LABELS else LABEL_DISPLAY[label]
            rows.append(f"{prefix}: {value}")
        rows.extend(line.free_text)

    task: dict = {
        "title": title,
        "description": "\n".join(_dedupe(rows)),
        "scan_cost": None,
        "modelisation_cost": None,
        "usinage_cost": None,
        "impression_printer_id": None,
        "impression_filament_id": None,
        "impression_weight_g": weight,
        "impression_time_min": minutes,
        "impression_quantity": max(1, round(impression.quantity)) if impression else None,
        "impression_color": color[:_COLOR_MAX] if color else None,
        "impression_cost": None,
    }
    for line in ordered:
        task[_COST_FIELD[line.service]] = line.amount
    return task


def _client_snapshot(estimate: dict, contact: dict | None) -> dict:
    """The client fields an Aito card stores.

    Degrades to the estimate's own customer when the contact could not be
    fetched: a Zoho contact outage must not cost the user their import.
    """
    if not contact:
        return {
            "id": estimate.get("customer_id") or "",
            "name": estimate.get("customer_name") or "",
            "phone": None,
            "email": None,
            "is_company": None,
        }
    sub_type = contact.get("customer_sub_type") or ""
    is_company = True if sub_type == "business" else (False if sub_type == "individual" else None)
    return {
        "id": contact.get("id") or estimate.get("customer_id") or "",
        "name": contact.get("name") or estimate.get("customer_name") or "",
        # Mobile first: it is where the board writes a phone number back.
        "phone": (contact.get("mobile") or contact.get("phone") or "").strip() or None,
        "email": (contact.get("email") or "").strip() or None,
        "is_company": is_company,
    }


def build_preview(estimate: dict, contact: dict | None, quote_url: str) -> dict:
    """Everything the import modal needs, in the shape POST /aito/ accepts."""
    lines, skipped = parse_lines(estimate)
    tasks = [_build_task(group) for group in group_lines(lines)]
    titles = [task["title"] for task in tasks if task["title"]]
    number = estimate.get("estimate_number") or ""
    return {
        "quote": {
            "id": estimate.get("estimate_id") or "",
            "number": number,
            "date": estimate.get("date") or "",
            "status": estimate.get("status") or "",
            "total": float(estimate.get("total") or 0),
            "currency_code": estimate.get("currency_code") or "",
            "url": quote_url,
            "salesperson": (estimate.get("salesperson_name") or "").strip() or None,
        },
        "client": _client_snapshot(estimate, contact),
        "suggested_description": "\n".join(titles) or number,
        "tasks": tasks,
        "skipped_lines": skipped,
    }
