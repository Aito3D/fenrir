"""Orca Cloud profile content <-> local preset JSON.

A local preset file holds vectors as JSON lists (``"nozzle_temperature": ["260"]``). Orca Cloud holds every value
as ONE string, exactly what OrcaSlicer's ``ConfigOption::serialize()`` returns: numbers, bools and enums joined
with ``,`` (``"260,nil"``), string vectors joined with ``;`` and quoted C-style when they need it
(``"\\"Bambu Lab H2S 0.4 nozzle\\";PETG"``). OrcaSlicer loads the cloud map with ``set_deserialize`` and throws on a
bool it cannot read, so a JSON list sent as-is crashes it at startup.
"""

# Keys a local preset file stores as a plain string.
_SCALARS = frozenset(
    {
        "name",
        "type",
        "from",
        "version",
        "inherits",
        "setting_id",
        "base_id",
        "filament_id",
        "user_id",
        "updated_time",
        "instantiation",
        "is_custom_defined",
        "description",
        "compatible_printers_condition",
        "compatible_prints_condition",
    }
)
# coStrings options a filament preset can carry (OrcaSlicer PrintConfig.cpp). Every other vector is comma-joined.
_STRING_VECTORS = frozenset(
    {
        "adaptive_pressure_advance_model",
        "compatible_printers",
        "compatible_prints",
        "default_filament_colour",
        "filament_change_extrusion_role_gcode",
        "filament_colour",
        "filament_colour_type",
        "filament_dev_ams_drying_ams_limitations",
        "filament_end_gcode",
        "filament_extruder_variant",
        "filament_ids",
        "filament_mixed_components",
        "filament_mixed_gradient_curve",
        "filament_mixed_gradient_range",
        "filament_mixed_sublayer_ratios",
        "filament_multi_colour",
        "filament_notes",
        "filament_ramming_parameters",
        "filament_settings_id",
        "filament_start_gcode",
        "filament_type",
        "filament_vendor",
        "volumetric_speed_coefficients",
    }
)
_QUOTE_IF = set(' \t;\\"\r\n')


def _escape_strings(values: list[str]) -> str:
    """OrcaSlicer's escape_strings_cstyle."""
    out = []
    for s in values:
        if _QUOTE_IF & set(s) or (s == "" and len(values) == 1):
            s = s.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n")
            s = f'"{s}"'
        out.append(s)
    return ";".join(out)


def _unescape_strings(text: str) -> list[str]:
    """OrcaSlicer's unescape_strings_cstyle; text it would refuse comes back as one value."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in " \t":
            i += 1
        if i == n:
            break
        buf = []
        if text[i] == '"':
            i += 1
            while i < n and text[i] != '"':
                c = text[i]
                if c == "\\":
                    i += 1
                    if i == n:
                        return [text]
                    c = {"r": "\r", "n": "\n"}.get(text[i], text[i])
                buf.append(c)
                i += 1
            if i == n:
                return [text]
            i += 1
        else:
            while i < n and text[i] != ";":
                buf.append(text[i])
                i += 1
        out.append("".join(buf))
        while i < n and text[i] in " \t":
            i += 1
        if i == n:
            break
        if text[i] != ";":
            return [text]
        i += 1
    return out


def encode_content(content: dict) -> dict[str, str]:
    """Local preset JSON -> the string map Orca Cloud stores."""
    out = {}
    for key, value in content.items():
        if isinstance(value, list):
            items = [str(v) for v in value]
            out[key] = _escape_strings(items) if key in _STRING_VECTORS else ",".join(items)
        else:
            out[key] = str(value)
    return out


def decode_content(content: dict) -> dict:
    """Orca Cloud string map -> local preset JSON. Values that are not strings pass through unchanged."""
    out = {}
    for key, value in content.items():
        if not isinstance(value, str) or key in _SCALARS:
            out[key] = value
        elif key in _STRING_VECTORS:
            out[key] = _unescape_strings(value)
        else:
            out[key] = value.split(",") if value else []
    return out


def is_wire_format(content: dict) -> bool:
    """False for content pushed as JSON lists by the first push release: it must be sent again."""
    return all(isinstance(v, str) for v in content.values())
