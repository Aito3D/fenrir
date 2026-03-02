"""API routes for kanban board cards."""

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import (
    calculate_file_hash,
    extract_gcode_thumbnail,
    get_library_files_dir,
    get_library_thumbnails_dir,
    to_relative_path,
)
from backend.app.core.database import get_db
from backend.app.models.archive import PrintArchive
from backend.app.models.kanban_card import KanbanCard
from backend.app.models.library import LibraryFile
from backend.app.schemas.kanban_card import (
    KanbanCardCreate,
    KanbanCardReorder,
    KanbanCardResponse,
    KanbanCardUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kanban", tags=["kanban"])


def _resolve_state(column: str) -> str:
    """Auto-set state based on column: finished only in done, progress elsewhere."""
    return "finished" if column == "done" else "progress"


async def _enrich_card(card: KanbanCard, db: AsyncSession) -> KanbanCardResponse:
    """Build a KanbanCardResponse with archive_completed_at populated."""
    resp = KanbanCardResponse.model_validate(card)
    if card.archive_id:
        result = await db.execute(
            select(PrintArchive.completed_at).where(PrintArchive.id == card.archive_id)
        )
        resp.archive_completed_at = result.scalar_one_or_none()
    return resp


async def _enrich_cards(cards: list[KanbanCard], db: AsyncSession) -> list[KanbanCardResponse]:
    """Batch-enrich cards with archive completion timestamps."""
    archive_ids = [c.archive_id for c in cards if c.archive_id]
    completed_map: dict[int, object] = {}
    if archive_ids:
        result = await db.execute(
            select(PrintArchive.id, PrintArchive.completed_at).where(
                PrintArchive.id.in_(archive_ids)
            )
        )
        completed_map = {row.id: row.completed_at for row in result.all()}

    responses = []
    for card in cards:
        resp = KanbanCardResponse.model_validate(card)
        if card.archive_id and card.archive_id in completed_map:
            resp.archive_completed_at = completed_map[card.archive_id]
        responses.append(resp)
    return responses


@router.get("/cards", response_model=list[KanbanCardResponse])
async def list_cards(
    db: AsyncSession = Depends(get_db),
):
    """List all kanban cards ordered by sort_order."""
    result = await db.execute(select(KanbanCard).order_by(KanbanCard.sort_order))
    cards = list(result.scalars().all())
    return await _enrich_cards(cards, db)


@router.post("/cards", response_model=KanbanCardResponse)
async def create_card(
    card_data: KanbanCardCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a new kanban card."""
    # Place at end of target column
    result = await db.execute(
        select(KanbanCard)
        .where(KanbanCard.column == card_data.column)
        .order_by(KanbanCard.sort_order.desc())
        .limit(1)
    )
    last_card = result.scalar_one_or_none()
    next_order = (last_card.sort_order + 1) if last_card else 0

    card = KanbanCard(
        title=card_data.title,
        quote_id=card_data.quote_id,
        quote_name=card_data.quote_name,
        client_id=card_data.client_id,
        client_name=card_data.client_name,
        client_phone=card_data.client_phone,
        quantity=card_data.quantity,
        column=card_data.column,
        state=_resolve_state(card_data.column),
        sort_order=next_order,
    )
    db.add(card)
    await db.commit()
    await db.refresh(card)

    logger.info("Created kanban card: %s (column=%s)", card.title, card.column)
    return card


@router.get("/cards/{card_id}", response_model=KanbanCardResponse)
async def get_card(
    card_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return await _enrich_card(card, db)


@router.patch("/cards/{card_id}", response_model=KanbanCardResponse)
async def update_card(
    card_id: int,
    update_data: KanbanCardUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Finished cards can only be moved (column change), not edited
    update_dict = update_data.model_dump(exclude_unset=True)
    if card.state == "finished":
        allowed = {"column", "sort_order"}
        disallowed = set(update_dict.keys()) - allowed
        if disallowed:
            raise HTTPException(status_code=400, detail="Finished cards cannot be edited")

    for key, value in update_dict.items():
        setattr(card, key, value)

    # Auto-set state based on column
    card.state = _resolve_state(card.column)

    await db.commit()
    await db.refresh(card)

    logger.info("Updated kanban card: %s (column=%s, state=%s)", card.title, card.column, card.state)
    return await _enrich_card(card, db)


@router.delete("/cards/{card_id}")
async def delete_card(
    card_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    title = card.title
    await db.delete(card)
    await db.commit()

    logger.info("Deleted kanban card: %s", title)
    return {"message": f"Card '{title}' deleted"}


@router.put("/cards/reorder", response_model=list[KanbanCardResponse])
async def reorder_cards(
    reorder_data: KanbanCardReorder,
    db: AsyncSession = Depends(get_db),
):
    """Update the sort order of cards."""
    for index, card_id in enumerate(reorder_data.ids):
        result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
        card = result.scalar_one_or_none()
        if card:
            card.sort_order = index

    await db.commit()

    result = await db.execute(select(KanbanCard).order_by(KanbanCard.sort_order))
    cards = list(result.scalars().all())

    logger.info("Reordered %d kanban cards", len(reorder_data.ids))
    return await _enrich_cards(cards, db)


@router.post("/cards/{card_id}/upload", response_model=KanbanCardResponse)
async def upload_card_file(
    card_id: int,
    file: UploadFile,
    db: AsyncSession = Depends(get_db),
):
    """Upload a file to a kanban card and move it to to-print."""
    import os
    import uuid

    from backend.app.services.archive import ThreeMFParser

    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    if not file.filename:
        raise HTTPException(status_code=400, detail="Filename is required")

    filename = file.filename
    ext = os.path.splitext(filename)[1].lower()
    file_type = ext[1:] if ext else "unknown"

    # Save file
    unique_filename = f"{uuid.uuid4().hex}{ext}"
    file_path = get_library_files_dir() / unique_filename

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    file_hash = calculate_file_hash(file_path)

    # Extract metadata and thumbnail (same logic as library upload)
    metadata = {}
    thumbnail_path = None
    thumbnails_dir = get_library_thumbnails_dir()

    if ext == ".3mf":
        try:
            parser = ThreeMFParser(str(file_path))
            raw_metadata = parser.parse()

            thumbnail_data = raw_metadata.get("_thumbnail_data")
            thumbnail_ext = raw_metadata.get("_thumbnail_ext", ".png")

            if thumbnail_data:
                thumb_filename = f"{uuid.uuid4().hex}{thumbnail_ext}"
                thumb_path = thumbnails_dir / thumb_filename
                with open(thumb_path, "wb") as f:
                    f.write(thumbnail_data)
                thumbnail_path = str(thumb_path)

            def clean_metadata(obj):
                if isinstance(obj, dict):
                    return {
                        k: clean_metadata(v)
                        for k, v in obj.items()
                        if not isinstance(v, bytes) and k not in ("_thumbnail_data", "_thumbnail_ext")
                    }
                elif isinstance(obj, list):
                    return [clean_metadata(i) for i in obj if not isinstance(i, bytes)]
                elif isinstance(obj, bytes):
                    return None
                return obj

            metadata = clean_metadata(raw_metadata)
        except Exception as e:
            logger.warning("Failed to parse 3MF: %s", e)

    elif ext == ".gcode":
        try:
            thumbnail_data = extract_gcode_thumbnail(file_path)
            if thumbnail_data:
                thumb_filename = f"{uuid.uuid4().hex}.png"
                thumb_path = thumbnails_dir / thumb_filename
                with open(thumb_path, "wb") as f:
                    f.write(thumbnail_data)
                thumbnail_path = str(thumb_path)
        except Exception as e:
            logger.warning("Failed to extract gcode thumbnail: %s", e)

    # Create library file record with full metadata
    lib_file = LibraryFile(
        filename=filename,
        file_path=to_relative_path(file_path),
        file_type=file_type,
        file_size=len(content),
        file_hash=file_hash,
        thumbnail_path=to_relative_path(thumbnail_path) if thumbnail_path else None,
        file_metadata=metadata if metadata else None,
    )
    db.add(lib_file)
    await db.flush()

    # Link file to card and move to to-print
    card.file_id = lib_file.id
    card.column = "to-print"
    card.state = _resolve_state("to-print")

    await db.commit()
    await db.refresh(card)

    logger.info("Uploaded file '%s' to card '%s', moved to to-print", filename, card.title)
    return await _enrich_card(card, db)
