"""Measured "reality check" figures for the pricing calculator.

The calculator prices jobs from assumed rates (failure %, electricity tariff,
filament cost). This service aggregates what the app actually measured so the
calculator can show "assumed vs measured" with one-click apply:

- failure rates from the print log (overall, per printer, per filament type)
- the global electricity price setting (`energy_cost_per_kwh`)
- average real spool purchase cost per material (and per brand+material) from
  the inventory
- slicer-estimate vs actual duration accuracy per printer
- measured average power draw per printer from smart-plug energy readings
- measured daily usage hours per printer from print-log durations

Groups with fewer than ``MIN_SAMPLE`` runs are suppressed — a rate computed
from a couple of prints is noise dressed up as truth.
"""

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, literal_column, null, or_, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.spool import Spool

MIN_SAMPLE = 5

# Same band as the archives stats fold (archives.py get_archive_stats):
# multi-plate runs and manual interventions produce ratios that are pure
# noise, so only ratios within [50%, 200%] count toward the average.
_ACCURACY_BAND_LO = 50.0
_ACCURACY_BAND_HI = 200.0

# Implied per-print watts outside this band are attribution noise (plug
# powering more than the printer, counter glitches, sub-minute blips).
_WATTS_BAND_LO = 1.0
_WATTS_BAND_HI = 3000.0
# Prints shorter than this can't produce a meaningful watts figure.
_MIN_POWER_SECONDS = 300
# Stale log entries (left open for weeks, then bulk-closed by a cleanup
# sweep) carry weeks of wall-clock time as "duration" — under any status.
# No real print outlasts this bound, so longer durations are corrupted
# records and must be skipped entirely, not clamped.
_MAX_PRINT_SECONDS = 4 * 24 * 3600
# A usage-hours/day figure needs at least this many observed days — a
# 3-day-old printer showing 20 h/day is noise, not utilization.
_MIN_USAGE_DAYS = 14

_FAILED_STATUSES = ("failed", "aborted")

# T-027/T-042/T-045: the offered windows (InsightsWindowDays) are nested —
# every run in the 30-day window is also in the 90-day window, which is also
# in the 365-day window — so a caller who fetches ANY two offered windows
# (not only adjacent ones) and subtracts their published aggregates recovers
# the (narrower, wider] band's figures even though `_residual_leaks` already
# suppresses *within-window* residuals. Probing only the immediate neighbour
# (365 against 90 alone) misses the case where the 90-day window itself
# suppressed a thin band against 30: the 365-vs-90 delta can still look
# large enough to publish even though 365-vs-30 recovers a sub-MIN_SAMPLE
# band that 90 already refused to disclose. Maps a window to *every*
# narrower offered window (widest first is irrelevant; all are probed) so we
# can apply the identical guard against each one: for each group published
# in the wider window, if its sample count grew by fewer than MIN_SAMPLE
# between some narrower window and this one, the wider window's rate/mean
# for that group is suppressed (the narrower window is left untouched — it
# discloses nothing new by itself). 30 has no narrower window and is never
# suppressed by this guard.
_NARROWER_WINDOWS: dict[int, tuple[int, ...]] = {90: (30,), 365: (90, 30)}


def _residual_leaks(total: int, published: int) -> bool:
    """True if the unpublished remainder of ``total`` (after subtracting the
    ``published`` partition) is small enough to be recoverable by subtraction
    but too small to publish on its own — i.e. it must be suppressed rather
    than let its figure leak through an aggregate. See T-003.
    """
    return 0 < (total - published) < MIN_SAMPLE


def _duration_usable_expr():
    """SQL predicate: ``duration_seconds`` is present and non-zero (usable as-is)."""
    return and_(PrintLogEntry.duration_seconds.isnot(None), PrintLogEntry.duration_seconds != 0)


def _duration_missing_expr():
    """SQL predicate: ``duration_seconds`` is absent or zero (needs the elapsed-time fallback)."""
    return or_(PrintLogEntry.duration_seconds.is_(None), PrintLogEntry.duration_seconds == 0)


class CalculatorInsightsService:
    """Aggregates measured pricing signals for GET /calculator/insights."""

    async def compute(self, db: AsyncSession, days: int = 365) -> dict:
        now = datetime.now(timezone.utc)
        since = now - timedelta(days=days)
        failure = await self._failure_rates(db, since)
        time_accuracy = await self._time_accuracy(db, since)
        spool_costs = await self._spool_costs(db)
        spool_costs_by_brand = await self._spool_costs_by_brand(db)
        power = await self._power_draw(db, since)
        usage = await self._daily_usage(db, since)
        await self._suppress_cross_window_leaks(db, now, days, failure, time_accuracy, power, usage)

        from backend.app.api.routes.settings import get_energy_cost_per_kwh

        return {
            "window_days": days,
            "failure": failure,
            "energy_cost_per_kwh": await get_energy_cost_per_kwh(db),
            "spool_cost_by_material": spool_costs,
            "spool_cost_by_brand": spool_costs_by_brand,
            "time_accuracy": time_accuracy,
            "power_by_printer": power,
            "usage_by_printer": usage,
        }

    async def _suppress_cross_window_leaks(
        self,
        db: AsyncSession,
        now: datetime,
        days: int,
        failure: dict,
        time_accuracy: dict,
        power: list[dict],
        usage: list[dict],
    ) -> None:
        """T-027/T-042/T-045/T-046/T-044: suppress `failure`/`time_accuracy`/
        `power`/`usage` figures a caller could recover by fetching this
        window and ANY narrower offered window and subtracting. Mutates the
        four collections in place; only `rate_pct`/`accuracy_pct`/
        `avg_watts`/`hours_per_day` are ever blanked, `sample` (and, for
        usage, `observed_days`) is always left as computed.

        `power`/`usage` are per-printer only (no overall/material figure to
        guard, unlike `failure`) — the weighted-mean subtraction the T-046
        audit demonstrated for `avg_watts` (and the equivalent for
        `hours_per_day` x `observed_days`) recovers the narrow band's figure
        the exact same way an unpublished residual does for the other two
        folds, so the identical count-only probe applies.

        Probing only the immediate narrower neighbour is not enough: a
        caller can subtract *any* two offered windows, not just adjacent
        ones, so days=365 must be probed against both 90 and 30 — otherwise
        a thin (30, 90] band that 90 itself suppresses can still be
        recovered from 365 (whose count against 90 alone looks large enough
        to publish) minus 30. A group is suppressed if its sample count grew
        by fewer than MIN_SAMPLE against *any* narrower offered window.

        Deliberately count-only: this issues one bounded COUNT-shaped query
        per fold per narrower offered window (mirroring the fold's own
        row-eligibility rules) — at most two extra queries per fold at
        days=365 — not a full re-fold of every aggregate for that window.
        """
        narrower_windows = _NARROWER_WINDOWS.get(int(days))
        if not narrower_windows:
            return

        failure_counts = [
            await self._failure_sample_counts(db, now - timedelta(days=narrower_days))
            for narrower_days in narrower_windows
        ]
        for row in failure["by_printer"]:
            if any(_residual_leaks(row["sample"], counts[0].get(row["printer_id"], 0)) for counts in failure_counts):
                row["rate_pct"] = None
        for row in failure["by_material"]:
            if any(_residual_leaks(row["sample"], counts[1].get(row["material"], 0)) for counts in failure_counts):
                row["rate_pct"] = None
        if failure["overall_pct"] is not None and any(
            _residual_leaks(failure["sample"], counts[2]) for counts in failure_counts
        ):
            failure["overall_pct"] = None

        ta_counts = [
            await self._time_accuracy_sample_counts(db, now - timedelta(days=narrower_days))
            for narrower_days in narrower_windows
        ]
        for row in time_accuracy["by_printer"]:
            if any(_residual_leaks(row["sample"], counts[0].get(row["printer_id"], 0)) for counts in ta_counts):
                row["accuracy_pct"] = None
        if time_accuracy["overall_pct"] is not None and any(
            _residual_leaks(time_accuracy["sample"], counts[1]) for counts in ta_counts
        ):
            time_accuracy["overall_pct"] = None

        power_counts = [
            await self._power_sample_counts(db, now - timedelta(days=narrower_days))
            for narrower_days in narrower_windows
        ]
        for row in power:
            if any(_residual_leaks(row["sample"], counts.get(row["printer_id"], 0)) for counts in power_counts):
                row["avg_watts"] = None

        usage_counts = [
            await self._usage_sample_counts(db, now - timedelta(days=narrower_days))
            for narrower_days in narrower_windows
        ]
        for row in usage:
            if any(_residual_leaks(row["sample"], counts.get(row["printer_id"], 0)) for counts in usage_counts):
                row["hours_per_day"] = None

    async def _failure_sample_counts(
        self, db: AsyncSession, since: datetime
    ) -> tuple[dict[int, int], dict[str, int], int]:
        """Total (not completed/failed-split) sample counts per printer,
        per material, and overall for `since` — the same population
        `_failure_rates` folds, but counts only (called once per narrower
        offered window by T-027/T-042/T-045's cross-window probe), so status
        isn't part of the grouping key."""
        rows = await db.execute(
            select(
                PrintLogEntry.printer_id,
                PrintLogEntry.filament_type,
                func.count(PrintLogEntry.id),
            )
            .where(
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
                PrintLogEntry.created_at >= since,
            )
            .group_by(PrintLogEntry.printer_id, PrintLogEntry.filament_type)
        )
        per_printer: dict[int, int] = {}
        per_material: dict[str, int] = {}
        overall = 0
        for printer_id, filament_type, count in rows.all():
            overall += count
            if printer_id is not None:
                per_printer[printer_id] = per_printer.get(printer_id, 0) + count
            for material in _split_materials(filament_type):
                per_material[material] = per_material.get(material, 0) + count
        return per_printer, per_material, overall

    async def _time_accuracy_sample_counts(self, db: AsyncSession, since: datetime) -> tuple[dict[int, int], int]:
        """Accuracy-eligible sample counts per printer and overall for
        `since` — the same population `_time_accuracy` folds, but counts
        only (called once per narrower offered window by T-027/T-042/T-045's
        cross-window probe): no printer-name lookups, no averaging. Applies
        the identical row eligibility (band, duration resolution) as
        `_time_accuracy` since that eligibility isn't a pure SQL count
        without the same Python fold — see `_time_accuracy_rows`, the shared
        helper both methods fold over."""
        per_printer: dict[int, int] = {}
        overall = 0
        for printer_id, _accuracy in await _time_accuracy_rows(db, since):
            overall += 1
            if printer_id is not None:
                per_printer[printer_id] = per_printer.get(printer_id, 0) + 1
        return per_printer, overall

    async def _power_sample_counts(self, db: AsyncSession, since: datetime) -> dict[int, int]:
        """Power-eligible sample counts per printer for `since` — the same
        population `_power_draw` folds, but counts only (called once per
        narrower offered window by T-046's cross-window probe). Applies the
        identical row eligibility (watts band, min/max seconds, duration
        resolution) as `_power_draw` since that eligibility isn't a pure SQL
        count without the same Python fold — see `_power_draw_rows`, the
        shared helper both methods fold over."""
        per_printer: dict[int, int] = {}
        for printer_id, _energy_kwh, _hours in await _power_draw_rows(db, since):
            per_printer[printer_id] = per_printer.get(printer_id, 0) + 1
        return per_printer

    async def _usage_sample_counts(self, db: AsyncSession, since: datetime) -> dict[int, int]:
        """Usage-eligible sample counts per printer for `since` — the same
        row eligibility `_daily_usage`'s SQL WHERE clause applies (no
        MIN_USAGE_DAYS gate: that's an aggregate check on the published
        entry's `observed_days`, not a per-row filter), called once per
        narrower offered window by T-044's cross-window probe."""
        rows = await db.execute(
            select(PrintLogEntry.printer_id, func.count(PrintLogEntry.id))
            .where(
                PrintLogEntry.printer_id.isnot(None),
                PrintLogEntry.created_at >= since,
                PrintLogEntry.duration_seconds.isnot(None),
                PrintLogEntry.duration_seconds <= _MAX_PRINT_SECONDS,
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
            )
            .group_by(PrintLogEntry.printer_id)
        )
        return dict(rows.all())

    async def _failure_rates(self, db: AsyncSession, since: datetime) -> dict:
        rows = await db.execute(
            select(
                PrintLogEntry.status,
                PrintLogEntry.printer_id,
                PrintLogEntry.filament_type,
                func.count(PrintLogEntry.id),
            )
            .where(
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
                PrintLogEntry.created_at >= since,
            )
            .group_by(PrintLogEntry.status, PrintLogEntry.printer_id, PrintLogEntry.filament_type)
        )

        overall = {"completed": 0, "failed": 0}
        per_printer: dict[int, dict[str, int]] = {}
        per_material: dict[str, dict[str, int]] = {}
        for status, printer_id, filament_type, count in rows.all():
            bucket = "completed" if status == "completed" else "failed"
            overall[bucket] += count
            if printer_id is not None:
                per_printer.setdefault(printer_id, {"completed": 0, "failed": 0})[bucket] += count
            # Multi-material runs store comma-joined types; each material
            # observed the run's outcome (same convention as stats splitting).
            for material in _split_materials(filament_type):
                per_material.setdefault(material, {"completed": 0, "failed": 0})[bucket] += count

        printer_names = await _printer_names(db, per_printer.keys())

        def rate(counts: dict[str, int]) -> tuple[float, int]:
            sample = counts["completed"] + counts["failed"]
            return (round(counts["failed"] / sample * 100, 1) if sample else 0.0, sample)

        overall_rate, overall_sample = rate(overall)
        by_printer = []
        for printer_id, counts in per_printer.items():
            pct, sample = rate(counts)
            if sample >= MIN_SAMPLE:
                by_printer.append(
                    {
                        "printer_id": printer_id,
                        "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                        "rate_pct": pct,
                        "sample": sample,
                    }
                )
        by_material = []
        for material, counts in per_material.items():
            pct, sample = rate(counts)
            if sample >= MIN_SAMPLE:
                by_material.append({"material": material, "rate_pct": pct, "sample": sample})

        # The published by_printer rows are a visible partition of the overall
        # sample. If they leave a small residual population — the overall
        # sample minus the sum of the published per-printer samples (runs with
        # no printer_id, or attributed to printers that didn't individually
        # clear MIN_SAMPLE) — that residual's completed/failed counts are
        # recoverable by subtraction even though no single group discloses
        # them directly (same rule as `_time_accuracy`/`_spool_costs`, see
        # `_residual_leaks`/T-003). Suppress the overall rate rather than let
        # that residual leak through it; `sample` itself is unaffected.
        published_printer_sample = sum(row["sample"] for row in by_printer)

        # `by_material` is a *second*, independent partition of the same
        # overall population (a run has exactly one printer_id but can carry
        # several materials), so it needs the identical residual check: a
        # small group of runs whose material(s) never clear MIN_SAMPLE is
        # still a recoverable residual against `overall_pct`, even when the
        # by_printer partition above is fully covered (e.g. one printer
        # prints everything, but a rarely-used filament type doesn't).
        #
        # T-028: multi-material runs are double-counted here — `filament_type`
        # is comma-joined and `_split_materials` fans one run's outcome out to
        # every material it names, so a run shared by two *published*
        # materials is added into `published_material_sample` twice. That can
        # only inflate the sum (never deflate it), which only ever shrinks the
        # computed residual (`overall_sample - published_material_sample`)
        # below the true count of runs left out of every published material
        # group — never grows it. So this reuses the exact same sum/threshold
        # as the by_printer check with no de-duplication attempt: on the rare
        # overlap that pulls the computed residual to <= 0 despite a genuine
        # small uncovered group, that overlap itself entangles the shared
        # runs' outcomes into the published materials' rates, which blocks
        # the clean subtraction the residual check exists to prevent in the
        # first place (see T-028 discussion). Whenever double-counting doesn't
        # fully mask the gap, the residual still lands in (0, MIN_SAMPLE) and
        # is suppressed exactly like the non-overlapping case. Erring toward
        # this cheaper, unified check (rather than a bespoke de-duplicated
        # count) is the conservative choice: it never publishes `overall_pct`
        # in a case the by_printer-only guard would have caught, and it only
        # additionally suppresses on genuine small material residuals.
        published_material_sample = sum(row["sample"] for row in by_material)

        overall_pct = (
            overall_rate
            if overall_sample >= MIN_SAMPLE
            and not _residual_leaks(overall_sample, published_printer_sample)
            and not _residual_leaks(overall_sample, published_material_sample)
            else None
        )

        return {
            "overall_pct": overall_pct,
            "sample": overall_sample,
            "by_printer": sorted(by_printer, key=lambda r: -r["sample"]),
            "by_material": sorted(by_material, key=lambda r: -r["sample"]),
        }

    async def _time_accuracy(self, db: AsyncSession, since: datetime) -> dict:
        accuracies: list[float] = []
        per_printer: dict[int, list[float]] = {}
        for printer_id, accuracy in await _time_accuracy_rows(db, since):
            accuracies.append(accuracy)
            if printer_id is not None:
                per_printer.setdefault(printer_id, []).append(accuracy)

        printer_names = await _printer_names(db, per_printer.keys())

        by_printer = [
            {
                "printer_id": printer_id,
                "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                "accuracy_pct": round(sum(values) / len(values), 1),
                "sample": len(values),
            }
            for printer_id, values in per_printer.items()
            if len(values) >= MIN_SAMPLE
        ]

        # Same residual rule as `_failure_rates`/`_spool_costs` (`_residual_leaks`,
        # T-003): the published by_printer rows are a visible partition of
        # `accuracies`. If they leave a small residual population — runs with
        # no printer_id, or attributed to printers that didn't individually
        # clear MIN_SAMPLE — that residual's mean accuracy is recoverable by
        # subtraction. Suppress the overall figure rather than let that
        # residual leak through it; `sample` itself is unaffected.
        published_printer_sample = sum(row["sample"] for row in by_printer)
        overall_pct = (
            round(sum(accuracies) / len(accuracies), 1)
            if accuracies and not _residual_leaks(len(accuracies), published_printer_sample)
            else None
        )
        return {
            "overall_pct": overall_pct,
            "sample": len(accuracies),
            "by_printer": sorted(by_printer, key=lambda r: -r["sample"]),
        }

    async def _power_draw(self, db: AsyncSession, since: datetime) -> list[dict]:
        """Energy-weighted average watts per printer from measured print energy.

        ``PrintLogEntry.energy_kwh`` is backfilled from the smart-plug lifetime
        counter delta, so attribution is already per-printer — but it assumes
        the plug powers only the printer; a plug also feeding a dryer or light
        inflates the figure (the outlier band catches the worst of it).
        """
        per_printer: dict[int, dict[str, float]] = {}
        for printer_id, energy_kwh, hours in await _power_draw_rows(db, since):
            bucket = per_printer.setdefault(printer_id, {"kwh": 0.0, "hours": 0.0, "sample": 0})
            bucket["kwh"] += energy_kwh
            bucket["hours"] += hours
            bucket["sample"] += 1

        printer_names = await _printer_names(db, per_printer.keys())

        by_printer = [
            {
                "printer_id": printer_id,
                "printer_name": printer_names.get(printer_id, f"#{printer_id}"),
                "avg_watts": round(bucket["kwh"] * 1000 / bucket["hours"], 1),
                "sample": int(bucket["sample"]),
            }
            for printer_id, bucket in per_printer.items()
            if bucket["sample"] >= MIN_SAMPLE and bucket["hours"] > 0
        ]
        return sorted(by_printer, key=lambda r: -r["sample"])

    async def _daily_usage(self, db: AsyncSession, since: datetime) -> list[dict]:
        """Measured usage-hours/day per printer, for the depreciation assumption."""
        rows = await db.execute(
            select(
                PrintLogEntry.printer_id,
                func.sum(PrintLogEntry.duration_seconds),
                func.count(PrintLogEntry.id),
                func.min(PrintLogEntry.created_at),
            )
            .where(
                PrintLogEntry.printer_id.isnot(None),
                PrintLogEntry.created_at >= since,
                PrintLogEntry.duration_seconds.isnot(None),
                PrintLogEntry.duration_seconds <= _MAX_PRINT_SECONDS,
                PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
            )
            .group_by(PrintLogEntry.printer_id)
        )

        now = datetime.now(timezone.utc)
        entries: dict[int, dict] = {}
        for printer_id, total_seconds, sample, first_at in rows.all():
            if not total_seconds or sample < MIN_SAMPLE or first_at is None:
                continue
            if first_at.tzinfo is None:
                first_at = first_at.replace(tzinfo=timezone.utc)
            observed_days = max(1, (now - first_at).days)
            if observed_days < _MIN_USAGE_DAYS:
                continue
            entries[printer_id] = {
                "printer_id": printer_id,
                "hours_per_day": round(total_seconds / 3600 / observed_days, 2),
                "observed_days": observed_days,
                "sample": sample,
            }

        printer_names = await _printer_names(db, entries.keys())
        for printer_id, entry in entries.items():
            entry["printer_name"] = printer_names.get(printer_id, f"#{printer_id}")
        return sorted(entries.values(), key=lambda r: -r["sample"])

    async def _spool_costs(self, db: AsyncSession) -> list[dict]:
        # One round trip, two independently-aggregated branches unioned
        # together — not one grouped-by-brand+material read re-folded in
        # Python. Two things matter here and a single ``GROUP BY upper(brand),
        # upper(material))`` can't give both at once:
        #   - the per-material average/count must be bit-identical to a bare
        #     ``avg(cost_per_kg) ... GROUP BY upper(material)`` (no brand in
        #     the grouping key), both in the value (SQL's own float
        #     accumulation, not a Python re-sum of per-brand partial sums,
        #     which re-associates the additions and can flip the last ULP —
        #     see the regression this fixes) and in row order (SQLite's
        #     grouping/sort order for that exact query, which callers rely on
        #     — see `calculatorInsights.ts`'s first-fuzzy-match lookup);
        #   - the published-brand subtotal needs counts from exactly the
        #     brand+material groups ``_spool_costs_by_brand`` emits, which
        #     does require grouping by brand.
        # `material_agg` is that bare per-material query, verbatim. `brand_agg`
        # is `_spool_costs_by_brand`'s own grouping (predicate re-applied in
        # Python below, identically). UNION ALL keeps both in one statement —
        # one snapshot, so a spool inserted/edited/archived between the two
        # populations can't skew the residual (T-120) — while each branch's
        # own GROUP BY still computes and orders independently, so
        # `material_agg`'s rows arrive exactly as they would standalone.
        material_agg = (
            select(
                literal_column("'material'").label("kind"),
                null().label("brand"),
                func.upper(Spool.material).label("material"),
                func.avg(Spool.cost_per_kg).label("avg_cost"),
                func.count(Spool.id).label("cnt"),
            )
            .where(Spool.cost_per_kg.isnot(None), Spool.archived_at.is_(None))
            .group_by(func.upper(Spool.material))
        )
        brand_agg = (
            select(
                literal_column("'brand'").label("kind"),
                func.upper(Spool.brand).label("brand"),
                func.upper(Spool.material).label("material"),
                null().label("avg_cost"),
                func.count(Spool.id).label("cnt"),
            )
            .where(Spool.cost_per_kg.isnot(None), Spool.archived_at.is_(None))
            .group_by(func.upper(Spool.brand), func.upper(Spool.material))
        )
        rows = await db.execute(union_all(material_agg, brand_agg))

        # Insertion order into `material_totals` follows only the
        # `material_agg` rows, in the order they arrive — i.e. exactly the
        # order a standalone per-material query would emit them in.
        material_totals: dict[str, dict[str, float]] = {}
        published_brand_counts: dict[str, int] = {}
        for kind, brand, material, avg_cost, count in rows.all():
            if not material:
                continue
            if kind == "material":
                material_totals[material] = {"avg": avg_cost, "count": count}
            elif brand and count >= MIN_SAMPLE:
                published_brand_counts[material] = published_brand_counts.get(material, 0) + count

        result = []
        for material, totals in material_totals.items():
            count = totals["count"]
            if count < MIN_SAMPLE:
                continue
            # The published brand+material rows for this material are a
            # visible partition of it. If they leave a small residual
            # population — this material's total minus the sum of its
            # published brand subgroups — that residual's average is
            # recoverable by subtraction even though no single query
            # discloses it directly (see T-089/T-106, `_residual_leaks`/T-003).
            # Suppress the whole material row rather than let that residual
            # leak through it.
            if _residual_leaks(count, published_brand_counts.get(material, 0)):
                continue
            result.append({"material": material, "avg_cost_per_kg": round(totals["avg"], 2), "sample": count})
        return result

    async def _spool_costs_by_brand(self, db: AsyncSession) -> list[dict]:
        """Like ``_spool_costs`` but grouped by brand+material for exact matches."""
        rows = await db.execute(
            select(
                func.upper(Spool.brand),
                func.upper(Spool.material),
                func.avg(Spool.cost_per_kg),
                func.count(Spool.id),
            )
            .where(
                Spool.cost_per_kg.isnot(None),
                Spool.archived_at.is_(None),
                Spool.brand.isnot(None),
            )
            .group_by(func.upper(Spool.brand), func.upper(Spool.material))
        )
        return [
            {"brand": brand, "material": material, "avg_cost_per_kg": round(avg_cost, 2), "sample": count}
            for brand, material, avg_cost, count in rows.all()
            if brand and material and count >= MIN_SAMPLE
        ]


async def _time_accuracy_rows(db: AsyncSession, since: datetime) -> list[tuple[int | None, float]]:
    """Shared row-eligibility fold for `_time_accuracy` and
    `_time_accuracy_sample_counts`: yields one (printer_id, accuracy) pair
    per completed run since `since` whose duration resolves and whose
    accuracy ratio falls in [`_ACCURACY_BAND_LO`, `_ACCURACY_BAND_HI`]. One
    home for the band/duration-resolution rule so a future change to either
    can't drift between the two callers.

    The extra SQL predicates below are a pure row-count optimization: they
    only exclude rows that `_resolve_duration` + the accuracy-band check
    below would discard anyway, so the Python fold that follows is untouched
    and sees the exact same (duration, estimate) pairs it always did. Two
    cases are pushed to SQL because they're exact integer/IEEE-754 float
    mirrors of the Python arithmetic:
      - duration_seconds is usable (truthy) directly, no timestamp math;
      - the accuracy ratio and its [50, 200] band, using `col * 1.0 / col`
        to force float division exactly like Python's `int / int`.
    Rows needing the started_at/completed_at fallback (duration_seconds null
    or 0) are always fetched and still resolved/banded in Python, since
    replicating that elapsed-time fallback in SQL would risk timezone/
    precision drift this task explicitly warns against.
    """
    duration_usable = _duration_usable_expr()
    duration_missing = _duration_missing_expr()
    accuracy_in_band = (PrintArchive.print_time_seconds * 1.0 / PrintLogEntry.duration_seconds * 100).between(
        _ACCURACY_BAND_LO, _ACCURACY_BAND_HI
    )
    rows = await db.execute(
        select(
            PrintLogEntry.duration_seconds,
            PrintLogEntry.started_at,
            PrintLogEntry.completed_at,
            PrintLogEntry.printer_id,
            PrintArchive.print_time_seconds,
        )
        .join(PrintArchive, PrintArchive.id == PrintLogEntry.archive_id)
        .where(
            PrintLogEntry.status == "completed",
            PrintLogEntry.created_at >= since,
            PrintArchive.print_time_seconds.isnot(None),
            # `not estimate_seconds` in the fold below also drops 0.
            PrintArchive.print_time_seconds != 0,
            or_(
                and_(duration_usable, accuracy_in_band),
                and_(
                    duration_missing,
                    PrintLogEntry.started_at.isnot(None),
                    PrintLogEntry.completed_at.isnot(None),
                ),
            ),
        )
    )

    result: list[tuple[int | None, float]] = []
    for duration_seconds, started_at, completed_at, printer_id, estimate_seconds in rows.all():
        actual_seconds = _resolve_duration(duration_seconds, started_at, completed_at)
        if not actual_seconds or not estimate_seconds:
            continue
        accuracy = (estimate_seconds / actual_seconds) * 100
        if accuracy < _ACCURACY_BAND_LO or accuracy > _ACCURACY_BAND_HI:
            continue
        result.append((printer_id, accuracy))
    return result


async def _power_draw_rows(db: AsyncSession, since: datetime) -> list[tuple[int, float, float]]:
    """Shared row-eligibility fold for `_power_draw` and
    `_power_sample_counts`: yields one (printer_id, energy_kwh, hours) tuple
    per print since `since` whose duration resolves and whose implied watts
    (`energy_kwh*1000/hours`) falls in [`_WATTS_BAND_LO`, `_WATTS_BAND_HI`],
    with actual seconds bounded by [`_MIN_POWER_SECONDS`,
    `_MAX_PRINT_SECONDS`]. One home for that eligibility rule so a future
    change to either caller can't drift from the other — see
    `_time_accuracy_rows`, the same pattern for the accuracy fold.

    The extra SQL predicates below are a pure row-count optimization: they
    only exclude rows that the Python fold below would discard anyway, for
    the duration_seconds-usable case where the arithmetic is an exact SQL
    mirror of the Python expressions (`hours = actual/3600`, `implied_watts =
    energy_kwh*1000/hours`, both forced to float division to match Python's
    automatic int/int promotion). Rows needing the started_at/completed_at
    fallback are always fetched, unresolved, and handled by the unchanged
    Python loop.
    """
    duration_usable = _duration_usable_expr()
    duration_missing = _duration_missing_expr()
    hours_expr = PrintLogEntry.duration_seconds * 1.0 / 3600
    implied_watts_expr = PrintLogEntry.energy_kwh * 1000 / hours_expr
    rows = await db.execute(
        select(
            PrintLogEntry.energy_kwh,
            PrintLogEntry.duration_seconds,
            PrintLogEntry.started_at,
            PrintLogEntry.completed_at,
            PrintLogEntry.printer_id,
        ).where(
            PrintLogEntry.energy_kwh > 0,
            PrintLogEntry.printer_id.isnot(None),
            PrintLogEntry.created_at >= since,
            PrintLogEntry.status.in_(("completed", *_FAILED_STATUSES)),
            or_(
                and_(
                    duration_usable,
                    PrintLogEntry.duration_seconds.between(_MIN_POWER_SECONDS, _MAX_PRINT_SECONDS),
                    implied_watts_expr.between(_WATTS_BAND_LO, _WATTS_BAND_HI),
                ),
                and_(
                    duration_missing,
                    PrintLogEntry.started_at.isnot(None),
                    PrintLogEntry.completed_at.isnot(None),
                ),
            ),
        )
    )

    result: list[tuple[int, float, float]] = []
    for energy_kwh, duration_seconds, started_at, completed_at, printer_id in rows.all():
        actual_seconds = _resolve_duration(duration_seconds, started_at, completed_at)
        if not actual_seconds or actual_seconds < _MIN_POWER_SECONDS or actual_seconds > _MAX_PRINT_SECONDS:
            continue
        hours = actual_seconds / 3600
        implied_watts = energy_kwh * 1000 / hours
        if implied_watts < _WATTS_BAND_LO or implied_watts > _WATTS_BAND_HI:
            continue
        result.append((printer_id, energy_kwh, hours))
    return result


async def _printer_names(db: AsyncSession, printer_ids) -> dict[int, str]:
    """Batched id → name lookup for the per-printer groupings."""
    ids = list(printer_ids)
    if not ids:
        return {}
    return dict((await db.execute(select(Printer.id, Printer.name).where(Printer.id.in_(ids)))).all())


def _resolve_duration(duration_seconds, started_at, completed_at) -> int | None:
    """Actual run seconds: the stored duration, else the started→completed elapsed."""
    if duration_seconds:
        return duration_seconds
    if started_at and completed_at:
        elapsed = (completed_at - started_at).total_seconds()
        return int(elapsed) if elapsed > 0 else None
    return None


def _split_materials(filament_type: str | None) -> list[str]:
    if not filament_type:
        return []
    return sorted({part.strip().upper() for part in filament_type.split(",") if part.strip()})


calculator_insights_service = CalculatorInsightsService()
