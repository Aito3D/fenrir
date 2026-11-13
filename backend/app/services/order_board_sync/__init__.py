"""The Order Board's local copy of Zoho Books and the pass that keeps it fresh.

Read-only towards Books: GETs only. One bounded pass lists every sales order
and purchase order (three calls today), fetches the detail of at most
``MAX_DETAILS_PER_PASS`` documents whose list row changed, re-reads stock for
the items on open order lines, then recomputes and stores the board. Opening
the page therefore costs one local read (``read_board``), never a Zoho call.

Two rules shape everything here:

* An empty or half-built board must never look like a verified answer:
  nothing is computed until a pass has ended with no document pending and
  stock loaded. After that, a failed pass leaves the stored board untouched.
* The Aito Kanban shares Zoho's per-minute call budget and stops its own
  background work at 50 calls in the last minute. This pass stops fetching
  details at ``CALL_CEILING``, well below that.

One module per area; the names callers use are re-exported here. Module state
(back-off window, locks, write marks, loop wake) lives in ``_common`` only.
"""

from backend.app.core.websocket import ws_manager
from backend.app.services.order_board_sync._board import find_board_row, read_board
from backend.app.services.order_board_sync._common import (
    CALL_CEILING,
    DAILY_BUDGET_FLOOR,
    MAX_DETAILS_PER_PASS,
    PENDING_PAUSE_SECONDS,
    OrderBoardSettings,
    OrderNotFinished,
    OrderNotStored,
    ZohoBusy,
    _busy_on_rate_limit,
    _find_state,
    _naive_utc,
    _now,
    _stored_query,
    _unconfirmed,
    _written_at,
    announce_board_change,
    load_settings,
    needs_refresh,
    note_write,
    open_rate_limit_window,
    zoho_busy,
)
from backend.app.services.order_board_sync._events import _has_event
from backend.app.services.order_board_sync._finished import (
    FINISHED_DETAIL_DAYS,
    FINISHED_DETAIL_GRACE_DAYS,
    _finished_docs,
    read_finished,
    read_finished_order,
)
from backend.app.services.order_board_sync._loop import _iteration, run_loop, start_order_board_sync
from backend.app.services.order_board_sync._pass import run_pass
from backend.app.services.order_board_sync._recompute import refresh_order, save_settings

__all__ = [
    "CALL_CEILING",
    "DAILY_BUDGET_FLOOR",
    "FINISHED_DETAIL_DAYS",
    "FINISHED_DETAIL_GRACE_DAYS",
    "MAX_DETAILS_PER_PASS",
    "PENDING_PAUSE_SECONDS",
    "OrderBoardSettings",
    "OrderNotFinished",
    "OrderNotStored",
    "ZohoBusy",
    "_busy_on_rate_limit",
    "_find_state",
    "_finished_docs",
    "_has_event",
    "_iteration",
    "_naive_utc",
    "_now",
    "_stored_query",
    "_unconfirmed",
    "_written_at",
    "announce_board_change",
    "find_board_row",
    "load_settings",
    "needs_refresh",
    "note_write",
    "open_rate_limit_window",
    "read_board",
    "read_finished",
    "read_finished_order",
    "refresh_order",
    "run_loop",
    "run_pass",
    "save_settings",
    "start_order_board_sync",
    "ws_manager",
    "zoho_busy",
]
