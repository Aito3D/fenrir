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

# The four Aito services, in the canonical order the board renders badges in
# (mirrors _SERVICE_COLUMNS in backend/app/api/routes/aito.py).
SERVICE_RANK: dict[str, int] = {"scan": 0, "modelisation": 1, "impression": 2, "usinage": 3}

# Shop's own service names — identical in all twelve locales (see
# frontend/src/components/aito/services.ts), so writing them into the task
# description carries no translation burden.
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
            labels.setdefault(key, match.group(2).strip())
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
