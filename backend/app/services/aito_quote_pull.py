"""Decide what a Books-side edit of a quote's lines means for the card.

Pure, like the two codecs it sits on: no database, no HTTP. The worker
(``aito_quote_sync._pull_lines``) hands over the card's tasks and the estimate
it just read, and applies whatever comes back.

There is no stored copy of "what we last pushed". Instead both sides go
through the same reader: the estimate as Books returns it, and the lines the
card WOULD push right now (``build_line_items``), are each parsed by
``aito_quote_import``. Whatever differs between the two readings is a Books
edit, because this is only asked of a card with nothing left to push.

Nothing is applied on trust. The patch is applied to a copy of the tasks,
exported again and read back: it must read exactly as Books does, or the
whole edit is refused. That is what makes a pull unable to start a push war —
the card ends up holding what Books holds, not an approximation of it.
"""

from dataclasses import dataclass, field, fields, replace

from backend.app.services.aito_quote_export import (
    SERVICES,
    Catalogue,
    ExportShipping,
    ExportTask,
    build_line_items,
    description_of,
    enabled_services,
    missing_maindoeuvre_description,
)
from backend.app.services.aito_quote_import import build_preview

# What a recognised line's SKU must start with for the importer to map it.
# The exporter writes item ids and Books answers with the item's own SKU,
# which a catalogue override may spell differently; lines are re-labelled
# from the item id so both readings classify a line the same way.
_SKU: dict[str, str] = {
    "scan": "P3DSCAN",
    "modelisation": "P3DMOD",
    "impression": "P3DIMP",
    "usinage": "U3DIMP",
    "maindoeuvre": "PM-CM",
}
# Never compared: the quote does not carry them, so both readings say None.
_NOT_ON_THE_QUOTE = frozenset({"impression_printer_id", "impression_filament_id"})
_EXPORT_FIELDS = frozenset(f.name for f in fields(ExportTask))
# The recipient fields a shipping line carries besides its island and price.
_SHIPPING_FIELDS = ("first_name", "last_name", "phone", "price")
# Column widths on AitoProject; Books' free text is not bound by them.
_SHIPPING_TEXT_LIMITS = {"first_name": 100, "last_name": 100, "phone": 50}


@dataclass(frozen=True)
class PullPlan:
    """What to do about a Books edit.

    ``task_patches`` is keyed by index into the task list given to
    ``plan_pull`` (board order); each value is ``AitoTask`` column -> new
    value. ``shipping`` is ``ExportShipping`` field -> new value. ``refused``
    names why nothing may be applied; the patches are then empty.
    """

    task_patches: dict[int, dict] = field(default_factory=dict)
    shipping: dict = field(default_factory=dict)
    refused: str | None = None


def _readings(
    tasks: list[ExportTask], estimate: dict, catalogue: Catalogue, shipping: ExportShipping | None
) -> tuple[dict, dict]:
    """(what Books holds, what the card would push), both as import previews."""
    pushed = build_line_items(tasks, estimate.get("line_items") or [], catalogue, shipping)
    # Lines the push echoes by id are not the card's to describe: foreign
    # lines, a hand-typed labour line, a shipment to an island we do not
    # know. They stay in the estimate (its total still counts them) but are
    # blanked so the reader files them under "not ours".
    echoed = {line["line_item_id"] for line in pushed if "item_id" not in line and "line_item_id" in line}
    sku_by_item = {catalogue.item_id(service): sku for service, sku in _SKU.items()}

    def relabel(line: dict) -> dict:
        if line.get("line_item_id") in echoed:
            return {**line, "sku": "", "item_id": ""}
        return {**line, "sku": sku_by_item.get(line.get("item_id") or "", line.get("sku") or "")}

    theirs = {**estimate, "line_items": [relabel(line) for line in estimate.get("line_items") or []]}
    ours = {
        "is_inclusive_tax": True,
        "price_precision": estimate.get("price_precision"),
        "line_items": [relabel(line) for line in pushed if "line_item_id" not in line],
    }
    return (
        build_preview(theirs, None, "", shipping_ids=catalogue.shipping),
        build_preview(ours, None, "", shipping_ids=catalogue.shipping),
    )


def _rows(text: str | None) -> list[str]:
    return (text or "").split("\n") if text else []


def _task_patch(card: ExportTask, ours: dict, theirs: dict) -> dict | None:
    """One task's patch, or None when the edit does not map onto it exactly."""
    changed = {key for key in theirs if key not in _NOT_ON_THE_QUOTE and theirs[key] != ours[key]}
    if not changed:
        return {}
    if "title" in changed:
        # Headers are positional, so a title is the only thing tying a group
        # of lines to a task. A rename is taken only when nothing else moved
        # (otherwise "task 2 deleted, another added" would read as an edit of
        # task 2), and never to nothing: a quote written before headers
        # existed must not blank the card's titles.
        return {"title": theirs["title"]} if changed == {"title"} and theirs["title"] else None
    patch: dict = {}
    for service in SERVICES:
        cost = f"{service}_cost"
        if (theirs[cost] is None) != (ours[cost] is None) and not ours["title"]:
            # A line added or removed: only under a header naming the task.
            return None
        if theirs[cost] is None and ours[cost] is not None:
            # The step is gone, and so is its tick (the rule PATCH /tasks applies).
            patch[f"{service}_done"] = False
    for key in changed:
        patch[key] = theirs[key]
        if key.endswith("_description"):
            # The reading adds rows the card does not store as text (the
            # impression line's `Matériau:`); they must not be written into
            # the description, where the next push would print them twice.
            added = set(_rows(ours[key])) - set(_rows(description_of(card, key.removesuffix("_description"))))
            patch[key] = "\n".join(row for row in _rows(theirs[key]) if row not in added) or None
    return patch


def plan_pull(
    tasks: list[ExportTask], estimate: dict, catalogue: Catalogue, shipping: ExportShipping | None
) -> PullPlan | None:
    """None when Books holds what the card would push; otherwise the plan.

    Applied: on a line that maps onto a task's service — rate, quantity,
    percent discount (or a flat one that is an exact percent), description,
    and the impression line's weight, time and colour; a task renamed by its
    header; a service line added to or removed from a task its header names;
    the shipping line's price and recipient.

    Refused (``PullPlan.refused``), leaving the card untouched: a different
    number of tasks, a line that moved between unnamed tasks, a rename
    together with any other change, a discount a card cannot hold, a shipping
    line added, removed or sent to another island, and anything that would
    not read back from the card exactly as Books holds it.
    """
    theirs, ours = _readings(tasks, estimate, catalogue, shipping)
    if theirs["discount_issues"]:
        # Before the comparison: a discount a card cannot hold reads as "no
        # discount", so the lines would look unchanged while the totals differ.
        return PullPlan(refused="discount")
    if theirs["tasks"] == ours["tasks"] and theirs["shipping"] == ours["shipping"]:
        return None
    emitted = [index for index, task in enumerate(tasks) if enabled_services(task)]
    # The second test is the card's own: untitled tasks have no header and may
    # read back merged, and then no line can be traced to its task.
    if len(theirs["tasks"]) != len(ours["tasks"]) or len(ours["tasks"]) != len(emitted):
        return PullPlan(refused="tasks")

    task_patches: dict[int, dict] = {}
    for index, our_task, their_task in zip(emitted, ours["tasks"], theirs["tasks"], strict=True):
        patch = _task_patch(tasks[index], our_task, their_task)
        if patch is None:
            return PullPlan(refused="tasks")
        if patch:
            task_patches[index] = patch

    shipping_patch: dict = {}
    if theirs["shipping"] != ours["shipping"]:
        if shipping is None or theirs["shipping"] is None:
            return PullPlan(refused="shipping")
        if any(theirs["shipping"][key] != ours["shipping"][key] for key in ("island", "service")):
            return PullPlan(refused="shipping")
        if any(len(theirs["shipping"][key]) > limit for key, limit in _SHIPPING_TEXT_LIMITS.items()):
            return PullPlan(refused="shipping")
        shipping_patch = {
            key: theirs["shipping"][key] for key in _SHIPPING_FIELDS if theirs["shipping"][key] != ours["shipping"][key]
        }

    # The proof: the patched card, exported and read back, is what Books holds.
    patched = [
        replace(task, **{key: value for key, value in task_patches.get(index, {}).items() if key in _EXPORT_FIELDS})
        for index, task in enumerate(tasks)
    ]
    if missing_maindoeuvre_description(patched):
        return PullPlan(refused="description")  # the next push would be refused for it
    patched_shipping = replace(shipping, **shipping_patch) if shipping is not None else None
    theirs, ours = _readings(patched, estimate, catalogue, patched_shipping)
    if theirs["tasks"] != ours["tasks"] or theirs["shipping"] != ours["shipping"]:
        return PullPlan(refused="unverified")
    return PullPlan(task_patches=task_patches, shipping=shipping_patch)
