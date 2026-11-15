"""Per-plate facts of a Bambu Studio project .3mf and its slice (Aito import, design 2026-11-14)."""

import io
import json
import zipfile

import pytest

from backend.app.services.aito_3mf_import import (
    ALREADY_SLICED,
    NO_SETTINGS,
    Import3mfError,
    check_importable,
    plate_facts,
)

NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"'
IDENTITY = "1 0 0 0 1 0 0 0 1 0 0 0"
ROT_Z_90 = "0 1 0 -1 0 0 0 0 1 0 0 0"  # row vectors: (x, y, z) -> (-y, x, z)
PNG = b"\x89PNG\r\n\x1a\nfake"


def make_3mf(entries: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return buf.getvalue()


def box_model(x: float, y: float, z: float) -> str:
    """One object (id 1): the eight corners of an x*y*z box, one triangle so the mesh counts."""
    corners = [(cx, cy, cz) for cx in (0, x) for cy in (0, y) for cz in (0, z)]
    vertices = "".join(f'<vertex x="{a}" y="{b}" z="{c}"/>' for a, b, c in corners)
    return (
        f'<model {NS}><resources><object id="1" type="model"><mesh><vertices>{vertices}</vertices>'
        '<triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources></model>'
    )


def root_model(objects: dict[int, list[str]], items: list[tuple[int, str]]) -> str:
    """``objects``: id -> component transforms (each places the box); ``items``: (objectid, transform)."""
    res = "".join(
        f'<object id="{oid}" type="model"><components>'
        + "".join(f'<component p:path="/3D/Objects/object_1.model" objectid="1" transform="{t}"/>' for t in comps)
        + "</components></object>"
        for oid, comps in objects.items()
    )
    build = "".join(f'<item objectid="{oid}" transform="{t}" printable="1"/>' for oid, t in items)
    return f"<model {NS}><resources>{res}</resources><build>{build}</build></model>"


def model_settings(names: dict[int, str], plates: list[tuple[int, str, list[int]]]) -> str:
    objs = "".join(f'<object id="{oid}"><metadata key="name" value="{n}"/></object>' for oid, n in names.items())
    out = ""
    for plater_id, plater_name, object_ids in plates:
        instances = "".join(
            f'<model_instance><metadata key="object_id" value="{oid}"/><metadata key="instance_id" value="0"/>'
            "</model_instance>"
            for oid in object_ids
        )
        out += (
            f'<plate><metadata key="plater_id" value="{plater_id}"/>'
            f'<metadata key="plater_name" value="{plater_name}"/>{instances}</plate>'
        )
    return f"<config>{objs}{out}</config>"


def slice_info(plates: list[tuple[int, int, float, list[tuple[int, str, str, float]]]]) -> str:
    out = ""
    for index, prediction, weight, filaments in plates:
        rows = "".join(f'<filament id="{i}" type="{t}" color="{c}" used_g="{g}"/>' for i, t, c, g in filaments)
        out += (
            f'<plate><metadata key="index" value="{index}"/><metadata key="printer_model_id" value="BL-P001"/>'
            f'<metadata key="prediction" value="{prediction}"/><metadata key="weight" value="{weight}"/>{rows}</plate>'
        )
    return f"<config>{out}</config>"


def source(objects, items, names, plates, **extra) -> bytes:
    return make_3mf(
        {
            "3D/3dmodel.model": root_model(objects, items),
            "3D/Objects/object_1.model": box_model(10, 20, 30),
            "Metadata/model_settings.config": model_settings(names, plates),
            "Metadata/project_settings.config": "{}",
            **extra,
        }
    )


def sliced(plates) -> bytes:
    return make_3mf(
        {
            "Metadata/slice_info.config": slice_info(plates),
            "Metadata/project_settings.config": json.dumps({"filament_vendor": ["SUNLU", "Bambu Lab"]}),
            "Metadata/plate_1.gcode": "G1",
        }
    )


TWO_FILAMENTS = [(1, "PETG", "#000000", 70.0), (2, "PLA", "#FFFFFF", 6.62)]
SOURCE = source(
    {2: [IDENTITY], 3: [IDENTITY]},
    [(2, IDENTITY), (3, "1 0 0 0 1 0 0 0 1 50 0 0")],
    {2: "marteau.stl", 3: "marteau.stl"},
    [(1, "Marteaux", [2, 3])],
    **{"Metadata/plate_1_small.png": PNG},
)
SLICED = sliced([(1, 21955, 76.62, TWO_FILAMENTS)])


def test_sliced_upload_is_refused():
    with pytest.raises(Import3mfError) as e:
        check_importable(make_3mf({"Metadata/plate_1.gcode": "G1", "Metadata/project_settings.config": "{}"}))
    assert (e.value.status_code, e.value.detail) == (400, ALREADY_SLICED)


def test_plain_cad_export_is_refused():
    with pytest.raises(Import3mfError) as e:
        check_importable(make_3mf({"3D/3dmodel.model": "<model/>"}))
    assert (e.value.status_code, e.value.detail) == (400, NO_SETTINGS)


def test_not_a_zip_is_refused():
    with pytest.raises(Import3mfError) as e:
        check_importable(b"hello")
    assert (e.value.status_code, e.value.detail) == (400, NO_SETTINGS)


def test_project_file_is_importable():
    check_importable(SOURCE)


def test_plate_takes_time_weight_and_filaments_from_the_slice():
    p = plate_facts(SOURCE, SLICED)[0]
    assert (p["index"], p["name"], p["print_time_seconds"], p["weight_g"], p["printer_model"]) == (
        1,
        "Marteaux",
        21955,
        76.62,
        "X1C",
    )
    assert p["filaments"] == [
        {"type": "PETG", "color": "#000000", "used_g": 70.0, "vendor": "SUNLU"},
        {"type": "PLA", "color": "#FFFFFF", "used_g": 6.62, "vendor": "Bambu Lab"},
    ]


def test_identical_instances_group_with_dimensions():
    assert plate_facts(SOURCE, SLICED)[0]["objects"] == [
        {"name": "marteau", "count": 2, "x_mm": 10, "y_mm": 20, "z_mm": 30}
    ]


def test_rotated_instance_reports_its_footprint_as_placed():
    src = source(
        {2: [IDENTITY], 3: [IDENTITY]},
        [(2, IDENTITY), (3, ROT_Z_90)],
        {2: "marteau.stl", 3: "marteau.stl"},
        [(1, "", [2, 3])],
    )
    assert plate_facts(src, SLICED)[0]["objects"] == [
        {"name": "marteau", "count": 1, "x_mm": 10, "y_mm": 20, "z_mm": 30},
        {"name": "marteau", "count": 1, "x_mm": 20, "y_mm": 10, "z_mm": 30},
    ]


def test_multi_part_object_is_measured_as_a_whole():
    src = source(
        {2: [IDENTITY, "1 0 0 0 1 0 0 0 1 10 0 0"]},
        [(2, IDENTITY)],
        {2: "Assemblage.STEP"},
        [(1, "", [2])],
    )
    assert plate_facts(src, SLICED)[0]["objects"] == [
        {"name": "Assemblage", "count": 1, "x_mm": 20, "y_mm": 20, "z_mm": 30}
    ]


def test_empty_plate_between_filled_plates():
    src = source(
        {2: [IDENTITY], 3: [IDENTITY]},
        [(2, IDENTITY), (3, IDENTITY)],
        {2: "a.stl", 3: "b.stl"},
        [(1, "", [2]), (2, "", []), (3, "", [3])],
    )
    facts = plate_facts(src, sliced([(1, 600, 5.0, TWO_FILAMENTS[:1]), (3, 3300, 12.9, TWO_FILAMENTS[:1])]))
    assert [p["index"] for p in facts] == [1, 2, 3]
    assert (facts[1]["print_time_seconds"], facts[1]["weight_g"], facts[1]["objects"], facts[1]["filaments"]) == (
        None,
        None,
        [],
        [],
    )
    assert facts[2]["print_time_seconds"] == 3300
    assert facts[2]["objects"][0]["name"] == "b"


def test_unnamed_plate_has_no_name():
    src = source({2: [IDENTITY]}, [(2, IDENTITY)], {2: "a.stl"}, [(1, "  ", [2])])
    assert plate_facts(src, SLICED)[0]["name"] is None


def test_unreadable_geometry_keeps_the_plate():
    src = make_3mf(
        {
            "Metadata/model_settings.config": model_settings({2: "marteau.stl", 3: "marteau.stl"}, [(1, "", [2, 3])]),
            "Metadata/project_settings.config": "{}",
        }
    )
    assert plate_facts(src, SLICED)[0]["objects"] == [
        {"name": "marteau", "count": 2, "x_mm": None, "y_mm": None, "z_mm": None}
    ]


def test_thumbnail_is_a_data_url():
    assert plate_facts(SOURCE, SLICED)[0]["thumbnail"] == "data:image/png;base64,iVBORw0KGgpmYWtl"


def test_missing_thumbnail_is_none():
    src = source({2: [IDENTITY]}, [(2, IDENTITY)], {2: "a.stl"}, [(1, "", [2])])
    assert plate_facts(src, SLICED)[0]["thumbnail"] is None
