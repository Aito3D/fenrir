import asyncio
import json
from typing import Any

from fastapi import WebSocket


class ConnectionManager:
    """Manages WebSocket connections and broadcasts."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

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

    async def broadcast(self, message: dict[str, Any]):
        """Broadcast a message to all connected clients."""
        if not self.active_connections:
            return

        data = json.dumps(message)
        async with self._lock:
            disconnected = []
            for connection in self.active_connections:
                try:
                    await connection.send_text(data)
                except Exception:
                    disconnected.append(connection)

            # Clean up disconnected clients
            for conn in disconnected:
                if conn in self.active_connections:
                    self.active_connections.remove(conn)

    async def broadcast_aito(self, message: dict[str, Any]):
        """Broadcast an Aito board message (``aito_changed`` /
        ``aito_presence_state``) only to connections whose stamped Aito
        authority allows it (T-038 / GHSA follow-up).

        ``routes/websocket.py`` stamps ``websocket.state.aito_read`` — True
        on auth-disabled installs and for any resolved principal holding
        ``Permission.AITO_READ`` (admins included, via
        ``User.has_permission``'s short-circuit), False otherwise — a short
        while *after* ``connect()`` (this class's own method) admits the
        socket into ``active_connections``: ``connect()`` only accepts and
        registers the connection, the stamp itself happens roughly thirty
        lines later in the route handler, once the auth token has been
        resolved to a principal and (for a non-empty principal) that
        principal's permissions have been looked up. So there is a brief,
        real window, between those two points, where a connection is
        already reachable by ``broadcast_aito`` but has not been stamped
        yet. The ``getattr(..., True)`` default is what that window relies
        on: an unstamped connection is treated exactly like a permitted
        one, matching the same fail-open shape the pre-existing
        ``bambuddy_principal_user_id`` stamp already has for
        ``broadcast_to_user``. Defaulting True here is the safe direction —
        it costs nothing for any non-Aito feature (this method is used ONLY
        for the two Aito fan-outs, so the window can only ever affect
        whether an about-to-be-stamped connection catches one extra Aito
        message, never any other broadcast), and it guarantees that a
        connection is never silently muted by a stamp that has not run yet.
        Every other broadcast (printer status, print start/complete,
        archive events, queue toasts, spool warnings) keeps calling the
        unfiltered ``broadcast()`` above and is untouched by this filter.
        """
        if not self.active_connections:
            return

        data = json.dumps(message)
        async with self._lock:
            disconnected = []
            for connection in self.active_connections:
                if not getattr(connection.state, "aito_read", True):
                    continue
                try:
                    await connection.send_text(data)
                except Exception:
                    disconnected.append(connection)

            for conn in disconnected:
                if conn in self.active_connections:
                    self.active_connections.remove(conn)

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
        """
        if user_id is None:
            await self.broadcast(message)
            return

        if not self.active_connections:
            return

        data = json.dumps(message)
        async with self._lock:
            disconnected = []
            for connection in self.active_connections:
                conn_uid = getattr(connection.state, "bambuddy_principal_user_id", None)
                if conn_uid != user_id:
                    continue
                try:
                    await connection.send_text(data)
                except Exception:
                    disconnected.append(connection)

            for conn in disconnected:
                if conn in self.active_connections:
                    self.active_connections.remove(conn)

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
