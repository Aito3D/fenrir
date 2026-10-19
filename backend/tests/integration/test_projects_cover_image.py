"""Replacing a project's cover image deletes the previous file from disk."""

import shutil

import pytest
from httpx import AsyncClient

from backend.app.api.routes.projects import get_project_attachments_dir
from backend.app.models.project import Project

PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c63f80f00000100010000000000000049454e44ae42"
    "6082"
)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_replacing_the_cover_image_removes_the_old_file(async_client: AsyncClient, db_session):
    project = Project(name="Cover replace", description="d", color="#FF0000")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)
    attachments = get_project_attachments_dir(project.id)
    try:
        first = await async_client.post(
            f"/api/v1/projects/{project.id}/cover-image", files={"file": ("a.png", PNG, "image/png")}
        )
        assert first.status_code == 200, first.text
        first_name = first.json()["filename"]
        assert (attachments / first_name).read_bytes() == PNG

        second = await async_client.post(
            f"/api/v1/projects/{project.id}/cover-image", files={"file": ("b.png", PNG + b"x", "image/png")}
        )
        assert second.status_code == 200, second.text
        second_name = second.json()["filename"]

        assert second_name != first_name
        assert not (attachments / first_name).exists()
        assert (attachments / second_name).read_bytes() == PNG + b"x"
        assert sorted(p.name for p in attachments.iterdir()) == [second_name]
    finally:
        shutil.rmtree(attachments.parent, ignore_errors=True)
