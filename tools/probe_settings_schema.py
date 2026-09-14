"""Golden probe (campaign 16): the settings feature's typed contract.

Prints, in one deterministic JSON document, everything a client of the
settings API can observe without a database:
  * every AppSettings / AppSettingsUpdate field with its annotation, default,
    required flag and description — a rename, a default change or a dropped
    field is a user-visible change;
  * DEFAULT_SETTINGS.model_dump() — what POST /settings/reset returns;
  * the module-level tuples that gate behaviour: the credential fields
    blanked for API-key callers, the /ui-preferences allow-list, the LAN
    service URL settings, and the accepted boolean spellings;
  * the names of the pydantic validators on both models — a validator that
    disappears silently widens what the API accepts.
"""

import json
import re
import sys

sys.path.insert(0, ".")

from backend.app.api.routes import settings as route_mod  # noqa: E402
from backend.app.schemas import settings as schema_mod  # noqa: E402


def fields(model):
    out = {}
    for name, f in sorted(model.model_fields.items()):
        out[name] = {
            "type": str(f.annotation),
            "default": repr(f.default) if f.default_factory is None else f"factory:{f.default_factory.__name__}",
            "required": f.is_required(),
            "description": f.description,
            "constraints": sorted(repr(m) for m in f.metadata),
        }
    return out


def validators(model):
    dec = model.__pydantic_decorators__
    return {
        "field_validators": {n: sorted(v.info.fields) for n, v in sorted(dec.field_validators.items())},
        "model_validators": sorted(dec.model_validators),
    }


doc = {
    "AppSettings": {"fields": fields(schema_mod.AppSettings), "validators": validators(schema_mod.AppSettings)},
    "AppSettingsUpdate": {
        "fields": fields(schema_mod.AppSettingsUpdate),
        "validators": validators(schema_mod.AppSettingsUpdate),
    },
    "DEFAULT_SETTINGS": route_mod.DEFAULT_SETTINGS.model_dump(),
    "sensitive_fields_for_api_key": list(route_mod._SENSITIVE_FIELDS_FOR_API_KEY),
    "ui_preference_fields": list(route_mod._UI_PREFERENCE_FIELDS),
    "lan_service_url_settings": list(schema_mod.LAN_SERVICE_URL_SETTINGS),
    "truthy": sorted(route_mod._TRUTHY_SETTING_VALUES),
    "falsy": sorted(route_mod._FALSY_SETTING_VALUES),
    "compose_dir_max_len": schema_mod._COMPOSE_DIR_MAX_LEN,
    "compose_dir_allowed": schema_mod._COMPOSE_DIR_ALLOWED.pattern,
}
print(re.sub(r" at 0x[0-9a-f]+", "", json.dumps(doc, sort_keys=True, indent=1, default=str)))
