"""Pins the shared project/item name validator used by the four PDM name schemas."""

import pytest
from pydantic import ValidationError

from backend.app.schemas.aito_project_links import TaskCreateProjectRequest
from backend.app.schemas.project_files import ProjectItemCreate, ProjectItemFork, ProjectItemRename

CASES = [
    (ProjectItemCreate, {"section": "scan"}),
    (ProjectItemRename, {}),
    (ProjectItemFork, {"revision_id": 1}),
    (TaskCreateProjectRequest, {}),
]


@pytest.mark.parametrize(("model", "extra"), CASES)
@pytest.mark.parametrize("blank", ["", "   ", "\t\n "])
def test_blank_name_is_rejected_with_the_shared_message(model, extra, blank):
    with pytest.raises(ValidationError) as exc:
        model(name=blank, **extra)
    errors = exc.value.errors()
    assert len(errors) == 1
    assert errors[0]["loc"] == ("name",)
    assert errors[0]["type"] == "value_error"
    assert errors[0]["msg"] == "Value error, name must not be blank"


@pytest.mark.parametrize(("model", "extra"), CASES)
def test_valid_name_is_stripped(model, extra):
    assert model(name="  Support moteur  ", **extra).name == "Support moteur"
    assert model(name="X", **extra).name == "X"
