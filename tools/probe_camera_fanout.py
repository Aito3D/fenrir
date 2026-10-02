"""Campaign-22 golden probe: the MJPEG fan-out broadcaster's observable behaviour.

Drives backend/app/services/camera_fanout.py with a scripted upstream whose
frames are released one at a time by the probe, so every scenario is
event-ordered rather than timing-based. The two module timers that would
otherwise make the probe slow (grace window, disconnect poll) are shortened
for the probe run only — the ORIGINAL values are printed first so a change
to them still moves the golden.

Loop machinery, not app code — nothing in backend/ imports this.
"""

import asyncio
import json
import logging
import sys

sys.path.insert(0, ".")
from backend.app.services import camera_fanout as cf  # noqa: E402

logging.disable(logging.CRITICAL)

OUT: dict = {
    "constants": {
        "GRACE_SECONDS": cf._GRACE_SECONDS,
        "TEARDOWN_WAIT_SECONDS": cf._TEARDOWN_WAIT_SECONDS,
        "SUBSCRIBER_QUEUE_SIZE": cf._SUBSCRIBER_QUEUE_SIZE,
        "DISCONNECT_POLL_SECONDS": cf._DISCONNECT_POLL_SECONDS,
        "DROP_LOG_INTERVAL": cf._DROP_LOG_INTERVAL,
        "UPSTREAM_GONE": cf._UPSTREAM_GONE.decode(),
    }
}

# Probe-only: make the timer-driven paths observable in milliseconds.
cf._GRACE_SECONDS = 0.05
cf._DISCONNECT_POLL_SECONDS = 0.02


class Scripted:
    """Upstream generator the probe controls: one frame per release()."""

    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = list(chunks)
        self.gate: asyncio.Queue[None] = asyncio.Queue()
        self.disconnect: asyncio.Event | None = None
        self.started = 0
        self.closed = False

    def factory(self, disconnect: asyncio.Event):
        self.disconnect = disconnect

        async def gen():
            self.started += 1
            try:
                for c in self.chunks:
                    await self.gate.get()
                    yield c
            finally:
                self.closed = True

        return gen()

    def release(self) -> None:
        self.gate.put_nowait(None)

    async def settle(self) -> None:
        """Let the pump consume every released frame."""
        for _ in range(50):
            await asyncio.sleep(0)
        await asyncio.sleep(0.01)


def s(b: bytes) -> str:
    return b.decode()


async def scenario_fanout() -> dict:
    up = Scripted([b"f1", b"f2", b"f3"])
    bc = cf.MjpegBroadcaster("fan", up.factory)
    q1 = await bc.subscribe()
    up.release()
    first = s(await asyncio.wait_for(q1.get(), 2))
    await up.settle()
    q2 = await bc.subscribe()
    primed = s(q2.get_nowait()) if not q2.empty() else None
    up.release()
    second = [s(await asyncio.wait_for(q1.get(), 2)), s(await asyncio.wait_for(q2.get(), 2))]
    up.release()
    third = [s(await asyncio.wait_for(q1.get(), 2)), s(await asyncio.wait_for(q2.get(), 2))]
    # Upstream is exhausted now: the pump exits and wakes both queues.
    tail = [s(await asyncio.wait_for(q1.get(), 2)), s(await asyncio.wait_for(q2.get(), 2))]
    await up.settle()
    return {
        "first": first,
        "late_joiner_primed_with": primed,
        "second": second,
        "third": third,
        "after_upstream_end": tail,
        "subscribers": bc.subscriber_count,
        "stopped_after_upstream_end": bc.stopped,
        "upstream_started": up.started,
        "upstream_closed": up.closed,
    }


async def scenario_slow_subscriber() -> dict:
    up = Scripted([f"f{i}".encode() for i in range(1, 8)])
    bc = cf.MjpegBroadcaster("slow", up.factory)
    q = await bc.subscribe()
    for _ in range(7):
        up.release()
    await up.settle()
    got = []
    while not q.empty():
        got.append(s(q.get_nowait()))
    return {"released": 7, "queued_for_slow_viewer": got, "queue_size_cap": cf._SUBSCRIBER_QUEUE_SIZE}


async def scenario_grace_teardown() -> dict:
    up = Scripted([b"f1", b"f2"])
    bc = cf.MjpegBroadcaster("grace", up.factory)
    q = await bc.subscribe()
    up.release()
    await asyncio.wait_for(q.get(), 2)
    remaining = await bc.unsubscribe(q)
    await asyncio.wait_for(bc.wait_until_torn_down(), 2)
    try:
        await bc.subscribe()
        resub = "subscribed"
    except RuntimeError as e:
        resub = f"RuntimeError: {e}"
    return {
        "remaining_after_unsubscribe": remaining,
        "stopped": bc.stopped,
        "upstream_disconnect_set": up.disconnect.is_set(),
        "upstream_closed": up.closed,
        "subscribe_after_stop": resub,
        "unsubscribe_unknown_queue_returns": await bc.unsubscribe(asyncio.Queue()),
    }


async def scenario_grace_cancelled_by_rejoin() -> dict:
    up = Scripted([b"f1", b"f2"])
    bc = cf.MjpegBroadcaster("rejoin", up.factory)
    q1 = await bc.subscribe()
    await bc.unsubscribe(q1)
    q2 = await bc.subscribe()
    await asyncio.sleep(0.15)  # well past the (shortened) grace window
    up.release()
    frame = s(await asyncio.wait_for(q2.get(), 2))
    return {
        "stopped": bc.stopped,
        "subscribers": bc.subscriber_count,
        "frame_after_rejoin": frame,
        "upstream_started": up.started,
    }


async def scenario_force_shutdown() -> dict:
    up = Scripted([b"f1", b"f2"])
    bc = cf.MjpegBroadcaster("force", up.factory)
    q1 = await bc.subscribe()
    q2 = await bc.subscribe()
    up.release()
    a = s(await asyncio.wait_for(q1.get(), 2))
    b = s(await asyncio.wait_for(q2.get(), 2))
    await bc.force_shutdown()
    kicked = [s(q1.get_nowait()), s(q2.get_nowait())]
    await bc.force_shutdown()  # idempotent
    return {
        "frames_before": [a, b],
        "kicked_with": kicked,
        "stopped": bc.stopped,
        "subscribers": bc.subscriber_count,
        "upstream_closed": up.closed,
        "upstream_disconnect_set": up.disconnect.is_set(),
    }


async def scenario_registry() -> dict:
    cf._broadcasters.clear()
    up1 = Scripted([b"a1", b"a2"])
    up2 = Scripted([b"b1", b"b2"])
    up3 = Scripted([b"c1", b"c2"])
    bc1 = await cf.get_or_create_broadcaster("k", up1.factory)
    same = (await cf.get_or_create_broadcaster("k", up2.factory)) is bc1
    keys_live = cf.active_broadcaster_keys()
    count0 = cf.get_subscriber_count("k")
    q = await bc1.subscribe()
    count1 = cf.get_subscriber_count("k")
    shut1 = await cf.shutdown_broadcaster("k")
    shut2 = await cf.shutdown_broadcaster("k")
    shut_missing = await cf.shutdown_broadcaster("nope")
    keys_after = cf.active_broadcaster_keys()
    count_after = cf.get_subscriber_count("k")
    still_registered = "k" in cf._broadcasters
    kicked = s(q.get_nowait())
    bc2 = await cf.get_or_create_broadcaster("k", up3.factory)
    chained = bc2 is not bc1 and bc2._predecessor is bc1
    q2 = await bc2.subscribe()
    up3.release()
    frame = s(await asyncio.wait_for(q2.get(), 2))
    await cf.shutdown_all_broadcasters()
    return {
        "same_instance_while_live": same,
        "keys_live": keys_live,
        "count_before_subscribe": count0,
        "count_after_subscribe": count1,
        "shutdown_returns": [shut1, shut2, shut_missing],
        "keys_after_shutdown": keys_after,
        "count_after_shutdown": count_after,
        "stopped_entry_stays_registered": still_registered,
        "kicked_with": kicked,
        "replacement_chained_to_predecessor": chained,
        "frame_from_replacement": frame,
        "factories_started": [up1.started, up2.started, up3.started],
        "registry_after_shutdown_all": sorted(cf._broadcasters),
        "bc2_stopped_after_shutdown_all": bc2.stopped,
    }


async def scenario_iter_subscriber() -> dict:
    up = Scripted([b"f1", b"f2", b"f3"])
    bc = cf.MjpegBroadcaster("iter", up.factory)
    q = await bc.subscribe()
    checks = 0
    seen_remaining: list[int] = []

    async def is_disconnected() -> bool:
        nonlocal checks
        checks += 1
        return checks >= 2

    agen = cf.iter_subscriber(bc, q, is_disconnected=is_disconnected, on_unsubscribe=seen_remaining.append)
    up.release()
    c1 = s(await asyncio.wait_for(agen.__anext__(), 2))
    up.release()
    c2 = s(await asyncio.wait_for(agen.__anext__(), 2))
    try:
        await asyncio.wait_for(agen.__anext__(), 2)
        ended = "yielded"
    except StopAsyncIteration:
        ended = "StopAsyncIteration"
    return {
        "chunks": [c1, c2],
        "disconnect_checks": checks,
        "ended": ended,
        "on_unsubscribe_remaining": seen_remaining,
        "subscribers": bc.subscriber_count,
    }


async def scenario_iter_subscriber_polls_when_black() -> dict:
    up = Scripted([b"never"])
    bc = cf.MjpegBroadcaster("black", up.factory)
    q = await bc.subscribe()
    polls = 0

    async def is_disconnected() -> bool:
        nonlocal polls
        polls += 1
        return polls >= 3

    agen = cf.iter_subscriber(bc, q, is_disconnected=is_disconnected)
    try:
        await asyncio.wait_for(agen.__anext__(), 2)
        ended = "yielded"
    except StopAsyncIteration:
        ended = "StopAsyncIteration"
    return {"ended_without_frames": ended, "polls_until_disconnect_seen": polls, "subscribers": bc.subscriber_count}


async def scenario_upstream_gone_then_iter() -> dict:
    up = Scripted([b"f1"])
    bc = cf.MjpegBroadcaster("gone", up.factory)
    q = await bc.subscribe()
    up.release()
    await up.settle()  # pump drains the single frame, then upstream ends
    agen = cf.iter_subscriber(bc, q)
    out = []
    try:
        while True:
            out.append(s(await asyncio.wait_for(agen.__anext__(), 2)))
    except StopAsyncIteration:
        pass
    return {"yielded": out, "subscribers": bc.subscriber_count, "stopped": bc.stopped}


async def main() -> None:
    OUT["fanout"] = await scenario_fanout()
    OUT["slow_subscriber"] = await scenario_slow_subscriber()
    OUT["grace_teardown"] = await scenario_grace_teardown()
    OUT["grace_cancelled_by_rejoin"] = await scenario_grace_cancelled_by_rejoin()
    OUT["force_shutdown"] = await scenario_force_shutdown()
    OUT["registry"] = await scenario_registry()
    OUT["iter_subscriber"] = await scenario_iter_subscriber()
    OUT["iter_subscriber_black"] = await scenario_iter_subscriber_polls_when_black()
    OUT["upstream_gone_then_iter"] = await scenario_upstream_gone_then_iter()
    print(json.dumps(OUT, indent=1, sort_keys=True))


asyncio.run(main())
