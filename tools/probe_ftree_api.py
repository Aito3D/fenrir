"""Filament-tree campaign (F1) golden probe: every /filament-trees route, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport (auth disabled) against the
app's own engine, which probe_ftree_lib points at a throw-away temp folder BEFORE the
app is imported. Nothing reaches the network: the Orca Cloud service behind /sync and
/candidates (``routes.filament_trees._build_authenticated_service``, the seam the tests
stub too) is a local stub. The Bambu base presets are real JSON files in a temp bundle
folder (``settings.bambu_studio_bundle_dir``), so the base reader runs unpatched.

Every step prints: label, method + path + query, the request body, the status code and
the JSON body (timestamps scrubbed). ``dump`` checkpoints print the rows of the filament
tree tables and the generated filament_presets (name + content digest; full content at
some checkpoints).

Parts: A empty state · B create · C colours · D nodes (get/put at every level, refusals)
· E history + revert · F patch (skip_02, source, rename) · G duplicate + bulk · H targets
· I unmanaged / migrate / managed-preset lock · J export · K sync + conflicts
· L candidates · M delete.
"""

import asyncio
import hashlib
import io
import json
import os
import sys
import zipfile
from unittest.mock import patch

sys.path.insert(0, "tools")
import probe_ftree_lib as lib  # noqa: E402  (temp DATA_DIR before the app is imported)

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import select  # noqa: E402

from backend.app.api.routes import filament_trees as routes  # noqa: E402
from backend.app.core.config import settings  # noqa: E402
from backend.app.core.database import async_session  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.models.filament_profile import BaseFilamentPreset, FilamentPreset  # noqa: E402
from backend.app.models.filament_tree import (  # noqa: E402
    FilamentTree,
    FilamentTreeChange,
    FilamentTreeColor,
    FilamentTreeLeaf,
    FilamentTreeOverride,
    FilamentTreeSnapshot,
)
from backend.app.models.settings import Settings  # noqa: E402
from backend.app.models.spool import Spool  # noqa: E402
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError  # noqa: E402

API = "/api/v1/filament-trees"
PROFILES = "/api/v1/filament-profiles"
TS_KEYS = {"created_at", "updated_at", "exported_at"}


def sha(text) -> str:
    return f"<{len(text)} chars sha256={hashlib.sha256(text.encode()).hexdigest()[:12]}>"


def scrub(v):
    if isinstance(v, dict):
        return {k: ("<ts>" if k in TS_KEYS and v[k] else scrub(v[k])) for k in v}
    if isinstance(v, list):
        return [scrub(x) for x in v]
    return v


def show(v) -> str:
    return json.dumps(v, indent=1, sort_keys=True, ensure_ascii=False)


class Client:
    def __init__(self, c: AsyncClient):
        self.c = c
        self.token = None  # X-Export-Token of the last zip response

    async def __call__(self, label, method, path, json_body=None, **params):
        params = {k: v for k, v in params.items() if v is not None}
        r = await self.c.request(method, path, json=json_body, params=params or None)
        query = "?" + "&".join(f"{k}={v}" for k, v in params.items()) if params else ""
        print(f"### {label}\n{method} {path}{query}" + (f"  body={json.dumps(json_body, sort_keys=True).replace(self.token or chr(0), "<token>")}" if json_body is not None else ""))
        print(f"-> {r.status_code}")
        if r.headers.get("content-type", "").startswith("application/zip"):
            print("content-disposition:", r.headers.get("content-disposition"))
            self.token = r.headers["x-export-token"]
            with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
                for name in sorted(zf.namelist()):
                    raw = zf.read(name).decode()
                    print(f"zip member {name!r} {sha(raw)} date={zf.getinfo(name).date_time}")
                    print(show(json.loads(raw)))
                print(f"zip members: {len(zf.namelist())}")
        else:
            try:
                print(show(scrub(r.json())))
            except ValueError:
                print(repr(r.text[:500]))
        return r


def row(obj) -> dict:
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


async def dump(label, full=False):
    """The filament tree tables + generated presets, as the database holds them."""
    print(f"### DUMP {label}")
    async with async_session() as db:
        for model in (FilamentTree, FilamentTreeColor, FilamentTreeOverride, FilamentTreeLeaf, FilamentTreeChange, FilamentTreeSnapshot):
            rows = (await db.execute(select(model).order_by(model.id))).scalars().all()
            print(f"-- {model.__tablename__} ({len(rows)})")
            for r in rows:
                d = row(r)
                for k in TS_KEYS & d.keys():
                    d[k] = "<ts>" if d[k] else None
                if d.get("baseline_content"):
                    d["baseline_content"] = sha(d["baseline_content"])
                if "payload" in d:
                    d["payload"] = [{**p, "content": sha(p["content"])} for p in json.loads(d["payload"])]
                print(json.dumps(d, sort_keys=True, ensure_ascii=False, default=str))
        rows = (await db.execute(select(FilamentPreset).order_by(FilamentPreset.id))).scalars().all()
        print(f"-- filament_presets ({len(rows)})")
        for r in rows:
            d = {k: v for k, v in row(r).items() if k not in TS_KEYS}
            content = d.pop("content")
            d["content"] = sha(content)
            print(json.dumps(d, sort_keys=True, ensure_ascii=False))
            if full:
                print(show(json.loads(content)))
        rows = (await db.execute(select(Settings).where(Settings.key.like("filament_tree%")).order_by(Settings.key))).scalars().all()
        print("-- settings:", json.dumps({r.key: r.value for r in rows}, sort_keys=True))


async def preset_content(name: str) -> dict:
    async with async_session() as db:
        return json.loads((await db.execute(select(FilamentPreset.content).where(FilamentPreset.name == name))).scalar_one())


class StubOrca:
    """Stands in for OrcaCloudService: canned profiles, optional failure, records close()."""

    def __init__(self):
        self.entries: list = []
        self.fail: Exception | None = None
        self.calls: list[str] = []

    async def list_profiles(self):
        self.calls.append("list_profiles")
        if self.fail:
            raise self.fail
        return self.entries

    async def get_profile(self, profile_id):
        self.calls.append(f"get_profile({profile_id})")
        if self.fail:
            raise self.fail
        return next((e for e in self.entries if e.get("id") == profile_id), "not a dict")

    async def introspect(self):
        # read-only pairing: SYNC pulls, and the push reports needs_write_scope without sending anything
        self.calls.append("introspect")
        return {"scope": "external_app:connect sync:read"}

    async def push_profile(self, **kw):
        self.calls.append(f"push_profile({kw.get('name')})")
        return {"updated_time": 2}

    async def delete_profiles(self, ids):
        self.calls.append(f"delete_profiles({len(ids)})")

    async def close(self):
        self.calls.append("close")


BUNDLE = {
    "Generic PETG @base": ("generic-petg-base.json", "", {"type": "filament", "nozzle_temperature": ["240"], "cool_plate_temp": ["35"], "filament_max_volumetric_speed": ["12"], "filament_cost": ["20"]}),
    "Generic PETG @BBL H2S": ("generic-petg-h2s.json", "Generic PETG @base", {"hot_plate_temp": ["70"], "setting_id": "GFSG99"}),
    "Generic PETG @BBL H2S 0.4 nozzle": ("generic-petg-h2s-04.json", "Generic PETG @BBL H2S", {"fan_min_speed": ["20"], "filament_max_volumetric_speed": ["16"]}),
    "Bambu PETG Basic @base": ("bambu-petg-base.json", "", {"fan_max_speed": ["90"], "cool_plate_temp": ["0"]}),
    "Bambu PETG Basic @BBL H2S": ("bambu-petg-h2s.json", "Bambu PETG Basic @base", {"filament_start_gcode": ["; base start"], "textured_plate_temp": ["70"]}),
    "Bambu PLA Basic @BBL H2S": ("bambu-pla-h2s.json", "", {"nozzle_temperature": ["220"]}),
}
COMPAT = [f"Bambu Lab {m} 0.4 nozzle" for m in ("H2S", "H2D", "H2C", "X2D")]


def flat_preset(name, color, hex_, inherits="Bambu PETG Basic @BBL H2S", k="0.035", **extra):
    content = {
        "name": name, "inherits": inherits, "from": "User", "version": "2.4.0.8", "filament_settings_id": [name], "compatible_printers": COMPAT,
        "filament_start_gcode": [f"M900 L1000 M10\nM900 K{k}"], "filament_max_volumetric_speed": ["24"], "nozzle_temperature": ["245"], **extra,
    }
    brand, material = name.split(" - ")[0].split(" ", 1) if " " in name.split(" - ")[0] else (name, "")
    return FilamentPreset(name=name, brand=brand, material=material, color=color, color_hex=hex_, filename=f"{name}.json", content=json.dumps(content, indent=4))


async def seed():
    bundle = os.path.join(lib.ROOT, "bundle")
    os.makedirs(bundle)
    settings.bambu_studio_bundle_dir = bundle
    async with async_session() as db:
        for name, (filename, inherits, values) in BUNDLE.items():
            with open(os.path.join(bundle, filename), "w") as f:
                json.dump({"name": name, **({"inherits": inherits} if inherits else {}), **values}, f)
            db.add(BaseFilamentPreset(name=name, inherits=inherits, filename=filename))
        for p in [
            flat_preset("Polymaker PETG - Black", "Black", "#000000", nozzle_temperature=["250"]),
            flat_preset("Polymaker PETG - Red", "Red", "#FF0000", k="0.05", fan_max_speed=["60"]),
            flat_preset("Polymaker PETG - White", "White", "#FFFFFF", fan_max_speed=["60"]),
            flat_preset("Mixed PLA - A", "A", "#111111", inherits="Bambu PLA Basic @BBL H2S"),
            flat_preset("Mixed PLA - B", "B", "#222222"),
            flat_preset("Unindexed ABS - White", "White", "#FFFFFF", inherits="Bambu ABS @BBL H2S"),
            flat_preset("Loose", "", ""),
        ]:
            db.add(p)
            await db.flush()  # ids in this order
        db.add_all([
            Spool(material="PETG", brand="Acme", color_name="White"),
            Spool(material="PETG", brand="acme", color_name="WHITE", subtype="Matte"),
            Spool(material="PETG", brand="Acme", color_name="Red", archived_at=__import__("datetime").datetime(2026, 1, 1)),
            Spool(material="PETG", brand="Other", color_name="White"),
        ])
        await db.commit()


async def main() -> None:
    await lib.create_schema()
    await seed()
    orca = StubOrca()

    async def build(_db, _user, **_kw):
        return orca

    with patch.object(routes, "_build_authenticated_service", build):
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test") as raw:
            c = Client(raw)
            # === A: empty state ====================================================================
            await c("A01 list empty", "GET", API)
            await c("A02 targets default", "GET", f"{API}/targets")
            await c("A03 unmanaged groups", "GET", f"{API}/unmanaged")
            await c("A04 export nothing", "POST", f"{API}/export", {})
            await c("A05 history of unknown tree", "GET", f"{API}/999/history")
            await dump("A seeded", full=False)

            # === B: create =========================================================================
            create = {"brand": "Acme", "material": "PETG", "base_family": "Generic PETG", "color_name": "White", "color_hex": "#FFFFFF", "machine": "H2S", "nozzle": "0.4"}
            r = await c("B01 create", "POST", API, create)
            t1 = r.json()["tree_id"]
            await c("B02 create same name refused", "POST", API, create)
            await c("B03 create on a non-target machine refused", "POST", API, {**create, "brand": "Nope", "machine": "A1"})
            await c("B04 create unsafe name 422", "POST", API, {**create, "brand": "a/b"})
            await c("B05 create abrasive at 0.2 refused", "POST", API, {**create, "material": "PA6-CF", "nozzle": "0.2"})
            r = await c("B06 list", "GET", API)
            white = r.json()[0]["colors"][0]["id"]
            await dump("B after create", full=True)

            # === H (early): targets, so later dumps stay small =====================================
            await c("H01 targets: nozzle format refused", "PUT", f"{API}/targets", {"machines": ["H2S"], "nozzles": ["04"]})
            await c("H02 targets: empty list refused", "PUT", f"{API}/targets", {"machines": [], "nozzles": ["0.4"]})
            await c("H03 targets: blank entry refused", "PUT", f"{API}/targets", {"machines": [" "], "nozzles": ["0.4"]})
            await c("H04 targets: source machine must stay", "PUT", f"{API}/targets", {"machines": ["H2D"], "nozzles": ["0.4"]})
            await c("H05 targets: too many 422", "PUT", f"{API}/targets", {"machines": ["m"] * 13, "nozzles": ["0.4"]})
            await c("H06 targets: padded names (source check runs on the unstripped payload)", "PUT", f"{API}/targets", {"machines": [" H2S", "H2D "], "nozzles": ["0.2", "0.4", "0.6"]})
            await c("H07 targets: shrink", "PUT", f"{API}/targets", {"machines": ["H2S", "H2D "], "nozzles": ["0.2", "0.4", "0.6"]})
            await c("H08 targets get", "GET", f"{API}/targets")
            await dump("H after targets shrink")

            # === C: colours ========================================================================
            r = await c("C01 add colour Red", "POST", f"{API}/{t1}/colors", {"name": "Red", "hex": "#FF0000"})
            red = r.json()["id"]
            r = await c("C02 add colour Blue (no hex)", "POST", f"{API}/{t1}/colors", {"name": "Blue"})
            blue = r.json()["id"]
            await c("C03 add colour unknown tree", "POST", f"{API}/999/colors", {"name": "X"})
            await c("C04 add colour unsafe name 422", "POST", f"{API}/{t1}/colors", {"name": "a..b"})
            await c("C05 rename Blue -> Navy + hex", "PATCH", f"{API}/{t1}/colors/{blue}", {"name": "Navy", "hex": "#000080"})
            await c("C06 rename keeps hex", "PATCH", f"{API}/{t1}/colors/{blue}", {"name": "Navy Blue"})
            await c("C07 rename unknown colour", "PATCH", f"{API}/{t1}/colors/999", {"name": "X"})
            await c("C08 rename colour of another tree", "PATCH", f"{API}/999/colors/{blue}", {"name": "X"})
            await c("C09 remove source colour refused", "DELETE", f"{API}/{t1}/colors/{white}")
            await c("C10 remove unknown colour", "DELETE", f"{API}/{t1}/colors/999")
            await c("C11 list", "GET", API)
            await dump("C after colours")

            # === D: nodes ==========================================================================
            node = f"{API}/{t1}/node"
            await c("D01 get root", "GET", node)
            await c("D02 put root", "PUT", node, {"set": {"nozzle_temperature": ["245"], "filament_cost": ["25.5"], "filament_flow_ratio": ["0.97"]}})
            await c("D03 put root again (old value logged)", "PUT", node, {"set": {"nozzle_temperature": ["246"]}, "clear": ["filament_flow_ratio", "never_set"]})
            await c("D04 put root: identity key refused", "PUT", node, {"set": {"name": "x", "nozzle_temperature": ["1"]}})
            await c("D05 put root: orca metadata key refused", "PUT", node, {"set": {"setting_id": "x"}})
            await c("D06 put root: nozzle-bound key refused", "PUT", node, {"set": {"pressure_advance": ["0.02"]}})
            await c("D07 put machine", "PUT", node, {"machine": "H2S", "set": {"hot_plate_temp": ["75"], "pressure_advance": ["0.01"]}})
            await c("D08 put nozzle", "PUT", node, {"machine": "H2S", "nozzle": "0.4", "set": {"pressure_advance": ["0.03"], "filament_start_gcode": ["M900 K0.03"], "enable_pressure_advance": ["1"]}})
            await c("D09 put colour-wide", "PUT", node, {"color_id": red, "set": {"fan_min_speed": ["40"], "hot_plate_temp": ["72"]}})
            await c("D10 put colour-wide: nozzle-bound refused", "PUT", node, {"color_id": red, "set": {"filament_max_volumetric_speed": ["9"]}})
            await c("D11 put colour-wide on the source colour refused", "PUT", node, {"color_id": white, "set": {"fan_min_speed": ["1"]}})
            await c("D12 put colour", "PUT", node, {"machine": "H2S", "nozzle": "0.6", "color_id": red, "set": {"nozzle_temperature": ["250"], "filament_max_volumetric_speed": ["18"]}})
            await c("D13 put colour on the source leaf refused", "PUT", node, {"machine": "H2S", "nozzle": "0.4", "color_id": white, "set": {"nozzle_temperature": ["1"]}})
            await c("D14 put: nozzle without machine refused", "PUT", node, {"nozzle": "0.4", "set": {"a": "1"}})
            await c("D15 put: machine + colour without nozzle refused", "PUT", node, {"machine": "H2S", "color_id": red, "set": {"a": "1"}})
            await c("D16 put: unknown colour", "PUT", node, {"machine": "H2S", "nozzle": "0.4", "color_id": 999, "set": {"a": "1"}})
            await c("D17 put: unknown tree", "PUT", f"{API}/999/node", {"set": {"a": "1"}})
            await c("D18 put: bad key 422", "PUT", node, {"set": {"Bad-Key": "1"}})
            await c("D19 put: nested value 422", "PUT", node, {"set": {"a": {"b": 1}}})
            await c("D20 put: scalar kinds", "PUT", node, {"machine": "H2D", "set": {"an_int": 3, "a_float": 1.5, "a_bool": True, "a_str": "s", "a_list": ["s", 1, 2.5]}})
            await c("D21 put: nothing", "PUT", node, {})
            await c("D22 put on a non-target machine (kept, no leaf)", "PUT", node, {"machine": "A1", "nozzle": "0.4", "set": {"nozzle_temperature": ["230"]}})
            await c("D30 get root", "GET", node)
            await c("D31 get machine", "GET", node, machine="H2S")
            await c("D32 get nozzle", "GET", node, machine="H2S", nozzle="0.4")
            await c("D33 get nozzle without base preset", "GET", node, machine="H2D", nozzle="0.6")
            await c("D34 get colour-wide", "GET", node, color_id=red)
            await c("D35 get colour", "GET", node, machine="H2S", nozzle="0.6", color_id=red)
            await c("D36 get source leaf", "GET", node, machine="H2S", nozzle="0.4", color_id=white)
            await c("D37 get: nozzle without machine", "GET", node, nozzle="0.4")
            await c("D38 get: machine + colour without nozzle", "GET", node, machine="H2S", color_id=red)
            await c("D39 get: unknown colour", "GET", node, color_id=999)
            await c("D40 get: unknown tree", "GET", f"{API}/999/node")
            await c("D41 get: non-integer colour 422", "GET", node, color_id="x")
            await c("D42 list (own_counts, price, spools)", "GET", API)
            await dump("D after node writes", full=True)

            # === E: history + revert ===============================================================
            r = await c("E01 history", "GET", f"{API}/{t1}/history")
            hist = r.json()
            first_set = next(h["id"] for h in hist if h["key"] == "hot_plate_temp" and h["machine"] == "H2S" and h["color_id"] == 0)
            changed = next(h["id"] for h in hist if h["key"] == "nozzle_temperature" and h["machine"] == "" and h["old_value"] == ["245"])
            cleared = next(h["id"] for h in hist if h["key"] == "filament_flow_ratio" and h["new_value"] is None)
            await c("E02 revert a first set (clears the key)", "POST", f"{API}/{t1}/history/{first_set}/revert")
            await c("E03 revert a change (old value back)", "POST", f"{API}/{t1}/history/{changed}/revert")
            await c("E04 revert a clear (value back)", "POST", f"{API}/{t1}/history/{cleared}/revert")
            await c("E05 revert the same change twice (no-op)", "POST", f"{API}/{t1}/history/{changed}/revert")
            await c("E06 revert unknown change", "POST", f"{API}/{t1}/history/9999/revert")
            await c("E07 revert a change of another tree", "POST", f"{API}/999/history/{changed}/revert")
            await c("E08 history", "GET", f"{API}/{t1}/history")
            await dump("E after reverts")

            # === F: patch ==========================================================================
            await c("F01 patch skip_02 true (0.2 leaves go)", "PATCH", f"{API}/{t1}", {"skip_02": True})
            await c("F02 patch source nozzle 0.2 refused while skipped", "PATCH", f"{API}/{t1}", {"source_nozzle": "0.2"})
            await c("F03 patch skip_02 null (auto)", "PATCH", f"{API}/{t1}", {"skip_02": None})
            await c("F04 patch source colour with colour values refused", "PATCH", f"{API}/{t1}", {"source_color_id": red})
            await c("F05 patch source colour", "PATCH", f"{API}/{t1}", {"source_color_id": blue})
            await c("F06 patch source machine + nozzle", "PATCH", f"{API}/{t1}", {"source_machine": "H2D", "source_nozzle": "0.6"})
            await c("F07 patch source: not a leaf", "PATCH", f"{API}/{t1}", {"source_machine": "A1"})
            await c("F08 patch source back", "PATCH", f"{API}/{t1}", {"source_machine": "H2S", "source_nozzle": "0.4", "source_color_id": white})
            await c("F09 patch material -> abrasive name", "PATCH", f"{API}/{t1}", {"material": "PETG-CF"})
            await c("F10 list after rename", "GET", API)
            await c("F11 patch brand + material back, skip_02 false", "PATCH", f"{API}/{t1}", {"brand": "Acme", "material": "PETG", "skip_02": False})
            await c("F12 patch nothing", "PATCH", f"{API}/{t1}", {})
            await c("F13 patch unknown tree", "PATCH", f"{API}/999", {"skip_02": True})
            await c("F14 patch unsafe brand 422", "PATCH", f"{API}/{t1}", {"brand": "a/b"})
            await c("F15 remove colour Navy Blue", "DELETE", f"{API}/{t1}/colors/{blue}")
            await dump("F after patches")

            # === G: duplicate + bulk ===============================================================
            r = await c("G01 duplicate", "POST", f"{API}/{t1}/duplicate", {"name": "Beta PETG", "brand": "Beta"})
            t2 = r.json()["tree_id"]
            await c("G02 duplicate: name taken", "POST", f"{API}/{t1}/duplicate", {"name": "Beta PETG", "brand": "Beta"})
            await c("G03 duplicate: unknown tree", "POST", f"{API}/999/duplicate", {"name": "Gamma PETG", "brand": "Gamma"})
            await c("G04 duplicate: unsafe name 422", "POST", f"{API}/{t1}/duplicate", {"name": "a/b", "brand": "Beta"})
            await c("G05 rename to a taken name refused", "PATCH", f"{API}/{t1}", {"brand": "Beta"})
            await c("G06 list (rename must not have stuck)", "GET", API)
            await c("G07 bulk machine write on both trees", "POST", f"{API}/bulk", {"tree_ids": [t1, t2, t1], "machine": "H2S", "set": {"fan_max_speed": ["80"]}, "clear": ["pressure_advance"]})
            await c("G08 bulk root write", "POST", f"{API}/bulk", {"tree_ids": [t2], "set": {"filament_cost": ["30"]}})
            await c("G09 bulk with an unknown tree: all or nothing", "POST", f"{API}/bulk", {"tree_ids": [t1, 999], "set": {"bulk_marker": ["1"]}})
            await c("G10 bulk nozzle without machine refused", "POST", f"{API}/bulk", {"tree_ids": [t1], "nozzle": "0.4", "set": {"a": "1"}})
            await c("G11 bulk nozzle-bound at root refused", "POST", f"{API}/bulk", {"tree_ids": [t1, t2], "set": {"pressure_advance": ["0.1"]}})
            await c("G12 bulk no trees 422", "POST", f"{API}/bulk", {"tree_ids": []})
            await c("G13 list", "GET", API)
            await c("G14 history of the copy", "GET", f"{API}/{t2}/history")
            await dump("G after duplicate + bulk")

            # === I: unmanaged / migrate / managed lock =============================================
            await c("I01 unmanaged groups", "GET", f"{API}/unmanaged")
            await c("I02 migrate: mixed base families refused", "POST", f"{API}/migrate", {"groups": [{"prefix": "Mixed PLA", "source_preset_id": 4, "machine": "H2S", "nozzle": "0.4"}]})
            await c("I03 migrate: unindexed base refused", "POST", f"{API}/migrate", {"groups": [{"prefix": "Unindexed ABS", "source_preset_id": 6, "machine": "H2S", "nozzle": "0.4"}]})
            await c("I04 migrate: unknown group", "POST", f"{API}/migrate", {"groups": [{"prefix": "Nope", "source_preset_id": 1, "machine": "H2S", "nozzle": "0.4"}]})
            await c("I05 migrate: preset not in the group", "POST", f"{API}/migrate", {"groups": [{"prefix": "Polymaker PETG", "source_preset_id": 4, "machine": "H2S", "nozzle": "0.4"}]})
            g = {"prefix": "Polymaker PETG", "source_preset_id": 3, "machine": "H2S", "nozzle": "0.4"}
            await c("I06 migrate: a group twice refused", "POST", f"{API}/migrate", {"groups": [g, g]})
            await c("I07 migrate: non-target machine refused", "POST", f"{API}/migrate", {"groups": [{**g, "machine": "A1"}]})
            await c("I08 migrate: one good + one refused group rolls back", "POST", f"{API}/migrate", {"groups": [g, {"prefix": "Mixed PLA", "source_preset_id": 4, "machine": "H2S", "nozzle": "0.4"}]})
            await c("I09 migrate: no groups 422", "POST", f"{API}/migrate", {"groups": []})
            await dump("I before migrate (refusals left nothing)")
            r = await c("I10 migrate Polymaker PETG + Loose", "POST", f"{API}/migrate", {"groups": [g, {"prefix": "Loose", "source_preset_id": 7, "machine": "H2D", "nozzle": "0.6"}]})
            t3 = r.json()["tree_ids"][0]
            await c("I11 migrate again: group is gone", "POST", f"{API}/migrate", {"groups": [g]})
            await c("I12 unmanaged groups after", "GET", f"{API}/unmanaged")
            await c("I13 list", "GET", API)
            await c("I14 migrated tree: root", "GET", f"{API}/{t3}/node")
            await c("I15 migrated tree: source nozzle", "GET", f"{API}/{t3}/node", machine="H2S", nozzle="0.4")
            await c("I20 managed preset: PATCH refused", "PATCH", f"{PROFILES}/3", {"name": "x"})
            await c("I21 managed preset: DELETE refused", "DELETE", f"{PROFILES}/3")
            await c("I22 managed preset: duplicate refused", "POST", f"{PROFILES}/3/duplicate", {"name": "copy"})
            await dump("I after migrate", full=True)

            # === J: export =========================================================================
            await c("J01 export one tree", "POST", f"{API}/export", {"tree_id": t2})
            await c("J01b confirm the download", "POST", f"{API}/export/confirm", {"token": c.token})
            await c("J01c confirm again (token spent)", "POST", f"{API}/export/confirm", {"token": c.token})
            await c("J02 export changed only (the rest)", "POST", f"{API}/export", {"changed_only": True})
            await c("J02b confirm the download", "POST", f"{API}/export/confirm", {"token": c.token})
            await c("J03 export changed only (nothing left)", "POST", f"{API}/export", {"changed_only": True})
            await c("J04 export unknown tree", "POST", f"{API}/export", {"tree_id": 999})
            await c("J05 a write marks leaves pending again", "PUT", f"{API}/{t2}/node", {"machine": "H2D", "set": {"hot_plate_temp": ["68"]}})
            await c("J06 list (export_pending)", "GET", API)
            await c("J07 export tree changed only", "POST", f"{API}/export", {"tree_id": t2, "changed_only": True})
            await c("J08 confirm the download", "POST", f"{API}/export/confirm", {"token": c.token})
            await c("J09 confirm unknown token", "POST", f"{API}/export/confirm", {"token": "nope"})
            await dump("J after exports")

            # === K: sync + conflicts ===============================================================
            red_04, red_06, white_04 = "Acme PETG - Red @H2S 0.4", "Acme PETG - Red @H2S 0.6", "Acme PETG - White @H2S 0.4"
            held = {n: {**(await preset_content(n)), "type": "filament", "setting_id": "orca-" + n[-9:]} for n in (red_04, red_06, white_04)}
            held[red_06]["nozzle_temperature"] = ["260"]  # differs at first sight -> conflict
            held[red_06]["only_in_orca"] = ["1"]

            def entries():
                return [
                    *({"id": f"id-{i}", "name": n, "content": dict(v)} for i, (n, v) in enumerate(held.items())),
                    {"id": "cand-1", "name": "eSUN PLA+ - Blue", "content": {"type": "filament", "from": "User", "name": "eSUN PLA+ - Blue"}},
                    {"id": "legacy", "name": "Acme PETG - Red", "content": {"type": "filament"}},
                    {"id": "foreign", "name": "Someone - Else @X1C 0.4", "content": {"type": "filament", "from": "User"}},
                    {"id": "system", "name": "Generic Thing", "content": {"type": "filament", "from": "system"}},
                    {"id": "process", "name": red_04, "content": {"type": "process"}},
                ]

            orca.entries = entries()
            await c("K01 sync: first sight (baselines, one conflict pair, candidate, legacy, missing)", "POST", f"{API}/sync")
            await dump("K after first sync")
            await c("K02 resolve first-sight conflict with Orca's value", "POST", f"{API}/conflicts/resolve",
                    {"tree_id": t1, "machine": "H2S", "nozzle": "0.6", "color_id": red, "key": "nozzle_temperature", "value": ["260"], "orca_value": ["260"]})
            await c("K03 resolve keeping Fenrir without the key", "POST", f"{API}/conflicts/resolve",
                    {"tree_id": t1, "machine": "H2S", "nozzle": "0.6", "color_id": red, "key": "only_in_orca", "value": None, "orca_value": ["1"]})
            held[red_04]["nozzle_temperature"] = ["255"]  # colour leaf edit -> colour node
            held[white_04]["fan_cooling_layer_time"] = ["30"]  # source leaf, new key -> root
            held[white_04]["fan_max_speed"] = ["85"]  # source leaf, key owned by the machine node
            held[white_04]["filament_start_gcode"] = ["M900 K0.045"]  # source leaf, nozzle-bound -> node
            held[red_06].pop("filament_cost")  # dropped in Orca: ignored
            orca.entries = entries()
            await c("K03p sync preview: edits about to be pulled (writes nothing)", "GET", f"{API}/sync")
            await c("K04 sync: edits applied at colour / root / machine / node", "POST", f"{API}/sync")
            await c("K05 node after sync: source nozzle", "GET", f"{API}/{t1}/node", machine="H2S", nozzle="0.4")
            await c("K06 a Fenrir edit of the colour leaf", "PUT", f"{API}/{t1}/node", {"machine": "H2S", "nozzle": "0.4", "color_id": red, "set": {"fan_min_speed": ["50"], "cool_plate_temp": ["33"]}})
            held[red_04]["fan_min_speed"] = ["60"]  # both sides changed, differently -> conflict
            held[red_04]["cool_plate_temp"] = ["33"]  # both sides changed to the same -> refresh
            orca.entries = entries()
            await c("K06p sync preview: a conflict is counted, not listed", "GET", f"{API}/sync")
            await c("K07 sync: conflict + coincident value", "POST", f"{API}/sync")
            await c("K08 resolve keeping Fenrir's value", "POST", f"{API}/conflicts/resolve",
                    {"tree_id": t1, "machine": "H2S", "nozzle": "0.4", "color_id": red, "key": "fan_min_speed", "value": ["50"], "orca_value": ["60"]})
            await c("K09 sync again: resolved conflict stays quiet", "POST", f"{API}/sync")
            held[white_04]["nozzle_temperature"] = ["248"]
            orca.entries = entries()
            await c("K10 sync: source leaf root edit", "POST", f"{API}/sync")
            await c("K11 resolve on the source leaf: nozzle-bound -> node", "POST", f"{API}/conflicts/resolve",
                    {"tree_id": t1, "machine": "H2S", "nozzle": "0.4", "color_id": white, "key": "pressure_advance", "value": ["0.04"], "orca_value": ["0.04"]})
            await c("K12 resolve: unknown tree", "POST", f"{API}/conflicts/resolve", {"tree_id": 999, "machine": "H2S", "nozzle": "0.4", "color_id": 1, "key": "a", "value": "1", "orca_value": "1"})
            await c("K13 resolve: unknown leaf", "POST", f"{API}/conflicts/resolve", {"tree_id": t1, "machine": "A1", "nozzle": "0.4", "color_id": red, "key": "a", "value": "1", "orca_value": "1"})
            await c("K14 resolve: identity key refused", "POST", f"{API}/conflicts/resolve", {"tree_id": t1, "machine": "H2S", "nozzle": "0.4", "color_id": red, "key": "name", "value": "x", "orca_value": "x"})
            await c("K15 resolve: bad key 422", "POST", f"{API}/conflicts/resolve", {"tree_id": t1, "machine": "H2S", "nozzle": "0.4", "color_id": red, "key": "Bad Key", "value": "x", "orca_value": "x"})
            orca.entries = []
            await c("K16 sync: Orca holds nothing (missing)", "POST", f"{API}/sync")
            for label, exc in [("K17 sync: Orca auth error", OrcaCloudAuthError("token expired")), ("K18 sync: Orca not found", OrcaCloudError("Profile not found")), ("K19 sync: Orca down", OrcaCloudError("boom"))]:
                orca.fail = exc
                await c(label, "POST", f"{API}/sync")
            orca.fail = None
            await c("K20 history after sync (actor empty)", "GET", f"{API}/{t1}/history")
            await dump("K after sync + conflicts", full=True)

            # === L: candidates =====================================================================
            cand = {"type": "filament", "from": "User", "name": "eSUN PLA+ - Blue", "inherits": "Bambu PLA Basic @BBL H2S", "setting_id": "xyz", "version": "2.5.0.1",
                    "nozzle_temperature": ["215"], "filament_max_volumetric_speed": ["18"], "filament_vendor": ["eSUN"]}
            orca.entries = [
                {"id": "c1", "name": "eSUN PLA+ - Blue", "content": cand},
                {"id": "c2", "name": "A process", "content": {"type": "process"}},
                {"id": "c3", "name": "No content"},
                {"id": "c4", "name": "Bare - Green", "content": {"type": "filament", "inherits": ["not", "a", "string"]}},
            ]
            body = {"orca_id": "c1", "name": "eSUN PLA+ - Blue", "brand": "eSUN", "material": "PLA+", "color_name": "Blue", "color_hex": "#0000FF", "machine": "H2S", "nozzle": "0.4"}
            await c("L01 candidate: non-target machine refused (rolled back)", "POST", f"{API}/candidates", {**body, "machine": "A1"})
            r = await c("L02 candidate becomes a tree", "POST", f"{API}/candidates", body)
            t4 = r.json()["tree_id"]
            await c("L03 candidate: tree name taken", "POST", f"{API}/candidates", body)
            await c("L04 candidate: not a filament preset", "POST", f"{API}/candidates", {**body, "orca_id": "c2", "name": "Other - X"})
            await c("L05 candidate: no content", "POST", f"{API}/candidates", {**body, "orca_id": "c3", "name": "Other - X"})
            await c("L06 candidate: unknown id (stub answers a non-dict)", "POST", f"{API}/candidates", {**body, "orca_id": "zzz", "name": "Other - X"})
            await c("L07 candidate: bare content, name without colour part", "POST", f"{API}/candidates", {**body, "orca_id": "c4", "name": " - Green", "brand": "Bare", "material": "PLA"})
            await c("L08 candidate: unsafe name 422", "POST", f"{API}/candidates", {**body, "name": "a/b"})
            for label, exc in [("L09 candidate: Orca auth error", OrcaCloudAuthError("token expired")), ("L10 candidate: Orca not found", OrcaCloudError("Profile NOT FOUND upstream")), ("L11 candidate: Orca down", OrcaCloudError("boom"))]:
                orca.fail = exc
                await c(label, "POST", f"{API}/candidates", {**body, "name": "Other - X"})
            orca.fail = None
            await c("L12 candidate tree: source nozzle", "GET", f"{API}/{t4}/node", machine="H2S", nozzle="0.4")
            await c("L13 list", "GET", API)
            await dump("L after candidates", full=True)

            # === M: delete =========================================================================
            await c("M01 delete tree", "DELETE", f"{API}/{t1}")
            await c("M02 delete again", "DELETE", f"{API}/{t1}")
            await c("M03 delete the migrated tree (its old preset rows go too)", "DELETE", f"{API}/{t3}")
            await c("M04 node of a deleted tree", "GET", f"{API}/{t1}/node")
            await c("M05 list", "GET", API)
            await c("M06 unmanaged after delete", "GET", f"{API}/unmanaged")
            await dump("M final")
    print("### orca stub calls:", json.dumps(orca.calls))


asyncio.run(main())
