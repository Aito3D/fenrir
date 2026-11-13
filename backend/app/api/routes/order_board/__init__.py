"""The Order Board: which open sales orders can ship today.

Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

from backend.app.api.routes.order_board import (  # noqa: F401, I001  (import order is the route order)
    board,
    tracking,
    payment,
    fulfilment,
)
from backend.app.api.routes.order_board._common import router

__all__ = ["router"]
