"""Campaign-24 golden probe: the Projects-PDM backend's PURE rules.

Everything here is a deterministic function of its inputs — storage naming,
the printable-file rule, section guessing, project codes, tag normalisation
and suggestion ranking, re-slice naming, 3MF snapshot parsing and the
constants the routes read. These are exactly what a refactor churns, and none
of them is observable through the HTTP probe alone.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path("/tmp/fenrir-refactor-probe/pdm-rules-data").resolve()
shutil.rmtree(ROOT, ignore_errors=True)
ROOT.mkdir(parents=True)
os.environ["DATA_DIR"] = str(ROOT)  # project_storage.projects_root() = {DATA_DIR}/projects
sys.path.insert(0, ".")

from starlette.datastructures import UploadFile  # noqa: E402

from backend.app.schemas.project import ProjectTagRef  # noqa: E402
from backend.app.services import (  # noqa: E402
    aito_project_links,
    project_codes,
    project_files,
    project_filing,
    project_print_trace,
    project_reslice,
    project_snapshot,
    project_storage,
    project_tags,
)

out: dict = {}


def safe(fn):
    try:
        v = fn()
        return "__none__" if v is None else v
    except Exception as e:  # noqa: BLE001
        return {"__threw__": f"{type(e).__name__}: {e}"}


NAMES = [
    "support.3mf", "support.gcode.3mf", "SUPPORT.GCODE.3MF", "plate.gcode", "plate.BGCODE", "model.stl",
    "model.STEP", "scan.ply", "notes.pdf", "noext", ".3mf", " padded.3mf ", "a.b.c.3mf", "", "x.3mf.bak",
    "P-0042_support.3mf", "p-0007 bracket.gcode", "P-42_short.3mf", "P-0042-dash.stl", "P-0042support.3mf",
    "nc.nc", "tap.tap", "dxf.DXF", "weird.3MF ",
]

# --- project_storage ---------------------------------------------------------
st = out["project_storage"] = {}
st["constants"] = {
    "PROJECTS_DIRNAME": project_storage.PROJECTS_DIRNAME,
    "MAX_COMPONENT_CHARS": project_storage.MAX_COMPONENT_CHARS,
    "SECTION_DIRS": project_storage.SECTION_DIRS,
    "TRASH_DIRNAME": project_storage.TRASH_DIRNAME,
    "ENABLED_SECTIONS": list(project_storage.ENABLED_SECTIONS),
    "PRINTABLE_EXTENSIONS": list(project_storage.PRINTABLE_EXTENSIONS),
    "WINDOWS_RESERVED": sorted(project_storage._WINDOWS_RESERVED),
}
st["slugify"] = {t: safe(lambda t=t: project_storage.slugify(t)) for t in [
    "Support caméra FX3", "  ", "", "Émile & Zoë – pièce n°3", "a" * 60, "---x---", "ÀÉÎÕÜ", "日本語 title", "P-0042"]}
st["slugify_max8"] = project_storage.slugify("Support caméra FX3", max_chars=8)
st["sanitize_component"] = {t: safe(lambda t=t: project_storage.sanitize_component(t)) for t in [
    "Pièce", " .hidden. ", "a/b\\c:d*e?f\"g<h>i|j", "CON", "con.txt", "LPT1.gcode", "nul", "", "   ", "..",
    "x" * 150, "tab\tnew\nline", "ends with dot.", "ends with space ", "NFD é", "ok name (2)"]}
st["sanitize_fallback"] = project_storage.sanitize_component("", fallback="fichier")
st["storage_dir_name"] = {c: project_storage.storage_dir_name(c, "Support caméra") for c in ["P-0001", "P-0042", "P-123456"]}
st["is_printable_filename"] = {n: project_storage.is_printable_filename(n) for n in NAMES}
st["_split_extension"] = {n: list(project_storage._split_extension(n)) for n in NAMES + ["archive.tar.gz", "x.verylongextensionnamehere", "x.ok+ext", "x.a-b", ".gcode.3mf"]}
st["_fit_name"] = {
    "short": project_storage._fit_name("stem", " (2)", ".3mf"),
    "long": project_storage._fit_name("s" * 200, " (12)", ".gcode.3mf"),
    "empty": project_storage._fit_name("", " (2)", ".3mf"),
    "dots": project_storage._fit_name("a" * 97 + " ..", " (2)", ".3mf"),
}
d = Path(tempfile.mkdtemp(dir=ROOT))
(d / "a.3mf").write_bytes(b"")
(d / "a (2).3mf").write_bytes(b"")
(d / "b.gcode.3mf").write_bytes(b"")
st["unique_file_path"] = {n: project_storage.unique_file_path(d, n).name for n in ["a.3mf", "b.gcode.3mf", "c.3mf", "x" * 150 + ".3mf", "CON.3mf", "../../evil.3mf"]}
claimed = [project_storage.claim_unique_file_path(d, "a.3mf").name for _ in range(3)]
st["claim_unique_file_path_sequence"] = claimed
st["claimed_exist"] = [(d / c).exists() for c in claimed]


class _P:
    def __init__(self, id, code, name, storage_dir=None):
        self.id, self.code, self.name, self.storage_dir = id, code, name, storage_dir


p = _P(7, "P-0007", "Support caméra")
st["ensure_project_dir"] = str(project_storage.ensure_project_dir(p).relative_to(ROOT))
st["storage_dir_assigned"] = p.storage_dir
legacy = _P(9, None, "Vieux projet")
st["ensure_project_dir_no_code"] = str(project_storage.ensure_project_dir(legacy).relative_to(ROOT))
st["item_dir"] = str(project_storage.item_dir(p, "impression", "Pièce/une").relative_to(ROOT))
st["item_dir_unknown_section"] = safe(lambda: str(project_storage.item_dir(p, "nope", "x")))
rd = project_storage.revision_dir(p, "impression", "Pièce", 3)
st["revision_dir"] = str(rd.relative_to(ROOT))
st["revision_dir_exists"] = rd.exists()
(rd / "plate.gcode.3mf").write_bytes(b"x")
trashed = project_storage.move_to_trash(p, rd / "plate.gcode.3mf")
st["move_to_trash_file"] = str(trashed.relative_to(ROOT)) if trashed else None
trashed_dir = project_storage.move_to_trash(p, rd)
st["move_to_trash_dir"] = str(trashed_dir.relative_to(ROOT)) if trashed_dir else None
st["move_to_trash_missing"] = safe(lambda: project_storage.move_to_trash(p, rd / "gone.3mf"))
st["move_to_trash_outside"] = safe(lambda: project_storage.move_to_trash(p, ROOT / "elsewhere"))
st["move_to_trash_root"] = safe(lambda: project_storage.move_to_trash(p, project_storage.ensure_project_dir(p)))
st["resolve_in_projects_traversal"] = safe(lambda: str(project_storage.resolve_in_projects("..", "x")))

# --- project_codes -----------------------------------------------------------
pc = out["project_codes"] = {"CODE_COUNTER_KEY": project_codes.CODE_COUNTER_KEY}
pc["format"] = {n: project_codes.format_project_code(n) for n in [0, 1, 42, 9999, 10000, 123456]}
pc["parse"] = {c: safe(lambda c=c: project_codes.parse_project_code(c)) for c in ["P-0042", "P-42", "p-0042", "P-", "0042", "", None, "P-0042_x", " P-0042", "P-00000"]}

# --- project_filing ----------------------------------------------------------
pf = out["project_filing"] = {
    "DROP_SECTIONS": {k: list(v) for k, v in project_filing._DROP_SECTIONS.items()},
    "SIMILAR_ITEM_THRESHOLD": project_filing.SIMILAR_ITEM_THRESHOLD,
    "SIMILAR_PROJECT_THRESHOLD": project_filing.SIMILAR_PROJECT_THRESHOLD,
    "AUTO_FILE_SETTING_KEY": project_filing.AUTO_FILE_SETTING_KEY,
    "RETRYABLE_SKIPS": list(project_filing._RETRYABLE_SKIPS),
}
pf["section_for_filename"] = {n: project_filing.section_for_filename(n) for n in NAMES}
pf["item_name_for_filename"] = {n: project_filing.item_name_for_filename(n) for n in NAMES}
pf["project_code_from_filename"] = {n: project_filing.project_code_from_filename(n) for n in NAMES}
pf["_name_without_code"] = {n: project_filing._name_without_code(n) for n in NAMES}

# --- project_tags ------------------------------------------------------------
pt = out["project_tags"] = {"MAX_TAG_CHARS": project_tags.MAX_TAG_CHARS, "MAX_SUGGESTIONS": project_tags.MAX_SUGGESTIONS, "MAX_NEW_SUGGESTIONS": project_tags.MAX_NEW_SUGGESTIONS}
TAGS = ["Drone", " drone ", "pièce, auto", "", ",", "x" * 70, "A,B,C", "É́"]
pt["tag_name_key"] = {t: project_tags.tag_name_key(t) for t in TAGS}
pt["clean_tag_name"] = {t: project_tags.clean_tag_name(t) for t in TAGS}
pt["split_tag_string"] = {s: project_tags.split_tag_string(s) for s in ["drone,, Drone , pièce auto,", "", None, " , ", "a,A,b,B,a", "x" * 70 + ",y"]}
pt["tag_mirror"] = {json.dumps(l): project_tags.tag_mirror(l) for l in [[], ["b", "A", "c"], ["Zed", "alpha"], ["dup", "Dup"]]}
cat = {project_tags.tag_name_key(n): ProjectTagRef(id=i, name=n) for i, n in [(1, "Drone"), (2, "Caméra"), (3, "Support")]}
pt["rank_tag_suggestions"] = {
    json.dumps([raw, sorted(ex)]): [s.model_dump() for s in project_tags.rank_tag_suggestions(raw, cat, set(ex))]
    for raw, ex in [
        (["drone", "camera", "new one", "another", "third new", "support"], []),
        (["DRONE", "Drone", "support"], [1]),
        (["n1", "n2", "n3", "Caméra"], []),
        ([], []),
        (["", " ,", "a,b"], []),
        (["Support", "drone", "caméra", "n1", "n2", "n3"], [2]),
    ]
}

# --- project_reslice ---------------------------------------------------------
pr = out["project_reslice"] = {}
pr["is_resliceable"] = {n: project_reslice.is_resliceable(n) for n in NAMES}
pr["output_filename"] = {n: project_reslice.output_filename(n) for n in NAMES}
pr["reslice_note"] = project_reslice.reslice_note(3, "PLA rapide")

# --- project_files guards + error type --------------------------------------
pfs = out["project_files"] = {"STL_THUMBNAIL_MAX_BYTES": project_files.STL_THUMBNAIL_MAX_BYTES, "USAGE_COLUMNS": [str(c) for c in project_files._USAGE_COLUMNS]}
pfs["require_enabled_section"] = {}
for s in ["impression", "scan", "modelisation", "usinage", "docs", "nope"]:
    try:
        project_files.require_enabled_section(s)
        pfs["require_enabled_section"][s] = "ok"
    except project_files.ProjectFilesError as e:
        pfs["require_enabled_section"][s] = [e.status_code, e.detail]
pfs["require_printable_uploads"] = {}
for names in [["a.3mf"], ["a.3mf", "b.stl"], ["b.stl"], [], ["c.gcode.3mf", "d.bgcode", "e.GCODE"]]:
    ups = [UploadFile(io.BytesIO(b""), filename=n) for n in names]
    try:
        project_files.require_printable_uploads(ups)
        pfs["require_printable_uploads"][json.dumps(names)] = "ok"
    except project_files.ProjectFilesError as e:
        pfs["require_printable_uploads"][json.dumps(names)] = [e.status_code, e.detail]
e = project_files.ProjectFilesError(409, "busy")
pfs["error_attrs"] = {"status_code": e.status_code, "detail": e.detail, "str": str(e), "stored_count": getattr(e, "stored_count", "__absent__")}

# --- project_print_trace / aito_project_links constants ----------------------
out["project_print_trace"] = {"QUEUED_KIND": project_print_trace.QUEUED_KIND, "TASK_UNUSABLE": project_print_trace.TASK_UNUSABLE, "QUEUED_STATUSES": list(project_print_trace._QUEUED_STATUSES)}
out["aito_project_links"] = {"SIMILAR_TITLE_THRESHOLD": aito_project_links.SIMILAR_TITLE_THRESHOLD, "SECTION_SUMMARY_LIMIT": aito_project_links.SECTION_SUMMARY_LIMIT, "DROP_SECTION": aito_project_links.DROP_SECTION}
le = aito_project_links.LinkError(409, "conflict")
out["aito_project_links"]["LinkError"] = {"status_code": le.status_code, "detail": le.detail, "str": str(le)}

# --- project_snapshot --------------------------------------------------------
sn = out["project_snapshot"] = {"MAX_PART_BYTES": project_snapshot._MAX_PART_BYTES, "MODEL_HEAD_BYTES": project_snapshot._MODEL_HEAD_BYTES}
sn["is_3mf"] = {n: project_snapshot.is_3mf(n) for n in NAMES}
CONFIG = {
    "printer_model": "Bambu Lab X1 Carbon", "printer_settings_id": "X1C 0.4 nozzle", "print_settings_id": "0.20mm Standard",
    "filament_settings_id": ["Bambu PLA Basic", "Generic PETG"], "filament_type": ["PLA", "PETG"], "nozzle_diameter": ["0.4"],
    "layer_height": "0.2", "version": "01.09.00.70", "unrelated": {"nested": [1, 2]},
}


def zip_bytes(parts: dict[str, bytes]) -> Path:
    path = Path(tempfile.mkstemp(dir=ROOT, suffix=".3mf")[1])
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in parts.items():
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return path


MODEL = b'<?xml version="1.0"?><model><metadata name="Application">BambuStudio-01.10.01.50</metadata></model>'
MODEL_NODASH = b'<model><metadata name="Application">OrcaSlicer</metadata></model>'
SLICE = b'<config><header><header_item key="X-BBL-Client-Version" value="02.00.00.11"/></header></config>'
CASES = {
    "full_sliced": {"Metadata/project_settings.config": json.dumps(CONFIG).encode(), "Metadata/slice_info.config": SLICE, "3D/3dmodel.model": MODEL, "Metadata/plate_1.gcode": b"G28"},
    "full_unsliced": {"Metadata/project_settings.config": json.dumps(CONFIG).encode(), "3D/3dmodel.model": MODEL},
    "no_config": {"3D/3dmodel.model": MODEL},
    "config_not_dict": {"Metadata/project_settings.config": b"[1,2]", "3D/3dmodel.model": MODEL},
    "config_empty_dict": {"Metadata/project_settings.config": b"{}"},
    "config_bad_json": {"Metadata/project_settings.config": b"{nope"},
    "app_no_dash_version_from_slice": {"3D/3dmodel.model": MODEL_NODASH, "Metadata/slice_info.config": SLICE},
    "version_from_config_only": {"Metadata/project_settings.config": json.dumps({"version": 7, "layer_height": "0.12"}).encode()},
    "scalar_filament": {"Metadata/project_settings.config": json.dumps({"filament_settings_id": "Solo", "filament_type": "PLA", "nozzle_diameter": "0.6"}).encode()},
    "empty_values": {"Metadata/project_settings.config": json.dumps({"printer_model": "", "layer_height": None, "filament_type": []}).encode()},
    "empty_zip": {},
    "gcode_plate_only": {"Metadata/plate_2.gcode": b"", "Metadata/plate_x.gcode.md5": b""},
}
sn["read_print_snapshot"] = {}
for name, parts in CASES.items():
    snap = project_snapshot.read_print_snapshot(zip_bytes(parts))
    sn["read_print_snapshot"][name] = None if snap is None else snap.__dict__
bad = Path(tempfile.mkstemp(dir=ROOT, suffix=".3mf")[1])
bad.write_bytes(b"not a zip at all")
sn["read_print_snapshot"]["not_a_zip"] = project_snapshot.read_print_snapshot(bad)
sn["read_print_snapshot"]["missing_file"] = project_snapshot.read_print_snapshot(ROOT / "nope.3mf")
sn["PrintSnapshot_fields"] = list(project_snapshot.PrintSnapshot.__dataclass_fields__) if hasattr(project_snapshot.PrintSnapshot, "__dataclass_fields__") else sorted(vars(project_snapshot.PrintSnapshot))

print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
