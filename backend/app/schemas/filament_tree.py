"""Pydantic schemas for /filament-trees."""

import re
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr

_TEXT_MAX = 200
_HEX_MAX = 32
_UNSAFE = re.compile(r"[/\\\x00-\x1f\x7f]|\.\.")


def _safe_name(value: str) -> str:
    # name parts end up in preset file names and zip entry names
    if _UNSAFE.search(value):
        raise ValueError("must not contain '/', '\\', '..' or control characters")
    return value


Name = Annotated[str, Field(min_length=1, max_length=_TEXT_MAX), AfterValidator(_safe_name)]
Part = Annotated[str, Field(min_length=1, max_length=32), AfterValidator(_safe_name)]  # machine / nozzle
# An Orca preset value: a scalar or a short list of scalars (e.g. ["246"], both extruders).
_Scalar = StrictStr | StrictInt | StrictFloat | StrictBool
PresetValue = _Scalar | Annotated[list[StrictStr | StrictInt | StrictFloat], Field(max_length=16)]
PresetKey = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-z0-9_]+$")]


class TreeSource(BaseModel):
    machine: str
    nozzle: str
    color_id: int | None


class TreeColor(BaseModel):
    id: int
    name: str
    hex: str


class TreeSummary(BaseModel):
    id: int
    name: str
    brand: str
    material: str
    skip_02: bool | None
    abrasive: bool
    source: TreeSource
    colors: list[TreeColor]
    # "root", "M", "M/N", "M/N/{color_id}", "color:{color_id}" -> number of own values at that node
    own_counts: dict[str, int]


class Targets(BaseModel):
    machines: list[Part] = Field(max_length=12)
    nozzles: list[Part] = Field(max_length=8)


class MigrateGroup(BaseModel):
    prefix: str = Field(min_length=1, max_length=_TEXT_MAX)
    source_preset_id: int
    machine: Part
    nozzle: Part


class MigrateRequest(BaseModel):
    groups: list[MigrateGroup] = Field(min_length=1)


class ConflictResolveRequest(BaseModel):
    tree_id: int
    machine: str
    nozzle: str
    color_id: int
    key: PresetKey
    value: PresetValue


class CandidateRequest(BaseModel):
    orca_id: str = Field(min_length=1, max_length=_TEXT_MAX)
    name: Name
    brand: Name
    material: Name
    color_name: Name
    color_hex: str = Field(max_length=_HEX_MAX)
    machine: Part
    nozzle: Part


class ExportRequest(BaseModel):
    tree_id: int | None = None


class NodeRow(BaseModel):
    key: str
    value: Any
    source: str  # root | machine | nozzle | colorwide | color | bambu
    own: bool
    inherited_value: Any = None
    inherited_source: str | None = None
    source_label: str | None = None  # the Bambu base preset name, for bambu rows


class NodeUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine: str | None = None
    nozzle: str | None = None
    color_id: int | None = None
    set_values: dict[PresetKey, PresetValue] = Field(default_factory=dict, alias="set", max_length=200)
    clear: list[PresetKey] = Field(default_factory=list, max_length=200)


class TreeUpdate(BaseModel):
    skip_02: bool | None = None
    source_color_id: int | None = None
    source_machine: Part | None = None
    source_nozzle: Part | None = None


class ColorCreate(BaseModel):
    name: Name
    hex: str = Field(default="", max_length=_HEX_MAX)


class ColorUpdate(BaseModel):
    name: Name
    hex: str | None = Field(default=None, max_length=_HEX_MAX)
