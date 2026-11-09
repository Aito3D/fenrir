# SURFACE.md — notifications campaign (N1) public contract: the notifications stack (frozen at setup)

Regenerate with: `bash tools/gen_surface_notif.sh > SURFACE.md` (from the repo root).
Each section is replayable by the `regen:` command shown above it (repo root,
`LC_ALL=C`). Any diff against the committed copy is a change to something
outside the feature`s own internals — a route or its permission, a public
function signature, a request schema, a table column, a setting or permission
the feature reads, an exported symbol, an API client type or method, a
translation key, the wiring — and fails the iteration unless the user approved it.

## HTTP routes under /notifications, /notification-templates, /user-notifications: method, path, handler, doors
```regen: ./venv/bin/python3 tools/probe_notif_surface.py routes 2>/dev/null```
```
GET /api/v1/notifications/  -> list_notification_providers  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:read']"}; get_printer_scope_if_auth_enabled]
POST /api/v1/notifications/  -> create_notification_provider  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:create']"}; get_printer_scope_if_auth_enabled]
POST /api/v1/notifications/test-config  -> test_notification_config  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:create']"}; probe_permissions_if_auth_enabled.<locals>.checker; get_printer_scope_if_auth_enabled]
POST /api/v1/notifications/test-all  -> test_all_notification_providers  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:update']"}; get_printer_scope_if_auth_enabled]
GET /api/v1/notifications/logs  -> get_notification_logs  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:read']"}; get_printer_scope_if_auth_enabled]
GET /api/v1/notifications/logs/stats  -> get_notification_log_stats  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:read']"}; get_printer_scope_if_auth_enabled]
DELETE /api/v1/notifications/logs  -> clear_notification_logs  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:delete']"}; get_printer_scope_if_auth_enabled]
GET /api/v1/notifications/photos/{filename}  -> get_notification_photo  []
POST /api/v1/notifications/app-message  -> send_app_message  [get_db; require_api_key_scope.<locals>.permission_checker{'owner_needs_permission': 'True', 'scope_attr': 'can_send_notifications', 'scope_name': 'send_notifications', 'user_permission': 'notifications:update'}; get_printer_scope_if_auth_enabled]
GET /api/v1/notifications/app-message/channels  -> app_message_channels  [get_db; require_api_key_scope.<locals>.permission_checker{'owner_needs_permission': 'True', 'scope_attr': 'can_send_notifications', 'scope_name': 'send_notifications', 'user_permission': 'notifications:update'}; get_printer_scope_if_auth_enabled]
GET /api/v1/notifications/{provider_id}  -> get_notification_provider  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:read']"}; get_printer_scope_if_auth_enabled]
PATCH /api/v1/notifications/{provider_id}  -> update_notification_provider  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:update']"}; get_printer_scope_if_auth_enabled]
DELETE /api/v1/notifications/{provider_id}  -> delete_notification_provider  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:delete']"}; get_printer_scope_if_auth_enabled]
POST /api/v1/notifications/{provider_id}/test  -> test_notification_provider  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:update']"}; get_printer_scope_if_auth_enabled]
GET /api/v1/notification-templates/  -> get_templates  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:read']"}]
GET /api/v1/notification-templates  -> get_templates  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:read']"}]
GET /api/v1/notification-templates/variables  -> get_variables  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:read']"}]
GET /api/v1/notification-templates/{template_id}  -> get_template  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:read']"}]
PUT /api/v1/notification-templates/{template_id}  -> update_template  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:update']"}]
POST /api/v1/notification-templates/{template_id}/reset  -> reset_template  [get_db; require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:update']"}]
POST /api/v1/notification-templates/preview  -> preview_template  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notification_templates:read']"}]
GET /api/v1/user-notifications/preferences  -> get_user_email_preferences  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:user_email']"}; get_db]
PUT /api/v1/user-notifications/preferences  -> update_user_email_preferences  [require_permission_if_auth_enabled.<locals>.permission_checker{'perm_strings': "['notifications:user_email']"}; get_db]
```

## Route decorators and routers (the three route modules)
```regen: grep -HE '^@router\.(get|post|put|patch|delete)\(|^router = APIRouter' backend/app/api/routes/notifications.py backend/app/api/routes/notification_templates.py backend/app/api/routes/user_notifications.py | sed 's/, *$//'```
```
backend/app/api/routes/notifications.py:router = APIRouter(prefix="/notifications", tags=["notifications"])
backend/app/api/routes/notifications.py:@router.get("/", response_model=list[NotificationProviderResponse])
backend/app/api/routes/notifications.py:@router.post("/", response_model=NotificationProviderResponse)
backend/app/api/routes/notifications.py:@router.post("/test-config", response_model=NotificationTestResponse)
backend/app/api/routes/notifications.py:@router.post("/test-all")
backend/app/api/routes/notifications.py:@router.get("/logs", response_model=list[NotificationLogResponse])
backend/app/api/routes/notifications.py:@router.get("/logs/stats", response_model=NotificationLogStats)
backend/app/api/routes/notifications.py:@router.delete("/logs")
backend/app/api/routes/notifications.py:@router.get("/photos/{filename}")
backend/app/api/routes/notifications.py:@router.post("/app-message", response_model=AppMessageResult)
backend/app/api/routes/notifications.py:@router.get("/app-message/channels", response_model=list[AppMessageChannel])
backend/app/api/routes/notifications.py:@router.get("/{provider_id}", response_model=NotificationProviderResponse)
backend/app/api/routes/notifications.py:@router.patch("/{provider_id}", response_model=NotificationProviderResponse)
backend/app/api/routes/notifications.py:@router.delete("/{provider_id}")
backend/app/api/routes/notifications.py:@router.post("/{provider_id}/test", response_model=NotificationTestResponse)
backend/app/api/routes/notification_templates.py:router = APIRouter(prefix="/notification-templates", tags=["notification-templates"])
backend/app/api/routes/notification_templates.py:@router.get("", response_model=list[NotificationTemplateResponse])
backend/app/api/routes/notification_templates.py:@router.get("/", response_model=list[NotificationTemplateResponse])
backend/app/api/routes/notification_templates.py:@router.get("/variables", response_model=list[EventVariablesResponse])
backend/app/api/routes/notification_templates.py:@router.get("/{template_id}", response_model=NotificationTemplateResponse)
backend/app/api/routes/notification_templates.py:@router.put("/{template_id}", response_model=NotificationTemplateResponse)
backend/app/api/routes/notification_templates.py:@router.post("/{template_id}/reset", response_model=NotificationTemplateResponse)
backend/app/api/routes/notification_templates.py:@router.post("/preview", response_model=TemplatePreviewResponse)
backend/app/api/routes/user_notifications.py:router = APIRouter(prefix="/user-notifications", tags=["user-notifications"])
backend/app/api/routes/user_notifications.py:@router.get("/preferences", response_model=UserEmailPreferenceResponse)
backend/app/api/routes/user_notifications.py:@router.put("/preferences", response_model=UserEmailPreferenceResponse)
```

## Backend public functions, classes, methods and constants of the in-scope modules, with signatures
```regen: ./venv/bin/python3 tools/probe_notif_surface.py callables 2>/dev/null```
```
## backend.app.api.routes.notifications
async def after_providers_deleted(*, notify: bool) -> None
async def app_message_channels(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.core.auth.ScopedCaller = Depends(dependency=<function require_api_key_scope.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def clear_notification_logs(older_than_days: int = Query(30), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def create_notification_provider(provider_data: backend.app.schemas.notification.NotificationProviderCreate, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def delete_notification_provider(provider_id: int, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def delete_provider(db: sqlalchemy.ext.asyncio.session.AsyncSession, provider: backend.app.models.notification.NotificationProvider) -> bool
def forget_app_senders(api_key_ids=(), user_ids=()) -> None
async def get_notification_log_stats(days: int = Query(7), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def get_notification_logs(limit: int = Query(100), offset: int = Query(0), provider_id: int | None = Query(None), event_type: str | None = Query(None), success: bool | None = Query(None), days: int | None = Query(7), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def get_notification_photo(filename: str)
async def get_notification_provider(provider_id: int, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def list_notification_providers(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def send_app_message(data: backend.app.schemas.notification.AppMessage, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), caller: backend.app.core.auth.ScopedCaller = Depends(dependency=<function require_api_key_scope.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def test_all_notification_providers(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def test_notification_config(test_request: backend.app.schemas.notification.NotificationTestRequest, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), can_update: bool = Depends(dependency=<function probe_permissions_if_auth_enabled.<locals>.checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def test_notification_provider(provider_id: int, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))
async def update_notification_provider(provider_id: int, update_data: backend.app.schemas.notification.NotificationProviderUpdate, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), printer_scope: backend.app.core.printer_scope.PrinterScope = Depends(dependency=<function get_printer_scope_if_auth_enabled>, use_cache=True, scope=None))

## backend.app.api.routes.notification_templates
async def get_template(template_id: int, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))
async def get_templates(db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))
async def get_variables(_: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))
async def preview_template(request: backend.app.schemas.notification_template.TemplatePreviewRequest, _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))
async def reset_template(template_id: int, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))
async def update_template(template_id: int, update: backend.app.schemas.notification_template.NotificationTemplateUpdate, db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'), _: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None))

## backend.app.api.routes.user_notifications
async def get_user_email_preferences(current_user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))
async def update_user_email_preferences(data: backend.app.schemas.user_notifications.UserEmailPreferenceUpdate, current_user: backend.app.models.user.User | None = Depends(dependency=<function require_permission_if_auth_enabled.<locals>.permission_checker>, use_cache=True, scope=None), db: sqlalchemy.ext.asyncio.session.AsyncSession = Depends(dependency=<function get_db>, use_cache=True, scope='function'))

## backend.app.models.notification
class NotificationDigestQueue(Base)
    def __init__(self, **kwargs)
class NotificationLog(Base)
    def __init__(self, **kwargs)
class NotificationProvider(Base)
    def __init__(self, **kwargs)
class TelegramPendingVerdict(Base)
    def __init__(self, **kwargs)

## backend.app.models.notification_inbox
class AitoWatch(Base)
    def __init__(self, **kwargs)
class Notification(Base)
    def __init__(self, **kwargs)
class UserInboxPreference(Base)
    def __init__(self, **kwargs)

## backend.app.models.notification_live_activity
class NotificationLiveActivity(Base)
    def __init__(self, **kwargs)

## backend.app.models.notification_lock_screen_widget
class NotificationLockScreenWidget(Base)
    def __init__(self, **kwargs)

## backend.app.models.notification_template
class NotificationTemplate(Base)
    def __init__(self, **kwargs)

## backend.app.schemas.notification
class AppMessage(BaseModel)
class AppMessageChannel(BaseModel)
class AppMessageResult(BaseModel)
class NotificationLogResponse(BaseModel)
class NotificationLogStats(BaseModel)
class NotificationProviderBase(BaseModel)
    def validate_time_format(cls, v: str | None) -> str | None
class NotificationProviderCreate(NotificationProviderBase)
class NotificationProviderResponse(NotificationProviderBase)
    def validate_time_format(cls, v: str | None) -> str | None
class NotificationProviderUpdate(IgnoresNullForRequiredColumns)
    def validate_time_format(cls, v: str | None) -> str | None
class NotificationTestRequest(BaseModel)
class NotificationTestResponse(BaseModel)
class ProviderType(StrEnum)

## backend.app.schemas.notification_template
class EventType(StrEnum)
class EventVariablesResponse(BaseModel)
class NotificationTemplateBase(BaseModel)
class NotificationTemplateResponse(NotificationTemplateBase)
class NotificationTemplateUpdate(IgnoresNullForRequiredColumns)
class TemplatePreviewRequest(BaseModel)
class TemplatePreviewResponse(BaseModel)

## backend.app.schemas.user_notifications
class UserEmailPreferenceResponse(BaseModel)
class UserEmailPreferenceUpdate(IgnoresNullForRequiredColumns)

## backend.app.services.notification_service
class NotificationService(object)
    def __init__(self)
    async def check_and_send_digests(self)
    def clear_template_cache(self)
    async def close(self)
    async def on_ai_failure_detection(self, printer_id: int, printer_name: str, task_name: str, confidence: float | None, action: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, image_data: bytes | None = None, print_quality: int | None = None)
    async def on_aito_payment_received(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, *, project_id: int, client_name: str | None, reference: str | None, amount: int | float, currency: str, source: str) -> None
    async def on_ams_drying_suspended(self, printer_id: int, printer_name: str, ams_label: str, humidity: float, threshold: float, cycles: int, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_ams_ht_humidity_high(self, printer_id: int, printer_name: str, ams_label: str, humidity: float, threshold: float, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_ams_ht_temperature_high(self, printer_id: int, printer_name: str, ams_label: str, temperature: float, threshold: float, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_ams_humidity_high(self, printer_id: int, printer_name: str, ams_label: str, humidity: float, threshold: float, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_ams_temperature_high(self, printer_id: int, printer_name: str, ams_label: str, temperature: float, threshold: float, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_app_message(self, db: sqlalchemy.ext.asyncio.session.AsyncSession, *, sender: str, title: str, message: str, url: str | None = None, allowed: collections.abc.Callable[[backend.app.models.notification.NotificationProvider], bool] | None = None) -> int
    async def on_bed_cooled(self, printer_id: int, printer_name: str, bed_temp: float, threshold: float, filename: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_billing_charge_failed(self, printer_id: int, printer_name: str, filename: str, archive_id: int | None, error: str, db: sqlalchemy.ext.asyncio.session.AsyncSession) -> None
    async def on_filament_low(self, printer_id: int, printer_name: str, slot: str, remaining_percent: int, db: sqlalchemy.ext.asyncio.session.AsyncSession, color: str | None = None)
    async def on_first_layer_complete(self, printer_id: int, printer_name: str, filename: str, total_layers: int, db: sqlalchemy.ext.asyncio.session.AsyncSession, image_data: bytes | None = None)
    async def on_ha_sensor_alert(self, printer_id: int, printer_name: str, sensor_name: str, state: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_location_ha_sensor_alert(self, location_name: str, sensor_name: str, state: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_maintenance_due(self, printer_id: int, printer_name: str, maintenance_items: list[dict], db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_plate_clear_required(self, printer_id: int, printer_name: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_plate_not_empty(self, printer_id: int, printer_name: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, difference_percent: float | None = None, image_data: bytes | None = None)
    async def on_print_complete(self, printer_id: int, printer_name: str, status: str, data: dict, db: sqlalchemy.ext.asyncio.session.AsyncSession, archive_data: dict | None = None)
    async def on_print_confirm_request(self, printer_id: int, printer_name: str, data: dict, db: sqlalchemy.ext.asyncio.session.AsyncSession, archive_data: dict | None = None, good_url: str | None = None, reject_url: str | None = None, confirm_url: str | None = None, archive_id: int | None = None, run_id: int | None = None)
    async def on_print_missing_spool_assignment(self, printer_id: int, printer_name: str, missing_slots: list[dict[str, str]], db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_print_pause_upcoming(self, printer_id: int, printer_name: str, filename: str, *, minutes: int, layer: int, total_layers: int, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_print_progress(self, printer_id: int, printer_name: str, filename: str, progress: int, db: sqlalchemy.ext.asyncio.session.AsyncSession, remaining_time: int | None = None, image_data: bytes | None = None)
    async def on_print_start(self, printer_id: int, printer_name: str, data: dict, db: sqlalchemy.ext.asyncio.session.AsyncSession, archive_data: dict | None = None)
    async def on_printer_error(self, printer_id: int | None, printer_name: str, error_type: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, error_detail: str | None = None, image_data: bytes | None = None)
    async def on_printer_offline(self, printer_id: int, printer_name: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_queue_completed(self, completed_count: int, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_queue_job_added(self, job_name: str, target: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, printer_id: int | None = None, printer_name: str | None = None)
    async def on_queue_job_assigned(self, job_name: str, printer_id: int, printer_name: str, target_model: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_queue_job_failed(self, job_name: str, printer_id: int | None, printer_name: str | None, reason: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_queue_job_skipped(self, job_name: str, printer_id: int, printer_name: str, reason: str, db: sqlalchemy.ext.asyncio.session.AsyncSession)
    async def on_queue_job_started(self, job_name: str, printer_id: int, printer_name: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, estimated_time: int | None = None)
    async def on_queue_job_waiting(self, job_name: str, target_model: str, waiting_reason: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, printer_id: int | None = None)
    async def on_stock_break_alert(self, material: str, brand: str | None, stock_g: float, rate_g_day: float, days_left: int, lead_time_days: int, db: sqlalchemy.ext.asyncio.session.AsyncSession, *, subtype: str | None = None, color: str | None = None)
    async def on_stock_reorder_alert(self, material: str, brand: str | None, stock_g: float, rate_g_day: float, days_left: int, db: sqlalchemy.ext.asyncio.session.AsyncSession, *, subtype: str | None = None, color: str | None = None, skip_break_subscribers: bool = False)
    async def send_digest(self, provider_id: int)
    async def send_test_notification(self, provider_type: str, config: dict[str, typing.Any], db: sqlalchemy.ext.asyncio.session.AsyncSession | None = None, attach_photo: bool = True) -> tuple[bool, str]
    async def send_user_print_email(self, event_type: str, created_by_id: int | None, printer_name: str, filename: str, db: sqlalchemy.ext.asyncio.session.AsyncSession, image_data: bytes | None = None, finish_photo_url: str | None = None) -> None
    def start_digest_scheduler(self)
    def stop_digest_scheduler(self)
notification_service: NotificationService
def telegram_markdown_escape(message: str) -> str

## backend.app.services.notify_client
class NotifyClient(object)
    def __init__(self, client: httpx.AsyncClient)
    async def create_widget(self, device_id: str, token: str, content: dict) -> dict
    async def delete_widget(self, widget_id: str, token: str) -> dict
    async def end_activity(self, activity_id: str, token: str, content: dict | None = None) -> dict
    async def get_activity(self, activity_id: str, token: str) -> dict
    async def list_widgets(self, device_id: str, token: str) -> dict
    async def send_notification(self, device_id: str, token: str, *, title: str, text: str, group_type: str | None = None, icon_url: str | None = None, image_url: str | None = None, time_sensitive: bool = False) -> dict
    async def start_activity(self, device_id: str, token: str, content: dict) -> dict
    async def update_activity(self, activity_id: str, token: str, content: dict) -> dict
    async def update_widget(self, widget_id: str, token: str, content: dict) -> dict
    async def validate(self, device_id: str, token: str) -> dict
class NotifyError(Exception)
    def __init__(self, message: str, *, status_code: int | None = None, payload: dict | None = None, retry_after_seconds: int | None = None, delivery_state: str | None = None)
def notify_credentials(config: dict) -> tuple[str, str]
def notify_supports_photos(device_id: Any) -> bool

## backend.app.services.notify_live_activities
class NotifyLiveActivityService(NotifyWorkerLifecycle)
    def __init__(self, session_factory=None, client=None)
    async def cleanup_provider(self, provider_id: int, old_config: dict, *, captured_rows=None) -> None
    def forget_printer(self, printer_id: int) -> None
    def observe(self, printer_id: int, state) -> None
    def print_finished(self, printer_id: int, data: dict) -> None
    def print_started(self, printer_id: int, state, data: dict | None = None) -> None
    async def tick(self) -> None
class PrintSnapshot(object)
    def __init__(self, key: str, connected: bool, state: str, filename: str, progress: float, remaining_seconds: int, layer: int, layers: int, job_key: str | None = None, fault: str | None = None, temperatures: tuple = (), stage: int = -1) -> None
    def content(self, printer_name: str, config: dict | None = None) -> dict
    def from_state(cls, state)
notify_live_activities: NotifyLiveActivityService

## backend.app.services.notify_widgets
class NotifyWidgetService(NotifyWorkerLifecycle)
    def __init__(self, session_factory=None, client=None, state_getter=None)
    async def cleanup_provider(self, provider_id: int, old_config: dict, *, captured_rows=None)
    def providers_changed(self)
    async def tick(self)
notify_widgets: NotifyWidgetService
def widget_content(printer_name: str, state) -> dict

## backend.app.services.notify_worker
class NotifyWorkerLifecycle(object)
    async def close(self)
    def providers_changed(self)
    async def schedule_cleanup(self, provider_id, old_config)
    def start(self)

## backend.app.services.spool_assignment_notifications
async def notify_missing_spool_assignments_on_print_complete(printer_id: int, missing_global_trays: list[int], db, logger: logging.Logger) -> None
async def notify_missing_spool_assignments_on_print_start(printer_id: int, data: dict, logger: logging.Logger) -> None

## backend.app.utils.notification_photos
def find_notification_photo(filename: 'str') -> 'Path | None'
def notification_photos_dir() -> 'Path'
def save_notification_photo(image_data: 'bytes', event_type: 'str') -> 'str'

```

## Pydantic schemas (schemas/notification.py, notification_template.py, user_notifications.py): fields, types, defaults
```regen: ./venv/bin/python3 tools/probe_notif_surface.py schemas 2>/dev/null```
```
## backend.app.schemas.notification
class AppMessage(BaseModel)
    title: <class 'str'>  required
    message: <class 'str'>  required
    url: str | None  default=None
class AppMessageChannel(BaseModel)
    name: <class 'str'>  required
    provider_type: <class 'str'>  required
class AppMessageResult(BaseModel)
    channels: <class 'int'>  required
class NotificationLogResponse(BaseModel)
    id: <class 'int'>  required
    provider_id: <class 'int'>  required
    provider_name: str | None  default=None
    provider_type: str | None  default=None
    event_type: <class 'str'>  required
    title: <class 'str'>  required
    message: <class 'str'>  required
    success: <class 'bool'>  required
    error_message: str | None  default=None
    printer_id: int | None  default=None
    printer_name: str | None  default=None
    created_at: <class 'datetime.datetime'>  required
class NotificationLogStats(BaseModel)
    total: <class 'int'>  required
    success_count: <class 'int'>  required
    failure_count: <class 'int'>  required
    by_event_type: dict[str, int]  required
    by_provider: dict[str, int]  required
class NotificationProviderBase(BaseModel)
    name: <class 'str'>  required
    provider_type: <enum 'ProviderType'>  required
    enabled: <class 'bool'>  default=True
    config: dict[str, typing.Any]  required
    attach_photo: <class 'bool'>  default=True
    on_print_start: <class 'bool'>  default=False
    on_print_complete: <class 'bool'>  default=True
    on_print_failed: <class 'bool'>  default=True
    on_print_stopped: <class 'bool'>  default=True
    on_print_progress: <class 'bool'>  default=False
    on_print_missing_spool_assignment: <class 'bool'>  default=False
    on_billing_charge_failed: <class 'bool'>  default=True
    on_aito_payment_received: <class 'bool'>  default=False
    on_printer_offline: <class 'bool'>  default=False
    on_printer_error: <class 'bool'>  default=False
    on_ai_failure_detection: <class 'bool'>  default=False
    on_filament_low: <class 'bool'>  default=False
    on_maintenance_due: <class 'bool'>  default=False
    on_ams_humidity_high: <class 'bool'>  default=False
    on_ams_temperature_high: <class 'bool'>  default=False
    on_ams_drying_suspended: <class 'bool'>  default=True
    on_ams_ht_humidity_high: <class 'bool'>  default=False
    on_ams_ht_temperature_high: <class 'bool'>  default=False
    on_ha_sensor_alert: <class 'bool'>  default=False
    on_location_ha_sensor_alert: <class 'bool'>  default=False
    on_plate_not_empty: <class 'bool'>  default=True
    on_plate_clear_required: <class 'bool'>  default=False
    on_print_confirm_request: <class 'bool'>  default=True
    telegram_verdict_mode: typing.Literal['buttons', 'reactions', 'both']  default='buttons'
    on_bed_cooled: <class 'bool'>  default=False
    on_first_layer_complete: <class 'bool'>  default=False
    on_print_pause_upcoming: <class 'bool'>  default=False
    on_app_message: <class 'bool'>  default=False
    on_stock_reorder_alert: <class 'bool'>  default=False
    on_stock_break_alert: <class 'bool'>  default=False
    on_queue_job_added: <class 'bool'>  default=False
    on_queue_job_assigned: <class 'bool'>  default=False
    on_queue_job_started: <class 'bool'>  default=False
    on_queue_job_waiting: <class 'bool'>  default=True
    on_queue_job_skipped: <class 'bool'>  default=True
    on_queue_job_failed: <class 'bool'>  default=True
    on_queue_completed: <class 'bool'>  default=False
    quiet_hours_enabled: <class 'bool'>  default=False
    quiet_hours_start: str | None  default=None
    quiet_hours_end: str | None  default=None
    daily_digest_enabled: <class 'bool'>  default=False
    daily_digest_time: str | None  default=None
    printer_id: int | None  default=None
class NotificationProviderCreate(NotificationProviderBase)
    name: <class 'str'>  required
    provider_type: <enum 'ProviderType'>  required
    enabled: <class 'bool'>  default=True
    config: dict[str, typing.Any]  required
    attach_photo: <class 'bool'>  default=True
    on_print_start: <class 'bool'>  default=False
    on_print_complete: <class 'bool'>  default=True
    on_print_failed: <class 'bool'>  default=True
    on_print_stopped: <class 'bool'>  default=True
    on_print_progress: <class 'bool'>  default=False
    on_print_missing_spool_assignment: <class 'bool'>  default=False
    on_billing_charge_failed: <class 'bool'>  default=True
    on_aito_payment_received: <class 'bool'>  default=False
    on_printer_offline: <class 'bool'>  default=False
    on_printer_error: <class 'bool'>  default=False
    on_ai_failure_detection: <class 'bool'>  default=False
    on_filament_low: <class 'bool'>  default=False
    on_maintenance_due: <class 'bool'>  default=False
    on_ams_humidity_high: <class 'bool'>  default=False
    on_ams_temperature_high: <class 'bool'>  default=False
    on_ams_drying_suspended: <class 'bool'>  default=True
    on_ams_ht_humidity_high: <class 'bool'>  default=False
    on_ams_ht_temperature_high: <class 'bool'>  default=False
    on_ha_sensor_alert: <class 'bool'>  default=False
    on_location_ha_sensor_alert: <class 'bool'>  default=False
    on_plate_not_empty: <class 'bool'>  default=True
    on_plate_clear_required: <class 'bool'>  default=False
    on_print_confirm_request: <class 'bool'>  default=True
    telegram_verdict_mode: typing.Literal['buttons', 'reactions', 'both']  default='buttons'
    on_bed_cooled: <class 'bool'>  default=False
    on_first_layer_complete: <class 'bool'>  default=False
    on_print_pause_upcoming: <class 'bool'>  default=False
    on_app_message: <class 'bool'>  default=False
    on_stock_reorder_alert: <class 'bool'>  default=False
    on_stock_break_alert: <class 'bool'>  default=False
    on_queue_job_added: <class 'bool'>  default=False
    on_queue_job_assigned: <class 'bool'>  default=False
    on_queue_job_started: <class 'bool'>  default=False
    on_queue_job_waiting: <class 'bool'>  default=True
    on_queue_job_skipped: <class 'bool'>  default=True
    on_queue_job_failed: <class 'bool'>  default=True
    on_queue_completed: <class 'bool'>  default=False
    quiet_hours_enabled: <class 'bool'>  default=False
    quiet_hours_start: str | None  default=None
    quiet_hours_end: str | None  default=None
    daily_digest_enabled: <class 'bool'>  default=False
    daily_digest_time: str | None  default=None
    printer_id: int | None  default=None
class NotificationProviderResponse(NotificationProviderBase)
    name: <class 'str'>  required
    provider_type: <enum 'ProviderType'>  required
    enabled: <class 'bool'>  default=True
    config: dict[str, typing.Any]  required
    attach_photo: <class 'bool'>  default=True
    on_print_start: <class 'bool'>  default=False
    on_print_complete: <class 'bool'>  default=True
    on_print_failed: <class 'bool'>  default=True
    on_print_stopped: <class 'bool'>  default=True
    on_print_progress: <class 'bool'>  default=False
    on_print_missing_spool_assignment: <class 'bool'>  default=False
    on_billing_charge_failed: <class 'bool'>  default=True
    on_aito_payment_received: <class 'bool'>  default=False
    on_printer_offline: <class 'bool'>  default=False
    on_printer_error: <class 'bool'>  default=False
    on_ai_failure_detection: <class 'bool'>  default=False
    on_filament_low: <class 'bool'>  default=False
    on_maintenance_due: <class 'bool'>  default=False
    on_ams_humidity_high: <class 'bool'>  default=False
    on_ams_temperature_high: <class 'bool'>  default=False
    on_ams_drying_suspended: <class 'bool'>  default=True
    on_ams_ht_humidity_high: <class 'bool'>  default=False
    on_ams_ht_temperature_high: <class 'bool'>  default=False
    on_ha_sensor_alert: <class 'bool'>  default=False
    on_location_ha_sensor_alert: <class 'bool'>  default=False
    on_plate_not_empty: <class 'bool'>  default=True
    on_plate_clear_required: <class 'bool'>  default=False
    on_print_confirm_request: <class 'bool'>  default=True
    telegram_verdict_mode: typing.Literal['buttons', 'reactions', 'both']  default='buttons'
    on_bed_cooled: <class 'bool'>  default=False
    on_first_layer_complete: <class 'bool'>  default=False
    on_print_pause_upcoming: <class 'bool'>  default=False
    on_app_message: <class 'bool'>  default=False
    on_stock_reorder_alert: <class 'bool'>  default=False
    on_stock_break_alert: <class 'bool'>  default=False
    on_queue_job_added: <class 'bool'>  default=False
    on_queue_job_assigned: <class 'bool'>  default=False
    on_queue_job_started: <class 'bool'>  default=False
    on_queue_job_waiting: <class 'bool'>  default=True
    on_queue_job_skipped: <class 'bool'>  default=True
    on_queue_job_failed: <class 'bool'>  default=True
    on_queue_completed: <class 'bool'>  default=False
    quiet_hours_enabled: <class 'bool'>  default=False
    quiet_hours_start: str | None  default=None
    quiet_hours_end: str | None  default=None
    daily_digest_enabled: <class 'bool'>  default=False
    daily_digest_time: str | None  default=None
    printer_id: int | None  default=None
    id: <class 'int'>  required
    last_success: datetime.datetime | None  default=None
    last_error: str | None  default=None
    last_error_at: datetime.datetime | None  default=None
    created_at: <class 'datetime.datetime'>  required
    updated_at: <class 'datetime.datetime'>  required
class NotificationProviderUpdate(IgnoresNullForRequiredColumns)
    name: str | None  default=None
    provider_type: backend.app.schemas.notification.ProviderType | None  default=None
    enabled: bool | None  default=None
    config: dict[str, typing.Any] | None  default=None
    attach_photo: bool | None  default=None
    on_print_start: bool | None  default=None
    on_print_complete: bool | None  default=None
    on_print_failed: bool | None  default=None
    on_print_stopped: bool | None  default=None
    on_print_progress: bool | None  default=None
    on_print_missing_spool_assignment: bool | None  default=None
    on_billing_charge_failed: bool | None  default=None
    on_aito_payment_received: bool | None  default=None
    on_printer_offline: bool | None  default=None
    on_printer_error: bool | None  default=None
    on_ai_failure_detection: bool | None  default=None
    on_filament_low: bool | None  default=None
    on_maintenance_due: bool | None  default=None
    on_ams_humidity_high: bool | None  default=None
    on_ams_temperature_high: bool | None  default=None
    on_ams_drying_suspended: bool | None  default=None
    on_ams_ht_humidity_high: bool | None  default=None
    on_ams_ht_temperature_high: bool | None  default=None
    on_ha_sensor_alert: bool | None  default=None
    on_location_ha_sensor_alert: bool | None  default=None
    on_plate_not_empty: bool | None  default=None
    on_plate_clear_required: bool | None  default=None
    on_print_confirm_request: bool | None  default=None
    telegram_verdict_mode: typing.Optional[typing.Literal['buttons', 'reactions', 'both']]  default=None
    on_bed_cooled: bool | None  default=None
    on_first_layer_complete: bool | None  default=None
    on_print_pause_upcoming: bool | None  default=None
    on_app_message: bool | None  default=None
    on_stock_reorder_alert: bool | None  default=None
    on_stock_break_alert: bool | None  default=None
    on_queue_job_added: bool | None  default=None
    on_queue_job_assigned: bool | None  default=None
    on_queue_job_started: bool | None  default=None
    on_queue_job_waiting: bool | None  default=None
    on_queue_job_skipped: bool | None  default=None
    on_queue_job_failed: bool | None  default=None
    on_queue_completed: bool | None  default=None
    quiet_hours_enabled: bool | None  default=None
    quiet_hours_start: str | None  default=None
    quiet_hours_end: str | None  default=None
    daily_digest_enabled: bool | None  default=None
    daily_digest_time: str | None  default=None
    printer_id: int | None  default=None
class NotificationTestRequest(BaseModel)
    provider_type: <enum 'ProviderType'>  required
    config: dict[str, typing.Any]  required
    attach_photo: <class 'bool'>  default=True
    provider_id: int | None  default=None
class NotificationTestResponse(BaseModel)
    success: <class 'bool'>  required
    message: <class 'str'>  required

## backend.app.schemas.notification_template
class EventVariablesResponse(BaseModel)
    event_type: <class 'str'>  required
    event_name: <class 'str'>  required
    variables: list[str]  required
    supports_photo: <class 'bool'>  default=False
class NotificationTemplateBase(BaseModel)
    title_template: <class 'str'>  required
    body_template: <class 'str'>  required
class NotificationTemplateResponse(NotificationTemplateBase)
    title_template: <class 'str'>  required
    body_template: <class 'str'>  required
    id: <class 'int'>  required
    event_type: <class 'str'>  required
    name: <class 'str'>  required
    is_default: <class 'bool'>  required
    created_at: <class 'datetime.datetime'>  required
    updated_at: <class 'datetime.datetime'>  required
class NotificationTemplateUpdate(IgnoresNullForRequiredColumns)
    title_template: str | None  default=None
    body_template: str | None  default=None
class TemplatePreviewRequest(BaseModel)
    event_type: <class 'str'>  required
    title_template: <class 'str'>  required
    body_template: <class 'str'>  required
class TemplatePreviewResponse(BaseModel)
    title: <class 'str'>  required
    body: <class 'str'>  required

## backend.app.schemas.user_notifications
class UserEmailPreferenceResponse(BaseModel)
    notify_print_start: <class 'bool'>  required
    notify_print_complete: <class 'bool'>  required
    notify_print_failed: <class 'bool'>  required
    notify_print_stopped: <class 'bool'>  required
class UserEmailPreferenceUpdate(IgnoresNullForRequiredColumns)
    notify_print_start: <class 'bool'>  required
    notify_print_complete: <class 'bool'>  required
    notify_print_failed: <class 'bool'>  required
    notify_print_stopped: <class 'bool'>  required

```

## Tables the in-scope models own — DDL, SQLite and PostgreSQL
```regen: ./venv/bin/python3 tools/probe_notif_surface.py ddl 2>/dev/null```
```
-- sqlite
CREATE TABLE aito_watches (
	id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	kinds_json JSON, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_aito_watch_user_project UNIQUE (user_id, project_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_aito_watches_project_id ON aito_watches (project_id);
CREATE INDEX ix_aito_watches_user_id ON aito_watches (user_id);
-- postgresql
CREATE TABLE aito_watches (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	project_id INTEGER NOT NULL, 
	kinds_json JSON, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_aito_watch_user_project UNIQUE (user_id, project_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_aito_watches_project_id ON aito_watches (project_id);
CREATE INDEX ix_aito_watches_user_id ON aito_watches (user_id);

-- sqlite
CREATE TABLE notification_digest_queue (
	id INTEGER NOT NULL, 
	provider_id INTEGER NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	message TEXT NOT NULL, 
	printer_id INTEGER, 
	printer_name VARCHAR(100), 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE SET NULL
);
CREATE INDEX ix_notification_digest_queue_created_at ON notification_digest_queue (created_at);
CREATE INDEX ix_notification_digest_queue_id ON notification_digest_queue (id);
-- postgresql
CREATE TABLE notification_digest_queue (
	id SERIAL NOT NULL, 
	provider_id INTEGER NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	message TEXT NOT NULL, 
	printer_id INTEGER, 
	printer_name VARCHAR(100), 
	created_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE SET NULL
);
CREATE INDEX ix_notification_digest_queue_created_at ON notification_digest_queue (created_at);
CREATE INDEX ix_notification_digest_queue_id ON notification_digest_queue (id);

-- sqlite
CREATE TABLE notification_live_activities (
	id INTEGER NOT NULL, 
	provider_id INTEGER NOT NULL, 
	printer_id INTEGER NOT NULL, 
	print_key VARCHAR(200) NOT NULL, 
	job_key VARCHAR(160), 
	print_name VARCHAR(255) NOT NULL, 
	eta_seconds INTEGER, 
	eta_deadline DATETIME, 
	credential_key VARCHAR(64) NOT NULL, 
	activity_id VARCHAR(16), 
	state VARCHAR(20) NOT NULL, 
	end_reason VARCHAR(40), 
	failures INTEGER NOT NULL, 
	content TEXT NOT NULL, 
	expires_at DATETIME, 
	next_attempt_at DATETIME, 
	last_sent_at DATETIME, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (provider_id, printer_id, print_key), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_live_activities_printer_id ON notification_live_activities (printer_id);
CREATE INDEX ix_notification_live_activities_provider_id ON notification_live_activities (provider_id);
-- postgresql
CREATE TABLE notification_live_activities (
	id SERIAL NOT NULL, 
	provider_id INTEGER NOT NULL, 
	printer_id INTEGER NOT NULL, 
	print_key VARCHAR(200) NOT NULL, 
	job_key VARCHAR(160), 
	print_name VARCHAR(255) NOT NULL, 
	eta_seconds INTEGER, 
	eta_deadline TIMESTAMP WITHOUT TIME ZONE, 
	credential_key VARCHAR(64) NOT NULL, 
	activity_id VARCHAR(16), 
	state VARCHAR(20) NOT NULL, 
	end_reason VARCHAR(40), 
	failures INTEGER NOT NULL, 
	content TEXT NOT NULL, 
	expires_at TIMESTAMP WITHOUT TIME ZONE, 
	next_attempt_at TIMESTAMP WITHOUT TIME ZONE, 
	last_sent_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (provider_id, printer_id, print_key), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_live_activities_printer_id ON notification_live_activities (printer_id);
CREATE INDEX ix_notification_live_activities_provider_id ON notification_live_activities (provider_id);

-- sqlite
CREATE TABLE notification_lock_screen_widgets (
	id INTEGER NOT NULL, 
	provider_id INTEGER NOT NULL, 
	printer_id INTEGER NOT NULL, 
	credential_key VARCHAR(64) NOT NULL, 
	widget_id VARCHAR(16), 
	state VARCHAR(20) NOT NULL, 
	content TEXT NOT NULL, 
	failures INTEGER NOT NULL, 
	next_attempt_at DATETIME, 
	last_sent_at DATETIME, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (provider_id, printer_id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_lock_screen_widgets_printer_id ON notification_lock_screen_widgets (printer_id);
CREATE INDEX ix_notification_lock_screen_widgets_provider_id ON notification_lock_screen_widgets (provider_id);
-- postgresql
CREATE TABLE notification_lock_screen_widgets (
	id SERIAL NOT NULL, 
	provider_id INTEGER NOT NULL, 
	printer_id INTEGER NOT NULL, 
	credential_key VARCHAR(64) NOT NULL, 
	widget_id VARCHAR(16), 
	state VARCHAR(20) NOT NULL, 
	content TEXT NOT NULL, 
	failures INTEGER NOT NULL, 
	next_attempt_at TIMESTAMP WITHOUT TIME ZONE, 
	last_sent_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (provider_id, printer_id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_lock_screen_widgets_printer_id ON notification_lock_screen_widgets (printer_id);
CREATE INDEX ix_notification_lock_screen_widgets_provider_id ON notification_lock_screen_widgets (provider_id);

-- sqlite
CREATE TABLE notification_logs (
	id INTEGER NOT NULL, 
	provider_id INTEGER NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	message TEXT NOT NULL, 
	success BOOLEAN, 
	error_message TEXT, 
	printer_id INTEGER, 
	printer_name VARCHAR(100), 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE SET NULL
);
CREATE INDEX ix_notification_logs_created_at ON notification_logs (created_at);
CREATE INDEX ix_notification_logs_id ON notification_logs (id);
-- postgresql
CREATE TABLE notification_logs (
	id SERIAL NOT NULL, 
	provider_id INTEGER NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	message TEXT NOT NULL, 
	success BOOLEAN, 
	error_message TEXT, 
	printer_id INTEGER, 
	printer_name VARCHAR(100), 
	created_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE SET NULL
);
CREATE INDEX ix_notification_logs_created_at ON notification_logs (created_at);
CREATE INDEX ix_notification_logs_id ON notification_logs (id);

-- sqlite
CREATE TABLE notification_providers (
	id INTEGER NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	provider_type VARCHAR(50) NOT NULL, 
	enabled BOOLEAN, 
	config TEXT NOT NULL, 
	attach_photo BOOLEAN DEFAULT 1, 
	on_print_start BOOLEAN, 
	on_print_complete BOOLEAN, 
	on_print_failed BOOLEAN, 
	on_print_stopped BOOLEAN, 
	on_print_progress BOOLEAN, 
	on_print_missing_spool_assignment BOOLEAN, 
	on_billing_charge_failed BOOLEAN DEFAULT 1, 
	on_aito_payment_received BOOLEAN, 
	on_printer_offline BOOLEAN, 
	on_printer_error BOOLEAN, 
	on_ai_failure_detection BOOLEAN DEFAULT 0, 
	on_filament_low BOOLEAN, 
	on_maintenance_due BOOLEAN, 
	on_ams_humidity_high BOOLEAN, 
	on_ams_temperature_high BOOLEAN, 
	on_ams_drying_suspended BOOLEAN DEFAULT 1, 
	on_ams_ht_humidity_high BOOLEAN, 
	on_ams_ht_temperature_high BOOLEAN, 
	on_ha_sensor_alert BOOLEAN DEFAULT 0, 
	on_location_ha_sensor_alert BOOLEAN DEFAULT 0, 
	on_plate_not_empty BOOLEAN, 
	on_plate_clear_required BOOLEAN DEFAULT 0, 
	on_print_confirm_request BOOLEAN DEFAULT 1, 
	telegram_verdict_mode VARCHAR(16) DEFAULT 'buttons', 
	on_bed_cooled BOOLEAN, 
	on_first_layer_complete BOOLEAN, 
	on_print_pause_upcoming BOOLEAN DEFAULT 0, 
	on_app_message BOOLEAN DEFAULT 0, 
	on_stock_reorder_alert BOOLEAN DEFAULT 0, 
	on_stock_break_alert BOOLEAN DEFAULT 0, 
	on_queue_job_added BOOLEAN, 
	on_queue_job_assigned BOOLEAN, 
	on_queue_job_started BOOLEAN, 
	on_queue_job_waiting BOOLEAN, 
	on_queue_job_skipped BOOLEAN, 
	on_queue_job_failed BOOLEAN, 
	on_queue_completed BOOLEAN, 
	quiet_hours_enabled BOOLEAN, 
	quiet_hours_start VARCHAR(5), 
	quiet_hours_end VARCHAR(5), 
	daily_digest_enabled BOOLEAN, 
	daily_digest_time VARCHAR(5), 
	printer_id INTEGER, 
	last_success DATETIME, 
	last_error TEXT, 
	last_error_at DATETIME, 
	created_at DATETIME, 
	updated_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_providers_id ON notification_providers (id);
-- postgresql
CREATE TABLE notification_providers (
	id SERIAL NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	provider_type VARCHAR(50) NOT NULL, 
	enabled BOOLEAN, 
	config TEXT NOT NULL, 
	attach_photo BOOLEAN DEFAULT true, 
	on_print_start BOOLEAN, 
	on_print_complete BOOLEAN, 
	on_print_failed BOOLEAN, 
	on_print_stopped BOOLEAN, 
	on_print_progress BOOLEAN, 
	on_print_missing_spool_assignment BOOLEAN, 
	on_billing_charge_failed BOOLEAN DEFAULT true, 
	on_aito_payment_received BOOLEAN, 
	on_printer_offline BOOLEAN, 
	on_printer_error BOOLEAN, 
	on_ai_failure_detection BOOLEAN DEFAULT false, 
	on_filament_low BOOLEAN, 
	on_maintenance_due BOOLEAN, 
	on_ams_humidity_high BOOLEAN, 
	on_ams_temperature_high BOOLEAN, 
	on_ams_drying_suspended BOOLEAN DEFAULT true, 
	on_ams_ht_humidity_high BOOLEAN, 
	on_ams_ht_temperature_high BOOLEAN, 
	on_ha_sensor_alert BOOLEAN DEFAULT false, 
	on_location_ha_sensor_alert BOOLEAN DEFAULT false, 
	on_plate_not_empty BOOLEAN, 
	on_plate_clear_required BOOLEAN DEFAULT false, 
	on_print_confirm_request BOOLEAN DEFAULT true, 
	telegram_verdict_mode VARCHAR(16) DEFAULT 'buttons', 
	on_bed_cooled BOOLEAN, 
	on_first_layer_complete BOOLEAN, 
	on_print_pause_upcoming BOOLEAN DEFAULT false, 
	on_app_message BOOLEAN DEFAULT false, 
	on_stock_reorder_alert BOOLEAN DEFAULT false, 
	on_stock_break_alert BOOLEAN DEFAULT false, 
	on_queue_job_added BOOLEAN, 
	on_queue_job_assigned BOOLEAN, 
	on_queue_job_started BOOLEAN, 
	on_queue_job_waiting BOOLEAN, 
	on_queue_job_skipped BOOLEAN, 
	on_queue_job_failed BOOLEAN, 
	on_queue_completed BOOLEAN, 
	quiet_hours_enabled BOOLEAN, 
	quiet_hours_start VARCHAR(5), 
	quiet_hours_end VARCHAR(5), 
	daily_digest_enabled BOOLEAN, 
	daily_digest_time VARCHAR(5), 
	printer_id INTEGER, 
	last_success TIMESTAMP WITHOUT TIME ZONE, 
	last_error TEXT, 
	last_error_at TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE, 
	updated_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(printer_id) REFERENCES printers (id) ON DELETE CASCADE
);
CREATE INDEX ix_notification_providers_id ON notification_providers (id);

-- sqlite
CREATE TABLE notification_templates (
	id INTEGER NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	title_template TEXT NOT NULL, 
	body_template TEXT NOT NULL, 
	is_default BOOLEAN NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (event_type)
);
CREATE INDEX ix_notification_templates_id ON notification_templates (id);
-- postgresql
CREATE TABLE notification_templates (
	id SERIAL NOT NULL, 
	event_type VARCHAR(50) NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	title_template TEXT NOT NULL, 
	body_template TEXT NOT NULL, 
	is_default BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (event_type)
);
CREATE INDEX ix_notification_templates_id ON notification_templates (id);

-- sqlite
CREATE TABLE notifications (
	id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	kind VARCHAR(40) NOT NULL, 
	family VARCHAR(16) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body VARCHAR(500) NOT NULL, 
	target_type VARCHAR(32), 
	target_id INTEGER, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	read_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_notifications_user_id ON notifications (user_id);
-- postgresql
CREATE TABLE notifications (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	kind VARCHAR(40) NOT NULL, 
	family VARCHAR(16) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	body VARCHAR(500) NOT NULL, 
	target_type VARCHAR(32), 
	target_id INTEGER, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	read_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX ix_notifications_user_id ON notifications (user_id);

-- sqlite
CREATE TABLE telegram_pending_verdicts (
	id INTEGER NOT NULL, 
	provider_id INTEGER NOT NULL, 
	chat_id VARCHAR(64) NOT NULL, 
	message_id INTEGER NOT NULL, 
	archive_id INTEGER NOT NULL, 
	confirm_token VARCHAR(64), 
	has_caption BOOLEAN, 
	message_text TEXT, 
	created_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(archive_id) REFERENCES print_archives (id) ON DELETE CASCADE
);
CREATE INDEX ix_telegram_pending_verdicts_created_at ON telegram_pending_verdicts (created_at);
CREATE INDEX ix_telegram_pending_verdicts_id ON telegram_pending_verdicts (id);
-- postgresql
CREATE TABLE telegram_pending_verdicts (
	id SERIAL NOT NULL, 
	provider_id INTEGER NOT NULL, 
	chat_id VARCHAR(64) NOT NULL, 
	message_id INTEGER NOT NULL, 
	archive_id INTEGER NOT NULL, 
	confirm_token VARCHAR(64), 
	has_caption BOOLEAN, 
	message_text TEXT, 
	created_at TIMESTAMP WITHOUT TIME ZONE, 
	PRIMARY KEY (id), 
	FOREIGN KEY(provider_id) REFERENCES notification_providers (id) ON DELETE CASCADE, 
	FOREIGN KEY(archive_id) REFERENCES print_archives (id) ON DELETE CASCADE
);
CREATE INDEX ix_telegram_pending_verdicts_created_at ON telegram_pending_verdicts (created_at);
CREATE INDEX ix_telegram_pending_verdicts_id ON telegram_pending_verdicts (id);

-- sqlite
CREATE TABLE user_inbox_preferences (
	id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	kinds_json JSON NOT NULL, 
	sound_kinds_json JSON NOT NULL, 
	auto_watch BOOLEAN NOT NULL, 
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);
-- postgresql
CREATE TABLE user_inbox_preferences (
	id SERIAL NOT NULL, 
	user_id INTEGER NOT NULL, 
	kinds_json JSON NOT NULL, 
	sound_kinds_json JSON NOT NULL, 
	auto_watch BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (user_id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

```

## Settings keys and env vars the stack reads or writes
```regen: grep -hoE '(get_setting|set_setting|get_settings_value)\([a-z_]+, *"[a-z_]+"|Settings\.key == "[a-z_]+"|key="[a-z_]+"' backend/app/api/routes/notifications.py backend/app/api/routes/notification_templates.py backend/app/api/routes/user_notifications.py backend/app/models/notification.py backend/app/models/notification_inbox.py backend/app/models/notification_live_activity.py backend/app/models/notification_lock_screen_widget.py backend/app/models/notification_template.py backend/app/schemas/notification.py backend/app/schemas/notification_template.py backend/app/schemas/user_notifications.py backend/app/services/notification_service.py backend/app/services/notify_client.py backend/app/services/notify_live_activities.py backend/app/services/notify_widgets.py backend/app/services/notify_worker.py backend/app/services/spool_assignment_notifications.py backend/app/utils/notification_photos.py | sort -u; echo 'env vars:'; grep -hoE 'os\.environ[^)]*\)|os\.getenv\([^)]*\)|env_get\([^)]*\)|settings\.[a-z_]+' backend/app/api/routes/notifications.py backend/app/api/routes/notification_templates.py backend/app/api/routes/user_notifications.py backend/app/models/notification.py backend/app/models/notification_inbox.py backend/app/models/notification_live_activity.py backend/app/models/notification_lock_screen_widget.py backend/app/models/notification_template.py backend/app/schemas/notification.py backend/app/schemas/notification_template.py backend/app/schemas/user_notifications.py backend/app/services/notification_service.py backend/app/services/notify_client.py backend/app/services/notify_live_activities.py backend/app/services/notify_widgets.py backend/app/services/notify_worker.py backend/app/services/spool_assignment_notifications.py backend/app/utils/notification_photos.py | sort -u```
```
Settings.key == "advanced_auth_enabled"
Settings.key == "user_notifications_enabled"
get_setting(db, "external_url"
get_setting(db, "notification_log_retention_days"
get_setting(db, "time_format"
env vars:
os.environ.get("HA_TOKEN", "")
os.environ.get("HA_URL", "")
settings.base_dir
settings.get
settings.static_dir
```

## Permissions: values, default groups, categories, API keys, and where the frontend checks them
```regen: ./venv/bin/python3 tools/probe_notif_surface.py permissions 2>/dev/null; grep -oE "'(notifications|notification_templates):[a-z_]+'" frontend/src/api/client.ts | sort -u | sed 's/^/frontend Permission union: /'; grep -rhoE "hasPermission\('(notifications|notification_templates):[a-z_]+'\)" frontend/src --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ | sort -u```
```
{
 "apikey_denied": [
  "notifications:create",
  "notifications:update",
  "notifications:delete",
  "notifications:user_email",
  "notification_templates:update"
 ],
 "apikey_scope": {
  "notification_templates:read": "can_read_status",
  "notification_templates:update": "None",
  "notifications:create": "None",
  "notifications:delete": "None",
  "notifications:read": "can_read_status",
  "notifications:update": "None",
  "notifications:user_email": "None"
 },
 "categories": {
  "Notifications": [
   "notifications:read",
   "notifications:create",
   "notifications:update",
   "notifications:delete",
   "notifications:user_email",
   "notification_templates:read",
   "notification_templates:update"
  ]
 },
 "groups": {
  "Administrators": [
   "notifications:read",
   "notifications:create",
   "notifications:update",
   "notifications:delete",
   "notifications:user_email",
   "notification_templates:read",
   "notification_templates:update"
  ],
  "Operators": [
   "notifications:read",
   "notifications:create",
   "notifications:update",
   "notifications:delete",
   "notifications:user_email",
   "notification_templates:read",
   "notification_templates:update"
  ],
  "Viewers": [
   "notifications:read",
   "notification_templates:read"
  ]
 },
 "values": [
  "notifications:read",
  "notifications:create",
  "notifications:update",
  "notifications:delete",
  "notifications:user_email",
  "notification_templates:read",
  "notification_templates:update"
 ]
}
frontend Permission union: 'notification_templates:read'
frontend Permission union: 'notification_templates:update'
frontend Permission union: 'notifications:create'
frontend Permission union: 'notifications:delete'
frontend Permission union: 'notifications:read'
frontend Permission union: 'notifications:update'
frontend Permission union: 'notifications:user_email'
hasPermission('notifications:read')
```

## Registration points (main.py, models/__init__.py, core/database.py)
```regen: grep -nE "notification|notify_|Notify|NotificationProvider|user_notifications" backend/app/main.py backend/app/models/__init__.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | grep -vE "^backend/app/main.py: *#|^backend/app/main.py: +(logger|\"\"\")" | sort -u; grep -nE "def seed_notification_templates|notification_providers|notification_logs|notification_templates|notification_live_activities|notification_lock_screen_widgets|user_inbox_preferences|aito_watches|notification_digest_queue|telegram_pending_verdicts" backend/app/core/database.py | sed -E "s/:[0-9]+:[[:space:]]*/: /" | sort -u```
```
backend/app/main.py: "[#1752] Printer %s connected→disconnected edge; scheduling offline notification in %.0fs",
backend/app/main.py: "[#1752] Printer %s reconnected before debounce; cancelling pending offline notification",
backend/app/main.py: "[CALLBACK] Internal printer job completed, no notification: filename=%s, subtask=%s",
backend/app/main.py: "[KILL SWITCH] Immediate provider notification failed for printer %s: %s",
backend/app/main.py: "[KILL SWITCH] WebSocket notification failed for printer %s: %s", printer_id, e
backend/app/main.py: "[NOTIFY-BG] Could not look up queue item for no-archive notification: %s", lookup_err
backend/app/main.py: "[NOTIFY-BG] Sending notification without archive: printer=%s, status=%s", printer_id, ps
backend/app/main.py: "[NOTIFY-BG] Starting notifications for printer %s, photo=%s", printer_id, finish_photo_filename
backend/app/main.py: "[PHOTO-NOTIFY] Photo capture timed out after %ss, sending notification without photo",
backend/app/main.py: (after the start notification) for a truly external print, which is not
backend/app/main.py: 75% notification together with Print Started, and since 75 was then on
backend/app/main.py: Lives here rather than inline in ``on_print_complete``'s notification task
backend/app/main.py: The print-complete notification waits only ~60s for the video, because
backend/app/main.py: _kill_switch_notification_tasks,
backend/app/main.py: _kill_switch_notification_tasks.pop(printer_id, None)
backend/app/main.py: _kill_switch_notification_tasks: dict[int, asyncio.Task[bool]] = {}
backend/app/main.py: _kill_switch_notification_tasks[printer_id] = spawn_background_task(
backend/app/main.py: _maybe_notify_printer_offline(printer_id),
backend/app/main.py: _notify_billing_charge_failed(),
backend/app/main.py: _printer_offline_notify_tasks.pop(printer_id, None)
backend/app/main.py: _printer_offline_notify_tasks: dict[int, asyncio.Task] = {}
backend/app/main.py: _printer_offline_notify_tasks[printer_id] = asyncio.create_task(
backend/app/main.py: _run_plate_id = billing_plate_id if billing_plate_id is not None else notify_plate_id
backend/app/main.py: _schedule_timelapse_scan(archive_id, printer_id, plate_id=notify_plate_id, run_id=completed_run_id)
backend/app/main.py: _send_kill_switch_provider_notification(printer_id, printer_name, notification_data),
backend/app/main.py: and notifications.
backend/app/main.py: app.include_router(notification_templates.router, prefix=app_settings.api_prefix)
backend/app/main.py: app.include_router(notifications.router, prefix=app_settings.api_prefix)
backend/app/main.py: app.include_router(user_notifications.router, prefix=app_settings.api_prefix)
backend/app/main.py: archive_data = _scope_notification_archive_data_to_plate(
backend/app/main.py: archive_id, timelapse_path, notify_plate_id, run_started_at, run_id=completed_run_id
backend/app/main.py: async def _auto_archive_off_and_unexpected(printer_id: int, data: dict, notification_sent: bool, logger) -> bool:
backend/app/main.py: async def _background_notifications(finish_photo_filename: str | None = None):
backend/app/main.py: async def _capture_snapshot_for_notification(printer_id: int, printer, logger, *, light: bool = True) -> bytes | None:
backend/app/main.py: async def _finish_photo_for_notification(
backend/app/main.py: async def _kill_switch_notification_already_sent(task: asyncio.Task[bool] | None) -> bool:
backend/app/main.py: async def _maybe_notify_printer_offline(printer_id: int) -> None:
backend/app/main.py: async def _notify_billing_charge_failed() -> None:
backend/app/main.py: async def _notify_no_archive():
backend/app/main.py: async def _send_kill_switch_provider_notification(
backend/app/main.py: async def _send_print_start_notification(
backend/app/main.py: async with async_session() as notification_db:
backend/app/main.py: authentication off, the notification that already went out links to
backend/app/main.py: await _background_notifications(finish_photo)
backend/app/main.py: await _send_print_start_notification(printer_id, data, _creator_data, logger)
backend/app/main.py: await _send_print_start_notification(printer_id, data, archive_data, logger)
backend/app/main.py: await _send_print_start_notification(printer_id, data, logger=logger)
backend/app/main.py: await notification_service.on_ams_ht_humidity_high(
backend/app/main.py: await notification_service.on_ams_ht_temperature_high(
backend/app/main.py: await notification_service.on_ams_humidity_high(
backend/app/main.py: await notification_service.on_ams_temperature_high(
backend/app/main.py: await notification_service.on_bed_cooled(
backend/app/main.py: await notification_service.on_billing_charge_failed(
backend/app/main.py: await notification_service.on_first_layer_complete(
backend/app/main.py: await notification_service.on_maintenance_due(printer_id, printer_name, items_needing_attention, db)
backend/app/main.py: await notification_service.on_plate_not_empty(
backend/app/main.py: await notification_service.on_print_complete(
backend/app/main.py: await notification_service.on_print_confirm_request(
backend/app/main.py: await notification_service.on_print_progress(
backend/app/main.py: await notification_service.on_print_start(printer_id, printer_name, data, db, archive_data=archive_data)
backend/app/main.py: await notification_service.on_printer_error(
backend/app/main.py: await notification_service.on_printer_offline(printer_id, printer.name, db)
backend/app/main.py: await notification_service.on_queue_completed(
backend/app/main.py: await notification_service.send_user_print_email(
backend/app/main.py: await notify_live_activities.close()
backend/app/main.py: await notify_missing_spool_assignments_on_print_start(printer_id, data, logger)
backend/app/main.py: await notify_widgets.close()
backend/app/main.py: bed_cool_logger.warning("[BED-COOL] Failed to send notification: %s", e)
backend/app/main.py: current = {_hms_notify_key(e) for e in errors}
backend/app/main.py: db, printer, printer_id, data, filename, subtask_id, acquired, notification_sent, logger, detected_at
backend/app/main.py: db, printer_id, data, filename, subtask_name, subtask_id, notification_sent, logger
backend/app/main.py: db, printer_id: int, data: dict, filename: str, subtask_name: str, subtask_id, notification_sent: bool, logger
backend/app/main.py: def _hms_notify_key(error) -> str:
backend/app/main.py: def _scope_notification_archive_data_to_plate(
backend/app/main.py: error_image_data = await _capture_snapshot_for_notification(
backend/app/main.py: except Exception as notification_error:
backend/app/main.py: existing = _printer_offline_notify_tasks.get(printer_id)
backend/app/main.py: f"[HMS] Sent notification for {sent_count} error(s) on printer {printer_id}"
backend/app/main.py: for ``plate_id`` so the completion notification reports what was actually
backend/app/main.py: for tasks in (_printer_offline_notify_tasks, _fallback_3mf_retry_tasks):
backend/app/main.py: frame = await _capture_snapshot_for_notification(printer_id, printer, logger, light=False)
backend/app/main.py: from backend.app.services.notification_service import notification_service
backend/app/main.py: from backend.app.services.notify_live_activities import notify_live_activities
backend/app/main.py: from backend.app.services.notify_widgets import notify_widgets
backend/app/main.py: from backend.app.services.spool_assignment_notifications import (
backend/app/main.py: from backend.app.utils.notification_photos import save_notification_photo
backend/app/main.py: holding a notification for minutes is worse than sending it with a live
backend/app/main.py: if await _auto_archive_off_and_unexpected(printer_id, data, notification_sent, logger):
backend/app/main.py: if not await _kill_switch_notification_already_sent(kill_switch_notification_task):
backend/app/main.py: if not notification_sent:
backend/app/main.py: image_data = await _capture_snapshot_for_notification(
backend/app/main.py: image_data = await _capture_snapshot_for_notification(printer_id, printer, logger)
backend/app/main.py: image_data = await _capture_snapshot_for_notification(printer_id, printer, logging.getLogger(__name__))
backend/app/main.py: it on, the link is to a copy in notification_photos, and attachments are
backend/app/main.py: its level is a real one. An ``hms[]`` fault at level 3 (notification) with
backend/app/main.py: kill_switch_notification_task = _kill_switch_notification_tasks.pop(printer_id, None)
backend/app/main.py: known of several, and the notification takes the printer's remaining
backend/app/main.py: link in Telegram, CallMeBot or a Home Assistant notification has, so the
backend/app/main.py: link only ever answered 401. The photo is then saved as a notification
backend/app/main.py: logging.getLogger(__name__).exception("Notify Live Activity status hook failed for printer %s", printer_id)
backend/app/main.py: logging.getLogger(__name__).warning("First layer notification failed: %s", e)
backend/app/main.py: logging.getLogger(__name__).warning(f"HMS error notification failed: {e}")
backend/app/main.py: logging.getLogger(__name__).warning(f"Progress milestone notification failed: {e}")
backend/app/main.py: name = await asyncio.to_thread(save_notification_photo, photo_bytes, "print_complete")
backend/app/main.py: name=f"kill-switch-notification-{printer_id}",
backend/app/main.py: notification (#3375): ``archive.print_time_seconds`` adds every plate of
backend/app/main.py: notification of a single-plate print. The queue UI already re-reads the
backend/app/main.py: notification payload (filament grams, time estimate, per-slot breakdown).
backend/app/main.py: notification_data = {
backend/app/main.py: notification_db,
backend/app/main.py: notification_error,
backend/app/main.py: notification_sent = catch_up
backend/app/main.py: notification_sent,
backend/app/main.py: notification_sent: bool,
backend/app/main.py: notification_service.start_digest_scheduler()
backend/app/main.py: notification_service.stop_digest_scheduler()
backend/app/main.py: notification_templates,
backend/app/main.py: notifications,
backend/app/main.py: notifications, the camera feed, the plate references. Ids are no longer
backend/app/main.py: notifications/relays (already sent by the previous process, or plain wrong
backend/app/main.py: notify_live_activities.forget_printer(printer_id)
backend/app/main.py: notify_live_activities.observe(printer_id, state)
backend/app/main.py: notify_live_activities.print_finished(printer_id, data)
backend/app/main.py: notify_live_activities.print_started(printer_id, printer_manager.get_status(printer_id), data)
backend/app/main.py: notify_live_activities.start()
backend/app/main.py: notify_missing_spool_assignments_on_print_start,
backend/app/main.py: notify_plate_id = _print_plate_ids.pop((printer_id, archive_id), None)
backend/app/main.py: notify_plate_id,
backend/app/main.py: notify_plate_id: int | None = None
backend/app/main.py: notify_widgets.start()
backend/app/main.py: pass  # Don't fail if notification fails
backend/app/main.py: pending = _printer_offline_notify_tasks.pop(printer_id, None)
backend/app/main.py: photo as well (utils/notification_photos.py) and the link points there: an
backend/app/main.py: photo_url, photo_bytes = await _finish_photo_for_notification(
backend/app/main.py: plate check and start notifications.
backend/app/main.py: plate_photo_data = await _capture_snapshot_for_notification(printer_id, printer, logger)
backend/app/main.py: plug, notifications, the timelapse baseline's FTP listing) can outlast the
backend/app/main.py: previous_task = _kill_switch_notification_tasks.pop(printer_id, None)
backend/app/main.py: printer_id, data, logger, bound_archive_id, notify_plate_id
backend/app/main.py: providers = await notification_service._get_providers_for_event(db, "on_bed_cooled", printer_id)
backend/app/main.py: rather than a 'print failed' notification.
backend/app/main.py: reclassify it as 'cancelled' so the correct 'print stopped' notification is sent
backend/app/main.py: return [e for e in errors if _hms_notify_key(e) in new_error_codes and _hms_fault_counts(e)]
backend/app/main.py: returned unchanged so the notification still sends.
backend/app/main.py: sends a notification. Level 0, Bambu's "invalid" level, never counts. This
backend/app/main.py: so the three sites in ``_background_notifications`` (and the per-plate
backend/app/main.py: spawn_background_task(_notify_no_archive(), name="notify-no-archive")
backend/app/main.py: start notification and the timelapse baseline.
backend/app/main.py: the alarm quiet for the skew on top of the cap. One unnecessary notification
backend/app/main.py: this early notification could not be delivered.
backend/app/main.py: url = f"{base}/api/v1/notifications/photos/{name}"
backend/app/main.py: user_notifications,
backend/app/main.py: when a notification was sent as well, which is why a room above it made the
backend/app/models/__init__.py: from backend.app.models.notification import NotificationLog
backend/app/models/__init__.py: from backend.app.models.notification_inbox import AitoWatch, Notification, UserInboxPreference
backend/app/models/__init__.py: from backend.app.models.notification_live_activity import NotificationLiveActivity
backend/app/models/__init__.py: from backend.app.models.notification_lock_screen_widget import NotificationLockScreenWidget
backend/app/models/__init__.py: from backend.app.models.notification_template import NotificationTemplate
2807:    # Migration: Add on_print_stopped column to notification_providers
2808:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_print_stopped BOOLEAN DEFAULT 1")
2823:    # Migration: Add on_maintenance_due column to notification_providers
2824:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_maintenance_due BOOLEAN DEFAULT 0")
2878:    # Migration: Add daily digest columns to notification_providers
2879:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN daily_digest_enabled BOOLEAN DEFAULT 0")
2880:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN daily_digest_time VARCHAR(5)")
2900:                    "ALTER TABLE notification_providers ADD COLUMN on_print_missing_spool_assignment BOOLEAN DEFAULT 0"
3033:    # Migration: Add AMS alarm notification columns to notification_providers
3034:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_ams_humidity_high BOOLEAN DEFAULT 0")
3038:                text("ALTER TABLE notification_providers ADD COLUMN on_ams_temperature_high BOOLEAN DEFAULT 0")
3043:    # Migration: Add AMS-HT alarm notification columns to notification_providers
3047:                text("ALTER TABLE notification_providers ADD COLUMN on_ams_ht_humidity_high BOOLEAN DEFAULT 0")
3054:                text("ALTER TABLE notification_providers ADD COLUMN on_ams_ht_temperature_high BOOLEAN DEFAULT 0")
3059:    # Migration: Add plate not empty notification column to notification_providers
3060:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_plate_not_empty BOOLEAN DEFAULT 1")
358:        ("notification_live_activities", "printer_id"),
359:        ("notification_lock_screen_widgets", "printer_id"),
3819:    # Migration: Add queue notification event columns to notification_providers
3820:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_job_added BOOLEAN DEFAULT 0")
3824:                text("ALTER TABLE notification_providers ADD COLUMN on_queue_job_assigned BOOLEAN DEFAULT 0")
3828:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_job_started BOOLEAN DEFAULT 0")
3829:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_job_waiting BOOLEAN DEFAULT 1")
3830:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_job_skipped BOOLEAN DEFAULT 1")
3831:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_job_failed BOOLEAN DEFAULT 1")
3832:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_queue_completed BOOLEAN DEFAULT 0")
4043:    # Migration: Add bed cooled notification column to notification_providers
4044:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_bed_cooled BOOLEAN DEFAULT 0")
4046:    # Migration: Add first layer complete notification column to notification_providers
4050:                text("ALTER TABLE notification_providers ADD COLUMN on_first_layer_complete BOOLEAN DEFAULT 0")
4567:            "ALTER TABLE notification_providers ADD COLUMN on_billing_charge_failed BOOLEAN DEFAULT 1",
4572:            "ALTER TABLE notification_providers ADD COLUMN on_billing_charge_failed BOOLEAN DEFAULT TRUE",
4579:            "ALTER TABLE notification_providers ADD COLUMN on_aito_payment_received BOOLEAN DEFAULT 0",
4584:        await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_aito_payment_received BOOLEAN")
5457:    # Migration: Add inventory stock alert columns to notification_providers.
5461:            conn, "ALTER TABLE notification_providers ADD COLUMN on_stock_reorder_alert BOOLEAN DEFAULT 0"
5464:            conn, "ALTER TABLE notification_providers ADD COLUMN on_stock_break_alert BOOLEAN DEFAULT 0"
5468:            conn, "ALTER TABLE notification_providers ADD COLUMN on_stock_reorder_alert BOOLEAN DEFAULT false"
5471:            conn, "ALTER TABLE notification_providers ADD COLUMN on_stock_break_alert BOOLEAN DEFAULT false"
5476:    # on an install whose notification_providers table was (re)created from
5490:                "UPDATE notification_providers SET on_stock_reorder_alert = :off WHERE on_stock_reorder_alert IS NULL"
5495:            text("UPDATE notification_providers SET on_stock_break_alert = :off WHERE on_stock_break_alert IS NULL"),
5500:        logger.info("Backfilled %s NULL inventory stock alert flag(s) on notification_providers", repaired)
5898:    # Migration: Add on_ai_failure_detection column to notification_providers (#1794).
5905:            "ALTER TABLE notification_providers ADD COLUMN on_ai_failure_detection BOOLEAN DEFAULT 0",
5910:            "ALTER TABLE notification_providers ADD COLUMN on_ai_failure_detection BOOLEAN DEFAULT false",
6704:            conn, "ALTER TABLE notification_providers ADD COLUMN on_plate_clear_required BOOLEAN DEFAULT 0"
6708:            conn, "ALTER TABLE notification_providers ADD COLUMN on_plate_clear_required BOOLEAN DEFAULT false"
6745:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_ha_sensor_alert BOOLEAN DEFAULT FALSE")
6752:        conn, "ALTER TABLE notification_providers ADD COLUMN on_ams_drying_suspended BOOLEAN DEFAULT TRUE"
6771:        conn, "ALTER TABLE notification_providers ADD COLUMN on_location_ha_sensor_alert BOOLEAN DEFAULT FALSE"
6797:        conn, "ALTER TABLE notification_providers ADD COLUMN on_print_confirm_request BOOLEAN DEFAULT TRUE"
6817:        conn, "ALTER TABLE notification_providers ADD COLUMN telegram_verdict_mode VARCHAR(16) DEFAULT 'buttons'"
6822:        CREATE TABLE IF NOT EXISTS telegram_pending_verdicts (
6824:            provider_id INTEGER NOT NULL REFERENCES notification_providers(id) ON DELETE CASCADE,
6836:        CREATE TABLE IF NOT EXISTS telegram_pending_verdicts (
6838:            provider_id INTEGER NOT NULL REFERENCES notification_providers(id) ON DELETE CASCADE,
6851:        "CREATE INDEX IF NOT EXISTS ix_telegram_pending_verdicts_created_at ON telegram_pending_verdicts (created_at)",
6975:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN on_app_message BOOLEAN DEFAULT FALSE")
6979:            text("UPDATE notification_providers SET on_app_message = :off WHERE on_app_message IS NULL"), {"off": False}
6995:    await _safe_execute(conn, "ALTER TABLE notification_providers ADD COLUMN attach_photo BOOLEAN DEFAULT TRUE")
6998:            text("UPDATE notification_providers SET attach_photo = :on WHERE attach_photo IS NULL"), {"on": True}
7188:        conn, "ALTER TABLE notification_providers ADD COLUMN on_print_pause_upcoming BOOLEAN DEFAULT FALSE"
7193:                "UPDATE notification_providers SET on_print_pause_upcoming = :off WHERE on_print_pause_upcoming IS NULL"
725:    await seed_notification_templates()
7262:    await _migrate_notification_providers_go_with_their_printer(conn)
7406:    ("notification_providers", "attach_photo"),
7407:    ("notification_providers", "on_ai_failure_detection"),
7408:    ("notification_providers", "on_ams_drying_suspended"),
7409:    ("notification_providers", "on_app_message"),
7410:    ("notification_providers", "on_billing_charge_failed"),
7411:    ("notification_providers", "on_ha_sensor_alert"),
7412:    ("notification_providers", "on_location_ha_sensor_alert"),
7413:    ("notification_providers", "on_plate_clear_required"),
7414:    ("notification_providers", "on_print_confirm_request"),
7415:    ("notification_providers", "on_print_pause_upcoming"),
7416:    ("notification_providers", "on_stock_break_alert"),
7417:    ("notification_providers", "on_stock_reorder_alert"),
7418:    ("notification_providers", "telegram_verdict_mode"),
7626:async def _migrate_notification_providers_go_with_their_printer(conn) -> None:
7627:    """notification_providers / smart_plugs.printer_id: ON DELETE CASCADE, as the models say (PostgreSQL).
7635:        await _pg_set_fk_ondelete(conn, "notification_providers", "printer_id", "printers", "CASCADE")
8193:        text("UPDATE notification_templates SET body_template = :new WHERE event_type = :et AND body_template = :old"),
8537:        text("UPDATE notification_templates SET name = :new WHERE event_type = :et AND name = :old"),
8565:                "UPDATE notification_templates SET body_template = :new WHERE event_type = :et AND body_template = :old"
8587:        text("UPDATE notification_templates SET body_template = :new WHERE event_type = :et AND body_template = :old"),
8608:        text("UPDATE notification_templates SET body_template = :new WHERE event_type = :et AND body_template = :old"),
8621:        text("UPDATE notification_templates SET body_template = :new WHERE event_type = :et AND body_template = :old"),
9223:    routes/notification_templates.py already uses ("User Print Completed Email").
9234:                text("UPDATE notification_templates SET name = :new WHERE event_type = :et AND name = :old"),
9252:async def seed_notification_templates():
```

## Frontend exported symbols, per file
```regen: grep -HoE '^export (default function|default async function|async function|function|const|type|interface|class|enum) [A-Za-z0-9_]+' frontend/src/components/AddNotificationModal.tsx frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationLogViewer.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/NotificationProviderCard.tsx frontend/src/components/NotificationTemplateEditor.tsx frontend/src/components/notificationKinds.ts frontend/src/pages/NotificationsPage.tsx frontend/src/utils/notify.ts | sort```
```
frontend/src/components/AddNotificationModal.tsx:export function AddNotificationModal
frontend/src/components/NotificationBell.tsx:export function NotificationBell
frontend/src/components/NotificationLogViewer.tsx:export function NotificationLogViewer
frontend/src/components/NotificationPanel.tsx:export function NotificationPanel
frontend/src/components/NotificationProviderCard.tsx:export function NotificationProviderCard
frontend/src/components/NotificationTemplateEditor.tsx:export function NotificationTemplateEditor
frontend/src/components/notificationKinds.ts:export const NOTIFICATION_KINDS
frontend/src/components/notificationKinds.ts:export const UNKNOWN_KIND
frontend/src/components/notificationKinds.ts:export function kindFamily
frontend/src/components/notificationKinds.ts:export interface NotificationKindMeta
frontend/src/pages/NotificationsPage.tsx:export function NotificationsPage
frontend/src/utils/notify.ts:export const isNotifyPhotoUnsupported
frontend/src/utils/notify.ts:export const isNotifyPushOnlyTarget
```

## API client — notification exported types and their fields
```regen: sed -n '/^export interface NotificationProvider {/,/^export interface NotificationLogStats {/p' frontend/src/api/client.ts | grep -E '^export |^  [a-zA-Z_]+\??: |^}'; sed -n '/^export interface NotificationLogStats {/,/^}/p' frontend/src/api/client.ts | grep -E '^export |^  [a-zA-Z_]+\??: |^}'; grep -nE '^export (interface|type) (Inbox[A-Za-z]*|UserEmailPreference[A-Za-z]*|AppMessage[A-Za-z]*|NotificationLogEntry|NotifyConfig)' frontend/src/api/client.ts | sed -E 's/^[0-9]+://'```
```
export interface NotificationProvider {
  id: number;
  name: string;
  provider_type: ProviderType;
  enabled: boolean;
  config: Record<string, unknown>;
  attach_photo: boolean;
  on_print_start: boolean;
  on_print_complete: boolean;
  on_print_failed: boolean;
  on_print_stopped: boolean;
  on_print_progress: boolean;
  on_print_missing_spool_assignment: boolean;
  on_billing_charge_failed: boolean;
  on_aito_payment_received: boolean;
  on_printer_offline: boolean;
  on_printer_error: boolean;
  on_ai_failure_detection: boolean;
  on_filament_low: boolean;
  on_maintenance_due: boolean;
  on_ams_humidity_high: boolean;
  on_ams_temperature_high: boolean;
  on_ams_drying_suspended: boolean;
  on_ams_ht_humidity_high: boolean;
  on_ams_ht_temperature_high: boolean;
  on_plate_not_empty: boolean;
  on_plate_clear_required: boolean;
  on_print_confirm_request: boolean;
  telegram_verdict_mode: TelegramVerdictMode;
  on_bed_cooled: boolean;
  on_ha_sensor_alert: boolean;
  on_location_ha_sensor_alert: boolean;
  on_first_layer_complete: boolean;
  on_print_pause_upcoming: boolean;
  on_app_message: boolean;
  on_stock_reorder_alert: boolean;
  on_stock_break_alert: boolean;
  on_queue_job_added: boolean;
  on_queue_job_assigned: boolean;
  on_queue_job_started: boolean;
  on_queue_job_waiting: boolean;
  on_queue_job_skipped: boolean;
  on_queue_job_failed: boolean;
  on_queue_completed: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  daily_digest_enabled: boolean;
  daily_digest_time: string | null;
  printer_id: number | null;
  last_success: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface NotificationProviderCreate {
  name: string;
  provider_type: ProviderType;
  enabled?: boolean;
  config: Record<string, unknown>;
  attach_photo?: boolean;
  on_print_start?: boolean;
  on_print_complete?: boolean;
  on_print_failed?: boolean;
  on_print_stopped?: boolean;
  on_print_progress?: boolean;
  on_print_missing_spool_assignment?: boolean;
  on_billing_charge_failed?: boolean;
  on_aito_payment_received?: boolean;
  on_printer_offline?: boolean;
  on_printer_error?: boolean;
  on_ai_failure_detection?: boolean;
  on_filament_low?: boolean;
  on_maintenance_due?: boolean;
  on_ams_humidity_high?: boolean;
  on_ams_temperature_high?: boolean;
  on_ams_drying_suspended?: boolean;
  on_ams_ht_humidity_high?: boolean;
  on_ams_ht_temperature_high?: boolean;
  on_plate_not_empty?: boolean;
  on_plate_clear_required?: boolean;
  on_print_confirm_request?: boolean;
  telegram_verdict_mode?: TelegramVerdictMode;
  on_bed_cooled?: boolean;
  on_ha_sensor_alert?: boolean;
  on_location_ha_sensor_alert?: boolean;
  on_first_layer_complete?: boolean;
  on_print_pause_upcoming?: boolean;
  on_app_message?: boolean;
  on_stock_reorder_alert?: boolean;
  on_stock_break_alert?: boolean;
  on_queue_job_added?: boolean;
  on_queue_job_assigned?: boolean;
  on_queue_job_started?: boolean;
  on_queue_job_waiting?: boolean;
  on_queue_job_skipped?: boolean;
  on_queue_job_failed?: boolean;
  on_queue_completed?: boolean;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  daily_digest_enabled?: boolean;
  daily_digest_time?: string | null;
  printer_id?: number | null;
}
export interface NotificationProviderUpdate {
  name?: string;
  provider_type?: ProviderType;
  enabled?: boolean;
  config?: Record<string, unknown>;
  attach_photo?: boolean;
  on_print_start?: boolean;
  on_print_complete?: boolean;
  on_print_failed?: boolean;
  on_print_stopped?: boolean;
  on_print_progress?: boolean;
  on_print_missing_spool_assignment?: boolean;
  on_billing_charge_failed?: boolean;
  on_aito_payment_received?: boolean;
  on_printer_offline?: boolean;
  on_printer_error?: boolean;
  on_ai_failure_detection?: boolean;
  on_filament_low?: boolean;
  on_maintenance_due?: boolean;
  on_ams_humidity_high?: boolean;
  on_ams_temperature_high?: boolean;
  on_ams_drying_suspended?: boolean;
  on_ams_ht_humidity_high?: boolean;
  on_ams_ht_temperature_high?: boolean;
  on_plate_not_empty?: boolean;
  on_plate_clear_required?: boolean;
  on_print_confirm_request?: boolean;
  telegram_verdict_mode?: TelegramVerdictMode;
  on_bed_cooled?: boolean;
  on_ha_sensor_alert?: boolean;
  on_location_ha_sensor_alert?: boolean;
  on_first_layer_complete?: boolean;
  on_print_pause_upcoming?: boolean;
  on_app_message?: boolean;
  on_stock_reorder_alert?: boolean;
  on_stock_break_alert?: boolean;
  on_queue_job_added?: boolean;
  on_queue_job_assigned?: boolean;
  on_queue_job_started?: boolean;
  on_queue_job_waiting?: boolean;
  on_queue_job_skipped?: boolean;
  on_queue_job_failed?: boolean;
  on_queue_completed?: boolean;
  quiet_hours_enabled?: boolean;
  quiet_hours_start?: string | null;
  quiet_hours_end?: string | null;
  daily_digest_enabled?: boolean;
  daily_digest_time?: string | null;
  printer_id?: number | null;
}
export type ScheduleType = 'hourly' | 'daily' | 'weekly';
export type GitProviderType = 'github' | 'gitea' | 'forgejo' | 'gitlab';
export interface CloudAccountCounts {
  bambu: number;
  orca: number;
}
export interface GitHubBackupConfig {
  id: number;
  repository_url: string;
  has_token: boolean;
  branch: string;
  provider: GitProviderType;
  allow_insecure_http: boolean;
  schedule_enabled: boolean;
  schedule_type: ScheduleType;
  backup_kprofiles: boolean;
  backup_cloud_profiles: boolean;
  backup_settings: boolean;
  backup_spools: boolean;
  backup_archives: boolean;
  enabled: boolean;
  last_backup_at: string | null;
  last_backup_status: string | null;
  last_backup_message: string | null;
  last_backup_commit_sha: string | null;
  next_scheduled_run: string | null;
  created_at: string;
  updated_at: string;
}
export interface GitHubBackupConfigCreate {
  repository_url: string;
  access_token: string;
  branch?: string;
  provider?: GitProviderType;
  allow_insecure_http?: boolean;
  schedule_enabled?: boolean;
  schedule_type?: ScheduleType;
  backup_kprofiles?: boolean;
  backup_cloud_profiles?: boolean;
  backup_settings?: boolean;
  backup_spools?: boolean;
  backup_archives?: boolean;
  enabled?: boolean;
}
export interface GitHubBackupLog {
  id: number;
  config_id: number;
  started_at: string;
  completed_at: string | null;
  status: string;
  trigger: string;
  commit_sha: string | null;
  files_changed: number;
  error_message: string | null;
}
export interface GitHubBackupStatus {
  configured: boolean;
  enabled: boolean;
  is_running: boolean;
  restore_running: boolean;
  progress: string | null;
  last_backup_at: string | null;
  last_backup_status: string | null;
  next_scheduled_run: string | null;
}
export type RestoreCategory = 'kprofiles' | 'settings' | 'spools' | 'archives';
export interface GitHubCommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}
export interface GitHubCommitListResponse {
  success: boolean;
  message: string;
  branch: string;
  commits: GitHubCommitInfo[];
}
export type GitHubRestoreParams = Record<string, string | number>;
export interface GitHubRestorePreviewCategory {
  category: RestoreCategory;
  available: boolean;
  item_count: number;
  detail: string | null;
  detail_code: string | null;
  detail_params: GitHubRestoreParams;
}
export interface GitHubRestorePreview {
  success: boolean;
  message: string;
  ref: string;
  commit: GitHubCommitInfo | null;
  metadata_version: string | null;
  categories: GitHubRestorePreviewCategory[];
}
export interface GitHubRestoreRequest {
  ref?: string;
  categories: RestoreCategory[];
  overwrite_existing?: boolean;
}
export interface GitHubRestoreNote {
  code: string;
  params: GitHubRestoreParams;
  message: string;
}
export interface GitHubRestoreCategoryResult {
  restored: number;
  skipped: number;
  failed: number;
  notes: GitHubRestoreNote[];
}
export interface GitHubRestoreResponse {
  success: boolean;
  message: string;
  log_id: number | null;
  ref: string | null;
  results: Record<string, GitHubRestoreCategoryResult>;
}
export interface LocalBackupStatus {
  enabled: boolean;
  schedule: string;
  time: string;
  retention: number;
  path: string;
  default_path: string;
  is_running: boolean;
  last_backup_at: string | null;
  last_status: string | null;
  last_message: string | null;
  next_run: string | null;
  timezone: string;
}
export interface LocalBackupFile {
  filename: string;
  size: number;
  created_at: string;
}
export interface LocalBackupPathCheck {
  writable: boolean;
  path: string;
  code: string;
  detail: string | null;
  remedy: string | null;
  message: string;
  warning: string | null;
}
export interface ObicoDetectionEvent {
  printer_id: number;
  task_name: string;
  timestamp: string;
  current_p: number;
  score: number;
  class: 'safe' | 'warning' | 'failure';
  detections: number;
}
export interface ObicoStatus {
  is_running: boolean;
  last_error: string | null;
  per_printer: Record<string, { class: string; frame_count: number; score: number }>;
  thresholds: { low: number; high: number; pause?: number };
  history: ObicoDetectionEvent[];
  enabled: boolean;
  ml_url: string;
  sensitivity: 'low' | 'medium' | 'high';
  action: 'notify' | 'pause' | 'pause_and_off';
  poll_interval: number;
  external_url_configured: boolean;
}
export interface ObicoPrinterStatus {
  enabled: boolean;
  monitored_printers: number[] | null;
  per_printer: Record<string, { class: string; frame_count: number; score: number }>;
  last_error: string | null;
}
export interface ObicoTestConnection {
  ok: boolean;
  status_code: number | null;
  body: string | null;
  error: string | null;
  auth_ok: boolean | null;
}
export type OctoEverywhereConfidence = 'lowest' | 'low' | 'medium' | 'high' | 'highest';
export interface OctoEverywhereDetection {
  class: 'safe' | 'warning' | 'failure' | 'error' | 'unknown';
  print_quality: number | null;
  frame_count: number;
  error?: string | null;
  error_code: string | null;
}
export interface OctoEverywhereDetectionEvent {
  timestamp: string;
  printer_id: number;
  class: OctoEverywhereDetection['class'];
  print_quality: number | null;
}
export interface OctoEverywhereStatus {
  enabled: boolean;
  api_key_configured: boolean;
  confidence: OctoEverywhereConfidence;
  action: 'notify' | 'pause' | 'pause_and_off';
  poll_interval: number;
  is_running: boolean;
  last_error: string | null;
  last_error_code: string | null;
  per_printer: Record<string, OctoEverywhereDetection>;
  history: OctoEverywhereDetectionEvent[];
  notifications: { configured: boolean; uncovered_printers: number[] };
}
export interface OctoEverywherePrinterStatus {
  enabled: boolean;
  monitored_printers: number[] | null;
  per_printer: Record<string, OctoEverywhereDetection>;
  last_error: string | null;
  last_error_code: string | null;
}
export interface OctoEverywhereTestConnection {
  ok: boolean;
  status_code: number | null;
  error: string | null;
  error_code: string | null;
}
export interface GitHubTestConnectionResponse {
  success: boolean;
  message: string;
  repo_name: string | null;
  permissions: Record<string, boolean> | null;
  is_private: boolean | null;
}
export interface GitHubBackupTriggerResponse {
  success: boolean;
  message: string;
  log_id: number | null;
  commit_sha: string | null;
  files_changed: number;
}
export interface NotificationTestRequest {
  provider_type: ProviderType;
  config: Record<string, unknown>;
  attach_photo?: boolean;
  provider_id?: number;
}
export interface NotificationTestResponse {
  success: boolean;
  message: string;
}
export interface CallMeBotConfig {
  phone: string;
  apikey: string;
}
export interface NtfyConfig {
  server?: string;
  topic: string;
  auth_token?: string | null;
}
export interface PushoverConfig {
  user_key: string;
  app_token: string;
  priority?: number;
}
export interface NotifyConfig {
  device_id: string;
  token: string;
  icon_url?: string;
  group_type?: string;
  live_activities?: boolean;
  lock_screen_widgets?: boolean;
  live_activity_privacy?: boolean;
  live_activity_stage?: boolean;
  live_activity_style?: 'bar' | 'segments' | 'none';
  live_activity_metrics?: ('progress' | 'eta' | 'layers' | 'nozzle' | 'bed' | 'chamber')[];
  live_activity_button_url?: string;
  live_activity_symbol?: string;
  live_activity_tint?: string;
  time_sensitive?: boolean;
}
export interface TelegramConfig {
  bot_token: string;
  chat_id: string;
}
export interface EmailConfig {
  smtp_server: string;
  smtp_port?: number;
  username: string;
  password: string;
  from_email: string;
  to_email: string;
  use_tls?: boolean;
}
export interface NotificationTemplate {
  id: number;
  event_type: string;
  name: string;
  title_template: string;
  body_template: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
export interface NotificationTemplateUpdate {
  title_template?: string;
  body_template?: string;
}
export interface EventVariablesResponse {
  event_type: string;
  event_name: string;
  variables: string[];
  supports_photo: boolean;
}
export interface TemplatePreviewRequest {
  event_type: string;
  title_template: string;
  body_template: string;
}
export interface TemplatePreviewResponse {
  title: string;
  body: string;
}
export interface NotificationLogEntry {
  id: number;
  provider_id: number;
  provider_name: string | null;
  provider_type: string | null;
  event_type: string;
  title: string;
  message: string;
  success: boolean;
  error_message: string | null;
  printer_id: number | null;
  printer_name: string | null;
  created_at: string;
}
export interface NotificationLogStats {
export interface NotificationLogStats {
  total: number;
  success_count: number;
  failure_count: number;
  by_event_type: Record<string, number>;
  by_provider: Record<string, number>;
}
export interface NotifyConfig {
export interface NotificationLogEntry {
export interface UserEmailPreferences {
export interface InboxItem {
export interface InboxPage {
export interface InboxKindInfo {
export interface InboxPreferencesUpdate {
export interface InboxPreferences extends InboxPreferencesUpdate {
```

## API client — notification / inbox methods and the endpoints they call
```regen: grep -E '^  [a-zA-Z]+: ' frontend/src/api/client.ts | grep -iE 'notification|inbox|appmessage' | sed -E 's/^  //; s/ =>.*//'; grep -oE "(request<[^(]*>|requestBlob)\((\`|')/(notifications|notification-templates|user-notifications|inbox)[^\`']*(\`|')(, \{ method: '[A-Z]+'|, '[A-Z]+')?" frontend/src/api/client.ts | sed -E 's/^request<.*>\(/request(/' | sort```
```
notifications: { configured: boolean; uncovered_printers: number[] };
items: InboxItem[];
available: InboxKindInfo[];
getNotificationProviders: ()
createNotificationProvider: (data: NotificationProviderCreate)
updateNotificationProvider: (id: number, data: NotificationProviderUpdate)
deleteNotificationProvider: (id: number)
testNotificationProvider: (id: number)
testNotificationConfig: (data: NotificationTestRequest)
testAllNotificationProviders: ()
getNotificationTemplates: ()
updateNotificationTemplate: (id: number, data: NotificationTemplateUpdate)
resetNotificationTemplate: (id: number)
getTemplateVariables: ()
getNotificationLogs: (params?: {
getNotificationLogStats: (days = 7)
clearNotificationLogs: (olderThanDays = 30)
getInbox: (before?: number)
markInboxRead: (id: number)
markInboxAllRead: (upTo?: number)
getInboxPreferences: ()
putInboxPreferences: (body: InboxPreferencesUpdate)
request('/inbox/preferences'
request('/inbox/preferences', { method: 'PUT'
request('/notification-templates'
request('/notification-templates/preview'
request('/notification-templates/variables'
request('/notifications/'
request('/notifications/'
request('/notifications/test-config'
request('/user-notifications/preferences'
request('/user-notifications/preferences'
request(`/inbox/${id}/read`, { method: 'POST'
request(`/notification-templates/${id}/reset`
request(`/notification-templates/${id}`
request(`/notifications/${id}/test`, { method: 'POST'
request(`/notifications/${id}`
request(`/notifications/${id}`, { method: 'DELETE'
request(`/notifications/logs/stats?days=${days}`
request(`/notifications/logs?${searchParams}`
```

## Translation keys of the notifications, notificationLog, notificationTemplates and inbox namespaces (en; placeholders after the key)
```regen: mkdir -p /tmp/fenrir-refactor-notif-probe && frontend/node_modules/.bin/rolldown tools/probe_notif_i18n_entry.ts --format cjs --file /tmp/fenrir-refactor-notif-probe/notifI18n.cjs >/dev/null 2>&1 && node tools/probe_notif_i18n.cjs | sed -n '/^--- en notifications/,/^--- es notifications/p' | grep -v '^--- es ' | sed -E 's/ = .*  placeholders=(.*)$/  \1/; s/ = .*//'```
```
--- en notifications (363 keys)
notifications.add
notifications.addTitle
notifications.aiFailureDetection
notifications.aiFailureDetectionDescription
notifications.aitoPaymentReceivedDescription
notifications.aitoPaymentReceivedLabel
notifications.allPrinters
notifications.amsAlarms
notifications.amsDryingSuspended
notifications.amsDryingSuspendedDescription
notifications.amsDryingSuspendedTitle
notifications.amsHtAlarms
notifications.amsHtHumidity
notifications.amsHtHumidityHigh
notifications.amsHtHumidityHighDescription
notifications.amsHtTemp
notifications.amsHtTemperatureHigh
notifications.amsHtTemperatureHighDescription
notifications.amsHumidity
notifications.amsHumidityHigh
notifications.amsHumidityHighDescription
notifications.amsTemp
notifications.amsTemperatureHigh
notifications.amsTemperatureHighDescription
notifications.apiKey
notifications.appMessages
notifications.appMessagesBadge
notifications.appMessagesDescription
notifications.appToken
notifications.attachPhotoDescription
notifications.attachPhotoLabel
notifications.authToken
notifications.authentication
notifications.authorization
notifications.availableVariables
notifications.batchNotifications
notifications.bedCooled
notifications.bedCooledAfterPrint
notifications.bedCooledDescription
notifications.bedCooledLabel
notifications.billingChargeFailedDescription
notifications.billingChargeFailedLabel
notifications.bodyLabel
notifications.bodyPlaceholder
notifications.bodyPreview
notifications.bodyRequired
notifications.botToken
notifications.cancel
notifications.chatId
notifications.clearOld
notifications.clickToInsert
notifications.complete
notifications.configuration
notifications.connectedApps
notifications.dailyDigest
notifications.dailyDigestLabel
notifications.delete
notifications.deleteConfirm  {{name}}
notifications.deleteProvider
notifications.digest  {{time}}
notifications.digestCollected
notifications.edit
notifications.editProviderToChangeDigestTime
notifications.editProviderToChangeQuietHours
notifications.editTemplate  {{name}}
notifications.editTitle
notifications.enabled
notifications.enterTemplateContent
notifications.error
notifications.eventPriority.default
notifications.eventPriority.helpGotify
notifications.eventPriority.helpNtfy
notifications.eventPriority.high
notifications.eventPriority.low
notifications.eventPriority.min
notifications.eventPriority.sectionTitle
notifications.eventPriority.sectionTitleGotify
notifications.eventPriority.urgent
notifications.eventSettings
notifications.eventTypes.filament_low
notifications.eventTypes.maintenance_due
notifications.eventTypes.print_complete
notifications.eventTypes.print_failed
notifications.eventTypes.print_progress
notifications.eventTypes.print_start
notifications.eventTypes.print_stopped
notifications.eventTypes.printer_error
notifications.eventTypes.printer_offline
notifications.eventTypes.test
notifications.failed
notifications.fieldRequired  {{field}}
notifications.firstLayer
notifications.firstLayerCompleteDescription
notifications.firstLayerCompleteLabel
notifications.fromEmail
notifications.haDataInvalid
notifications.haSensorAlert
notifications.haSensorAlertDescription
notifications.haServiceHelp
notifications.hide
notifications.inventoryAlerts
notifications.jobAdded
notifications.jobAddedDescription
notifications.jobAssigned
notifications.jobAssignedDescription
notifications.jobFailed
notifications.jobFailedDescription
notifications.jobSkipped
notifications.jobSkippedDescription
notifications.jobStarted
notifications.jobStartedDescription
notifications.jobWaiting
notifications.jobWaitingDescription
notifications.justNow
notifications.last24Hours
notifications.last30Days
notifications.last7Days
notifications.last90Days
notifications.lastSuccess  {{date}}
notifications.livePreview
notifications.loadingPreview
notifications.locationHaSensorAlert
notifications.locationHaSensorAlertDescription
notifications.logError
notifications.logMessage
notifications.logProvider  {{type}}
notifications.logTime  {{time}}
notifications.logTitle
notifications.lowFilament
notifications.lowFilamentLabel
notifications.maintenance
notifications.maintenanceDue
notifications.maintenanceDueDescription
notifications.messageFieldName
notifications.missingSpoolAssignmentDescription
notifications.missingSpoolAssignmentLabel
notifications.nameLabel
notifications.namePlaceholder
notifications.nameRequired
notifications.noFailedNotifications
notifications.noNotificationsDuring
notifications.noNotificationsLogged
notifications.noPhoto
notifications.notificationEvents
notifications.notificationLog
notifications.notifyAppearance
notifications.notifyDashboardUrl
notifications.notifyDeviceId
notifications.notifyGroupType
notifications.notifyGroupTypeHelp
notifications.notifyIconUrl
notifications.notifyIosFeaturesUnavailable
notifications.notifyLifecycleHelp
notifications.notifyLiveActivities
notifications.notifyLiveActivitiesHelp
notifications.notifyLockScreenWidgets
notifications.notifyLockScreenWidgetsHelp
notifications.notifyMetrics
notifications.notifyMetricsHelp
notifications.notifyPhotoUnavailable
notifications.notifyPrivacy
notifications.notifyPrivacyHelp
notifications.notifyShowStage
notifications.notifyStyle
notifications.notifyStyleBar
notifications.notifyStyleNone
notifications.notifyStyleSegments
notifications.notifySymbol
notifications.notifyTestHelp
notifications.notifyTimeSensitive
notifications.notifyTimeSensitiveHelp
notifications.notifyTint
notifications.notifyToken
notifications.offline
notifications.onlyFromPrinter
notifications.password
notifications.pauseUpcomingBadge
notifications.pauseUpcomingDescription
notifications.pauseUpcomingLabel
notifications.payloadFormat
notifications.phoneNumber
notifications.photoPreview
notifications.photoPreviewNote
notifications.photoPreviewNoteEmailOnly
notifications.photoPreviewNoteWithEmail
notifications.plateCheck
notifications.plateClear
notifications.plateClearRequired
notifications.plateClearRequiredDescription
notifications.plateNotEmpty
notifications.plateNotEmptyDescription
notifications.printCompleted
notifications.printConfirmRequest
notifications.printConfirmRequestDescription
notifications.printEvents
notifications.printFailed
notifications.printQueue
notifications.printStarted
notifications.printStopped
notifications.printer
notifications.printerError
notifications.printerFilter
notifications.printerOffline
notifications.printerStatus
notifications.priority
notifications.progress
notifications.progressMilestones
notifications.progressMilestonesDescription
notifications.progressPercent
notifications.providerDescriptions.bark
notifications.providerDescriptions.callmebot
notifications.providerDescriptions.discord
notifications.providerDescriptions.email
notifications.providerDescriptions.gotify
notifications.providerDescriptions.homeassistant
notifications.providerDescriptions.notify
notifications.providerDescriptions.ntfy
notifications.providerDescriptions.pushover
notifications.providerDescriptions.telegram
notifications.providerDescriptions.webhook
notifications.providerTypeLabel
notifications.providerTypes.bark
notifications.providerTypes.callmebot
notifications.providerTypes.discord
notifications.providerTypes.email
notifications.providerTypes.gotify
notifications.providerTypes.homeassistant
notifications.providerTypes.notify
notifications.providerTypes.ntfy
notifications.providerTypes.pushover
notifications.providerTypes.telegram
notifications.providerTypes.webhook
notifications.pushoverExpire
notifications.pushoverRetry
notifications.queueComplete
notifications.queueCompleteDescription
notifications.quiet
notifications.quietEnd
notifications.quietHours
notifications.quietHoursDnd
notifications.quietStart
notifications.refresh
notifications.resetToDefault
notifications.save
notifications.security
notifications.sendAt  {{time}}
notifications.sendDigestAt
notifications.sendFromProvider
notifications.sendTestNotification
notifications.serverUrl
notifications.show
notifications.showFailedOnly
notifications.smtpPort
notifications.smtpServer
notifications.start
notifications.statsFailed  {{count}}
notifications.statsNotifications
notifications.statsSent  {{count}}
notifications.statsSummary  {{days}}
notifications.stockBreakAlert
notifications.stockBreakAlertDescription
notifications.stockReorderAlert
notifications.stockReorderAlertDescription
notifications.stopped
notifications.telegramThreadId
notifications.telegramThreadIdHelp
notifications.telegramThreadIdInvalid
notifications.telegramVerdictBadgeBoth
notifications.telegramVerdictBadgeReactions
notifications.telegramVerdictMode
notifications.telegramVerdictModeBoth
notifications.telegramVerdictModeButtons
notifications.telegramVerdictModeHelp
notifications.telegramVerdictModeReactions
notifications.testConfiguration
notifications.titleFieldName
notifications.titleLabel
notifications.titlePlaceholder
notifications.titlePreview
notifications.titleRequired
notifications.toEmail
notifications.topic
notifications.unknownProvider
notifications.userEmail.emailNotifications
notifications.userEmail.emailNotificationsDesc
notifications.userEmail.noEmailWarning
notifications.userEmail.printErrors
notifications.userEmail.printErrorsDesc
notifications.userEmail.printJobFinishes
notifications.userEmail.printJobFinishesDesc
notifications.userEmail.printJobNotifications
notifications.userEmail.printJobNotificationsDesc
notifications.userEmail.printJobStarts
notifications.userEmail.printJobStartsDesc
notifications.userEmail.printJobStops
notifications.userEmail.printJobStopsDesc
notifications.userEmail.saveError
notifications.userEmail.saveSuccess
notifications.userEmail.sendingTo
notifications.userEmail.title
notifications.userKey
notifications.username
notifications.webhookUrl
notificationLog.events.lowFilament
notificationLog.events.maintenanceDue
notificationLog.events.printComplete
notificationLog.events.printFailed
notificationLog.events.printStarted
notificationLog.events.printStopped
notificationLog.events.printerError
notificationLog.events.printerOffline
notificationLog.events.progress
notificationLog.events.test
notificationLog.timeAgo.hoursAgo  {{hours}}
notificationLog.timeAgo.justNow
notificationLog.timeAgo.minutesAgo  {{minutes}}
notificationLog.title
notificationTemplates.placeholders.body
notificationTemplates.placeholders.title
inbox.autoWatch
inbox.bellLabel
inbox.comingLater
inbox.empty
inbox.familyAito
inbox.familyPrinters
inbox.filterAito
inbox.filterAll
inbox.filterPrinters
inbox.kind.aitoOverdue
inbox.kind.aitoPaid
inbox.kind.aitoQuoteAccepted
inbox.kind.aitoQuoteDeclined
inbox.kind.aitoQuoteViewed
inbox.kind.hoursReadingsDue
inbox.kind.printerFailed
inbox.kind.printerFinished
inbox.kind.printerJobSent
inbox.markAllRead
inbox.markRead
inbox.markReadFailed
inbox.offInSettings
inbox.open
inbox.perUser
inbox.ring
inbox.saveFailed
inbox.settingsIntro
inbox.settingsTitle
inbox.soundOff
inbox.soundOn
inbox.targetGone
inbox.title
inbox.unread_one  {{count}}
inbox.unread_other  {{count}}
inbox.watchBody
inbox.watchFollowsSettings
inbox.watchLoadFailed
inbox.watchSave
inbox.watchSaved
inbox.watchStop
inbox.watchStopped
inbox.watchTitle
inbox.watching
nav.notifications
```

## Translation keys the notification UI reads (string literals and templates)
```regen: grep -hoE --include='*.ts' --include='*.tsx' "'(notifications|notificationLog|notificationTemplates|inbox|nav|common|settings)\.[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*'|\`(notifications|inbox)\.[a-zA-Z0-9_.]*\$\{[^}]*\}[a-zA-Z0-9_]*\`" frontend/src/components/AddNotificationModal.tsx frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationLogViewer.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/NotificationProviderCard.tsx frontend/src/components/NotificationTemplateEditor.tsx frontend/src/components/notificationKinds.ts frontend/src/pages/NotificationsPage.tsx frontend/src/utils/notify.ts | sort -u```
```
'common.close'
'common.no'
'common.save'
'common.saving'
'common.secretKept'
'common.yes'
'inbox.bellLabel'
'inbox.empty'
'inbox.filterAito'
'inbox.filterAll'
'inbox.filterPrinters'
'inbox.markAllRead'
'inbox.markRead'
'inbox.markReadFailed'
'inbox.open'
'inbox.soundOff'
'inbox.soundOn'
'inbox.targetGone'
'inbox.title'
'inbox.unread'
'notifications.add'
'notifications.addTitle'
'notifications.allPrinters'
'notifications.attachPhotoDescription'
'notifications.attachPhotoLabel'
'notifications.availableVariables'
'notifications.batchNotifications'
'notifications.bodyLabel'
'notifications.bodyPlaceholder'
'notifications.bodyPreview'
'notifications.bodyRequired'
'notifications.cancel'
'notifications.clearOld'
'notifications.clickToInsert'
'notifications.configuration'
'notifications.dailyDigest'
'notifications.dailyDigestLabel'
'notifications.delete'
'notifications.deleteConfirm'
'notifications.deleteProvider'
'notifications.digest'
'notifications.digestCollected'
'notifications.edit'
'notifications.editProviderToChangeDigestTime'
'notifications.editProviderToChangeQuietHours'
'notifications.editTemplate'
'notifications.editTitle'
'notifications.enabled'
'notifications.enterTemplateContent'
'notifications.error'
'notifications.eventPriority.default'
'notifications.eventPriority.helpGotify'
'notifications.eventPriority.helpNtfy'
'notifications.eventPriority.high'
'notifications.eventPriority.low'
'notifications.eventPriority.min'
'notifications.eventPriority.sectionTitle'
'notifications.eventPriority.sectionTitleGotify'
'notifications.eventPriority.urgent'
'notifications.eventSettings'
'notifications.fieldRequired'
'notifications.haDataInvalid'
'notifications.haServiceHelp'
'notifications.hide'
'notifications.justNow'
'notifications.last24Hours'
'notifications.last30Days'
'notifications.last7Days'
'notifications.last90Days'
'notifications.lastSuccess'
'notifications.livePreview'
'notifications.loadingPreview'
'notifications.logError'
'notifications.logMessage'
'notifications.logProvider'
'notifications.logTime'
'notifications.logTitle'
'notifications.nameLabel'
'notifications.namePlaceholder'
'notifications.nameRequired'
'notifications.noFailedNotifications'
'notifications.noNotificationsDuring'
'notifications.noNotificationsLogged'
'notifications.noPhoto'
'notifications.notificationEvents'
'notifications.notificationLog'
'notifications.notifyAppearance'
'notifications.notifyDashboardUrl'
'notifications.notifyDeviceId'
'notifications.notifyGroupType'
'notifications.notifyGroupTypeHelp'
'notifications.notifyIconUrl'
'notifications.notifyIosFeaturesUnavailable'
'notifications.notifyLifecycleHelp'
'notifications.notifyLiveActivities'
'notifications.notifyLiveActivitiesHelp'
'notifications.notifyLockScreenWidgets'
'notifications.notifyLockScreenWidgetsHelp'
'notifications.notifyMetrics'
'notifications.notifyMetricsHelp'
'notifications.notifyPhotoUnavailable'
'notifications.notifyPrivacy'
'notifications.notifyPrivacyHelp'
'notifications.notifyShowStage'
'notifications.notifyStyle'
'notifications.notifyStyleBar'
'notifications.notifyStyleNone'
'notifications.notifyStyleSegments'
'notifications.notifySymbol'
'notifications.notifyTestHelp'
'notifications.notifyTimeSensitive'
'notifications.notifyTimeSensitiveHelp'
'notifications.notifyTint'
'notifications.notifyToken'
'notifications.onlyFromPrinter'
'notifications.photoPreview'
'notifications.photoPreviewNote'
'notifications.photoPreviewNoteEmailOnly'
'notifications.photoPreviewNoteWithEmail'
'notifications.printer'
'notifications.printerFilter'
'notifications.progress'
'notifications.providerTypeLabel'
'notifications.pushoverExpire'
'notifications.pushoverRetry'
'notifications.quiet'
'notifications.quietEnd'
'notifications.quietHours'
'notifications.quietHoursDnd'
'notifications.quietStart'
'notifications.refresh'
'notifications.resetToDefault'
'notifications.save'
'notifications.sendAt'
'notifications.sendDigestAt'
'notifications.sendFromProvider'
'notifications.sendTestNotification'
'notifications.show'
'notifications.showFailedOnly'
'notifications.statsFailed'
'notifications.statsNotifications'
'notifications.statsSent'
'notifications.statsSummary'
'notifications.telegramThreadId'
'notifications.telegramThreadIdHelp'
'notifications.telegramThreadIdInvalid'
'notifications.telegramVerdictBadgeBoth'
'notifications.telegramVerdictBadgeReactions'
'notifications.telegramVerdictMode'
'notifications.telegramVerdictModeBoth'
'notifications.telegramVerdictModeButtons'
'notifications.telegramVerdictModeHelp'
'notifications.telegramVerdictModeReactions'
'notifications.testConfiguration'
'notifications.titleLabel'
'notifications.titlePlaceholder'
'notifications.titlePreview'
'notifications.titleRequired'
'notifications.unknownProvider'
'notifications.userEmail.emailNotifications'
'notifications.userEmail.emailNotificationsDesc'
'notifications.userEmail.noEmailWarning'
'notifications.userEmail.printErrors'
'notifications.userEmail.printErrorsDesc'
'notifications.userEmail.printJobFinishes'
'notifications.userEmail.printJobFinishesDesc'
'notifications.userEmail.printJobNotifications'
'notifications.userEmail.printJobNotificationsDesc'
'notifications.userEmail.printJobStarts'
'notifications.userEmail.printJobStartsDesc'
'notifications.userEmail.printJobStops'
'notifications.userEmail.printJobStopsDesc'
'notifications.userEmail.saveError'
'notifications.userEmail.saveSuccess'
'notifications.userEmail.sendingTo'
'notifications.userEmail.title'
```

## React Query hooks, keys and invalidations in the notification components
```regen: grep -hoE --include='*.ts' --include='*.tsx' 'useQuery|useMutation|useIsMutating|(query|mutation)Key: [^,}]*|[A-Z_]+_KEY = \[[^]]*\]|(invalidate|remove|cancel)Queries\([^)]*\)|setQueryData\([^,]*,' frontend/src/components/AddNotificationModal.tsx frontend/src/components/NotificationBell.tsx frontend/src/components/NotificationLogViewer.tsx frontend/src/components/NotificationPanel.tsx frontend/src/components/NotificationProviderCard.tsx frontend/src/components/NotificationTemplateEditor.tsx frontend/src/components/notificationKinds.ts frontend/src/pages/NotificationsPage.tsx frontend/src/utils/notify.ts | sort -u```
```
INBOX_KEY = ['inbox']
PREFS_KEY = ['inbox-preferences']
cancelQueries({ queryKey: INBOX_KEY })
invalidateQueries({ queryKey: INBOX_KEY })
invalidateQueries({ queryKey: PREFS_KEY })
invalidateQueries({ queryKey: ['notification-log-stats'] })
invalidateQueries({ queryKey: ['notification-logs'] })
invalidateQueries({ queryKey: ['notification-providers'] })
invalidateQueries({ queryKey: ['notification-templates'] })
invalidateQueries({ queryKey: ['user-email-preferences'] })
queryKey: INBOX_KEY
queryKey: PREFS_KEY
queryKey: ['advancedAuthStatus']
queryKey: ['notification-log-stats'
queryKey: ['notification-logs'
queryKey: ['printers']
queryKey: ['template-preview'
queryKey: ['template-variables']
queryKey: ['user-email-preferences']
setQueryData(PREFS_KEY,
useMutation
useQuery
```

## Wiring — route path, bell placement, URL parameters
```regen: grep -nE "NotificationsPage|path=\"notifications\"" frontend/src/App.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//"; grep -nE "NotificationBell|id: .notifications.|notifications: .notifications:read." frontend/src/components/Layout.tsx | sed -E "s/^[0-9]+://; s/^[[:space:]]*//" | sort -u; grep -hoE "searchParams\.get\(.[a-z_]+.\)|[?&](provider|tab|template)=" frontend/src/pages/NotificationsPage.tsx | sort -u```
```
const NotificationsPage = lazyWithReload(() => import('./pages/NotificationsPage').then(m => ({ default: m.NotificationsPage })));
<Route path="notifications" element={<NotificationsPage />} />
<NotificationBell />
import { NotificationBell } from './NotificationBell';
{ id: 'notifications', to: '/notifications', icon: Bell, labelKey: 'nav.notifications' },
{!isSidebarCompact && <NotificationBell />}
```

