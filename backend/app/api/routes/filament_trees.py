"""Filament profile trees: brand + material > machine > nozzle > colour; each leaf generates one filament preset."""

import json
from contextlib import contextmanager
from dataclasses import asdict, replace

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import delete, func, select
from sqlalchemy.exc import NoResultFound
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.cloud import _cloud_api_key_gate, cloud_caller
from backend.app.api.routes.orca_cloud import _build_authenticated_service
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.filament_profile import FilamentPreset
from backend.app.models.filament_tree import (
    FilamentTree,
    FilamentTreeChange,
    FilamentTreeColor,
    FilamentTreeLeaf,
    FilamentTreeOverride,
)
from backend.app.models.spool import Spool
from backend.app.models.user import User
from backend.app.schemas.filament_tree import (
    BulkNodeUpdate,
    CandidateRequest,
    ColorCreate,
    ColorUpdate,
    ConflictResolveRequest,
    ExportRequest,
    MigrateRequest,
    NodeRow,
    NodeUpdate,
    Targets,
    TreeChange,
    TreeColor,
    TreeCreate,
    TreeDuplicate,
    TreeSource,
    TreeSummary,
    TreeUpdate,
)
from backend.app.services import filament_tree_store as store
from backend.app.services.filament_tree import (
    NOZZLE_BOUND_KEYS,
    SKIP_KEYS,
    TreeData,
    is_abrasive,
    leaf_targets,
    match_base,
    parse_inherits,
    resolve_with_sources,
)
from backend.app.services.filament_tree_base import build_base_reader
from backend.app.services.filament_tree_export import build_export_zip
from backend.app.services.filament_tree_migration import apply_migration, propose_groups, row_dict
from backend.app.services.filament_tree_pull import (
    apply_pull,
    collect_leaf_states,
    plan_pull,
    resolve_conflict,
)
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError

router = APIRouter(prefix="/filament-trees", tags=["filament-trees"])

_READ = Permission.FILAMENTS_READ
_CREATE = Permission.FILAMENTS_CREATE
_UPDATE = Permission.FILAMENTS_UPDATE
_DELETE = Permission.FILAMENTS_DELETE


@contextmanager
def _mapped():
    """Store errors -> HTTP: ValueError 400, missing row 404 (KeyError/IndexError are bugs, not 404s)."""
    try:
        yield
    except (KeyError, IndexError):
        raise
    except (LookupError, NoResultFound) as e:
        raise HTTPException(404, str(e) or "not found") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


async def _orca_call(db: AsyncSession, user: User | None, fn):
    svc = await _build_authenticated_service(db, user)
    try:
        return await fn(svc)
    except OrcaCloudAuthError as e:
        raise HTTPException(401, str(e)) from e
    except OrcaCloudError as e:
        if "not found" in str(e).lower():
            raise HTTPException(404, str(e)) from e
        raise HTTPException(502, str(e)) from e
    finally:
        await svc.close()


def _check_node(tree: TreeData, machine: str | None, nozzle: str | None, color_id: int | None) -> None:
    if color_id is not None and color_id not in tree.colors:
        raise LookupError(f"colour {color_id} not found")
    if (machine is None and nozzle is not None) or (machine is not None and nozzle is None and color_id is not None):
        raise ValueError("a node needs its ancestors: machine, then nozzle, then colour")


def _without_own(tree: TreeData, machine: str | None, nozzle: str | None, color_id: int | None) -> TreeData:
    """The tree as if this node had no own values, so resolving it yields what the node inherits."""
    if machine is None and color_id is None:
        return replace(tree, own={})
    node = (machine or "", nozzle or "", color_id or 0)
    return replace(tree, overrides={k: v for k, v in tree.overrides.items() if k != node})


def _node_level(machine: str | None, nozzle: str | None, color_id: int | None) -> str:
    if color_id is not None:
        return "color" if machine is not None else "colorwide"
    return "nozzle" if nozzle is not None else "machine" if machine is not None else "root"


def _own_counts(tree: TreeData) -> dict[str, int]:
    counts = {"root": len(tree.own)}
    for (m, n, c), values in tree.overrides.items():
        key = f"color:{c}" if not m else "/".join(p for p in (m, n, str(c) if c else "") if p)
        counts[key] = len(values)
    return counts


def _actor(user: User | None) -> str:
    return user.username if user else ""


async def _spool_counts(db: AsyncSession) -> dict[tuple[str, str, str], int]:
    """(brand, material, colour name), casefolded -> active spools; a spool counts under "PLA" and "PLA Matte"."""
    # shortcut: exact-name matching only (a "Bambu Lab" spool never matches a "Bambu" tree), add an alias map if needed
    rows = await db.execute(
        select(Spool.brand, Spool.material, Spool.subtype, Spool.color_name, func.count())
        .where(Spool.archived_at.is_(None))
        .group_by(Spool.brand, Spool.material, Spool.subtype, Spool.color_name)
    )
    counts: dict[tuple[str, str, str], int] = {}
    for brand, material, subtype, color, n in rows.all():
        for mat in {material or "", f"{material or ''} {subtype or ''}".strip()}:
            key = ((brand or "").casefold(), mat.casefold(), (color or "").casefold())
            counts[key] = counts.get(key, 0) + n
    return counts


def _price(tree: TreeData, color_id: int) -> float | None:
    raw = resolve_with_sources(tree, None, None, color_id).get("filament_cost", (None,))[0]
    try:
        return float(str(raw[0] if isinstance(raw, list) else raw))
    except (TypeError, ValueError, IndexError):
        return None


# --- literal routes, above /{tree_id} ---


@router.get("", response_model=list[TreeSummary])
async def list_trees(
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    out = []
    spools = await _spool_counts(db)
    pending = dict(
        (
            await db.execute(
                select(FilamentTreeLeaf.tree_id, func.count())
                .where(FilamentTreeLeaf.export_pending)
                .group_by(FilamentTreeLeaf.tree_id)
            )
        )
        .tuples()
        .all()
    )
    for meta in (await db.execute(select(FilamentTree).order_by(FilamentTree.name, FilamentTree.id))).scalars().all():
        tree = await store.load_tree(db, meta.id)
        stock = (meta.brand.casefold(), meta.material.casefold())
        out.append(
            TreeSummary(
                id=meta.id,
                name=meta.name,
                brand=meta.brand,
                material=meta.material,
                skip_02=meta.skip_02,
                abrasive=is_abrasive(tree),
                source=TreeSource(
                    machine=meta.source_machine, nozzle=meta.source_nozzle, color_id=meta.source_color_id
                ),
                colors=[
                    TreeColor(
                        id=cid,
                        name=name,
                        hex=hex_,
                        spools=spools.get((*stock, name.casefold()), 0),
                        price=_price(tree, cid),
                    )
                    for cid, (name, hex_) in tree.colors.items()
                ],
                own_counts=_own_counts(tree),
                export_pending=pending.get(meta.id, 0),
            )
        )
    return out


@router.post("")
async def create_tree(
    payload: TreeCreate,
    _: User | None = RequirePermissionIfAuthEnabled(_CREATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """A new filament from scratch: one colour, no own values, leaves inherit the Bambu family."""
    try:
        with _mapped():
            tree_id = await store.create_tree(db, name=f"{payload.brand} {payload.material}", **payload.model_dump())
            await db.commit()
    except BaseException:
        await db.rollback()
        raise
    return {"tree_id": tree_id}


@router.post("/bulk")
async def bulk_node(
    payload: BulkNodeUpdate,
    user: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """One write on the same node of several trees; all or nothing."""
    try:
        with _mapped():
            for tree_id in dict.fromkeys(payload.tree_ids):
                _check_node(await store.load_tree(db, tree_id), payload.machine, payload.nozzle, None)
                await store.set_node_values(
                    db,
                    tree_id,
                    payload.machine,
                    payload.nozzle,
                    None,
                    payload.set_values,
                    payload.clear,
                    regenerate=False,
                    actor=_actor(user),
                )
                await store.regenerate_tree(db, tree_id)
            await db.commit()
    except BaseException:
        await db.rollback()
        raise
    return {"success": True}


@router.get("/targets", response_model=Targets)
async def get_targets(
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await store.get_targets(db)


@router.put("/targets", response_model=Targets)
async def put_targets(
    payload: Targets,
    _: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    tree_ids = (await db.execute(select(FilamentTree.id))).scalars().all()
    with _mapped():
        for tree_id in tree_ids:
            tree = await store.load_tree(db, tree_id)
            if tree.source not in leaf_targets(tree, payload.model_dump()):
                raise ValueError(
                    f"{tree.name}: its calibration source {tree.source[0]} {tree.source[1]} must stay a target"
                )
        try:
            # one transaction: the targets only change if every tree regenerates under them
            targets = await store.set_targets(db, payload.model_dump(), commit=False)
            for tree_id in tree_ids:
                await store.regenerate_tree(db, tree_id)
            await db.commit()
        except BaseException:
            await db.rollback()
            raise
    return targets


@router.get("/unmanaged")
async def list_unmanaged(
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    rows = (await db.execute(select(FilamentPreset).order_by(FilamentPreset.name))).scalars().all()
    with _mapped():
        groups = propose_groups(
            [row_dict(r) for r in rows], await store.managed_preset_ids(db), await store.get_targets(db)
        )
    return [asdict(g) for g in groups]


@router.post("/migrate")
async def migrate(
    payload: MigrateRequest,
    _: User | None = RequirePermissionIfAuthEnabled(_CREATE, _UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        tree_ids = await apply_migration(db, [g.model_dump() for g in payload.groups])
    return {"tree_ids": tree_ids}


@router.post("/sync", dependencies=[Depends(_cloud_api_key_gate)])
async def sync(
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = cloud_caller(_UPDATE, Permission.ORCA_CLOUD_AUTH),
):
    """Pull only: fold OrcaSlicer edits into the trees, report conflicts and candidates."""
    entries = await _orca_call(db, current_user, lambda svc: svc.list_profiles())
    leaves, colour_names = await collect_leaf_states(db)
    plan = plan_pull(entries, leaves, colour_names)
    with _mapped():
        await apply_pull(db, plan)
    return {k: v for k, v in asdict(plan).items() if k != "baselines"}  # full Orca contents stay server-side


@router.post("/conflicts/resolve")
async def resolve(
    payload: ConflictResolveRequest,
    _: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        await resolve_conflict(
            db,
            payload.tree_id,
            payload.machine,
            payload.nozzle,
            payload.color_id,
            payload.key,
            payload.value,
            payload.orca_value,
        )
    return {"success": True}


@router.post("/candidates", dependencies=[Depends(_cloud_api_key_gate)])
async def adopt_candidate(
    payload: CandidateRequest,
    db: AsyncSession = Depends(get_db, scope="function"),
    # reads the caller's Orca Cloud, so it needs orca_cloud:auth like /sync
    current_user: User | None = cloud_caller(_CREATE, Permission.ORCA_CLOUD_AUTH),
):
    """Turn an Orca-only preset into a one-colour tree calibrated at (machine, nozzle)."""
    profile = await _orca_call(db, current_user, lambda svc: svc.get_profile(payload.orca_id))
    content = profile.get("content") if isinstance(profile, dict) else None
    if not isinstance(content, dict) or content.get("type") != "filament":
        raise HTTPException(400, "That Orca Cloud preset is not a filament preset")
    raw_inherits = content.get("inherits")
    inherits = raw_inherits if isinstance(raw_inherits, str) else ""
    machine, nozzle = payload.machine, payload.nozzle
    tree_name = payload.name.split(" - ", 1)[0].strip() or f"{payload.brand} {payload.material}"
    try:
        with _mapped():
            if await db.scalar(select(FilamentTree.id).where(FilamentTree.name == tree_name)) is not None:
                raise ValueError(f"a filament tree named {tree_name!r} already exists")
            tree = FilamentTree(
                name=tree_name,
                brand=payload.brand,
                material=payload.material,
                version=str(content.get("version") or "2.4.0.8"),
                base_family=parse_inherits(inherits)[0],
                fallback_inherits=inherits,
                own_values=json.dumps({k: v for k, v in content.items() if k not in SKIP_KEYS | NOZZLE_BOUND_KEYS}),
                source_machine=machine,
                source_nozzle=nozzle,
            )
            db.add(tree)
            await db.flush()
            color = FilamentTreeColor(tree_id=tree.id, name=payload.color_name, hex=payload.color_hex)
            db.add(color)
            await db.flush()
            tree.source_color_id = color.id
            bound = {k: v for k, v in content.items() if k in NOZZLE_BOUND_KEYS}
            if bound:
                db.add(FilamentTreeOverride(tree_id=tree.id, machine=machine, nozzle=nozzle, values=json.dumps(bound)))
            await db.flush()
            if (machine, nozzle, color.id) not in leaf_targets(
                await store.load_tree(db, tree.id), await store.get_targets(db)
            ):
                raise ValueError(f"{machine} {nozzle} is not a target leaf")
            await store.regenerate_tree(db, tree.id)
            await db.commit()
    except BaseException:
        await db.rollback()
        raise
    return {"tree_id": tree.id}


@router.post("/export")
async def export(
    payload: ExportRequest,
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        data = await build_export_zip(db, payload.tree_id, payload.changed_only)
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="fenrir-filaments.zip"'},
    )


# --- /{tree_id} routes ---


@router.get("/{tree_id}/node", response_model=list[NodeRow])
async def get_node(
    tree_id: int,
    machine: str | None = None,
    nozzle: str | None = None,
    color_id: int | None = None,
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        tree = await store.load_tree(db, tree_id)
        _check_node(tree, machine, nozzle, color_id)
    current = resolve_with_sources(tree, machine, nozzle, color_id)
    parent = resolve_with_sources(_without_own(tree, machine, nozzle, color_id), machine, nozzle, color_id)
    level = _node_level(machine, nozzle, color_id)
    # Above the nozzle level the Bambu preset is the calibration source's: the parent values the tree was built on.
    base_machine, base_nozzle = machine or tree.source[0], nozzle or tree.source[1]
    base_name, base = None, {}
    if base_machine and base_nozzle:
        base_name = match_base(
            tree.base_family, base_machine, base_nozzle, await store.base_names(db), tree.fallback_inherits
        )
        reader = await build_base_reader(db)
        skip = SKIP_KEYS if nozzle is not None else SKIP_KEYS | NOZZLE_BOUND_KEYS
        base = {k: v for k, v in reader.values(base_name).items() if k not in skip}
    rows = []
    for key in sorted(current.keys() | base.keys()):
        if key in current:
            value, source = current[key]
            inherited = parent.get(key) or ((base[key], "bambu") if key in base else (None, None))
            rows.append(
                NodeRow(
                    key=key,
                    value=value,
                    source=source,
                    own=source == level,
                    inherited_value=inherited[0],
                    inherited_source=inherited[1],
                    source_label=base_name if inherited[1] == "bambu" else None,
                )
            )
        else:
            rows.append(NodeRow(key=key, value=base[key], source="bambu", own=False, source_label=base_name))
    return rows


@router.put("/{tree_id}/node")
async def put_node(
    tree_id: int,
    payload: NodeUpdate,
    user: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        _check_node(await store.load_tree(db, tree_id), payload.machine, payload.nozzle, payload.color_id)
        await store.set_node_values(
            db,
            tree_id,
            payload.machine,
            payload.nozzle,
            payload.color_id,
            payload.set_values,
            payload.clear,
            actor=_actor(user),
        )
    return {"success": True}


@router.post("/{tree_id}/duplicate")
async def duplicate_tree(
    tree_id: int,
    payload: TreeDuplicate,
    _: User | None = RequirePermissionIfAuthEnabled(_CREATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    try:
        with _mapped():
            new_id = await store.duplicate_tree(db, tree_id, payload.name, payload.brand)
            await db.commit()
    except BaseException:
        await db.rollback()
        raise
    return {"tree_id": new_id}


@router.get("/{tree_id}/history", response_model=list[TreeChange])
async def get_history(
    tree_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(_READ),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    rows = await db.execute(
        select(FilamentTreeChange)
        .where(FilamentTreeChange.tree_id == tree_id)
        .order_by(FilamentTreeChange.id.desc())
        .limit(200)
    )
    return [
        TreeChange(
            id=c.id,
            machine=c.machine,
            nozzle=c.nozzle,
            color_id=c.color_id,
            key=c.key,
            old_value=None if c.old_value is None else json.loads(c.old_value),
            new_value=None if c.new_value is None else json.loads(c.new_value),
            actor=c.actor,
            created_at=c.created_at,
        )
        for c in rows.scalars().all()
    ]


@router.post("/{tree_id}/history/{change_id}/revert")
async def revert_change(
    tree_id: int,
    change_id: int,
    user: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Put a node's key back to what it was before that change (itself logged as a new change)."""
    change = await db.get(FilamentTreeChange, change_id)
    if change is None or change.tree_id != tree_id:
        raise HTTPException(404, f"change {change_id} not found")
    node = (change.machine or None, change.nozzle or None, change.color_id or None)
    old = None if change.old_value is None else json.loads(change.old_value)
    with _mapped():
        _check_node(await store.load_tree(db, tree_id), *node)
        await store.set_node_values(
            db,
            tree_id,
            *node,
            {} if old is None else {change.key: old},
            [change.key] if old is None else [],
            actor=_actor(user),
        )
    return {"success": True}


@router.patch("/{tree_id}")
async def patch_tree(
    tree_id: int,
    payload: TreeUpdate,
    _: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    changes = payload.model_dump(exclude_unset=True)
    kwargs = {}
    with _mapped():
        tree = await store.load_tree(db, tree_id)
        if "skip_02" in changes:
            kwargs["skip_02"] = changes["skip_02"]
        kwargs.update({k: changes[k] for k in ("brand", "material") if changes.get(k)})
        if changes.keys() & {"source_machine", "source_nozzle", "source_color_id"}:
            m, n, c = tree.source
            source = (
                changes.get("source_machine") or m,
                changes.get("source_nozzle") or n,
                changes.get("source_color_id") or c,
            )
            # the source must stay a generated leaf, or its calibration has nowhere to live
            check = replace(tree, skip_02=kwargs.get("skip_02", tree.skip_02))
            if source not in leaf_targets(check, await store.get_targets(db)):
                raise ValueError(f"{source[0]} {source[1]} with that colour is not a leaf of this tree")
            kwargs["source"] = source
        await store.update_tree(db, tree_id, **kwargs)
    return {"success": True}


@router.post("/{tree_id}/colors")
async def add_color(
    tree_id: int,
    payload: ColorCreate,
    _: User | None = RequirePermissionIfAuthEnabled(_CREATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        return {"id": await store.add_color(db, tree_id, payload.name, payload.hex)}


@router.patch("/{tree_id}/colors/{color_id}")
async def rename_color(
    tree_id: int,
    color_id: int,
    payload: ColorUpdate,
    _: User | None = RequirePermissionIfAuthEnabled(_UPDATE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        await store.rename_color(db, tree_id, color_id, payload.name, payload.hex)
    return {"success": True}


@router.delete("/{tree_id}/colors/{color_id}")
async def remove_color(
    tree_id: int,
    color_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(_DELETE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    with _mapped():
        await store.remove_color(db, tree_id, color_id)
    return {"success": True}


@router.delete("/{tree_id}")
async def delete_tree(
    tree_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(_DELETE),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    if await db.get(FilamentTree, tree_id) is None:
        raise HTTPException(404, f"filament tree {tree_id} not found")
    preset_ids = list(
        (await db.execute(select(FilamentTreeLeaf.preset_id).where(FilamentTreeLeaf.tree_id == tree_id))).scalars()
    )
    # explicit child deletes: don't depend on the database enforcing ON DELETE CASCADE
    for model in (FilamentTreeLeaf, FilamentTreeOverride, FilamentTreeColor, FilamentTreeChange):
        await db.execute(delete(model).where(model.tree_id == tree_id))
    await db.execute(delete(FilamentPreset).where(FilamentPreset.id.in_(preset_ids)))
    await db.execute(delete(FilamentTree).where(FilamentTree.id == tree_id))
    await db.commit()
    return {"success": True}
