"""Energy consumption time series built from hourly smart-plug snapshots.

The snapshot loop (smart_plug_manager) records each plug's lifetime kWh
counter once per hour. Consumption per bucket is the sum of consecutive-pair
deltas ``max(0, s[i] - s[i-1])`` assigned to the bucket of ``s[i]``'s local
time — clamping handles counter resets, and a plug added mid-window simply
contributes nothing before its first snapshot pair. Because snapshots are
hourly, sub-hour usage smears into the neighbouring bucket; that's accepted,
matching the /archives/stats snapshot-delta behaviour.
"""

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.settings import get_setting
from backend.app.models.smart_plug import SmartPlug
from backend.app.models.smart_plug_energy_snapshot import SmartPlugEnergySnapshot
from backend.app.schemas.smart_plug import (
    EnergyHistoryBucket,
    EnergyHistoryPlugSeries,
    EnergyHistoryResponse,
)
from backend.app.utils.dates import local_day_bounds

DEFAULT_WINDOW_DAYS = 30


def _bucket_key(recorded_at: datetime, tz_offset_minutes: int, bucket: str) -> str:
    """Bucket key for a naive-UTC timestamp in the client's local time."""
    local = recorded_at + timedelta(minutes=tz_offset_minutes)
    if bucket == "hour":
        return local.strftime("%Y-%m-%dT%H:00")
    return local.date().isoformat()


def _zero_filled_keys(date_from: date, date_to: date, bucket: str) -> list[str]:
    """All bucket keys spanning the inclusive local-day window."""
    keys: list[str] = []
    current = date_from
    while current <= date_to:
        if bucket == "hour":
            keys.extend(f"{current.isoformat()}T{h:02d}:00" for h in range(24))
        else:
            keys.append(current.isoformat())
        current += timedelta(days=1)
    return keys


async def get_energy_history(
    db: AsyncSession,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    tz_offset_minutes: int = 0,
    bucket: str = "day",
) -> EnergyHistoryResponse:
    """Per-bucket energy usage across all smart plugs, plus per-plug series."""
    # Default to the last DEFAULT_WINDOW_DAYS local days ending today
    local_today = (datetime.now(timezone.utc) + timedelta(minutes=tz_offset_minutes)).date()
    if date_to is None:
        date_to = local_today
    if date_from is None:
        date_from = date_to - timedelta(days=DEFAULT_WINDOW_DAYS - 1)
    dt_from, dt_to = local_day_bounds(date_from, date_to, tz_offset_minutes)

    cost_per_kwh_str = await get_setting(db, "energy_cost_per_kwh")
    cost_per_kwh = float(cost_per_kwh_str) if cost_per_kwh_str else 0.15

    plugs_result = await db.execute(select(SmartPlug.id, SmartPlug.name, SmartPlug.printer_id))
    plugs = plugs_result.all()

    combined: dict[str, float] = dict.fromkeys(_zero_filled_keys(date_from, date_to, bucket), 0.0)
    plug_series: list[EnergyHistoryPlugSeries] = []
    warming_up = False
    total_kwh = 0.0

    for plug_id, plug_name, printer_id in plugs:
        baseline_q = await db.execute(
            select(SmartPlugEnergySnapshot.lifetime_kwh)
            .where(
                SmartPlugEnergySnapshot.plug_id == plug_id,
                SmartPlugEnergySnapshot.recorded_at <= dt_from,
            )
            .order_by(SmartPlugEnergySnapshot.recorded_at.desc())
            .limit(1)
        )
        baseline = baseline_q.scalar()
        if baseline is None:
            # No snapshot before the window start (fresh install/upgrade or a
            # plug added mid-window) — the window's beginning is undercounted.
            warming_up = True

        rows_result = await db.execute(
            select(SmartPlugEnergySnapshot.recorded_at, SmartPlugEnergySnapshot.lifetime_kwh)
            .where(
                SmartPlugEnergySnapshot.plug_id == plug_id,
                SmartPlugEnergySnapshot.recorded_at > dt_from,
                SmartPlugEnergySnapshot.recorded_at <= dt_to,
            )
            .order_by(SmartPlugEnergySnapshot.recorded_at.asc())
        )
        rows = rows_result.all()

        per_bucket: dict[str, float] = {}
        prev = baseline
        plug_total = 0.0
        for recorded_at, lifetime_kwh in rows:
            if prev is not None:
                delta = max(0.0, lifetime_kwh - prev)
                if delta > 0:
                    key = _bucket_key(recorded_at, tz_offset_minutes, bucket)
                    per_bucket[key] = per_bucket.get(key, 0.0) + delta
                    plug_total += delta
            prev = lifetime_kwh

        for key, kwh in per_bucket.items():
            if key in combined:
                combined[key] += kwh
        total_kwh += plug_total

        plug_series.append(
            EnergyHistoryPlugSeries(
                plug_id=plug_id,
                plug_name=plug_name,
                printer_id=printer_id,
                total_kwh=round(plug_total, 4),
                buckets=[EnergyHistoryBucket(period=key, kwh=round(kwh, 4)) for key, kwh in sorted(per_bucket.items())],
            )
        )

    return EnergyHistoryResponse(
        bucket=bucket,
        total_kwh=round(total_kwh, 4),
        total_cost=round(total_kwh * cost_per_kwh, 2),
        cost_per_kwh=cost_per_kwh,
        buckets=[EnergyHistoryBucket(period=key, kwh=round(kwh, 4)) for key, kwh in combined.items()],
        plugs=plug_series,
        warming_up=warming_up,
    )
