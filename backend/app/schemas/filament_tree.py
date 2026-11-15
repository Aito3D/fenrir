"""Pydantic schemas for /filament-trees."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

_TEXT_MAX = 200
_HEX_MAX = 32


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
    machines: list[str]
    nozzles: list[str]


class MigrateGroup(BaseModel):
    prefix: str = Field(min_length=1, max_length=_TEXT_MAX)
    source_preset_id: int
    machine: str = Field(min_length=1, max_length=_TEXT_MAX)
    nozzle: str = Field(min_length=1, max_length=_TEXT_MAX)


class MigrateRequest(BaseModel):
    groups: list[MigrateGroup] = Field(min_length=1)


class ConflictResolveRequest(BaseModel):
    tree_id: int
    machine: str
    nozzle: str
    color_id: int
    key: str = Field(min_length=1, max_length=_TEXT_MAX)
    value: Any


class CandidateRequest(BaseModel):
    orca_id: str = Field(min_length=1, max_length=_TEXT_MAX)
    name: str = Field(min_length=1, max_length=_TEXT_MAX)
    brand: str = Field(min_length=1, max_length=_TEXT_MAX)
    material: str = Field(min_length=1, max_length=_TEXT_MAX)
    color_name: str = Field(min_length=1, max_length=_TEXT_MAX)
    color_hex: str = Field(max_length=_HEX_MAX)
    machine: str = Field(min_length=1, max_length=_TEXT_MAX)
    nozzle: str = Field(min_length=1, max_length=_TEXT_MAX)


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
    set_values: dict[str, Any] = Field(default_factory=dict, alias="set")
    clear: list[str] = Field(default_factory=list)


class TreeUpdate(BaseModel):
    skip_02: bool | None = None
    source_color_id: int | None = None
    source_machine: str | None = None
    source_nozzle: str | None = None


class ColorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=_TEXT_MAX)
    hex: str = Field(default="", max_length=_HEX_MAX)


class ColorUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=_TEXT_MAX)
    hex: str | None = Field(default=None, max_length=_HEX_MAX)
