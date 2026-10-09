"""Campaign-23 golden probe: the post-campaign-21 sync machinery, pure parts.

Prints a deterministic table for the three modules the 2026-10-01 Aito–Zoho
sync rework added: ``aito_push_schedule`` (per-card push windows + flush
waiters), ``aito_change_poll`` (constants + poll table), and the Aito-fed
inbox's kind table (``services/inbox``). Only pure, clock-free functions are
exercised: the caller passes ``now`` readings in, so no sleeping, no DB.
"""
import json
import sys

sys.path.insert(0, ".")
from backend.app.models.notification_inbox import AitoWatch, UserInboxPreference  # noqa: E402
from backend.app.services import aito_change_poll as cp  # noqa: E402
from backend.app.services import aito_events as ev  # noqa: E402
from backend.app.services import aito_push_schedule as ps  # noqa: E402
from backend.app.services import inbox  # noqa: E402

out = {}

# --- push windows: a scripted edit session, one line per step -----------------
ps.reset()
steps = []


def snap(label, now):
    steps.append(
        {
            "step": label,
            "now": now,
            "due_1": ps.is_due(1, now),
            "due_2": ps.is_due(2, now),
            "any_due": ps.any_due(now),
            "next_due": ps.next_due(now),
            "windows": {str(k): [w.opened_at, w.due_at, w.immediate] for k, w in sorted(ps._windows.items())},
        }
    )


snap("empty", 0.0)
ps.note_edit(1, 0.0)
snap("edit#1@0", 0.0)
ps.note_edit(1, 5.0)
snap("edit#1@5 (quiet extends)", 5.0)
snap("tick@14.9", 14.9)
snap("tick@15", 15.0)
for t in (20.0, 28.0, 36.0, 44.0, 52.0):
    ps.note_edit(1, t)
snap("edits every 8s -> capped at opened+45", 52.0)
ps.note_edit(2, 52.0)
ps.note_immediate(2, 53.0)
snap("card 2 immediate", 53.0)
ps.note_edit(2, 54.0)
snap("edit after immediate does not push due out", 54.0)
ps.take(1)
snap("take(1)", 54.0)
ps.note_edit(1, 54.0)
ps.drop_due_except(70.0, keep={1})
snap("drop_due_except(70, keep={1})", 70.0)
ps.note_immediate(3, 70.0)
snap("immediate on a fresh card", 70.0)
out["push_schedule"] = {
    "constants": {"EDIT_QUIET_SECONDS": ps.EDIT_QUIET_SECONDS, "EDIT_MAX_WAIT_SECONDS": ps.EDIT_MAX_WAIT_SECONDS},
    "steps": steps,
}
ps.reset()

# --- change poll: constants and the poll table ---------------------------------
out["change_poll"] = {
    "BACKFILL_DAYS": cp.BACKFILL_DAYS,
    "OVERLAP_SECONDS": cp.OVERLAP_SECONDS,
    "TRUNCATED_OVERLAP_SECONDS": cp.TRUNCATED_OVERLAP_SECONDS,
    "polls": [list(p) for p in cp._POLLS],
    "changes_fields": sorted(cp.Changes.__dataclass_fields__),
}

# --- inbox kinds: table, defaults, event -> kind over every Aito event kind ----
out["inbox"] = {
    "RETENTION_DAYS": inbox.RETENTION_DAYS,
    "KINDS": {k: {"family": v.family, "default_on": v.default_on, "events": list(v.events)} for k, v in inbox.KINDS.items()},
    "DEFAULT_KINDS": list(inbox.DEFAULT_KINDS),
    "event_to_kind": {k: inbox.inbox_kind_for(k) for k in sorted(ev.KINDS)},
}
prefs = UserInboxPreference(user_id=1, kinds_json=["aito.paid", "printer.finished", "aito.quote_viewed"], sound_kinds_json=[], auto_watch=True)
out["inbox"]["effective_watch_kinds"] = {
    "auto_watch(None)": inbox.effective_watch_kinds(AitoWatch(project_id=1, user_id=1, kinds_json=None), prefs),
    "explicit subset": inbox.effective_watch_kinds(AitoWatch(project_id=1, user_id=1, kinds_json=["aito.paid", "aito.overdue"]), prefs),
    "explicit empty": inbox.effective_watch_kinds(AitoWatch(project_id=1, user_id=1, kinds_json=[]), prefs),
}
print(json.dumps(out, indent=1, sort_keys=True))
