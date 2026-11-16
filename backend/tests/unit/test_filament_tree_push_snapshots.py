"""Orca snapshot rotation: push snapshots rotate, the pre-cleanup snapshot is kept."""

from backend.app.services import filament_tree_push as push_service


def test_push_snapshots_never_prune_a_cleanup_snapshot(monkeypatch, tmp_path):
    monkeypatch.setattr(push_service, "_snapshot_dir", lambda: tmp_path)
    cleanup = push_service._snapshot([{"id": "a"}], "cleanup")
    assert cleanup.startswith("cleanup-")
    for _ in range(push_service._KEEP_SNAPSHOTS + 5):
        push_service._snapshot([])
    names = sorted(p.name for p in tmp_path.iterdir())
    assert cleanup in names
    assert len([n for n in names if n.startswith("filaments-")]) == push_service._KEEP_SNAPSHOTS
