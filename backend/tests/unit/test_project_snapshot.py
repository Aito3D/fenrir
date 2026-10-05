"""Slicer settings snapshot read from a 3MF (spec §5.1)."""

import hashlib
import json
import struct
import zipfile

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
    """Config with lone surrogate should not raise UnicodeEncodeError in hash."""
    # Create config that decodes to a surrogate after lossy utf-8 replacement
    config_bytes = b'{"a":"' + b"\xed\xa0\x80" + b'"}'  # UTF-8 encoded U+D800
    path = tmp_path / "surrogate.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", config_bytes)
    snap = read_print_snapshot(path)
    assert snap is not None
    # The surrogate is in the config, but surrogatepass handles it in hash
    assert snap.config_hash is not None or snap.config is None
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


def test_corrupted_zip_entry_no_exception(tmp_path):
    """Corrupted zip entry (bad CRC / understated file_size) should not raise BadZipFile."""
    path = tmp_path / "bad_crc.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"version":"1.0"}')
    # Corrupt the CRC in the local file header
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        # Find a CRC field (after the file name) and corrupt it
        if len(data) > 30:
            data[30:34] = b"\x00\x00\x00\x00"
        f.seek(0)
        f.write(data)
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.print_profile == {"sliced": False}


def test_encrypted_entry_no_exception(tmp_path):
    """Encrypted zip entry should not raise RuntimeError."""
    path = tmp_path / "encrypted.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"version":"1.0"}')
    # Set general-purpose flag bit 0 to indicate encryption
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        if len(data) > 6:
            # Local file header is at offset 0, general purpose flag at offset 6-7
            flags = struct.unpack("<H", data[6:8])[0]
            flags |= 0x01  # Set encryption bit
            data[6:8] = struct.pack("<H", flags)
        f.seek(0)
        f.write(data)
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.print_profile == {"sliced": False}


def test_bad_compression_method_no_exception(tmp_path):
    """Bad compression method should not raise NotImplementedError / zlib.error."""
    path = tmp_path / "bad_compression.3mf"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("Metadata/project_settings.config", '{"version":"1.0"}')
    # Overwrite compression method with unsupported value (99)
    with open(path, "r+b") as f:
        data = bytearray(f.read())
        if len(data) > 10:
            # Local file header, compression method at offset 8-9
            data[8:10] = struct.pack("<H", 99)
        f.seek(0)
        f.write(data)
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.print_profile == {"sliced": False}


def test_empty_config_returns_none(tmp_path):
    """Empty config {} should return None, not config={}."""
    path = _zip(tmp_path / "empty.3mf", {"Metadata/project_settings.config": "{}"})
    snap = read_print_snapshot(path)
    assert snap is not None
    assert snap.config is None
    assert snap.config_hash is None
    assert snap.print_profile == {"sliced": False}
