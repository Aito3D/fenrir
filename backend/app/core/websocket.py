import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and broadcasts."""

    # (T-020) Per-send bound for broadcast(). uvicorn applies TCP backpressure,
    # so send_text() to a client whose socket window is full (sleeping laptop,
    # dead cell link) never returns on its own. 5s is generous enough that a
    # merely-slow-but-healthy client on a congested LAN/Wi-Fi round-trip is not
    # penalized (printer-status broadcasts already recur every 1-2s, so a
    # single delayed frame is invisible to the user), while being short enough
    # that a genuinely wedged socket cannot stall the fan-out to everyone else
    # for more than one broadcast cycle.
    _BROADCAST_SEND_TIMEOUT = 5.0

    # (T-041) Bound for the best-effort close() issued against a connection
    # _fan_out() just evicted. A socket wedged badly enough to blow the send
    # timeout can also hang on close() (e.g. the underlying transport is
    # stuck, not merely slow) — this keeps that from lingering forever. 1011
    # is the WebSocket "internal error" close code: the server, not the
    # client, decided the connection could not continue.
    _EVICTION_CLOSE_TIMEOUT = 2.0
    _EVICTION_CLOSE_CODE = 1011

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()
        # (T-041) Strong references to in-flight eviction-close tasks so
        # they are not garbage-collected mid-await; discarded once done.
        self._pending_eviction_closes: set[asyncio.Task] = set()

    async def connect(self, websocket: WebSocket):
        """Accept a new WebSocket connection."""
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)

    def aito_presence_state(self) -> dict[str, Any]:
        """The full viewer map, keyed by stringified project id (JSON object
        keys are strings anyway; stringifying here keeps the payload identical
        to what the frontend indexes). Presence is stored on the connection
        state (aito_project_id) so it cannot leak or outlive disconnection."""
        viewers: dict[str, list[str]] = {}
        for conn in self.active_connections:
            project_id = getattr(conn.state, "aito_project_id", None)
            if project_id is not None:
                name = getattr(conn.state, "bambuddy_principal", None) or "Operator"
                viewers.setdefault(str(project_id), []).append(name)
        return {"type": "aito_presence_state", "viewers": viewers}

    async def set_aito_presence(self, websocket: WebSocket, project_id: int | None):
        """Record which Aito project this connection is viewing (None: none),
        then broadcast the full map. Mutation under the lock, broadcast after —
        broadcast() takes the same lock and would deadlock inside it."""
        async with self._lock:
            websocket.state.aito_project_id = project_id
        await self.broadcast_aito(self.aito_presence_state())

    async def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection."""
        had_presence = False
        async with self._lock:
            had_presence = getattr(websocket.state, "aito_project_id", None) is not None
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)
        if had_presence:
            await self.broadcast_aito(self.aito_presence_state())

    async def _close_quietly(self, connection: WebSocket) -> None:
        """(T-041) Best-effort, bounded close of a connection ``_fan_out``
        just evicted, run as a fire-and-forget task outside the manager
        lock.

        Without this, an evicted socket that woke back up (e.g. a laptop
        that slept through the send timeout) would look perfectly healthy
        to the client: ``ws.onclose`` never fires, so the frontend's
        reconnect logic never runs, and the tab silently stops receiving
        updates until the user reloads it. Calling ``close()`` here makes
        the server side of that TCP connection actually go away, which
        unblocks the endpoint's ``await websocket.receive_json()`` loop and
        lets the client's own close handler kick off a reconnect.

        Bounded by ``_EVICTION_CLOSE_TIMEOUT`` because a socket wedged badly
        enough to blow the send timeout can also hang on close() — this
        must never block the caller (``_fan_out``) waiting on it. Any
        exception (the peer already tore the connection down, close() isn't
        supported by this transport, etc.) is swallowed: this is cleanup of
        an already-evicted connection, not something callers can act on.
        """
        try:
            await asyncio.wait_for(
                connection.close(code=self._EVICTION_CLOSE_CODE), timeout=self._EVICTION_CLOSE_TIMEOUT
            )
        except Exception:
            logger.debug("Best-effort close of an evicted WebSocket connection failed", exc_info=True)

    async def _fan_out(self, connections: list[WebSocket], data: str) -> None:
        """Shared send path for ``broadcast()``, ``broadcast_aito()`` and
        ``broadcast_to_user()`` (T-020, T-028, T-042).

        Sends fan out concurrently across ``connections`` — the lock is
        never held across this call, only around building the snapshot
        passed in. Holding it across ``send_text`` would mean one client
        stuck behind TCP backpressure (a laptop that slept with the
        dashboard open, a phone on a dead cell link) stalls delivery to
        every other client *and* blocks ``connect()``/``disconnect()`` from
        registering new sockets, since they take the same lock. Each send
        is bounded by ``_BROADCAST_SEND_TIMEOUT``; a connection that times
        out or raises is dropped via the same removal path a normal
        disconnect uses, under the lock, against the live list (not the
        snapshot passed in) so it can't race a concurrent
        connect()/disconnect(). (T-041) Once removed, each evicted
        connection also gets a best-effort, bounded ``close()`` fired as a
        background task *outside* the lock — see ``_close_quietly`` — so the
        client actually observes the drop and reconnects instead of sitting
        parked on a socket the server has already given up on.
        """
        if not connections:
            return

        results = await asyncio.gather(
            *(
                asyncio.wait_for(connection.send_text(data), timeout=self._BROADCAST_SEND_TIMEOUT)
                for connection in connections
            ),
            return_exceptions=True,
        )

        disconnected = [
            conn for conn, result in zip(connections, results, strict=True) if isinstance(result, Exception)
        ]
        if disconnected:
            async with self._lock:
                for conn in disconnected:
                    if conn in self.active_connections:
                        self.active_connections.remove(conn)
            for conn in disconnected:
                task = asyncio.create_task(self._close_quietly(conn))
                self._pending_eviction_closes.add(task)
                task.add_done_callback(self._pending_eviction_closes.discard)

    async def broadcast(self, message: dict[str, Any]):
        """Broadcast a message to all connected clients.

        (T-020) The lock is only held to take a snapshot of
        ``active_connections`` before handing off to ``_fan_out`` — never
        across the actual I/O. See ``_fan_out`` for why.
        """
        async with self._lock:
            connections = list(self.active_connections)
        if not connections:
            return
        data = json.dumps(message)
        await self._fan_out(connections, data)

    async def broadcast_aito(self, message: dict[str, Any]):
        """Broadcast an Aito board message (``aito_changed`` /
        ``aito_presence_state``) only to connections whose stamped Aito
        authority allows it (T-038 / GHSA follow-up).

        ``routes/websocket.py`` stamps ``websocket.state.aito_read`` — True
        on auth-disabled installs and for any resolved principal holding
        ``Permission.AITO_READ`` (admins included, via
        ``User.has_permission``'s short-circuit), False otherwise — *before*
        ``connect()`` (this class's own method) admits the socket into
        ``active_connections`` (T-030 / audit-security follow-up to T-038:
        the route handler used to call ``connect()`` first and stamp
        roughly thirty lines later, once the auth token had been resolved
        to a principal and, for a non-empty principal, that principal's
        permissions had been looked up — a real window during which a
        connection was already reachable by ``broadcast_aito`` but not yet
        stamped). With the stamp now guaranteed to exist before a
        connection can ever appear in ``active_connections``, the
        ``getattr(..., False)`` default below has no window left to
        cover — it exists only to fail closed on a connection that
        somehow, through code elsewhere, never gets stamped at all. Every
        other broadcast (printer status, print start/complete, archive
        events, queue toasts, spool warnings) keeps calling the unfiltered
        ``broadcast()`` above and is untouched by this filter.

        (T-028) Filtering happens under the lock while building the
        snapshot, then the lock is released before handing off to
        ``_fan_out`` — the same shape as ``broadcast()``, for the same
        reason: without it, one connection stuck behind TCP backpressure
        would stall Aito delivery to every other client and block
        ``connect()``/``disconnect()``, and since ``broadcast_aito`` is
        awaited inline from request handlers after every board mutation
        (e.g. ``routes/aito.py``), that stall would also hang the HTTP
        response itself. See ``_fan_out`` for the timeout/cleanup details.
        """
        async with self._lock:
            connections = [conn for conn in self.active_connections if getattr(conn.state, "aito_read", False)]
        if not connections:
            return
        data = json.dumps(message)
        await self._fan_out(connections, data)

    async def broadcast_to_user(self, user_id: int | None, message: dict[str, Any]):
        """Send a message to every connection authenticated as the given user.

        When ``user_id`` is None the message fans out to all connections —
        this is the auth-disabled single-user path, where neither the queue
        item's ``created_by_id`` nor the WS principal is set, and the
        existing fan-out semantics are exactly what the user wants.

        Per-user routing reads ``websocket.state.bambuddy_principal_user_id``
        stamped at connect time (``routes/websocket.py``). Connections
        without a stamped id are skipped on the targeted path so an
        anonymous reader never receives another user's dispatch toast.

        (T-042) Filtering happens under the lock while building the
        snapshot, then the lock is released before handing off to
        ``_fan_out`` — the same shape as ``broadcast()``/``broadcast_aito()``,
        for the same reason: this is the path FTP dispatch progress toasts
        (``send_queue_item_upload_progress`` et al.) go through, and without
        it a single wedged operator socket would stall every other
        broadcast — including ``broadcast_aito()``, awaited inline from
        ``routes/aito.py`` after every board mutation — behind the same
        lock for as long as the stall lasts. See ``_fan_out`` for the
        timeout/cleanup details.
        """
        if user_id is None:
            await self.broadcast(message)
            return

        if not self.active_connections:
            return

        data = json.dumps(message)
        async with self._lock:
            connections = [
                conn
                for conn in self.active_connections
                if getattr(conn.state, "bambuddy_principal_user_id", None) == user_id
            ]
        if not connections:
            return
        await self._fan_out(connections, data)

    async def send_printer_status(self, printer_id: int, status: dict):
        """Send printer status update to all clients."""
        await self.broadcast(
            {
                "type": "printer_status",
                "printer_id": printer_id,
                "data": status,
            }
        )

    async def send_print_start(self, printer_id: int, data: dict):
        """Notify clients that a print has started."""
        await self.broadcast(
            {
                "type": "print_start",
                "printer_id": printer_id,
                "data": data,
            }
        )

    async def send_print_complete(self, printer_id: int, data: dict):
        """Notify clients that a print has completed."""
        await self.broadcast(
            {
                "type": "print_complete",
                "printer_id": printer_id,
                "data": data,
            }
        )

    async def send_archive_created(self, archive: dict):
        """Notify clients that a new archive was created."""
        await self.broadcast(
            {
                "type": "archive_created",
                "data": archive,
            }
        )

    async def send_archive_updated(self, archive: dict):
        """Notify clients that an archive was updated."""
        await self.broadcast(
            {
                "type": "archive_updated",
                "data": archive,
            }
        )

    async def send_queue_item_uploading(
        self,
        user_id: int | None,
        queue_item_id: int,
        printer_id: int,
        printer_name: str | None,
        file_name: str,
        total_bytes: int,
    ):
        """Toast trigger: scheduler picked the item up, FTP upload starts."""
        await self.broadcast_to_user(
            user_id,
            {
                "type": "queue_item_uploading",
                "queue_item_id": queue_item_id,
                "printer_id": printer_id,
                "printer_name": printer_name,
                "file_name": file_name,
                "total_bytes": total_bytes,
            },
        )

    async def send_queue_item_upload_progress(
        self,
        user_id: int | None,
        queue_item_id: int,
        bytes_transferred: int,
        total_bytes: int,
    ):
        """Toast update: throttled byte-level progress during the FTP upload."""
        pct = int(round(100 * bytes_transferred / total_bytes)) if total_bytes else 0
        await self.broadcast_to_user(
            user_id,
            {
                "type": "queue_item_upload_progress",
                "queue_item_id": queue_item_id,
                "bytes_transferred": bytes_transferred,
                "total_bytes": total_bytes,
                "pct": pct,
            },
        )

    async def send_queue_item_acked(
        self,
        user_id: int | None,
        queue_item_id: int,
        printer_id: int,
    ):
        """Toast trigger: watchdog confirmed the printer transitioned out of pre_state."""
        await self.broadcast_to_user(
            user_id,
            {
                "type": "queue_item_acked",
                "queue_item_id": queue_item_id,
                "printer_id": printer_id,
            },
        )

    async def send_queue_item_failed(
        self,
        user_id: int | None,
        queue_item_id: int,
        printer_id: int | None,
        reason: str,
    ):
        """Toast trigger: dispatch failed at any stage. Toast turns red, auto-dismisses."""
        await self.broadcast_to_user(
            user_id,
            {
                "type": "queue_item_failed",
                "queue_item_id": queue_item_id,
                "printer_id": printer_id,
                "reason": reason,
            },
        )

    async def send_missing_spool_assignment(
        self,
        printer_id: int,
        printer_name: str,
        missing_slots: list[dict[str, str]],
    ):
        """Notify clients that a print started with missing spool assignments."""
        await self.broadcast(
            {
                "type": "missing_spool_assignment",
                "printer_id": printer_id,
                "printer_name": printer_name,
                "missing_slots": missing_slots,
            }
        )


# Global connection manager
ws_manager = ConnectionManager()
