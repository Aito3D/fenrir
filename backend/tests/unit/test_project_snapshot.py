"""Slicer settings snapshot read from a 3MF (spec §5.1)."""

import hashlib
import json
import struct
import zipfile

import pytest

from backend.app.services.project_snapshot import is_3mf, read_print_snapshot

CONFIG = {
    "version": "02.08.00.50",
    "printer_model": "Bambu Lab H2D",
    "printer_settings_id": "Bambu Lab H2D 0.6 nozzle",
    "print_settings_id": "0.20mm Standard @BBL H2D",
    "filament_settings_id": ["Bambu PETG-CF @BBL H2D"],
    "filament_type": ["PETG-CF"],
    "nozzle_diameter": ["0.6", "0.6"],
    "layer_height": "0.2",
}


def _zip(path, files):
    with zipfile.ZipFile(path, "w") as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return path


def test_full_bambu_file(tmp_path):
    path = _zip(
        tmp_path / "a.gcode.3mf",
        {
            "Metadata/project_settings.config": json.dumps(CONFIG),
            "Metadata/slice_info.config": '<config><header><header_item key="X-BBL-Client-Version" value="02.08.00.50"/></header></config>',
            "3D/3dmodel.model": '<model><metadata name="Application">BambuStudio-02.08.00.50</metadata></model>',
            "Metadata/plate_1.gcode": "G28",
        },
    )
    snap = read_print_snapshot(path)
    assert snap.config == CONFIG
    assert (
        snap.config_hash
        == hashlib.sha256(
            json.dumps(CONFIG, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
    )
    assert (snap.slicer_name, snap.slicer_version) == ("BambuStudio", "02.08.00.50")
    assert snap.print_profile == {
        "printer_model": "Bambu Lab H2D",
        "printer_preset": "Bambu Lab H2D 0.6 nozzle",
        "process_preset": "0.20mm Standard @BBL H2D",
        "filament_presets": ["Bambu PETG-CF @BBL H2D"],
        "filament_types": ["PETG-CF"],
        "nozzle_diameter": "0.6",
        "layer_height": "0.2",
        "sliced": True,
    }


def test_version_falls_back_to_slice_info_then_config(tmp_path):
    only_header = _zip(
        tmp_path / "b.3mf",
        {
            "Metadata/project_settings.config": json.dumps({"version": "1.0"}),
            "Metadata/slice_info.config": '<header_item key="X-BBL-Client-Version" value="02.07.00.00"/>',
        },
    )
    snap = read_print_snapshot(only_header)
    assert (snap.slicer_name, snap.slicer_version) == (None, "02.07.00.00")
    only_config = _zip(tmp_path / "c.3mf", {"Metadata/project_settings.config": json.dumps({"version": "1.0"})})
    assert read_print_snapshot(only_config).slicer_version == "1.0"


def test_unsliced_project_and_missing_config(tmp_path):
    snap = read_print_snapshot(_zip(tmp_path / "d.3mf", {"3D/3dmodel.model": "<model/>"}))
    assert snap.config is None and snap.config_hash is None
    assert snap.print_profile == {"sliced": False}


def test_corrupt_config_and_not_a_zip(tmp_path):
    snap = read_print_snapshot(_zip(tmp_path / "e.3mf", {"Metadata/project_settings.config": "{not json"}))
    assert snap.config is None
    junk = tmp_path / "f.3mf"
    junk.write_bytes(b"not a zip")
    assert read_print_snapshot(junk) is None


def test_is_3mf():
    assert is_3mf("A.GCODE.3MF") and is_3mf("b.3mf")
    assert not is_3mf("c.stl")


def test_surrogate_in_config_no_exception(tmp_path):
    """Config with lone surrogate (via escaped JSON) should not raise UnicodeEncodeError in hash."""
    # Use literal escaped JSON form: json.loads will parse \ud800 as an actual surrogate
    config_text = '{"a": "\\ud800"}'
    # Precondition: verify that this config can't be round-tripped without surrogatepass
    config_obj = json.loads(config_text)
    with pytest.raises(UnicodeEncodeError):
        json.dumps(config_obj, ensure_ascii=False).encode("utf-8")
    # Now verify that our reader handles it gracefully
    path = tmp_path / "surrogate.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", config_text)
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config == config_obj  # Successfully parsed the surrogate
    assert snap.config_hash is not None  # surrogatepass allowed encoding it
    assert snap.print_profile == {"sliced": False}


def test_deeply_nested_json_no_exception(tmp_path):
    """Deeply nested JSON like [[[[...]]]] should not raise RecursionError."""
    nested = "[" * 100000 + "]" * 100000
    path = _zip(tmp_path / "nested.3mf", {"Metadata/project_settings.config": nested})
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None  # RecursionError caught
    assert snap.config_hash is None
    assert snap.print_profile == {"sliced": False}


def test_corrupted_zip_entry_crc_mismatch_no_exception(tmp_path):
    """Corrupted zip entry (CRC mismatch) should not raise BadZipFile."""
    path = tmp_path / "bad_crc.3mf"
    content = '{"version":"1.0"}'
    # Use ZIP_STORED (no compression) so we can safely flip data bytes
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
        zf.writestr("Metadata/project_settings.config", content)
    # Flip a byte in the stored data (not in headers)
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        # Find the stored data: search for the JSON content and flip a byte
        idx = data.find(b'{"version":"1.0"}')
        if idx >= 0:
            data[idx + 5] ^= 0xFF  # Flip one byte in the data
            f.seek(0)
            f.write(data)
    # Precondition: verify this file would raise BadZipFile on normal read
    with pytest.raises(zipfile.BadZipFile), zipfile.ZipFile(path) as zf:
        zf.read("Metadata/project_settings.config")
    # Verify our reader handles it gracefully
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None
    assert snap.print_profile == {"sliced": False}


def test_encrypted_entry_no_exception(tmp_path):
    """Encrypted zip entry should not raise RuntimeError."""
    path = tmp_path / "encrypted.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"version":"1.0"}')
    # Patch central directory (not local header) to set encryption flag
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        # Find central directory header signature "PK\x01\x02"
        cd_offset = data.rfind(b"PK\x01\x02")
        if cd_offset >= 0:
            # General purpose flags at offset +8 from signature
            flags_offset = cd_offset + 8
            flags = struct.unpack("<H", data[flags_offset : flags_offset + 2])[0]
            flags |= 0x01  # Set encryption bit
            data[flags_offset : flags_offset + 2] = struct.pack("<H", flags)
            f.seek(0)
            f.write(data)
    # Precondition: verify this file would raise RuntimeError on normal read
    with pytest.raises(RuntimeError, match="is encrypted|password"), zipfile.ZipFile(path) as zf:
        zf.read("Metadata/project_settings.config")
    # Verify our reader handles it gracefully
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None
    assert snap.print_profile == {"sliced": False}


def test_bad_compression_method_no_exception(tmp_path):
    """Bad compression method should not raise NotImplementedError / zlib.error."""
    path = tmp_path / "bad_compression.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"version":"1.0"}')
    # Patch central directory (not local header) to set bad compression method
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        # Find central directory header signature "PK\x01\x02"
        cd_offset = data.rfind(b"PK\x01\x02")
        if cd_offset >= 0:
            # Compression method at offset +10 from signature
            method_offset = cd_offset + 10
            data[method_offset : method_offset + 2] = struct.pack("<H", 99)  # Unsupported method
            f.seek(0)
            f.write(data)
    # Precondition: verify this file would raise NotImplementedError on normal read
    with pytest.raises(NotImplementedError), zipfile.ZipFile(path) as zf:
        zf.read("Metadata/project_settings.config")
    # Verify our reader handles it gracefully
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None
    assert snap.print_profile == {"sliced": False}


def test_empty_config_returns_none(tmp_path):
    """Empty config {} should return None, not config={}."""
    path = _zip(tmp_path / "empty.3mf", {"Metadata/project_settings.config": "{}"})
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None
    assert snap.config_hash is None
    assert snap.print_profile == {"sliced": False}


def test_big_model_part_still_yields_the_slicer(tmp_path):
    header = '<?xml version="1.0"?>\n<model><metadata name="Application">BambuStudio-02.08.00.50</metadata>\n'
    mesh = "<vertex x='1' y='2' z='3'/>\n" * (9 * 1024 * 1024 // 28)
    model = header + mesh + "</model>"
    assert len(model) > 8 * 1024 * 1024
    path = tmp_path / "big.3mf"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Metadata/project_settings.config", json.dumps(CONFIG))
        zf.writestr("3D/3dmodel.model", model)
    snap = read_print_snapshot(path)
    assert (snap.slicer_name, snap.slicer_version) == ("BambuStudio", "02.08.00.50")
    assert snap.print_profile["printer_model"] == "Bambu Lab H2D"


def test_big_config_part_is_still_skipped(tmp_path):
    big = json.dumps({**CONFIG, "padding": "x" * (9 * 1024 * 1024)})
    path = tmp_path / "big-config.3mf"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Metadata/project_settings.config", big)
    snap = read_print_snapshot(path)
    assert snap.config is None
