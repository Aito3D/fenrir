"""Pydantic schemas for /filament-trees."""

import re
from datetime import datetime
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
    spools: int = 0  # active inventory spools of this brand + material + colour name
    price: float | None = None  # filament_cost per kg, as the colour resolves it


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
    export_pending: int = 0  # leaves whose preset changed since the last Export for Orca


class Targets(BaseModel):
    machines: list[Part] = Field(max_length=12)
    nozzles: list[Part] = Field(max_length=8)
    # nozzles of one printer whose presets would be identical share one preset
    merge_nozzles: bool = False


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
    value: PresetValue | None  # None: keep Fenrir having no value for the key
    orca_value: PresetValue | None  # what Orca holds: always becomes the baseline


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
    changed_only: bool = False


class ExportConfirm(BaseModel):
    token: str


class OrcaCleanupRequest(BaseModel):
    names: list[str]  # the profiles the user saw in the preview and confirmed


class TreeCreate(BaseModel):
    brand: Name
    material: Name
    base_family: Name  # the Bambu preset family the leaves inherit, e.g. "Generic PETG"
    color_name: Name
    color_hex: str = Field(default="", max_length=_HEX_MAX)
    machine: Part
    nozzle: Part


class TreeDuplicate(BaseModel):
    name: Name
    brand: Name


class BulkNodeUpdate(BaseModel):
    """The same root / machine / nozzle-level write on several trees (colour ids differ per tree)."""

    model_config = ConfigDict(populate_by_name=True)

    tree_ids: list[int] = Field(min_length=1, max_length=200)
    machine: Part | None = None
    nozzle: Part | None = None
    set_values: dict[PresetKey, PresetValue] = Field(default_factory=dict, alias="set", max_length=200)
    clear: list[PresetKey] = Field(default_factory=list, max_length=200)


class TreeChange(BaseModel):
    id: int
    machine: str
    nozzle: str
    color_id: int
    key: str
    old_value: Any = None
    new_value: Any = None
    actor: str
    created_at: datetime


class NodeRow(BaseModel):
    key: str
    value: Any
    source: str  # root | machine | nozzle | colorwide | color | bambu
    own: bool
    inherited_value: Any = None
    inherited_source: str | None = None
    source_label: str | None = None  # the Bambu base preset name, for bambu rows
    variants: list[str] | None = None  # extruder variant of each entry, for per-variant arrays


class NodeUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    machine: Part | None = None
    nozzle: Part | None = None
    color_id: int | None = None
    set_values: dict[PresetKey, PresetValue] = Field(default_factory=dict, alias="set", max_length=200)
    clear: list[PresetKey] = Field(default_factory=list, max_length=200)


class TreeUpdate(BaseModel):
    brand: Name | None = None  # renames the tree (and every generated profile) to "<brand> <material>"
    material: Name | None = None
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
