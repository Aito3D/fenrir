# SURFACE.md — filament-tree campaign (F1) public contract: the filament profile tree (frozen at setup)

Regenerate with: `bash tools/gen_surface_ftree.sh > SURFACE.md` (from the repo root).
Each section is replayable by the `regen:` command shown above it (repo root,
`LC_ALL=C`). Any diff against the committed copy is a change to something
outside the feature`s own internals — a route or its permission, a public
function signature, a request schema, a table column, a setting or permission
the feature reads, an exported symbol, an API client type or method, a
translation key, the wiring — and fails the iteration unless the user approved it.

## HTTP routes under /api/v1/filament-trees: method, path, handler, doors (dependencies, permissions; sub-dependencies after <-)
```regen: ./venv/bin/python3 tools/probe_ftree_surface.py routes 2>/dev/null```
```
GET /api/v1/filament-trees  -> list_trees  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:read']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees  -> create_tree  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:create']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/bulk  -> bulk_node  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
GET /api/v1/filament-trees/targets  -> get_targets  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:read']"} <- (HTTPBearer); get_db]
PUT /api/v1/filament-trees/targets  -> put_targets  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
GET /api/v1/filament-trees/unmanaged  -> list_unmanaged  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:read']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/migrate  -> migrate  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:create', 'filaments:update']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/sync  -> sync  [_cloud_api_key_gate <- (HTTPBearer); get_db; cloud_caller.<locals>.resolved <- (require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update', 'orca_cloud:auth']"} <- (HTTPBearer))]
POST /api/v1/filament-trees/conflicts/resolve  -> resolve  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/candidates  -> adopt_candidate  [_cloud_api_key_gate <- (HTTPBearer); get_db; cloud_caller.<locals>.resolved <- (require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:create', 'orca_cloud:auth']"} <- (HTTPBearer))]
POST /api/v1/filament-trees/export  -> export  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/export/confirm  -> export_confirm  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
GET /api/v1/filament-trees/{tree_id}/node  -> get_node  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:read']"} <- (HTTPBearer); get_db]
PUT /api/v1/filament-trees/{tree_id}/node  -> put_node  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/{tree_id}/duplicate  -> duplicate_tree  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:create']"} <- (HTTPBearer); get_db]
GET /api/v1/filament-trees/{tree_id}/history  -> get_history  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:read']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/{tree_id}/history/{change_id}/revert  -> revert_change  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
PATCH /api/v1/filament-trees/{tree_id}  -> patch_tree  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
POST /api/v1/filament-trees/{tree_id}/colors  -> add_color  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:create']"} <- (HTTPBearer); get_db]
PATCH /api/v1/filament-trees/{tree_id}/colors/{color_id}  -> rename_color  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:update']"} <- (HTTPBearer); get_db]
DELETE /api/v1/filament-trees/{tree_id}/colors/{color_id}  -> remove_color  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:delete']"} <- (HTTPBearer); get_db]
DELETE /api/v1/filament-trees/{tree_id}  -> delete_tree  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['filaments:delete']"} <- (HTTPBearer); get_db]
```

## Route decorators and router (routes/filament_trees.py)
```regen: grep -HE '^@router\.(get|post|put|patch|delete)\(|^router = APIRouter' backend/app/api/routes/filament_trees.py | sed 's/, *$//'```
```
backend/app/api/routes/filament_trees.py:router = APIRouter(prefix="/filament-trees", tags=["filament-trees"])
backend/app/api/routes/filament_trees.py:@router.get("", response_model=list[TreeSummary])
backend/app/api/routes/filament_trees.py:@router.post("")
backend/app/api/routes/filament_trees.py:@router.post("/bulk")
backend/app/api/routes/filament_trees.py:@router.get("/targets", response_model=Targets)
backend/app/api/routes/filament_trees.py:@router.put("/targets", response_model=Targets)
backend/app/api/routes/filament_trees.py:@router.get("/unmanaged")
backend/app/api/routes/filament_trees.py:@router.post("/migrate")
backend/app/api/routes/filament_trees.py:@router.post("/sync", dependencies=[Depends(_cloud_api_key_gate)])
backend/app/api/routes/filament_trees.py:@router.post("/conflicts/resolve")
backend/app/api/routes/filament_trees.py:@router.post("/candidates", dependencies=[Depends(_cloud_api_key_gate)])
backend/app/api/routes/filament_trees.py:@router.post("/export")
backend/app/api/routes/filament_trees.py:@router.post("/export/confirm")
backend/app/api/routes/filament_trees.py:@router.get("/{tree_id}/node", response_model=list[NodeRow])
backend/app/api/routes/filament_trees.py:@router.put("/{tree_id}/node")
backend/app/api/routes/filament_trees.py:@router.post("/{tree_id}/duplicate")
backend/app/api/routes/filament_trees.py:@router.get("/{tree_id}/history", response_model=list[TreeChange])
backend/app/api/routes/filament_trees.py:@router.post("/{tree_id}/history/{change_id}/revert")
backend/app/api/routes/filament_trees.py:@router.patch("/{tree_id}")
backend/app/api/routes/filament_trees.py:@router.post("/{tree_id}/colors")
backend/app/api/routes/filament_trees.py:@router.patch("/{tree_id}/colors/{color_id}")
backend/app/api/routes/filament_trees.py:@router.delete("/{tree_id}/colors/{color_id}")
backend/app/api/routes/filament_trees.py:@router.delete("/{tree_id}")
```

## Pydantic request/response schemas (schemas/filament_tree.py): fields, types, defaults
```regen: ./venv/bin/python3 tools/probe_ftree_surface.py schemas 2>/dev/null```
```
## backend.app.schemas.filament_tree
class BulkNodeUpdate(BaseModel)
    tree_ids: list[int]  required
    machine: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None
    nozzle: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None
    set_values: dict[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=100), _PydanticGeneralMetadata(pattern='^[a-z0-9_]+$')])], typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)], typing.Annotated[bool, Strict(strict=True)], typing.Annotated[list[typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)]]], FieldInfo(annotation=NoneType, required=True, metadata=[MaxLen(max_length=16)])]]]  default_factory=dict
    clear: list[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=100), _PydanticGeneralMetadata(pattern='^[a-z0-9_]+$')])]]  default_factory=list
class CandidateRequest(BaseModel)
    orca_id: <class 'str'>  required
    name: <class 'str'>  required
    brand: <class 'str'>  required
    material: <class 'str'>  required
    color_name: <class 'str'>  required
    color_hex: <class 'str'>  required
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
class ColorCreate(BaseModel)
    name: <class 'str'>  required
    hex: <class 'str'>  default=''
class ColorUpdate(BaseModel)
    name: <class 'str'>  required
    hex: str | None  default=None
class ConflictResolveRequest(BaseModel)
    tree_id: <class 'int'>  required
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
    color_id: <class 'int'>  required
    key: <class 'str'>  required
    value: typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)], typing.Annotated[bool, Strict(strict=True)], typing.Annotated[list[typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)]]], FieldInfo(annotation=NoneType, required=True, metadata=[MaxLen(max_length=16)])], NoneType]  required
    orca_value: typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)], typing.Annotated[bool, Strict(strict=True)], typing.Annotated[list[typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)]]], FieldInfo(annotation=NoneType, required=True, metadata=[MaxLen(max_length=16)])], NoneType]  required
class ExportConfirm(BaseModel)
    token: <class 'str'>  required
class ExportRequest(BaseModel)
    tree_id: int | None  default=None
    changed_only: <class 'bool'>  default=False
class MigrateGroup(BaseModel)
    prefix: <class 'str'>  required
    source_preset_id: <class 'int'>  required
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
class MigrateRequest(BaseModel)
    groups: list[backend.app.schemas.filament_tree.MigrateGroup]  required
class NodeRow(BaseModel)
    key: <class 'str'>  required
    value: typing.Any  required
    source: <class 'str'>  required
    own: <class 'bool'>  required
    inherited_value: typing.Any  default=None
    inherited_source: str | None  default=None
    source_label: str | None  default=None
class NodeUpdate(BaseModel)
    machine: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None
    nozzle: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None
    color_id: int | None  default=None
    set_values: dict[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=100), _PydanticGeneralMetadata(pattern='^[a-z0-9_]+$')])], typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)], typing.Annotated[bool, Strict(strict=True)], typing.Annotated[list[typing.Union[typing.Annotated[str, Strict(strict=True)], typing.Annotated[int, Strict(strict=True)], typing.Annotated[float, Strict(strict=True)]]], FieldInfo(annotation=NoneType, required=True, metadata=[MaxLen(max_length=16)])]]]  default_factory=dict
    clear: list[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=100), _PydanticGeneralMetadata(pattern='^[a-z0-9_]+$')])]]  default_factory=list
class Targets(BaseModel)
    machines: list[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  required
    nozzles: list[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  required
class TreeChange(BaseModel)
    id: <class 'int'>  required
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
    color_id: <class 'int'>  required
    key: <class 'str'>  required
    old_value: typing.Any  default=None
    new_value: typing.Any  default=None
    actor: <class 'str'>  required
    created_at: <class 'datetime.datetime'>  required
class TreeColor(BaseModel)
    id: <class 'int'>  required
    name: <class 'str'>  required
    hex: <class 'str'>  required
    spools: <class 'int'>  default=0
    price: float | None  default=None
class TreeCreate(BaseModel)
    brand: <class 'str'>  required
    material: <class 'str'>  required
    base_family: <class 'str'>  required
    color_name: <class 'str'>  required
    color_hex: <class 'str'>  default=''
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
class TreeDuplicate(BaseModel)
    name: <class 'str'>  required
    brand: <class 'str'>  required
class TreeSource(BaseModel)
    machine: <class 'str'>  required
    nozzle: <class 'str'>  required
    color_id: int | None  required
class TreeSummary(BaseModel)
    id: <class 'int'>  required
    name: <class 'str'>  required
    brand: <class 'str'>  required
    material: <class 'str'>  required
    skip_02: bool | None  required
    abrasive: <class 'bool'>  required
    source: <class 'backend.app.schemas.filament_tree.TreeSource'>  required
    colors: list[backend.app.schemas.filament_tree.TreeColor]  required
    own_counts: dict[str, int]  required
    export_pending: <class 'int'>  default=0
class TreeUpdate(BaseModel)
    brand: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=200)]), AfterValidator(func=<function _safe_name>)]]  default=None
    material: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=200)]), AfterValidator(func=<function _safe_name>)]]  default=None
    skip_02: bool | None  default=None
    source_color_id: int | None  default=None
    source_machine: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None
    source_nozzle: typing.Optional[typing.Annotated[str, FieldInfo(annotation=NoneType, required=True, metadata=[MinLen(min_length=1), MaxLen(max_length=32)]), AfterValidator(func=<function _safe_name>)]]  default=None

```

## Tables the filament tree models own — DDL, SQLite and PostgreSQL
```regen: ./venv/bin/python3 tools/probe_ftree_surface.py ddl 2>/dev/null```
```
-- sqlite
CREATE TABLE filament_tree_changes (
	id INTEGER NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	"key" VARCHAR NOT NULL, 
	old_value TEXT, 
	new_value TEXT, 
	actor VARCHAR NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);
CREATE INDEX ix_filament_tree_changes_tree_id ON filament_tree_changes (tree_id);
-- postgresql
CREATE TABLE filament_tree_changes (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	key VARCHAR NOT NULL, 
	old_value TEXT, 
	new_value TEXT, 
	actor VARCHAR NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);
CREATE INDEX ix_filament_tree_changes_tree_id ON filament_tree_changes (tree_id);

-- sqlite
CREATE TABLE filament_tree_colors (
	id INTEGER NOT NULL, 
	tree_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	hex VARCHAR NOT NULL, 
	sort INTEGER NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);
-- postgresql
CREATE TABLE filament_tree_colors (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	hex VARCHAR NOT NULL, 
	sort INTEGER NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);

-- sqlite
CREATE TABLE filament_tree_leaves (
	id INTEGER NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	preset_id INTEGER NOT NULL, 
	baseline_content TEXT, 
	exported_at DATETIME, 
	export_pending BOOLEAN DEFAULT '1' NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (tree_id, machine, nozzle, color_id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE, 
	UNIQUE (preset_id), 
	FOREIGN KEY(preset_id) REFERENCES filament_presets (id) ON DELETE CASCADE
);
-- postgresql
CREATE TABLE filament_tree_leaves (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	preset_id INTEGER NOT NULL, 
	baseline_content TEXT, 
	exported_at TIMESTAMP WITHOUT TIME ZONE, 
	export_pending BOOLEAN DEFAULT '1' NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (tree_id, machine, nozzle, color_id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE, 
	UNIQUE (preset_id), 
	FOREIGN KEY(preset_id) REFERENCES filament_presets (id) ON DELETE CASCADE
);

-- sqlite
CREATE TABLE filament_tree_overrides (
	id INTEGER NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	"values" TEXT NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (tree_id, machine, nozzle, color_id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);
-- postgresql
CREATE TABLE filament_tree_overrides (
	id SERIAL NOT NULL, 
	tree_id INTEGER NOT NULL, 
	machine VARCHAR NOT NULL, 
	nozzle VARCHAR NOT NULL, 
	color_id INTEGER NOT NULL, 
	values TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (tree_id, machine, nozzle, color_id), 
	FOREIGN KEY(tree_id) REFERENCES filament_trees (id) ON DELETE CASCADE
);

-- sqlite
CREATE TABLE filament_tree_snapshots (
	id INTEGER NOT NULL, 
	kind VARCHAR NOT NULL, 
	payload TEXT NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id)
);
-- postgresql
CREATE TABLE filament_tree_snapshots (
	id SERIAL NOT NULL, 
	kind VARCHAR NOT NULL, 
	payload TEXT NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);

-- sqlite
CREATE TABLE filament_trees (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	brand VARCHAR NOT NULL, 
	material VARCHAR NOT NULL, 
	base_family VARCHAR NOT NULL, 
	fallback_inherits VARCHAR NOT NULL, 
	version VARCHAR NOT NULL, 
	own_values TEXT NOT NULL, 
	source_machine VARCHAR NOT NULL, 
	source_nozzle VARCHAR NOT NULL, 
	source_color_id INTEGER, 
	skip_02 BOOLEAN, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id)
);
-- postgresql
CREATE TABLE filament_trees (
	id SERIAL NOT NULL, 
	name VARCHAR NOT NULL, 
	brand VARCHAR NOT NULL, 
	material VARCHAR NOT NULL, 
	base_family VARCHAR NOT NULL, 
	fallback_inherits VARCHAR NOT NULL, 
	version VARCHAR NOT NULL, 
	own_values TEXT NOT NULL, 
	source_machine VARCHAR NOT NULL, 
	source_nozzle VARCHAR NOT NULL, 
	source_color_id INTEGER, 
	skip_02 BOOLEAN, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);

```

## Backend public functions, classes, methods and constants of the in-scope modules, with signatures
```regen: ./venv/bin/python3 tools/probe_ftree_surface.py callables 2>/dev/null```
```
## backend.app.api.routes.filament_trees
async def add_color(tree_id: int, payload: backend.app.schemas.filament_tree.ColorCreate, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def adopt_candidate(payload: backend.app.schemas.filament_tree.CandidateRequest, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), current_user: backend.app.models.user.User | None = Depends(dependency=<function cloud_caller.<locals>.resolved>, use_cache=True, scope=None))
async def bulk_node(payload: backend.app.schemas.filament_tree.BulkNodeUpdate, user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def create_tree(payload: backend.app.schemas.filament_tree.TreeCreate, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def delete_tree(tree_id: int, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def duplicate_tree(tree_id: int, payload: backend.app.schemas.filament_tree.TreeDuplicate, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def export(payload: backend.app.schemas.filament_tree.ExportRequest, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def export_confirm(payload: backend.app.schemas.filament_tree.ExportConfirm, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def get_history(tree_id: int, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def get_node(tree_id: int, machine: str | None = None, nozzle: str | None = None, color_id: int | None = None, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def get_targets(_: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def list_trees(_: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def list_unmanaged(_: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def migrate(payload: backend.app.schemas.filament_tree.MigrateRequest, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def patch_tree(tree_id: int, payload: backend.app.schemas.filament_tree.TreeUpdate, user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def put_node(tree_id: int, payload: backend.app.schemas.filament_tree.NodeUpdate, user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def put_targets(payload: backend.app.schemas.filament_tree.Targets, user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def remove_color(tree_id: int, color_id: int, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def rename_color(tree_id: int, color_id: int, payload: backend.app.schemas.filament_tree.ColorUpdate, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def resolve(payload: backend.app.schemas.filament_tree.ConflictResolveRequest, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def revert_change(tree_id: int, change_id: int, user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def sync(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), current_user: backend.app.models.user.User | None = Depends(dependency=<function cloud_caller.<locals>.resolved>, use_cache=True, scope=None))

## backend.app.models.filament_tree
class FilamentTree(Base)
    def __init__(self, **kwargs)
class FilamentTreeChange(Base)
    def __init__(self, **kwargs)
class FilamentTreeColor(Base)
    def __init__(self, **kwargs)
class FilamentTreeLeaf(Base)
    def __init__(self, **kwargs)
class FilamentTreeOverride(Base)
    def __init__(self, **kwargs)
class FilamentTreeSnapshot(Base)
    def __init__(self, **kwargs)

## backend.app.schemas.filament_tree
class BulkNodeUpdate(BaseModel)
class CandidateRequest(BaseModel)
class ColorCreate(BaseModel)
class ColorUpdate(BaseModel)
class ConflictResolveRequest(BaseModel)
class ExportConfirm(BaseModel)
class ExportRequest(BaseModel)
class MigrateGroup(BaseModel)
class MigrateRequest(BaseModel)
class NodeRow(BaseModel)
class NodeUpdate(BaseModel)
class Targets(BaseModel)
class TreeChange(BaseModel)
class TreeColor(BaseModel)
class TreeCreate(BaseModel)
class TreeDuplicate(BaseModel)
class TreeSource(BaseModel)
class TreeSummary(BaseModel)
class TreeUpdate(BaseModel)

## backend.app.services.filament_tree
DEFAULT_TARGETS = {'machines': ['X2D', 'H2S', 'H2D', 'H2C'], 'nozzles': ['0.2', '0.4', '0.6', '0.8']}
IDENTITY_KEYS = ['compatible_printers', 'default_filament_colour', 'filament_settings_id', 'filament_vendor', 'from', 'inherits', 'name', 'version']
NOZZLE_BOUND_KEYS = ['enable_pressure_advance', 'filament_max_volumetric_speed', 'filament_start_gcode', 'pressure_advance']
SKIP_KEYS = ['base_id', 'compatible_printers', 'compatible_printers_condition', 'compatible_prints', 'compatible_prints_condition', 'default_filament_colour', 'filament_id', 'filament_settings_id', 'filament_vendor', 'from', 'inherits', 'instantiation', 'is_custom_defined', 'name', 'setting_id', 'type', 'updated_time', 'user_id', 'version']
class TreeData(object)
    def __init__(self, name: str, brand: str, version: str, base_family: str, fallback_inherits: str, own: dict, colors: dict[int, tuple[str, str]], overrides: dict[tuple[str, str, int], dict], source: tuple[str, str, int | None], skip_02: bool | None, material: str) -> None
def is_abrasive(tree: backend.app.services.filament_tree.TreeData) -> bool
def leaf_name(tree: backend.app.services.filament_tree.TreeData, machine: str, nozzle: str, color_id: int) -> str
def leaf_targets(tree: backend.app.services.filament_tree.TreeData, targets: dict) -> list[tuple[str, str, int]]
def match_base(base_family: str, machine: str, nozzle: str, base_names: set[str], fallback: str) -> str
def parse_inherits(inherits: str) -> tuple[str, str | None, str | None]
def resolve_leaf(tree: backend.app.services.filament_tree.TreeData, machine: str, nozzle: str, color_id: int, base_names: set[str]) -> dict
def resolve_with_sources(tree: backend.app.services.filament_tree.TreeData, machine: str | None, nozzle: str | None, color_id: int | None) -> dict[str, tuple[object, str]]

## backend.app.services.filament_tree_base
class BaseValueReader(object)
    def __init__(self, filenames: dict[str, str])
    def values(self, name: str) -> dict
async def build_base_reader(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> backend.app.services.filament_tree_base.BaseValueReader

## backend.app.services.filament_tree_export
async def build_export_zip(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int | None, changed_only: bool = False) -> tuple[bytes, str]
async def confirm_export(db: sqlalchemy.ext.asyncio.session.AsyncSession, token: str) -> int

## backend.app.services.filament_tree_migration
class MigrationGroup(object)
    def __init__(self, prefix: str, preset_ids: list[int], proposed_source_preset_id: int, proposed_machine: str, proposed_nozzle: str, warnings: list[str] = <factory>) -> None
async def apply_migration(db: sqlalchemy.ext.asyncio.session.AsyncSession, choices: list[dict]) -> list[int]
def plan_tree(group_presets: list[dict], source_preset_id: int, machine: str, nozzle: str, base_values: collections.abc.Callable[[str], dict], known_bases: set[str] | None = None) -> dict
def propose_groups(presets: list[dict], exclude_ids: frozenset[int] | set[int] = frozenset(), targets: dict | None = None) -> list[backend.app.services.filament_tree_migration.MigrationGroup]
def row_dict(row: backend.app.models.filament_profile.FilamentPreset) -> dict

## backend.app.services.filament_tree_pull
class LeafState(object)
    def __init__(self, tree_id: int, machine: str, nozzle: str, color_id: int, name: str, generated: dict, baseline: dict | None, is_source: bool, owned_at: dict[str, str] = <factory>, exported: bool = False) -> None
class PullPlan(object)
    def __init__(self, applied: list[dict] = <factory>, conflicts: list[dict] = <factory>, candidates: list[dict] = <factory>, legacy: int = 0, missing: list[str] = <factory>, ignored: int = 0, refresh: list[dict] = <factory>, baselines: list[dict] = <factory>) -> None
async def apply_pull(db: sqlalchemy.ext.asyncio.session.AsyncSession, plan: backend.app.services.filament_tree_pull.PullPlan) -> None
async def collect_leaf_states(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> tuple[list[backend.app.services.filament_tree_pull.LeafState], set[str]]
def plan_pull(orca_entries: list[dict], leaves: list[backend.app.services.filament_tree_pull.LeafState], tree_colour_names: set[str]) -> backend.app.services.filament_tree_pull.PullPlan
async def resolve_conflict(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, machine: str, nozzle: str, color_id: int, key: str, value, orca_value) -> None

## backend.app.services.filament_tree_store
TARGETS_KEY = 'filament_tree_targets'
async def add_color(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, name: str, hex: str) -> int
async def base_names(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> set[str]
async def create_tree(db: sqlalchemy.ext.asyncio.session.AsyncSession, *, name: str, brand: str, material: str, base_family: str, color_name: str, color_hex: str, machine: str, nozzle: str, own_values: dict | None = None) -> int
async def duplicate_tree(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, name: str, brand: str) -> int
async def get_targets(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> dict
async def load_tree(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int) -> backend.app.services.filament_tree.TreeData
async def managed_preset_ids(db: sqlalchemy.ext.asyncio.session.AsyncSession) -> set[int]
async def regenerate_tree(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int) -> dict
async def remove_color(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, color_id: int) -> None
async def rename_color(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, color_id: int, name: str, hex: str | None = None) -> None
async def set_node_values(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, machine: str | None, nozzle: str | None, color_id: int | None, set_values: dict, clear: list[str], *, regenerate: bool = True, actor: str = '') -> None
async def set_targets(db: sqlalchemy.ext.asyncio.session.AsyncSession, targets: dict, *, commit: bool = True) -> dict
def tree_write_lock(tree_ids: collections.abc.Iterable[int]) -> collections.abc.AsyncIterator[None]
async def update_tree(db: sqlalchemy.ext.asyncio.session.AsyncSession, tree_id: int, *, skip_02: Any = <object object>, source: Any = <object object>, brand: str | None = None, material: str | None = None) -> None
def validate_targets(targets: dict) -> dict

```

## Settings keys, env vars / app settings and borrowed helpers the feature reads
```regen: grep -hoE '(get_setting|set_setting)\([a-z_]+, *[A-Za-z_"]+|[A-Z_]+_KEY = "[a-z_]+"|Settings\.key == "[a-z_]+"' backend/app/api/routes/filament_trees.py backend/app/models/filament_tree.py backend/app/schemas/filament_tree.py backend/app/services/filament_tree.py backend/app/services/filament_tree_*.py | sort -u; echo 'env vars / app settings:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)|settings\.[a-z_]+' backend/app/api/routes/filament_trees.py backend/app/models/filament_tree.py backend/app/schemas/filament_tree.py backend/app/services/filament_tree.py backend/app/services/filament_tree_*.py | sort -u; echo 'limits and helpers borrowed from other modules:'; grep -hE '^from backend\.app\.(schemas\.filament_profile|api\.routes\.(settings|cloud|orca_cloud)|services\.(bambu_studio|orca_cloud)) import' backend/app/api/routes/filament_trees.py backend/app/models/filament_tree.py backend/app/schemas/filament_tree.py backend/app/services/filament_tree.py backend/app/services/filament_tree_*.py | sort -u```
```
TARGETS_KEY = "filament_tree_targets"
get_setting(db, TARGETS_KEY
set_setting(db, TARGETS_KEY
env vars / app settings:
limits and helpers borrowed from other modules:
from backend.app.api.routes.cloud import _cloud_api_key_gate, cloud_caller
from backend.app.api.routes.orca_cloud import _build_authenticated_service
from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.schemas.filament_profile import _CONTENT_MAX_LENGTH, _validate_bare_filename
from backend.app.services.bambu_studio import read_bundle_preset
from backend.app.services.orca_cloud import OrcaCloudAuthError, OrcaCloudError
```

## Permissions the routes require: values, default groups, categories, API keys, and where the frontend checks them
```regen: ./venv/bin/python3 tools/probe_ftree_surface.py permissions 2>/dev/null; grep -oE "'(filaments|orca_cloud):[a-z_]+'" frontend/src/api/client.ts | sort -u | sed 's/^/frontend Permission union: /'; grep -hoE "hasPermission\('[a-z_]+:[a-z_]+'\)|hasAnyPermission\([^)]*\)" frontend/src/components/filament-trees/*.ts frontend/src/components/filament-trees/*.tsx frontend/src/pages/FilamentProfilesPage.tsx | sort -u```
```
{
 "apikey_denied": [
  "filaments:create",
  "filaments:update",
  "filaments:delete"
 ],
 "apikey_scope": {
  "filaments:create": "None",
  "filaments:delete": "None",
  "filaments:read": "can_read_status",
  "filaments:update": "None",
  "orca_cloud:auth": "can_access_cloud"
 },
 "categories": {
  "Cloud": [
   "orca_cloud:auth"
  ],
  "Filaments": [
   "filaments:read",
   "filaments:create",
   "filaments:update",
   "filaments:delete"
  ]
 },
 "groups": {
  "Administrators": [
   "filaments:read",
   "filaments:create",
   "filaments:update",
   "filaments:delete",
   "orca_cloud:auth"
  ],
  "Operators": [
   "filaments:read",
   "filaments:create",
   "filaments:update",
   "filaments:delete",
   "orca_cloud:auth"
  ],
  "Viewers": [
   "filaments:read"
  ]
 },
 "values": [
  "filaments:read",
  "filaments:create",
  "filaments:update",
  "filaments:delete",
  "orca_cloud:auth"
 ]
}
frontend Permission union: 'filaments:create'
frontend Permission union: 'filaments:delete'
frontend Permission union: 'filaments:read'
frontend Permission union: 'filaments:update'
frontend Permission union: 'orca_cloud:auth'
hasPermission('calculator:update')
hasPermission('filaments:create')
hasPermission('filaments:delete')
hasPermission('filaments:update')
hasPermission('orca_cloud:auth')
```

## Registration points (main.py, models/__init__.py, core/database.py)
```regen: grep -nE "filament_tree|FilamentTree" backend/app/main.py backend/app/models/__init__.py backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | sort -u```
```
backend/app/core/database.py: "ALTER TABLE filament_tree_leaves ADD COLUMN export_pending BOOLEAN NOT NULL DEFAULT "
backend/app/core/database.py: filament_tree,
backend/app/main.py: app.include_router(filament_trees.router, prefix=app_settings.api_prefix)
backend/app/main.py: filament_trees,
backend/app/models/__init__.py: "FilamentTree",
backend/app/models/__init__.py: "FilamentTreeChange",
backend/app/models/__init__.py: "FilamentTreeColor",
backend/app/models/__init__.py: "FilamentTreeLeaf",
backend/app/models/__init__.py: "FilamentTreeOverride",
backend/app/models/__init__.py: "FilamentTreeSnapshot",
backend/app/models/__init__.py: FilamentTree,
backend/app/models/__init__.py: FilamentTreeChange,
backend/app/models/__init__.py: FilamentTreeColor,
backend/app/models/__init__.py: FilamentTreeLeaf,
backend/app/models/__init__.py: FilamentTreeOverride,
backend/app/models/__init__.py: FilamentTreeSnapshot,
backend/app/models/__init__.py: from backend.app.models.filament_tree import (
```

## Frontend exported symbols, per file
```regen: grep -HoE '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' frontend/src/components/filament-trees/*.ts frontend/src/components/filament-trees/*.tsx frontend/src/pages/FilamentProfilesPage.tsx | sort```
```
frontend/src/components/filament-trees/BulkApplyModal.tsx:export function BulkApplyModal
frontend/src/components/filament-trees/Dialog.tsx:export function Dialog
frontend/src/components/filament-trees/HistoryTab.tsx:export function HistoryTab
frontend/src/components/filament-trees/JsonView.tsx:export function JsonView
frontend/src/components/filament-trees/MaterialCards.tsx:export function MaterialCards
frontend/src/components/filament-trees/MaterialCards.tsx:export interface MaterialCardsProps
frontend/src/components/filament-trees/MigrateModal.tsx:export function MigrateModal
frontend/src/components/filament-trees/NewTreeModal.tsx:export function NewTreeModal
frontend/src/components/filament-trees/NodePanel.tsx:export function NodePanel
frontend/src/components/filament-trees/NodePanel.tsx:export type NodeRef
frontend/src/components/filament-trees/SyncResultModal.tsx:export function SyncResultModal
frontend/src/components/filament-trees/TargetsModal.tsx:export function TargetsModal
frontend/src/components/filament-trees/TreeSettingsPanel.tsx:export function TreeSettingsPanel
frontend/src/components/filament-trees/errorMessage.ts:export const errorMessage
frontend/src/components/filament-trees/exportDownload.ts:export async function downloadTreeExport
frontend/src/components/filament-trees/orcaLayout.ts:export const DEPENDENCIES_ICON
frontend/src/components/filament-trees/orcaLayout.ts:export const MAPPED_KEYS
frontend/src/components/filament-trees/orcaLayout.ts:export const PA_KEY
frontend/src/components/filament-trees/orcaLayout.ts:export const TABS
frontend/src/components/filament-trees/orcaLayout.ts:export const keyLabel
frontend/src/components/filament-trees/orcaLayout.ts:export type FieldKind
frontend/src/components/filament-trees/orcaLayout.ts:export type FieldSpec
frontend/src/components/filament-trees/orcaLayout.ts:export type RowSpec
frontend/src/components/filament-trees/orcaLayout.ts:export type SectionSpec
frontend/src/components/filament-trees/orcaLayout.ts:export type TabSpec
frontend/src/components/filament-trees/paGcode.ts:export function normalizePaK
frontend/src/components/filament-trees/paGcode.ts:export function readPaK
frontend/src/components/filament-trees/paGcode.ts:export function writePaK
frontend/src/pages/FilamentProfilesPage.tsx:export function FilamentProfilesPage
```

## API client — FilamentTree* exported types
```regen: awk -f tools/probe_ftree_client.awk -v what=types frontend/src/api/client.ts```
```
export type FilamentTreePresetValue = string | number | boolean | Array<string | number>;
export interface FilamentTreeColor { id: number; name: string; hex: string; spools?: number; price?: number | null }
export interface FilamentTreeSummary {
  id: number; name: string; brand: string; material: string;
  skip_02: boolean | null; abrasive: boolean;
  source: { machine: string; nozzle: string; color_id: number | null };
  colors: FilamentTreeColor[];
  /** keys: "root", "M", "M/N", "M/N/cid", "color:cid" */
  own_counts: Record<string, number>;
  /** leaves whose preset changed since the last Export for Orca */
  export_pending?: number;
}
export interface FilamentTreeChange {
  id: number; machine: string; nozzle: string; color_id: number; key: string;
  old_value: unknown; new_value: unknown; actor: string; created_at: string;
}
export interface FilamentTreeTargets { machines: string[]; nozzles: string[] }
export interface FilamentTreeNodeRow {
  key: string; value: unknown;
  source: 'root' | 'machine' | 'nozzle' | 'colorwide' | 'color' | 'bambu';
  own: boolean;
  inherited_value?: unknown; inherited_source?: string | null;
  /** the Bambu base preset name, for bambu rows */
  source_label?: string | null;
}
export interface FilamentTreeMigrationGroup {
  prefix: string; preset_ids: number[]; proposed_source_preset_id: number;
  proposed_machine: string; proposed_nozzle: string; warnings: string[];
}
export interface FilamentTreeConflict {
  tree_id: number; machine: string; nozzle: string; color_id: number;
  key: string; fenrir_value: unknown; orca_value: unknown;
}
export interface FilamentTreeCandidate {
  orca_id: string | null; name: string; content: Record<string, unknown>;
}
export interface FilamentTreePullResult {
  applied: Array<{ tree_id: number; machine: string; nozzle: string; color_id: number; target: string; values: Record<string, unknown> }>;
  conflicts: FilamentTreeConflict[];
  candidates: FilamentTreeCandidate[];
  legacy: number; missing: string[]; ignored: number;
  refresh: Array<{ tree_id: number; machine: string; nozzle: string; color_id: number; keys: string[] }>;
}
export interface FilamentTreeNodeUpdate {
  machine?: string | null; nozzle?: string | null; color_id?: number | null;
  set?: Record<string, FilamentTreePresetValue>; clear?: string[];
}
export interface FilamentTreeUpdate {
  skip_02?: boolean | null; source_color_id?: number; source_machine?: string; source_nozzle?: string;
  brand?: string; material?: string;
}
```

## API client — methods calling /filament-trees
```regen: awk -f tools/probe_ftree_client.awk -v what=methods frontend/src/api/client.ts```
```
  getFilamentTrees: () => request<FilamentTreeSummary[]>('/filament-trees'),
  getFilamentTreeTargets: () => request<FilamentTreeTargets>('/filament-trees/targets'),
  setFilamentTreeTargets: (data: FilamentTreeTargets) =>
    request<FilamentTreeTargets>('/filament-trees/targets', { method: 'PUT', body: JSON.stringify(data) }),
  getUnmanagedFilamentGroups: () => request<FilamentTreeMigrationGroup[]>('/filament-trees/unmanaged'),
  migrateFilamentPresets: (groups: Array<{ prefix: string; source_preset_id: number; machine: string; nozzle: string }>) =>
    request<{ tree_ids: number[] }>('/filament-trees/migrate', { method: 'POST', body: JSON.stringify({ groups }) }),
  syncFilamentTrees: () => request<FilamentTreePullResult>('/filament-trees/sync', { method: 'POST' }),
  // orca_value: what Orca holds; the server stores it as the leaf's baseline whichever value is kept
  resolveFilamentTreeConflict: (data: { tree_id: number; machine: string; nozzle: string; color_id: number; key: string; value: FilamentTreePresetValue | null; orca_value: FilamentTreePresetValue | null }) =>
    request<{ success: boolean }>('/filament-trees/conflicts/resolve', { method: 'POST', body: JSON.stringify(data) }),
  createFilamentTreeFromCandidate: (data: { orca_id: string; name: string; brand: string; material: string; color_name: string; color_hex: string; machine: string; nozzle: string }) =>
    request<{ tree_id: number }>('/filament-trees/candidates', { method: 'POST', body: JSON.stringify(data) }),
  exportFilamentTrees: async (treeId?: number, changedOnly = false): Promise<{ blob: Blob; token: string }> => {
    const response = await postForResponse('/filament-trees/export', { ...(treeId !== undefined && { tree_id: treeId }), ...(changedOnly && { changed_only: true }) });
    return { blob: await response.blob(), token: response.headers.get('X-Export-Token') ?? '' };
  },
  confirmFilamentTreeExport: (token: string) =>
    request<{ confirmed: number }>('/filament-trees/export/confirm', { method: 'POST', body: JSON.stringify({ token }) }),
  createFilamentTree: (data: { brand: string; material: string; base_family: string; color_name: string; color_hex: string; machine: string; nozzle: string }) =>
    request<{ tree_id: number }>('/filament-trees', { method: 'POST', body: JSON.stringify(data) }),
  duplicateFilamentTree: (treeId: number, data: { name: string; brand: string }) =>
    request<{ tree_id: number }>(`/filament-trees/${treeId}/duplicate`, { method: 'POST', body: JSON.stringify(data) }),
  bulkSetFilamentTreeNode: (data: { tree_ids: number[]; machine?: string; nozzle?: string; set: Record<string, FilamentTreePresetValue> }) =>
    request<{ success: boolean }>('/filament-trees/bulk', { method: 'POST', body: JSON.stringify(data) }),
  getFilamentTreeHistory: (treeId: number) => request<FilamentTreeChange[]>(`/filament-trees/${treeId}/history`),
  revertFilamentTreeChange: (treeId: number, changeId: number) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}/history/${changeId}/revert`, { method: 'POST' }),
  getFilamentTreeNode: (treeId: number, node: { machine?: string; nozzle?: string; colorId?: number } = {}) => {
    const q = new URLSearchParams();
    if (node.machine !== undefined) q.set('machine', node.machine);
    if (node.nozzle !== undefined) q.set('nozzle', node.nozzle);
    if (node.colorId !== undefined) q.set('color_id', String(node.colorId));
    const qs = q.toString();
    return request<FilamentTreeNodeRow[]>(`/filament-trees/${treeId}/node${qs ? `?${qs}` : ''}`);
  },
  setFilamentTreeNode: (treeId: number, body: FilamentTreeNodeUpdate) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}/node`, { method: 'PUT', body: JSON.stringify(body) }),
  updateFilamentTree: (treeId: number, data: FilamentTreeUpdate) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  addFilamentTreeColor: (treeId: number, data: { name: string; hex?: string }) =>
    request<{ id: number }>(`/filament-trees/${treeId}/colors`, { method: 'POST', body: JSON.stringify(data) }),
  updateFilamentTreeColor: (treeId: number, colorId: number, data: { name: string; hex?: string | null }) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}/colors/${colorId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteFilamentTreeColor: (treeId: number, colorId: number) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}/colors/${colorId}`, { method: 'DELETE' }),
  deleteFilamentTree: (treeId: number) =>
    request<{ success: boolean }>(`/filament-trees/${treeId}`, { method: 'DELETE' }),
  // Filament profile manager
```

## Translation keys of the filamentTrees namespace (en key paths; placeholders after the key)
```regen: node tools/probe_ftree_i18n.cjs | sed -n '/^--- en values/,/^$/p' | grep -E '^(filamentTrees|nav)\.' | sed -E 's/ = .*  placeholders=(.*)$/  \1/; s/ = .*//'```
```
filamentTrees.addColour
filamentTrees.addMachine
filamentTrees.addNozzle
filamentTrees.allMachines  {{color}}
filamentTrees.anyMachine
filamentTrees.anyNozzle
filamentTrees.applyConfirm  {{n}}
filamentTrees.applyTargets
filamentTrees.applyToOthers
filamentTrees.applyValues
filamentTrees.baseFamily
filamentTrees.baseFamilyHint
filamentTrees.brand
filamentTrees.calibrationSource
filamentTrees.candidatesTitle
filamentTrees.colourCount  {{n}}
filamentTrees.colourHex
filamentTrees.colourHexOf  {{name}}
filamentTrees.colourName
filamentTrees.colourNameOf  {{name}}
filamentTrees.colourTotal_one  {{count}}
filamentTrees.colourTotal_other  {{count}}
filamentTrees.colours
filamentTrees.conflictsHint
filamentTrees.conflictsTitle
filamentTrees.createTree
filamentTrees.deleteTree  {{name}}
filamentTrees.deleteTreeBody  {{name}}
filamentTrees.duplicateTitle  {{name}}
filamentTrees.emptyBody
filamentTrees.emptyNone
filamentTrees.emptyTitle
filamentTrees.exportChanged  {{n}}
filamentTrees.exportOrca
filamentTrees.exportTree
filamentTrees.from  {{source}}
filamentTrees.fromBambu  {{machine}},{{nozzle}}
filamentTrees.history
filamentTrees.historyEmpty
filamentTrees.inStock  {{n}}
filamentTrees.include  {{name}}
filamentTrees.jsonNoProfile
filamentTrees.jsonTitle
filamentTrees.json_own
filamentTrees.json_ownHint
filamentTrees.json_profile
filamentTrees.json_profileHint
filamentTrees.json_resolved
filamentTrees.json_resolvedHint
filamentTrees.keepFenrir  {{value}}
filamentTrees.keepOrca  {{value}}
filamentTrees.machine
filamentTrees.machines
filamentTrees.material
filamentTrees.migrateConfirm
filamentTrees.migrateTitle
filamentTrees.migrated  {{n}}
filamentTrees.moreActions
filamentTrees.navLabel
filamentTrees.newColourHex
filamentTrees.newColourName
filamentTrees.newFilament
filamentTrees.no02
filamentTrees.notInTree  {{n}}
filamentTrees.nozzle
filamentTrees.nozzles
filamentTrees.orca.adaptivePa
filamentTrees.orca.adaptiveVol
filamentTrees.orca.adhesiveness
filamentTrees.orca.airFiltration
filamentTrees.orca.auxFan
filamentTrees.orca.basicInfo
filamentTrees.orca.bedTemp
filamentTrees.orca.chamberControl
filamentTrees.orca.chamberSec
filamentTrees.orca.chamberTemp
filamentTrees.orca.colourFromTree
filamentTrees.orca.compatPrinters
filamentTrees.orca.compatibleLeaf  {{machine}},{{nozzle}}
filamentTrees.orca.coolFirst
filamentTrees.orca.coolLast
filamentTrees.orca.coolingLayer
filamentTrees.orca.coolingMoves
filamentTrees.orca.defaultColor
filamentTrees.orca.delayUnload
filamentTrees.orca.density
filamentTrees.orca.deretractSpeed
filamentTrees.orca.diameter
filamentTrees.orca.dontSlowOuter
filamentTrees.orca.enablePa
filamentTrees.orca.endGcode
filamentTrees.orca.everyTarget
filamentTrees.orca.exhaustComplete
filamentTrees.orca.exhaustDuring
filamentTrees.orca.exhaustFan
filamentTrees.orca.extraRestart
filamentTrees.orca.fanSpeed
filamentTrees.orca.firstLayer
filamentTrees.orca.flowPa
filamentTrees.orca.flowRatio
filamentTrees.orca.forceOverhangCooling
filamentTrees.orca.fullFanLayer
filamentTrees.orca.idleTemp
filamentTrees.orca.interfaceTemp
filamentTrees.orca.internalBridgeFan
filamentTrees.orca.ironing
filamentTrees.orca.ironingFan
filamentTrees.orca.ironingFlow
filamentTrees.orca.ironingInset
filamentTrees.orca.ironingSpacing
filamentTrees.orca.ironingSpeed
filamentTrees.orca.keepFanOn
filamentTrees.orca.layerTime
filamentTrees.orca.length
filamentTrees.orca.liftAbove
filamentTrees.orca.liftBelow
filamentTrees.orca.load
filamentTrees.orca.loadStart
filamentTrees.orca.longRetractCut
filamentTrees.orca.longRetractEc
filamentTrees.orca.max
filamentTrees.orca.maxFanThreshold
filamentTrees.orca.maxVol
filamentTrees.orca.min
filamentTrees.orca.minFanThreshold
filamentTrees.orca.minPrintSpeed
filamentTrees.orca.minPurge
filamentTrees.orca.minimal
filamentTrees.orca.modified_one  {{count}}
filamentTrees.orca.modified_other  {{count}}
filamentTrees.orca.multiFilament
filamentTrees.orca.multiRamFlow
filamentTrees.orca.multiRamVol
filamentTrees.orca.multiRamming
filamentTrees.orca.noCoolingFirst
filamentTrees.orca.nozzle
filamentTrees.orca.nozzleBound
filamentTrees.orca.nozzleHrc
filamentTrees.orca.onSurfaces
filamentTrees.orca.other
filamentTrees.orca.otherLayers
filamentTrees.orca.overhangFanSpeed
filamentTrees.orca.overhangThreshold
filamentTrees.orca.overrideFor  {{field}}
filamentTrees.orca.pa
filamentTrees.orca.partFan
filamentTrees.orca.plateCool
filamentTrees.orca.plateEng
filamentTrees.orca.plateHot
filamentTrees.orca.plateSuperTack
filamentTrees.orca.plateTexturedCool
filamentTrees.orca.plateTexturedPei
filamentTrees.orca.preExtDist
filamentTrees.orca.preExtLen
filamentTrees.orca.price
filamentTrees.orca.printTemp
filamentTrees.orca.purgeLen
filamentTrees.orca.rammingLength
filamentTrees.orca.recNozzle
filamentTrees.orca.resetEmpty
filamentTrees.orca.resetTo  {{source}},{{value}}
filamentTrees.orca.retractAfterWipe
filamentTrees.orca.retractBeforeWipe
filamentTrees.orca.retractLayer
filamentTrees.orca.retractSpeed
filamentTrees.orca.retraction
filamentTrees.orca.retractionSwitch
filamentTrees.orca.roleGcode
filamentTrees.orca.shrinkXY
filamentTrees.orca.shrinkZ
filamentTrees.orca.slowDown
filamentTrees.orca.softening
filamentTrees.orca.soluble
filamentTrees.orca.stampDist
filamentTrees.orca.stampSpeed
filamentTrees.orca.startGcode
filamentTrees.orca.support
filamentTrees.orca.supportInterfaceFan
filamentTrees.orca.tabAdvanced
filamentTrees.orca.tabCooling
filamentTrees.orca.tabDependencies
filamentTrees.orca.tabFilament
filamentTrees.orca.tabMultimaterial
filamentTrees.orca.tabNotes
filamentTrees.orca.tabOverrides
filamentTrees.orca.tabs
filamentTrees.orca.target
filamentTrees.orca.toolChangeMulti
filamentTrees.orca.toolChangeSingle
filamentTrees.orca.toolchangeExtra
filamentTrees.orca.toolchangeLength
filamentTrees.orca.towerIroning
filamentTrees.orca.travelThreshold
filamentTrees.orca.type
filamentTrees.orca.unload
filamentTrees.orca.unloadStart
filamentTrees.orca.vendor
filamentTrees.orca.volSpeed
filamentTrees.orca.wipe
filamentTrees.orca.wipeDistance
filamentTrees.orca.wipeTower
filamentTrees.orca.zHopHeight
filamentTrees.orca.zHopType
filamentTrees.orcaConnect
filamentTrees.orcaNotConnected
filamentTrees.organise
filamentTrees.own
filamentTrees.ownCount_one  {{count}}
filamentTrees.ownCount_other  {{count}}
filamentTrees.ownHint
filamentTrees.paInvalid
filamentTrees.paK
filamentTrees.parentBambu
filamentTrees.parentValue  {{value}}
filamentTrees.path
filamentTrees.pendingExport  {{n}}
filamentTrees.pickNozzle
filamentTrees.removeColour  {{name}}
filamentTrees.removeColourBody  {{name}},{{tree}}
filamentTrees.revert
filamentTrees.saveTargets
filamentTrees.skip02
filamentTrees.skip02Auto
filamentTrees.skip02No
filamentTrees.skip02Yes
filamentTrees.sourceColour
filamentTrees.sourceReadOnly
filamentTrees.stat.applied
filamentTrees.stat.ignored
filamentTrees.stat.legacy
filamentTrees.stat.missing
filamentTrees.subtitle
filamentTrees.sync
filamentTrees.syncTitle
filamentTrees.targetsHint
filamentTrees.targetsTitle
filamentTrees.treeCreated
filamentTrees.useParent
filamentTrees.useParentFor  {{field}}
nav.filamentProfiles
```

## Translation keys the filament-tree UI reads (string literals, templates, orcaLayout L(...) labels)
```regen: grep -hoE "'(filamentTrees|filamentProfiles|nav|common)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\`filamentTrees\.[a-zA-Z0-9_.]*\$\{[^}]*\}[a-zA-Z0-9_.]*\`|L\('[a-zA-Z0-9_]+'\)" frontend/src/components/filament-trees/*.ts frontend/src/components/filament-trees/*.tsx frontend/src/pages/FilamentProfilesPage.tsx | sort -u```
```
'common.cancel'
'common.close'
'common.copied'
'common.copy'
'common.create'
'common.delete'
'common.duplicate'
'common.loading'
'common.name'
'common.retry'
'filamentProfiles.allBrands'
'filamentProfiles.basePresetLabel'
'filamentProfiles.extruder'
'filamentProfiles.noResults'
'filamentProfiles.primeVolume'
'filamentProfiles.searchPlaceholder'
'filamentProfiles.syncBase'
'filamentProfiles.syncToPc'
'filamentProfiles.syncZohoPrices'
'filamentProfiles.title'
'filamentTrees.addColour'
'filamentTrees.addMachine'
'filamentTrees.addNozzle'
'filamentTrees.allMachines'
'filamentTrees.anyMachine'
'filamentTrees.anyNozzle'
'filamentTrees.applyConfirm'
'filamentTrees.applyTargets'
'filamentTrees.applyToOthers'
'filamentTrees.applyValues'
'filamentTrees.baseFamily'
'filamentTrees.baseFamilyHint'
'filamentTrees.brand'
'filamentTrees.calibrationSource'
'filamentTrees.candidatesTitle'
'filamentTrees.colourCount'
'filamentTrees.colourHex'
'filamentTrees.colourHexOf'
'filamentTrees.colourName'
'filamentTrees.colourNameOf'
'filamentTrees.colourTotal'
'filamentTrees.colours'
'filamentTrees.conflictsHint'
'filamentTrees.conflictsTitle'
'filamentTrees.createTree'
'filamentTrees.deleteTree'
'filamentTrees.deleteTreeBody'
'filamentTrees.duplicateTitle'
'filamentTrees.emptyBody'
'filamentTrees.emptyNone'
'filamentTrees.emptyTitle'
'filamentTrees.exportChanged'
'filamentTrees.exportOrca'
'filamentTrees.exportTree'
'filamentTrees.from'
'filamentTrees.fromBambu'
'filamentTrees.history'
'filamentTrees.historyEmpty'
'filamentTrees.inStock'
'filamentTrees.include'
'filamentTrees.jsonNoProfile'
'filamentTrees.jsonTitle'
'filamentTrees.keepFenrir'
'filamentTrees.keepOrca'
'filamentTrees.machine'
'filamentTrees.machines'
'filamentTrees.material'
'filamentTrees.migrateConfirm'
'filamentTrees.migrateTitle'
'filamentTrees.migrated'
'filamentTrees.moreActions'
'filamentTrees.navLabel'
'filamentTrees.newColourHex'
'filamentTrees.newColourName'
'filamentTrees.newFilament'
'filamentTrees.no02'
'filamentTrees.notInTree'
'filamentTrees.nozzle'
'filamentTrees.nozzles'
'filamentTrees.orca.colourFromTree'
'filamentTrees.orca.compatPrinters'
'filamentTrees.orca.compatibleLeaf'
'filamentTrees.orca.everyTarget'
'filamentTrees.orca.modified'
'filamentTrees.orca.nozzleBound'
'filamentTrees.orca.other'
'filamentTrees.orca.overrideFor'
'filamentTrees.orca.resetEmpty'
'filamentTrees.orca.resetTo'
'filamentTrees.orca.tabDependencies'
'filamentTrees.orca.tabs'
'filamentTrees.orcaConnect'
'filamentTrees.orcaNotConnected'
'filamentTrees.organise'
'filamentTrees.ownCount'
'filamentTrees.ownHint'
'filamentTrees.paInvalid'
'filamentTrees.paK'
'filamentTrees.parentBambu'
'filamentTrees.parentValue'
'filamentTrees.path'
'filamentTrees.pendingExport'
'filamentTrees.pickNozzle'
'filamentTrees.removeColour'
'filamentTrees.removeColourBody'
'filamentTrees.revert'
'filamentTrees.saveTargets'
'filamentTrees.skip02'
'filamentTrees.skip02Auto'
'filamentTrees.skip02No'
'filamentTrees.skip02Yes'
'filamentTrees.sourceColour'
'filamentTrees.sourceReadOnly'
'filamentTrees.subtitle'
'filamentTrees.sync'
'filamentTrees.syncTitle'
'filamentTrees.targetsHint'
'filamentTrees.targetsTitle'
'filamentTrees.treeCreated'
'filamentTrees.useParentFor'
L('auxFan')
L('basicInfo')
L('bedTemp')
L('chamberSec')
L('coolingLayer')
L('endGcode')
L('exhaustFan')
L('flowPa')
L('ironing')
L('multiFilament')
L('partFan')
L('printTemp')
L('retraction')
L('retractionSwitch')
L('roleGcode')
L('startGcode')
L('tabAdvanced')
L('tabCooling')
L('tabDependencies')
L('tabFilament')
L('tabMultimaterial')
L('tabNotes')
L('tabOverrides')
L('toolChangeMulti')
L('toolChangeSingle')
L('volSpeed')
L('wipeTower')
```

## React Query hooks, keys and invalidations in the filament-tree components
```regen: grep -hoE 'useQuery|useMutation|useQueryClient|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel|refetch)Queries\([^)]*\)|setQueryData\([^,]*,' frontend/src/components/filament-trees/*.ts frontend/src/components/filament-trees/*.tsx frontend/src/pages/FilamentProfilesPage.tsx | sort -u```
```
invalidateQueries({ queryKey: ['filament-trees'] })
queryKey: ['filament-trees'
queryKey: ['filament-trees']
queryKey: ['filamentBasePresets']
queryKey: ['filamentPresets']
useMutation
useQuery
useQueryClient
```

## Wiring — router registration, page route, sidebar item, URL / storage state, importers
```regen: grep -nE "filament_trees" backend/app/main.py | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "FilamentProfilesPage|path=\"filament-profiles\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "filament-profiles" frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//" | sort -u; grep -hoE "useSearchParams|useParams|useNavigate|searchParams\.(get|set|delete)\([^)]*\)|localStorage\.(get|set|remove)Item\([^,)]*" frontend/src/pages/FilamentProfilesPage.tsx frontend/src/components/filament-trees/*.tsx | sort -u; grep -rlE "components/filament-trees/|pages/FilamentProfilesPage" frontend/src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ | sort | sed "s/^/imports the feature: /"```
```
filament_trees,
app.include_router(filament_trees.router, prefix=app_settings.api_prefix)
const FilamentProfilesPage = lazyWithReload(() => import('./pages/FilamentProfilesPage').then(m => ({ default: m.FilamentProfilesPage })));
<Route path="filament-profiles" element={<FilamentProfilesPage />} />
'filament-profiles': 'filaments:read',
{ id: 'filament-profiles', to: '/filament-profiles', icon: Droplets, labelKey: 'nav.filamentProfiles' },
localStorage.getItem(TAB_STORAGE_KEY
localStorage.setItem(TAB_STORAGE_KEY
useSearchParams
imports the feature: frontend/src/App.tsx
imports the feature: frontend/src/pages/FilamentProfilesPage.tsx
```

