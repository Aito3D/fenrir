# SURFACE.md — campaign-9 public contract: THE WHOLE APP (frozen at setup)

Regenerate every section with `bash tools/gen_surface_all.sh > SURFACE.md`.
Each section names the exact command that produces it. ANY diff against this
file is a change to the app's public contract and fails the iteration.

## HTTP routes (path + methods)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\")]" 2>/dev/null```
```
/ ['GET']
/api/v1/aito/ ['GET']
/api/v1/aito/ ['POST']
/api/v1/aito/import ['POST']
/api/v1/aito/proofread ['POST']
/api/v1/aito/shipping/services ['GET']
/api/v1/aito/summarize ['POST']
/api/v1/aito/tasks/{task_id} ['PATCH']
/api/v1/aito/tasks/{task_id} ['DELETE']
/api/v1/aito/trash ['GET']
/api/v1/aito/{project_id} ['PATCH']
/api/v1/aito/{project_id} ['DELETE']
/api/v1/aito/{project_id}/contacted ['PATCH']
/api/v1/aito/{project_id}/events ['GET']
/api/v1/aito/{project_id}/events ['POST']
/api/v1/aito/{project_id}/flag ['PATCH']
/api/v1/aito/{project_id}/invoice ['GET']
/api/v1/aito/{project_id}/invoice-email ['GET']
/api/v1/aito/{project_id}/invoice-email ['POST']
/api/v1/aito/{project_id}/invoice.pdf ['GET']
/api/v1/aito/{project_id}/move ['PATCH']
/api/v1/aito/{project_id}/quote-email ['GET']
/api/v1/aito/{project_id}/quote-email ['POST']
/api/v1/aito/{project_id}/quote-status ['POST']
/api/v1/aito/{project_id}/quote.pdf ['GET']
/api/v1/aito/{project_id}/restore ['POST']
/api/v1/aito/{project_id}/sync ['POST']
/api/v1/aito/{project_id}/tasks ['GET']
/api/v1/aito/{project_id}/tasks ['POST']
/api/v1/aito/{project_id}/tasks/reorder ['PATCH']
/api/v1/ams-history/{printer_id} ['DELETE']
/api/v1/ams-history/{printer_id}/{ams_id} ['GET']
/api/v1/api-keys/ ['GET']
/api/v1/api-keys/ ['POST']
/api/v1/api-keys/{key_id} ['GET']
/api/v1/api-keys/{key_id} ['PATCH']
/api/v1/api-keys/{key_id} ['DELETE']
/api/v1/archives/ ['GET']
/api/v1/archives/analysis/failures ['GET']
/api/v1/archives/backfill-hashes ['POST']
/api/v1/archives/compare ['GET']
/api/v1/archives/export ['GET']
/api/v1/archives/no-3mf-warning ['GET']
/api/v1/archives/purge ['POST']
/api/v1/archives/purge/preview ['GET']
/api/v1/archives/purge/settings ['GET']
/api/v1/archives/purge/settings ['PUT']
/api/v1/archives/recalculate-costs ['POST']
/api/v1/archives/rescan-all ['POST']
/api/v1/archives/search ['GET']
/api/v1/archives/search/rebuild-index ['POST']
/api/v1/archives/slim ['GET']
/api/v1/archives/stats ['GET']
/api/v1/archives/stats/export ['GET']
/api/v1/archives/tags ['GET']
/api/v1/archives/tags/{tag_name} ['PUT']
/api/v1/archives/tags/{tag_name} ['DELETE']
/api/v1/archives/upload ['POST']
/api/v1/archives/upload-bulk ['POST']
/api/v1/archives/upload-source ['POST']
/api/v1/archives/{archive_id} ['GET']
/api/v1/archives/{archive_id} ['PATCH']
/api/v1/archives/{archive_id} ['DELETE']
/api/v1/archives/{archive_id}/capabilities ['GET']
/api/v1/archives/{archive_id}/delete-impact ['GET']
/api/v1/archives/{archive_id}/dl/{token}/{filename} ['GET']
/api/v1/archives/{archive_id}/download ['GET']
/api/v1/archives/{archive_id}/duplicates ['GET']
/api/v1/archives/{archive_id}/f3d ['POST']
/api/v1/archives/{archive_id}/f3d ['GET']
/api/v1/archives/{archive_id}/f3d ['DELETE']
/api/v1/archives/{archive_id}/favorite ['POST']
/api/v1/archives/{archive_id}/filament-requirements ['GET']
/api/v1/archives/{archive_id}/file/{filename} ['GET']
/api/v1/archives/{archive_id}/gcode ['GET']
/api/v1/archives/{archive_id}/media-download-token ['POST']
/api/v1/archives/{archive_id}/media/dl/{token}/{filename} ['GET']
/api/v1/archives/{archive_id}/photos ['POST']
/api/v1/archives/{archive_id}/photos/{filename} ['GET']
/api/v1/archives/{archive_id}/photos/{filename} ['DELETE']
/api/v1/archives/{archive_id}/plate-preview ['GET']
/api/v1/archives/{archive_id}/plate-thumbnail/{plate_index} ['GET']
/api/v1/archives/{archive_id}/plates ['GET']
/api/v1/archives/{archive_id}/printer-media ['GET']
/api/v1/archives/{archive_id}/project-image/{image_path:path} ['GET']
/api/v1/archives/{archive_id}/project-page ['GET']
/api/v1/archives/{archive_id}/project-page ['PATCH']
/api/v1/archives/{archive_id}/qrcode ['GET']
/api/v1/archives/{archive_id}/reprint ['POST']
/api/v1/archives/{archive_id}/rescan ['POST']
/api/v1/archives/{archive_id}/runs ['GET']
/api/v1/archives/{archive_id}/similar ['GET']
/api/v1/archives/{archive_id}/slice ['POST']
/api/v1/archives/{archive_id}/slicer-token ['POST']
/api/v1/archives/{archive_id}/source ['POST']
/api/v1/archives/{archive_id}/source ['GET']
/api/v1/archives/{archive_id}/source ['DELETE']
/api/v1/archives/{archive_id}/source-dl/{token}/{filename} ['GET']
/api/v1/archives/{archive_id}/source-slicer-token ['POST']
/api/v1/archives/{archive_id}/source/{filename} ['GET']
/api/v1/archives/{archive_id}/thumbnail ['GET']
/api/v1/archives/{archive_id}/timelapse ['GET']
/api/v1/archives/{archive_id}/timelapse ['DELETE']
/api/v1/archives/{archive_id}/timelapse/info ['GET']
/api/v1/archives/{archive_id}/timelapse/process ['POST']
/api/v1/archives/{archive_id}/timelapse/scan ['POST']
/api/v1/archives/{archive_id}/timelapse/select ['POST']
/api/v1/archives/{archive_id}/timelapse/thumbnails ['GET']
/api/v1/archives/{archive_id}/timelapse/upload ['POST']
/api/v1/auth/2fa/admin/{user_id} ['DELETE']
/api/v1/auth/2fa/email/disable ['POST']
/api/v1/auth/2fa/email/enable ['POST']
/api/v1/auth/2fa/email/enable/confirm ['POST']
/api/v1/auth/2fa/email/send ['POST']
/api/v1/auth/2fa/status ['GET']
/api/v1/auth/2fa/totp/disable ['POST']
/api/v1/auth/2fa/totp/enable ['POST']
/api/v1/auth/2fa/totp/regenerate-backup-codes ['POST']
/api/v1/auth/2fa/totp/setup ['POST']
/api/v1/auth/2fa/verify ['POST']
/api/v1/auth/advanced-auth/disable ['POST']
/api/v1/auth/advanced-auth/enable ['POST']
/api/v1/auth/advanced-auth/status ['GET']
/api/v1/auth/disable ['POST']
/api/v1/auth/encryption-status ['GET']
/api/v1/auth/forgot-password ['POST']
/api/v1/auth/forgot-password/confirm ['POST']
/api/v1/auth/ldap/provision ['POST']
/api/v1/auth/ldap/search ['GET']
/api/v1/auth/ldap/status ['GET']
/api/v1/auth/ldap/test ['POST']
/api/v1/auth/login ['POST']
/api/v1/auth/logout ['POST']
/api/v1/auth/me ['GET']
/api/v1/auth/oidc/authorize/{provider_id} ['GET']
/api/v1/auth/oidc/callback ['GET']
/api/v1/auth/oidc/exchange ['POST']
/api/v1/auth/oidc/links ['GET']
/api/v1/auth/oidc/links/{provider_id} ['DELETE']
/api/v1/auth/oidc/providers ['GET']
/api/v1/auth/oidc/providers ['POST']
/api/v1/auth/oidc/providers/all ['GET']
/api/v1/auth/oidc/providers/{provider_id} ['PUT']
/api/v1/auth/oidc/providers/{provider_id} ['DELETE']
/api/v1/auth/oidc/providers/{provider_id}/icon ['GET']
/api/v1/auth/oidc/providers/{provider_id}/icon ['DELETE']
/api/v1/auth/oidc/providers/{provider_id}/icon/refresh ['POST']
/api/v1/auth/reset-password ['POST']
/api/v1/auth/setup ['POST']
/api/v1/auth/smtp ['GET']
/api/v1/auth/smtp ['POST']
/api/v1/auth/smtp/test ['POST']
/api/v1/auth/status ['GET']
/api/v1/auth/tokens ['POST']
/api/v1/auth/tokens ['GET']
/api/v1/auth/tokens/all ['GET']
/api/v1/auth/tokens/{token_id} ['DELETE']
/api/v1/auth/ws-token ['POST']
/api/v1/bug-report/start-logging ['POST']
/api/v1/bug-report/stop-logging ['POST']
/api/v1/bug-report/submit ['POST']
/api/v1/calculator/defaults ['GET']
/api/v1/calculator/defaults ['PATCH']
/api/v1/calculator/filaments/ ['GET']
/api/v1/calculator/filaments/ ['POST']
/api/v1/calculator/filaments/zoho-sync ['POST']
/api/v1/calculator/filaments/{filament_id} ['PATCH']
/api/v1/calculator/filaments/{filament_id} ['DELETE']
/api/v1/calculator/insights ['GET']
/api/v1/calculator/printers/ ['GET']
/api/v1/calculator/printers/ ['POST']
/api/v1/calculator/printers/{printer_id} ['PATCH']
/api/v1/calculator/printers/{printer_id} ['DELETE']
/api/v1/calculator/zoho-filaments ['GET']
/api/v1/cloud/builtin-filaments ['GET']
/api/v1/cloud/devices ['GET']
/api/v1/cloud/fields ['GET']
/api/v1/cloud/fields/{preset_type} ['GET']
/api/v1/cloud/filament-id-map ['GET']
/api/v1/cloud/filament-info ['POST']
/api/v1/cloud/filaments ['GET']
/api/v1/cloud/firmware-updates ['GET']
/api/v1/cloud/login ['POST']
/api/v1/cloud/logout ['POST']
/api/v1/cloud/settings ['GET']
/api/v1/cloud/settings ['POST']
/api/v1/cloud/settings/{setting_id} ['GET']
/api/v1/cloud/settings/{setting_id} ['PUT']
/api/v1/cloud/settings/{setting_id} ['DELETE']
/api/v1/cloud/status ['GET']
/api/v1/cloud/token ['POST']
/api/v1/cloud/verify ['POST']
/api/v1/discovery/info ['GET']
/api/v1/discovery/printers ['GET']
/api/v1/discovery/scan ['POST']
/api/v1/discovery/scan/status ['GET']
/api/v1/discovery/scan/stop ['POST']
/api/v1/discovery/start ['POST']
/api/v1/discovery/status ['GET']
/api/v1/discovery/stop ['POST']
/api/v1/external-links/ ['GET']
/api/v1/external-links/ ['POST']
/api/v1/external-links/reorder ['PUT']
/api/v1/external-links/{link_id} ['GET']
/api/v1/external-links/{link_id} ['PATCH']
/api/v1/external-links/{link_id} ['DELETE']
/api/v1/external-links/{link_id}/icon ['POST']
/api/v1/external-links/{link_id}/icon ['DELETE']
/api/v1/external-links/{link_id}/icon ['GET']
/api/v1/filament-catalog/ ['GET']
/api/v1/filament-catalog/ ['POST']
/api/v1/filament-catalog/by-type/{filament_type} ['GET']
/api/v1/filament-catalog/calculate-cost ['POST']
/api/v1/filament-catalog/seed-defaults ['POST']
/api/v1/filament-catalog/{filament_id} ['GET']
/api/v1/filament-catalog/{filament_id} ['PATCH']
/api/v1/filament-catalog/{filament_id} ['DELETE']
/api/v1/filament-profiles ['GET']
/api/v1/filament-profiles ['POST']
/api/v1/filament-profiles/bambu-scan ['GET']
/api/v1/filament-profiles/bambu-sync ['POST']
/api/v1/filament-profiles/base-content ['GET']
/api/v1/filament-profiles/base-presets ['GET']
/api/v1/filament-profiles/base-upload ['POST']
/api/v1/filament-profiles/sync-base ['POST']
/api/v1/filament-profiles/zoho-sync ['POST']
/api/v1/filament-profiles/{preset_id} ['PATCH']
/api/v1/filament-profiles/{preset_id} ['DELETE']
/api/v1/filament-profiles/{preset_id}/duplicate ['POST']
/api/v1/finance/cost-centers ['GET']
/api/v1/finance/cost-centers ['POST']
/api/v1/finance/cost-centers/mine ['GET']
/api/v1/finance/cost-centers/{cost_center_id} ['GET']
/api/v1/finance/cost-centers/{cost_center_id} ['PATCH']
/api/v1/finance/cost-centers/{cost_center_id} ['DELETE']
/api/v1/finance/cost-centers/{cost_center_id}/budgets ['PATCH']
/api/v1/finance/cost-centers/{cost_center_id}/members ['POST']
/api/v1/finance/cost-centers/{cost_center_id}/members/{user_id} ['DELETE']
/api/v1/finance/me/balance ['GET']
/api/v1/finance/me/transactions ['GET']
/api/v1/finance/rebuild-balance-ledger ['POST']
/api/v1/finance/transactions ['GET']
/api/v1/finance/transactions/manual ['POST']
/api/v1/finance/transactions/{transaction_id} ['DELETE']
/api/v1/finance/transactions/{transaction_id} ['PATCH']
/api/v1/finance/users/{user_id}/balance ['GET']
/api/v1/finance/users/{user_id}/deposit ['POST']
/api/v1/finance/users/{user_id}/transactions ['GET']
/api/v1/finance/users/{user_id}/withdraw ['POST']
/api/v1/firmware/latest ['GET']
/api/v1/firmware/updates ['GET']
/api/v1/firmware/updates/{printer_id} ['GET']
/api/v1/firmware/updates/{printer_id}/prepare ['GET']
/api/v1/firmware/updates/{printer_id}/upload ['POST']
/api/v1/firmware/updates/{printer_id}/upload/status ['GET']
/api/v1/github-backup/cloud-accounts ['GET']
/api/v1/github-backup/commits ['GET']
/api/v1/github-backup/config ['GET']
/api/v1/github-backup/config ['POST']
/api/v1/github-backup/config ['PATCH']
/api/v1/github-backup/config ['DELETE']
/api/v1/github-backup/logs ['GET']
/api/v1/github-backup/logs ['DELETE']
/api/v1/github-backup/restore ['POST']
/api/v1/github-backup/restore/preview ['GET']
/api/v1/github-backup/run ['POST']
/api/v1/github-backup/status ['GET']
/api/v1/github-backup/test ['POST']
/api/v1/github-backup/test-stored ['POST']
/api/v1/groups ['GET']
/api/v1/groups ['POST']
/api/v1/groups/ ['GET']
/api/v1/groups/ ['POST']
/api/v1/groups/permissions ['GET']
/api/v1/groups/{group_id} ['GET']
/api/v1/groups/{group_id} ['PATCH']
/api/v1/groups/{group_id} ['DELETE']
/api/v1/groups/{group_id}/users/{user_id} ['POST']
/api/v1/groups/{group_id}/users/{user_id} ['DELETE']
/api/v1/ha-sensors/ ['GET']
/api/v1/ha-sensors/ ['POST']
/api/v1/ha-sensors/by-printer/{printer_id}/readings ['GET']
/api/v1/ha-sensors/entities ['GET']
/api/v1/ha-sensors/{sensor_id} ['GET']
/api/v1/ha-sensors/{sensor_id} ['PATCH']
/api/v1/ha-sensors/{sensor_id} ['DELETE']
/api/v1/inventory/assignments ['GET']
/api/v1/inventory/assignments ['POST']
/api/v1/inventory/assignments/{printer_id}/{ams_id}/{tray_id} ['DELETE']
/api/v1/inventory/catalog ['GET']
/api/v1/inventory/catalog ['POST']
/api/v1/inventory/catalog/bulk-delete ['POST']
/api/v1/inventory/catalog/reset ['POST']
/api/v1/inventory/catalog/{entry_id} ['PUT']
/api/v1/inventory/catalog/{entry_id} ['DELETE']
/api/v1/inventory/colors ['GET']
/api/v1/inventory/colors ['POST']
/api/v1/inventory/colors/bulk-delete ['POST']
/api/v1/inventory/colors/by-material ['GET']
/api/v1/inventory/colors/lookup ['GET']
/api/v1/inventory/colors/map ['GET']
/api/v1/inventory/colors/reset ['POST']
/api/v1/inventory/colors/search ['GET']
/api/v1/inventory/colors/sync ['POST']
/api/v1/inventory/colors/{entry_id} ['PUT']
/api/v1/inventory/colors/{entry_id} ['DELETE']
/api/v1/inventory/labels ['POST']
/api/v1/inventory/locations ['GET']
/api/v1/inventory/locations ['POST']
/api/v1/inventory/locations/{location_id} ['PATCH']
/api/v1/inventory/locations/{location_id} ['DELETE']
/api/v1/inventory/shopping-list ['GET']
/api/v1/inventory/shopping-list ['POST']
/api/v1/inventory/shopping-list ['DELETE']
/api/v1/inventory/shopping-list/{item_id} ['DELETE']
/api/v1/inventory/shopping-list/{item_id}/status ['PATCH']
/api/v1/inventory/sku-settings ['GET']
/api/v1/inventory/sku-settings ['POST']
/api/v1/inventory/spools ['GET']
/api/v1/inventory/spools ['POST']
/api/v1/inventory/spools/bulk ['POST']
/api/v1/inventory/spools/bulk-archive ['POST']
/api/v1/inventory/spools/bulk-delete ['POST']
/api/v1/inventory/spools/bulk-restore ['POST']
/api/v1/inventory/spools/bulk-update ['POST']
/api/v1/inventory/spools/by-tag ['GET']
/api/v1/inventory/spools/export ['GET']
/api/v1/inventory/spools/from-slot ['POST']
/api/v1/inventory/spools/import ['POST']
/api/v1/inventory/spools/reset-consumed-counter-bulk ['POST']
/api/v1/inventory/spools/{spool_id} ['GET']
/api/v1/inventory/spools/{spool_id} ['PATCH']
/api/v1/inventory/spools/{spool_id} ['DELETE']
/api/v1/inventory/spools/{spool_id}/archive ['POST']
/api/v1/inventory/spools/{spool_id}/k-profiles ['GET']
/api/v1/inventory/spools/{spool_id}/k-profiles ['PUT']
/api/v1/inventory/spools/{spool_id}/link-tag ['PATCH']
/api/v1/inventory/spools/{spool_id}/reset-consumed-counter ['POST']
/api/v1/inventory/spools/{spool_id}/restore ['POST']
/api/v1/inventory/spools/{spool_id}/usage ['GET']
/api/v1/inventory/spools/{spool_id}/usage ['DELETE']
/api/v1/inventory/sync-ams-weights ['POST']
/api/v1/inventory/usage ['GET']
/api/v1/library/bulk-delete ['POST']
/api/v1/library/files ['GET']
/api/v1/library/files ['POST']
/api/v1/library/files/ ['GET']
/api/v1/library/files/ ['POST']
/api/v1/library/files/add-to-queue ['POST']
/api/v1/library/files/check-duplicates ['POST']
/api/v1/library/files/extract-zip ['POST']
/api/v1/library/files/move ['POST']
/api/v1/library/files/{file_id} ['GET']
/api/v1/library/files/{file_id} ['PUT']
/api/v1/library/files/{file_id} ['DELETE']
/api/v1/library/files/{file_id}/dl/{token}/{filename} ['GET']
/api/v1/library/files/{file_id}/download ['GET']
/api/v1/library/files/{file_id}/filament-requirements ['GET']
/api/v1/library/files/{file_id}/gcode ['GET']
/api/v1/library/files/{file_id}/history ['GET']
/api/v1/library/files/{file_id}/plate-thumbnail/{plate_index} ['GET']
/api/v1/library/files/{file_id}/plates ['GET']
/api/v1/library/files/{file_id}/print ['POST']
/api/v1/library/files/{file_id}/slice ['POST']
/api/v1/library/files/{file_id}/slicer-token ['POST']
/api/v1/library/files/{file_id}/thumbnail ['GET']
/api/v1/library/folders ['GET']
/api/v1/library/folders ['POST']
/api/v1/library/folders/ ['GET']
/api/v1/library/folders/ ['POST']
/api/v1/library/folders/by-archive/{archive_id} ['GET']
/api/v1/library/folders/by-project/{project_id} ['GET']
/api/v1/library/folders/external ['POST']
/api/v1/library/folders/{folder_id} ['GET']
/api/v1/library/folders/{folder_id} ['PUT']
/api/v1/library/folders/{folder_id} ['DELETE']
/api/v1/library/folders/{folder_id}/readme ['GET']
/api/v1/library/folders/{folder_id}/scan ['POST']
/api/v1/library/generate-stl-thumbnails ['POST']
/api/v1/library/purge ['POST']
/api/v1/library/purge/preview ['GET']
/api/v1/library/stats ['GET']
/api/v1/library/tags ['GET']
/api/v1/library/tags ['POST']
/api/v1/library/tags/ ['GET']
/api/v1/library/tags/ ['POST']
/api/v1/library/tags/bulk-assign ['POST']
/api/v1/library/tags/{tag_id} ['PATCH']
/api/v1/library/tags/{tag_id} ['DELETE']
/api/v1/library/trash ['GET']
/api/v1/library/trash ['DELETE']
/api/v1/library/trash/settings ['GET']
/api/v1/library/trash/settings ['PUT']
/api/v1/library/trash/{file_id} ['DELETE']
/api/v1/library/trash/{file_id}/restore ['POST']
/api/v1/library/variant-groups ['POST']
/api/v1/library/variant-groups/ ['POST']
/api/v1/library/variant-groups/by-file/{file_id} ['GET']
/api/v1/library/variant-groups/{group_id} ['GET']
/api/v1/library/variant-groups/{group_id} ['PATCH']
/api/v1/library/variant-groups/{group_id} ['DELETE']
/api/v1/library/variant-groups/{group_id}/members ['POST']
/api/v1/library/variant-groups/{group_id}/members/{file_id} ['DELETE']
/api/v1/local-backup/backups ['GET']
/api/v1/local-backup/backups/{filename} ['DELETE']
/api/v1/local-backup/backups/{filename}/download ['GET']
/api/v1/local-backup/backups/{filename}/restore ['POST']
/api/v1/local-backup/path-check ['GET']
/api/v1/local-backup/run ['POST']
/api/v1/local-backup/status ['GET']
/api/v1/local-presets/ ['GET']
/api/v1/local-presets/ ['POST']
/api/v1/local-presets/base-cache/refresh ['POST']
/api/v1/local-presets/base-cache/status ['GET']
/api/v1/local-presets/import ['POST']
/api/v1/local-presets/reclassify ['POST']
/api/v1/local-presets/{preset_id} ['GET']
/api/v1/local-presets/{preset_id} ['PUT']
/api/v1/local-presets/{preset_id} ['DELETE']
/api/v1/maintenance/items/{item_id} ['PATCH']
/api/v1/maintenance/items/{item_id} ['DELETE']
/api/v1/maintenance/items/{item_id}/history ['GET']
/api/v1/maintenance/items/{item_id}/perform ['POST']
/api/v1/maintenance/overview ['GET']
/api/v1/maintenance/printers/{printer_id} ['GET']
/api/v1/maintenance/printers/{printer_id}/assign/{type_id} ['POST']
/api/v1/maintenance/printers/{printer_id}/hours ['PATCH']
/api/v1/maintenance/summary ['GET']
/api/v1/maintenance/types ['GET']
/api/v1/maintenance/types ['POST']
/api/v1/maintenance/types/restore-defaults ['POST']
/api/v1/maintenance/types/{type_id} ['PATCH']
/api/v1/maintenance/types/{type_id} ['DELETE']
/api/v1/makerworld/import ['POST']
/api/v1/makerworld/recent-imports ['GET']
/api/v1/makerworld/resolve ['POST']
/api/v1/makerworld/status ['GET']
/api/v1/makerworld/thumbnail ['GET']
/api/v1/metrics ['GET']
/api/v1/notification-templates ['GET']
/api/v1/notification-templates/ ['GET']
/api/v1/notification-templates/preview ['POST']
/api/v1/notification-templates/variables ['GET']
/api/v1/notification-templates/{template_id} ['GET']
/api/v1/notification-templates/{template_id} ['PUT']
/api/v1/notification-templates/{template_id}/reset ['POST']
/api/v1/notifications/ ['GET']
/api/v1/notifications/ ['POST']
/api/v1/notifications/logs ['GET']
/api/v1/notifications/logs ['DELETE']
/api/v1/notifications/logs/stats ['GET']
/api/v1/notifications/test-all ['POST']
/api/v1/notifications/test-config ['POST']
/api/v1/notifications/{provider_id} ['GET']
/api/v1/notifications/{provider_id} ['PATCH']
/api/v1/notifications/{provider_id} ['DELETE']
/api/v1/notifications/{provider_id}/test ['POST']
/api/v1/obico/cached-frame/{nonce} ['GET']
/api/v1/obico/printer-status ['GET']
/api/v1/obico/status ['GET']
/api/v1/obico/test-connection ['POST']
/api/v1/orca-cloud/device/poll ['POST']
/api/v1/orca-cloud/device/start ['POST']
/api/v1/orca-cloud/logout ['POST']
/api/v1/orca-cloud/profiles ['GET']
/api/v1/orca-cloud/profiles/{profile_id} ['GET']
/api/v1/orca-cloud/status ['GET']
/api/v1/pending-uploads/ ['GET']
/api/v1/pending-uploads/archive-all ['POST']
/api/v1/pending-uploads/count ['GET']
/api/v1/pending-uploads/discard-all ['DELETE']
/api/v1/pending-uploads/{upload_id} ['GET']
/api/v1/pending-uploads/{upload_id} ['DELETE']
/api/v1/pending-uploads/{upload_id}/archive ['POST']
/api/v1/pipeline-runs ['GET']
/api/v1/pipeline-runs/clear ['POST']
/api/v1/pipeline-runs/{run_id} ['GET']
/api/v1/pipeline-runs/{run_id}/cancel ['POST']
/api/v1/pipeline-runs/{run_id}/retry-failed ['POST']
/api/v1/print-log/ ['GET']
/api/v1/print-log/ ['DELETE']
/api/v1/print-log/{entry_id} ['DELETE']
/api/v1/print-log/{entry_id} ['PATCH']
/api/v1/print-log/{entry_id}/thumbnail ['GET']
/api/v1/printer-sensor-history/{printer_id} ['GET']
/api/v1/printer-sensor-history/{printer_id} ['DELETE']
/api/v1/printers/ ['GET']
/api/v1/printers/ ['POST']
/api/v1/printers/available-filaments ['GET']
/api/v1/printers/camera/grid-stream ['GET']
/api/v1/printers/camera/hub-status ['GET']
/api/v1/printers/camera/stream-token ['POST']
/api/v1/printers/developer-mode-warnings ['GET']
/api/v1/printers/diagnostic ['POST']
/api/v1/printers/test ['POST']
/api/v1/printers/usb-cameras ['GET']
/api/v1/printers/{printer_id} ['GET']
/api/v1/printers/{printer_id} ['PATCH']
/api/v1/printers/{printer_id} ['DELETE']
/api/v1/printers/{printer_id}/airduct-mode ['POST']
/api/v1/printers/{printer_id}/ams-backup ['POST']
/api/v1/printers/{printer_id}/ams-labels ['GET']
/api/v1/printers/{printer_id}/ams-labels/{ams_id} ['PUT']
/api/v1/printers/{printer_id}/ams-labels/{ams_id} ['DELETE']
/api/v1/printers/{printer_id}/ams/load ['POST']
/api/v1/printers/{printer_id}/ams/unload ['POST']
/api/v1/printers/{printer_id}/ams/{ams_id}/slot/{slot_id}/refresh ['POST']
/api/v1/printers/{printer_id}/ams/{ams_id}/tray/{tray_id}/reset ['POST']
/api/v1/printers/{printer_id}/bed-jog ['POST']
/api/v1/printers/{printer_id}/calibration ['POST']
/api/v1/printers/{printer_id}/camera/check-plate ['GET']
/api/v1/printers/{printer_id}/camera/diagnose ['POST']
/api/v1/printers/{printer_id}/camera/external/test ['POST']
/api/v1/printers/{printer_id}/camera/plate-detection/calibrate ['POST']
/api/v1/printers/{printer_id}/camera/plate-detection/calibrate ['DELETE']
/api/v1/printers/{printer_id}/camera/plate-detection/references ['GET']
/api/v1/printers/{printer_id}/camera/plate-detection/references/{index} ['PUT']
/api/v1/printers/{printer_id}/camera/plate-detection/references/{index} ['DELETE']
/api/v1/printers/{printer_id}/camera/plate-detection/references/{index}/thumbnail ['GET']
/api/v1/printers/{printer_id}/camera/plate-detection/status ['GET']
/api/v1/printers/{printer_id}/camera/snapshot ['GET']
/api/v1/printers/{printer_id}/camera/status ['GET']
/api/v1/printers/{printer_id}/camera/stop ['POST']
/api/v1/printers/{printer_id}/camera/stream ['GET']
/api/v1/printers/{printer_id}/camera/test ['GET']
/api/v1/printers/{printer_id}/camera/webrtc ['POST']
/api/v1/printers/{printer_id}/chamber-light ['POST']
/api/v1/printers/{printer_id}/clear-plate ['POST']
/api/v1/printers/{printer_id}/connect ['POST']
/api/v1/printers/{printer_id}/cover ['GET']
/api/v1/printers/{printer_id}/current-print-user ['GET']
/api/v1/printers/{printer_id}/debug/simulate-print-complete ['POST']
/api/v1/printers/{printer_id}/diagnostic ['GET']
/api/v1/printers/{printer_id}/disconnect ['POST']
/api/v1/printers/{printer_id}/drying/start ['POST']
/api/v1/printers/{printer_id}/drying/stop ['POST']
/api/v1/printers/{printer_id}/extruder-jog ['POST']
/api/v1/printers/{printer_id}/fan-speed ['POST']
/api/v1/printers/{printer_id}/files ['GET']
/api/v1/printers/{printer_id}/files ['DELETE']
/api/v1/printers/{printer_id}/files/dl/{token}/{filename} ['GET']
/api/v1/printers/{printer_id}/files/download ['GET']
/api/v1/printers/{printer_id}/files/download-job ['POST']
/api/v1/printers/{printer_id}/files/download-jobs/{job_id} ['GET']
/api/v1/printers/{printer_id}/files/download-jobs/{job_id} ['DELETE']
/api/v1/printers/{printer_id}/files/download-zip ['POST']
/api/v1/printers/{printer_id}/files/gcode ['GET']
/api/v1/printers/{printer_id}/files/plate-thumbnail/{plate_index} ['GET']
/api/v1/printers/{printer_id}/files/plates ['GET']
/api/v1/printers/{printer_id}/hms/clear ['POST']
/api/v1/printers/{printer_id}/hms/execute-action ['POST']
/api/v1/printers/{printer_id}/home-axes ['POST']
/api/v1/printers/{printer_id}/inventory-remain ['GET']
/api/v1/printers/{printer_id}/kprofiles/ ['GET']
/api/v1/printers/{printer_id}/kprofiles/ ['POST']
/api/v1/printers/{printer_id}/kprofiles/ ['DELETE']
/api/v1/printers/{printer_id}/kprofiles/batch ['POST']
/api/v1/printers/{printer_id}/kprofiles/notes ['GET']
/api/v1/printers/{printer_id}/kprofiles/notes ['PUT']
/api/v1/printers/{printer_id}/kprofiles/notes/{setting_id} ['DELETE']
/api/v1/printers/{printer_id}/logging ['GET']
/api/v1/printers/{printer_id}/logging ['DELETE']
/api/v1/printers/{printer_id}/logging/disable ['POST']
/api/v1/printers/{printer_id}/logging/enable ['POST']
/api/v1/printers/{printer_id}/overlay-status ['GET']
/api/v1/printers/{printer_id}/print-options ['POST']
/api/v1/printers/{printer_id}/print-speed ['POST']
/api/v1/printers/{printer_id}/print/objects ['GET']
/api/v1/printers/{printer_id}/print/pause ['POST']
/api/v1/printers/{printer_id}/print/resume ['POST']
/api/v1/printers/{printer_id}/print/skip-objects ['POST']
/api/v1/printers/{printer_id}/print/stop ['POST']
/api/v1/printers/{printer_id}/refresh-status ['POST']
/api/v1/printers/{printer_id}/runtime-debug ['GET']
/api/v1/printers/{printer_id}/select-extruder ['POST']
/api/v1/printers/{printer_id}/slot-presets ['GET']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['GET']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['PUT']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['DELETE']
/api/v1/printers/{printer_id}/slots/{ams_id}/{tray_id}/configure ['POST']
/api/v1/printers/{printer_id}/status ['GET']
/api/v1/printers/{printer_id}/storage ['GET']
/api/v1/printers/{printer_id}/temperature/bed ['POST']
/api/v1/printers/{printer_id}/temperature/chamber ['POST']
/api/v1/printers/{printer_id}/temperature/nozzle ['POST']
/api/v1/printers/{printer_id}/xy-jog ['POST']
/api/v1/projects ['GET']
/api/v1/projects/ ['GET']
/api/v1/projects/ ['POST']
/api/v1/projects/from-template/{template_id} ['POST']
/api/v1/projects/import ['POST']
/api/v1/projects/import/file ['POST']
/api/v1/projects/templates ['GET']
/api/v1/projects/{project_id} ['GET']
/api/v1/projects/{project_id} ['PATCH']
/api/v1/projects/{project_id} ['DELETE']
/api/v1/projects/{project_id}/add-archives ['POST']
/api/v1/projects/{project_id}/add-queue ['POST']
/api/v1/projects/{project_id}/archives ['GET']
/api/v1/projects/{project_id}/attachments ['POST']
/api/v1/projects/{project_id}/attachments/{filename} ['GET']
/api/v1/projects/{project_id}/attachments/{filename} ['DELETE']
/api/v1/projects/{project_id}/bom ['GET']
/api/v1/projects/{project_id}/bom ['POST']
/api/v1/projects/{project_id}/bom/{item_id} ['PATCH']
/api/v1/projects/{project_id}/bom/{item_id} ['DELETE']
/api/v1/projects/{project_id}/cover-image ['POST']
/api/v1/projects/{project_id}/cover-image ['GET']
/api/v1/projects/{project_id}/cover-image ['DELETE']
/api/v1/projects/{project_id}/create-template ['POST']
/api/v1/projects/{project_id}/export ['GET']
/api/v1/projects/{project_id}/file-progress ['GET']
/api/v1/projects/{project_id}/queue ['GET']
/api/v1/projects/{project_id}/remove-archives ['POST']
/api/v1/projects/{project_id}/timeline ['GET']
/api/v1/queue/ ['GET']
/api/v1/queue/ ['POST']
/api/v1/queue/batches ['POST']
/api/v1/queue/batches ['GET']
/api/v1/queue/batches/{batch_id} ['PATCH']
/api/v1/queue/batches/{batch_id} ['GET']
/api/v1/queue/batches/{batch_id} ['DELETE']
/api/v1/queue/batches/{batch_id}/dispatch ['POST']
/api/v1/queue/batches/{batch_id}/ungroup ['POST']
/api/v1/queue/bulk ['PATCH']
/api/v1/queue/printer/{printer_id}/resume ['POST']
/api/v1/queue/reorder ['POST']
/api/v1/queue/{item_id} ['GET']
/api/v1/queue/{item_id} ['PATCH']
/api/v1/queue/{item_id} ['DELETE']
/api/v1/queue/{item_id}/cancel ['POST']
/api/v1/queue/{item_id}/start ['POST']
/api/v1/queue/{item_id}/stop ['POST']
/api/v1/scheduled-dryings ['POST']
/api/v1/scheduled-dryings ['GET']
/api/v1/scheduled-dryings/{scheduled_drying_id} ['DELETE']
/api/v1/settings ['GET']
/api/v1/settings ['PATCH']
/api/v1/settings/ ['GET']
/api/v1/settings/ ['PUT']
/api/v1/settings/ ['PATCH']
/api/v1/settings/backup ['GET']
/api/v1/settings/check-ffmpeg ['GET']
/api/v1/settings/check-go2rtc ['GET']
/api/v1/settings/default-sidebar-order ['GET']
/api/v1/settings/electricity-price ['POST']
/api/v1/settings/mqtt/status ['GET']
/api/v1/settings/network-interfaces ['GET']
/api/v1/settings/reset ['POST']
/api/v1/settings/restore ['POST']
/api/v1/settings/spoolman ['GET']
/api/v1/settings/spoolman ['PUT']
/api/v1/settings/ui-preferences ['GET']
/api/v1/settings/virtual-printer ['GET']
/api/v1/settings/virtual-printer ['PUT']
/api/v1/settings/virtual-printer/models ['GET']
/api/v1/slice-jobs/{job_id} ['GET']
/api/v1/slicer-pipelines/ ['GET']
/api/v1/slicer-pipelines/ ['POST']
/api/v1/slicer-pipelines/{pipeline_id} ['GET']
/api/v1/slicer-pipelines/{pipeline_id} ['PUT']
/api/v1/slicer-pipelines/{pipeline_id} ['DELETE']
/api/v1/slicer-pipelines/{pipeline_id}/check-eligibility ['POST']
/api/v1/slicer-pipelines/{pipeline_id}/run ['POST']
/api/v1/slicer-pipelines/{pipeline_id}/runs ['GET']
/api/v1/slicer/preset-values ['GET']
/api/v1/slicer/presets ['GET']
/api/v1/slicer/preview-progress/{request_id} ['GET']
/api/v1/slicer/printer-models ['GET']
/api/v1/smart-plugs/ ['GET']
/api/v1/smart-plugs/ ['POST']
/api/v1/smart-plugs/by-printer/{printer_id} ['GET']
/api/v1/smart-plugs/by-printer/{printer_id}/scripts ['GET']
/api/v1/smart-plugs/discover/devices ['GET']
/api/v1/smart-plugs/discover/scan ['POST']
/api/v1/smart-plugs/discover/status ['GET']
/api/v1/smart-plugs/discover/stop ['POST']
/api/v1/smart-plugs/energy/history ['GET']
/api/v1/smart-plugs/ha/entities ['GET']
/api/v1/smart-plugs/ha/sensors ['GET']
/api/v1/smart-plugs/ha/test-connection ['POST']
/api/v1/smart-plugs/rest/test-connection ['POST']
/api/v1/smart-plugs/test-connection ['POST']
/api/v1/smart-plugs/{plug_id} ['GET']
/api/v1/smart-plugs/{plug_id} ['PATCH']
/api/v1/smart-plugs/{plug_id} ['DELETE']
/api/v1/smart-plugs/{plug_id}/control ['POST']
/api/v1/smart-plugs/{plug_id}/status ['GET']
/api/v1/sponsor-prompt/check ['GET']
/api/v1/sponsor-prompt/dismiss ['POST']
/api/v1/spoolbuddy/devices ['GET']
/api/v1/spoolbuddy/devices/register ['POST']
/api/v1/spoolbuddy/devices/{device_id} ['DELETE']
/api/v1/spoolbuddy/devices/{device_id}/calibration ['GET']
/api/v1/spoolbuddy/devices/{device_id}/calibration/set-factor ['POST']
/api/v1/spoolbuddy/devices/{device_id}/calibration/set-tare ['POST']
/api/v1/spoolbuddy/devices/{device_id}/calibration/tare ['POST']
/api/v1/spoolbuddy/devices/{device_id}/cancel-write ['POST']
/api/v1/spoolbuddy/devices/{device_id}/display ['GET']
/api/v1/spoolbuddy/devices/{device_id}/display ['PUT']
/api/v1/spoolbuddy/devices/{device_id}/heartbeat ['POST']
/api/v1/spoolbuddy/devices/{device_id}/system/command ['POST']
/api/v1/spoolbuddy/devices/{device_id}/system/command-result ['POST']
/api/v1/spoolbuddy/devices/{device_id}/system/config ['POST']
/api/v1/spoolbuddy/devices/{device_id}/update ['POST']
/api/v1/spoolbuddy/devices/{device_id}/update-check ['GET']
/api/v1/spoolbuddy/devices/{device_id}/update-status ['POST']
/api/v1/spoolbuddy/diagnostics/{device_id}/result ['GET']
/api/v1/spoolbuddy/diagnostics/{device_id}/result ['POST']
/api/v1/spoolbuddy/diagnostics/{device_id}/run ['POST']
/api/v1/spoolbuddy/nfc/tag-removed ['POST']
/api/v1/spoolbuddy/nfc/tag-scanned ['POST']
/api/v1/spoolbuddy/nfc/write-result ['POST']
/api/v1/spoolbuddy/nfc/write-tag ['POST']
/api/v1/spoolbuddy/scale/reading ['POST']
/api/v1/spoolbuddy/scale/update-spool-weight ['POST']
/api/v1/spoolbuddy/ssh/public-key ['GET']
/api/v1/spoolman/connect ['POST']
/api/v1/spoolman/disconnect ['POST']
/api/v1/spoolman/filaments ['GET']
/api/v1/spoolman/inventory/filaments ['GET']
/api/v1/spoolman/inventory/filaments/{filament_id} ['PATCH']
/api/v1/spoolman/inventory/slot-assignments ['POST']
/api/v1/spoolman/inventory/slot-assignments ['GET']
/api/v1/spoolman/inventory/slot-assignments/all ['GET']
/api/v1/spoolman/inventory/slot-assignments/{spoolman_spool_id} ['DELETE']
/api/v1/spoolman/inventory/spools ['GET']
/api/v1/spoolman/inventory/spools ['POST']
/api/v1/spoolman/inventory/spools/bulk ['POST']
/api/v1/spoolman/inventory/spools/bulk-archive ['POST']
/api/v1/spoolman/inventory/spools/bulk-delete ['POST']
/api/v1/spoolman/inventory/spools/bulk-restore ['POST']
/api/v1/spoolman/inventory/spools/bulk-update ['POST']
/api/v1/spoolman/inventory/spools/reset-consumed-counter-bulk ['POST']
/api/v1/spoolman/inventory/spools/{spool_id} ['GET']
/api/v1/spoolman/inventory/spools/{spool_id} ['PATCH']
/api/v1/spoolman/inventory/spools/{spool_id} ['DELETE']
/api/v1/spoolman/inventory/spools/{spool_id}/archive ['POST']
/api/v1/spoolman/inventory/spools/{spool_id}/k-profiles ['GET']
/api/v1/spoolman/inventory/spools/{spool_id}/k-profiles ['PUT']
/api/v1/spoolman/inventory/spools/{spool_id}/reset-consumed-counter ['POST']
/api/v1/spoolman/inventory/spools/{spool_id}/restore ['POST']
/api/v1/spoolman/inventory/spools/{spool_id}/tag ['PATCH']
/api/v1/spoolman/inventory/spools/{spool_id}/weight ['PATCH']
/api/v1/spoolman/inventory/sync-ams-weights ['POST']
/api/v1/spoolman/labels ['POST']
/api/v1/spoolman/spools ['GET']
/api/v1/spoolman/spools/from-slot ['POST']
/api/v1/spoolman/spools/linked ['GET']
/api/v1/spoolman/spools/unlinked ['GET']
/api/v1/spoolman/spools/{spool_id}/link ['POST']
/api/v1/spoolman/spools/{spool_id}/unlink ['POST']
/api/v1/spoolman/status ['GET']
/api/v1/spoolman/sync-all ['POST']
/api/v1/spoolman/sync/{printer_id} ['POST']
/api/v1/support/bundle ['GET']
/api/v1/support/debug-logging ['GET']
/api/v1/support/debug-logging ['POST']
/api/v1/support/logs ['GET']
/api/v1/support/logs ['DELETE']
/api/v1/system/appliance ['GET']
/api/v1/system/db-pool ['GET']
/api/v1/system/health ['GET']
/api/v1/system/info ['GET']
/api/v1/system/storage-usage ['GET']
/api/v1/updates/apply ['POST']
/api/v1/updates/check ['GET']
/api/v1/updates/status ['GET']
/api/v1/updates/version ['GET']
/api/v1/user-notifications/preferences ['GET']
/api/v1/user-notifications/preferences ['PUT']
/api/v1/users ['GET']
/api/v1/users ['POST']
/api/v1/users/ ['GET']
/api/v1/users/ ['POST']
/api/v1/users/me/change-password ['POST']
/api/v1/users/slim ['GET']
/api/v1/users/{user_id} ['GET']
/api/v1/users/{user_id} ['PATCH']
/api/v1/users/{user_id} ['DELETE']
/api/v1/users/{user_id}/items-count ['GET']
/api/v1/virtual-printers ['GET']
/api/v1/virtual-printers ['POST']
/api/v1/virtual-printers/ca-certificate ['GET']
/api/v1/virtual-printers/tailscale-status ['GET']
/api/v1/virtual-printers/{vp_id} ['GET']
/api/v1/virtual-printers/{vp_id} ['PUT']
/api/v1/virtual-printers/{vp_id} ['DELETE']
/api/v1/virtual-printers/{vp_id}/diagnostic ['GET']
/api/v1/webhook/printer/{printer_id}/cancel ['POST']
/api/v1/webhook/printer/{printer_id}/start ['POST']
/api/v1/webhook/printer/{printer_id}/status ['GET']
/api/v1/webhook/printer/{printer_id}/stop ['POST']
/api/v1/webhook/queue ['GET']
/api/v1/webhook/queue/add ['POST']
/api/v1/zoho/contacts ['GET']
/api/v1/zoho/contacts ['POST']
/api/v1/zoho/contacts/{contact_id} ['PATCH']
/api/v1/zoho/estimates ['GET']
/api/v1/zoho/estimates/{estimate_id}/preview ['GET']
/api/v1/zoho/status ['GET']
/docs ['GET', 'HEAD']
/docs/oauth2-redirect ['GET', 'HEAD']
/health ['GET']
/manifest.json ['GET', 'HEAD']
/openapi.json ['GET', 'HEAD']
/redoc ['GET', 'HEAD']
/sw-register.js ['GET', 'HEAD']
/sw.js ['GET', 'HEAD']
/{full_path:path} ['GET']
```

## Permission catalogue
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.permissions import ALL_PERMISSIONS; [print(p) for p in sorted(ALL_PERMISSIONS)]" 2>/dev/null```
```
aito:create
aito:delete
aito:read
aito:update
ams_history:read
api_keys:create
api_keys:delete
api_keys:read
api_keys:update
archives:create
archives:delete_all
archives:delete_own
archives:purge
archives:read
archives:read_all
archives:read_own
archives:reprint_all
archives:reprint_own
archives:update_all
archives:update_own
calculator:read
calculator:update
camera:view
cloud:auth
cost_centers:create
cost_centers:modify
cost_centers:read_all
cost_centers:read_own
discovery:scan
external_links:create
external_links:delete
external_links:read
external_links:update
filaments:create
filaments:delete
filaments:read
filaments:update
firmware:read
firmware:update
github:backup
github:restore
groups:create
groups:delete
groups:read
groups:update
inventory:create
inventory:delete
inventory:forecast_read
inventory:forecast_write
inventory:read
inventory:update
inventory:view_assignments
kprofiles:create
kprofiles:delete
kprofiles:read
kprofiles:update
library:delete_all
library:delete_own
library:purge
library:read
library:read_all
library:read_own
library:update_all
library:update_own
library:upload
maintenance:create
maintenance:delete
maintenance:read
maintenance:update
makerworld:import
makerworld:view
notification_templates:read
notification_templates:update
notifications:create
notifications:delete
notifications:read
notifications:update
notifications:user_email
orca_cloud:auth
pipelines:read
pipelines:run
pipelines:write
printer_sensor_history:read
printers:ams_rfid
printers:clear_plate
printers:control
printers:create
printers:delete
printers:files
printers:read
printers:update
projects:create
projects:delete
projects:read
projects:update
queue:create
queue:delete_all
queue:delete_own
queue:read
queue:read_all
queue:read_own
queue:reorder
queue:update_all
queue:update_own
settings:backup
settings:read
settings:restore
settings:update
smart_plugs:control
smart_plugs:create
smart_plugs:delete
smart_plugs:read
smart_plugs:update
stats:filter_by_user
stats:read
system:read
users:create
users:delete
users:read
users:read_slim
users:update
websocket:connect
```

## Settings / environment surface (name = default)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.config import settings; [print(n, \"=\", repr(f.default)) for n, f in sorted(type(settings).model_fields.items())]" 2>/dev/null```
```
api_prefix = '/api/v1'
app_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor')
app_name = 'Bambuddy'
archive_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor/archive')
bambu_studio_api_url = 'http://localhost:3001'
bambu_studio_bundle_dir = None
bambu_studio_user_dirs = None
bambu_user_id = '1961034787'
base_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor')
database_url = 'sqlite+aiosqlite:////Users/paultheis/Documents/Code/bambuddy-refactor/bambuddy.db'
db_max_overflow = None
db_pool_recycle = None
db_pool_size = None
db_pool_timeout = None
db_pool_use_lifo = None
debug = False
log_backup_count = 3
log_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor/logs')
log_level = 'INFO'
log_max_bytes = 5242880
log_to_file = True
plate_calibration_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor/data/plate_calibration')
slicer_api_url = 'http://localhost:3003'
static_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy-refactor/static')
```

## Backend service top-level defs (count per signature)
```regen: grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/*.py | sort | uniq -c | sed "s/^ *//"```
```
1 async def apply_camera_rotation_to_file(path: Path, rotation: int, logger: logging.Logger) -> None:
1 async def apply_print_charge_for_archive(
1 async def auto_assign_spool(
1 async def backfill_batch_statuses(db: AsyncSession) -> int:
1 async def build_printer_file(
1 async def build_printer_files_zip(
1 async def build_slot_materials(db: AsyncSession, printer_id: int) -> list[SlotMaterial]:
1 async def calculate_personal_balance(db: AsyncSession, user_id: int) -> float:
1 async def calibrate_plate(
1 async def cancel_printer_files_job(job_id: str, printer_id: int) -> bool:
1 async def capture_camera_frame_bytes(
1 async def capture_camera_frame(
1 async def capture_camera_image(
1 async def capture_finish_photo(
1 async def capture_frame(
1 async def check_pipeline_eligibility(
1 async def check_plate_empty(
1 async def cleanup_tracking(
1 async def clear_persisted_session(db: AsyncSession, printer_id: int) -> None:
1 async def close_spoolman_client():
1 async def collect_diagnostic_snapshot(db: AsyncSession) -> dict[str, Any]:
1 async def collect_sensitive_strings(db: AsyncSession) -> dict[str, str]:
1 async def compute_deficit_for_queue_item(
1 async def count_internal_spools_at_location(db: AsyncSession, location_id: int) -> int:
1 async def count_spools_at_location_by_name(db: AsyncSession, name: str) -> int:
1 async def create_budget_reservation(
1 async def create_password_reset_email_from_template(
1 async def create_password_reset_link_email_from_template(
1 async def create_spool_from_tray(db: AsyncSession, tray_data: dict) -> Spool:
1 async def create_tls_proxy(target_host: str, target_port: int) -> tuple[int, "asyncio.Server"]:
1 async def create_token(
1 async def create_welcome_email_from_template(
1 async def delete_archived_timelapse(
1 async def delete_dependent_variants(db: AsyncSession, file_ids: list[int]) -> None:
1 async def delete_file_async(
1 async def derive_today_yesterday(
1 async def detect_gpu_hwaccels() -> list[str]:
1 async def detect_vaapi_support() -> dict:
1 async def diagnose_camera(
1 async def discard_session(db: AsyncSession, printer_id: int) -> None:
1 async def dismiss(db: AsyncSession, user_id: int | None, milestone: str) -> None:
1 async def dispatch_remaining(
1 async def download_file_async(
1 async def download_file_bytes_async(
1 async def download_file_try_paths_async(
1 async def energy_plug_candidates(db: AsyncSession, printer_id: int | None) -> list[SmartPlug]:
1 async def enrich_spool_dicts_with_location_id(db: AsyncSession, spools: list[dict]) -> None:
1 async def ensure_user_finance_defaults(db: AsyncSession, user: User) -> bool:
1 async def estimate_queue_source_cost(
1 async def evaluate(db: AsyncSession, user_id: int | None) -> Trigger | None:
1 async def execute_action(printer_id: int, action: str, task_name: str, score: float) -> None:
1 async def extract_video_last_frame(video_path: Path, output_path: Path) -> bool:
1 async def fetch_and_cache_base_profile(name: str, profile_type: str, db: AsyncSession) -> dict | None:
1 async def fetch_catalogue(db: AsyncSession, *, refresh: bool = True) -> list[FilamentProduct]:
1 async def fetch_icon(url: str) -> tuple[bytes, str, str]:
1 async def fill_derived_energy(db: AsyncSession, plug_id: int, energy: dict) -> dict:
1 async def find_matching_untagged_spool(db: AsyncSession, tray_data: dict) -> Spool | None:
1 async def find_remote_file_async(
1 async def find_slot_kprofile_for_extruder(
1 async def generate_chamber_image_stream(
1 async def generate_mjpeg_stream(
1 async def get_cache_status(db: AsyncSession) -> dict:
1 async def get_cached_base_profile(name: str, db: AsyncSession) -> dict | None:
1 async def get_cost_center_reserved_map(
1 async def get_energy_history(
1 async def get_ftp_retry_settings() -> tuple[bool, int, float, float]:
1 async def get_location_by_id(db: AsyncSession, location_id: int) -> Location | None:
1 async def get_location_by_name(db: AsyncSession, name: str) -> Location | None:
1 async def get_locations_by_name_keys(db: AsyncSession, keys: set[str]) -> dict[str, Location]:
1 async def get_notification_template(db: AsyncSession, event_type: str) -> NotificationTemplate | None:
1 async def get_or_create_broadcaster(key: str, factory: UpstreamFactory) -> MjpegBroadcaster:
1 async def get_or_create_keypair() -> tuple[Path, Path]:
1 async def get_persisted_print_name(db: AsyncSession, printer_id: int) -> str | None:
1 async def get_preview_filaments(
1 async def get_printer_files_job(job_id: str, printer_id: int) -> PrinterFilesJobStatus | None:
1 async def get_public_key() -> str:
1 async def get_smtp_settings(db: AsyncSession) -> SMTPSettings | None:
1 async def get_spool_by_tag(db: AsyncSession, tag_uid: str, tray_uuid: str) -> Spool | None:
1 async def get_spoolman_client() -> SpoolmanClient | None:
1 async def get_stall_timeout_seconds(db) -> float:
1 async def get_storage_info_async(
1 async def import_orca_file(filename: str, content: bytes, db: AsyncSession) -> dict:
1 async def init_printer_connections(db: AsyncSession):
1 async def init_spoolman_client(url: str) -> SpoolmanClient:
1 async def is_billing_enabled(db: AsyncSession) -> bool:
1 async def is_personal_transaction(db: AsyncSession, user_id: int, cost_center_id: int | None) -> bool:
1 async def is_printer_kill_switch_enabled(db: AsyncSession) -> bool:
1 async def iter_subscriber(
1 async def link_tag_to_inventory_spool(db: AsyncSession, spool: Spool, tray_data: dict) -> None:
1 async def list_all_tokens(db: AsyncSession) -> list[LongLivedToken]:
1 async def list_files_async(
1 async def list_files_result_async(
1 async def list_user_tokens(db: AsyncSession, user_id: int) -> list[LongLivedToken]:
1 async def load_export_tasks(db: AsyncSession, project_id: int) -> list[ExportTask]:
1 async def load_progress(db: AsyncSession, batch: PrintBatch) -> BatchProgress:
1 async def maybe_sync_spoolman_locations(db: AsyncSession, *, client=None) -> bool:
1 async def mirror_comments(db: AsyncSession, project: AitoProject, comments: list[dict]) -> int:
1 async def notify_missing_spool_assignments_on_print_start(
1 async def on_layer_change(printer_id: int, layer_num: int):
1 async def on_print_complete(
1 async def on_print_complete(printer_id: int) -> Path | None:
1 async def on_print_start(
1 async def parse_and_validate(raw_bytes: bytes, db: AsyncSession) -> ImportPreview:
1 async def perform_ssh_update(device_id: str, ip_address: str, install_path: str | None = None) -> None:
1 async def persist_session(
1 async def pop_frame(nonce: str) -> bytes | None:
1 async def prepare_internal_spool_payload(db: AsyncSession, data: dict, fields_set: set[str]) -> dict:
1 async def proofread_text(db: AsyncSession, text: str) -> tuple[str, str]:
1 async def prune_stale_printer_file_bundles() -> None:
1 async def read_chamber_image_frame(
1 async def read_next_chamber_frame(reader: asyncio.StreamReader, timeout: float = 10.0) -> bytes | None:
1 async def reclassify_presets(db: AsyncSession) -> dict:
1 async def reconcile_quote_status(db: AsyncSession, project: AitoProject, estimate: dict) -> None:
1 async def record_tray_change(db: AsyncSession, printer_id: int, tray_global: int, layer_num: int) -> None:
1 async def record(
1 async def refresh_base_cache(db: AsyncSession) -> dict:
1 async def refresh_batch_status_for_item(db: AsyncSession, queue_item_id: int) -> None:
1 async def refresh_batch_status(db: AsyncSession, batch: PrintBatch) -> bool:
1 async def release_budget_reservation(
1 async def release_queue_references(db: AsyncSession, file_ids: list[int]) -> int:
1 async def remote_file_settled(
1 async def rename_location(db: AsyncSession, location: Location, new_name: str) -> Location:
1 async def report_usage(printer_id: int, archive_id: int):
1 async def resolve_camera_quality(preset_name: str, stream_count: int = 1) -> str:
1 async def resolve_location_by_name(db: AsyncSession, name: str, *, create: bool = True) -> Location | None:
1 async def resolve_preset_ref(
1 async def resolve_preset(preset_data: dict, profile_type: str, db: AsyncSession, depth: int = 0) -> dict:
1 async def resolve_slicer_filament(
1 async def resolve_spool_location_fields(
1 async def resolve_spoolman_location_string(
1 async def restore_session(db: AsyncSession, printer_id: int, register_active: bool = True) -> list[list[int]] | None:
1 async def revoke_token(db: AsyncSession, token_id: int) -> bool:
1 async def run_connection_diagnostic(
1 async def run_sync_loop() -> None:
1 async def run_sync_once(db: AsyncSession, pending_only: bool = False) -> int:
1 async def save_smtp_settings(db: AsyncSession, smtp_settings: SMTPSettings) -> None:
1 async def select_energy_reading(
1 async def send_user_print_notification(
1 async def shutdown_all_broadcasters() -> None:
1 async def shutdown_broadcaster(key: str) -> bool:
1 async def start_printer_files_job(
1 async def stash_frame(data: bytes) -> str:
1 async def stop_printer_download_cleanup() -> None:
1 async def store_print_data(
1 async def submit_report(
1 async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]:
1 async def sync_enabled(db: AsyncSession) -> bool:
1 async def sync_interval_seconds(db: AsyncSession) -> int:
1 async def sync_locations_from_spoolman(db: AsyncSession, client) -> bool:
1 async def sync_personal_wallet_balance(db: AsyncSession, wallet: UserWallet) -> float:
1 async def sync_project(db: AsyncSession, project: AitoProject) -> None:
1 async def test_camera_connection(
1 async def test_connection(url: str, camera_type: str) -> dict:
1 async def upload_file_async(
1 async def upsert_slot_preset_for_spool(
1 async def upsert_slot_preset_for_spoolman_spool(
1 async def upsert_slot_preset(
1 async def validate_print_budget(
1 async def verify_token(
1 async def with_ftp_retry(
1 async def write_log_entry(
1 class AMSTray:
1 class ArchiveComparisonService:
1 class ArchivePurgeService:
1 class ArchiveService:
1 class BambuCloudAuthError(BambuCloudError):
1 class BambuCloudError(Exception):
1 class BambuCloudService:
1 class BambuFTPClient:
1 class BambuMQTTClient:
1 class BatchDispatchError(Exception):
1 class BatchProgress:
1 class BillingRunIdCollisionError(RuntimeError):
1 class CalculatorInsightsService:
1 class CameraDiagnoseResult:
1 class CameraDiagnoseStage:
1 class CameraProfile:
1 class Catalogue:
1 class CatalogueIndex:
1 class ChamberConnectionClosed(Exception):
1 class CreatedToken:
1 class DeleteResult(Enum):
1 class DesignOverride(NamedTuple):
1 class DevicePoll:
1 class DiscoveredPrinter:
1 class DownloadCancelled(Exception):
1 class DownloadInsufficientSpace(Exception):
1 class DownloadLimitExceeded(Exception):
1 class EligibilityIssue:
1 class EligibilityReport:
1 class ExportService:
1 class ExportShipping:
1 class ExportTask:
1 class FailureAnalysisService:
1 class FilamentDeficit:
1 class FilamentProduct:
1 class FilaSwitchState:
1 class FileListResult:
1 class FileNotOnPrinterError(Exception):
1 class FirmwareCheckService:
1 class FirmwareUpdateService:
1 class FirmwareUploadState:
1 class FirmwareUploadStatus(StrEnum):
1 class FirmwareVersion:
1 class FtpFailure:
1 class FtpFailureKind(Enum):
1 class FtpFailureReport:
1 class FTPProfile:
1 class GitHubBackupService:
1 class GitHubRestoreService:
1 class Go2RTCService:
1 class HASensorManager:
1 class HMSAction(StrEnum):
1 class HMSError:
1 class HomeAssistantService:
1 class ImplicitFTP_TLS(FTP_TLS):
1 class ImportPreview(BaseModel):
1 class ImportResult(BaseModel):
1 class ImportRowResult(BaseModel):
1 class KProfile:
1 class LabelData:
1 class LDAPConfig:
1 class LDAPSearchResult:
1 class LDAPUserInfo:
1 class LibraryTrashService:
1 class LocalBackupService:
1 class LogEntry(BaseModel):
1 class LogFinding(BaseModel):
1 class LogSignature:
1 class MakerWorldAuthError(MakerWorldError):
1 class MakerWorldError(Exception):
1 class MakerWorldForbiddenError(MakerWorldError):
1 class MakerWorldNotFoundError(MakerWorldError):
1 class MakerWorldService:
1 class MakerWorldUnavailableError(MakerWorldError):
1 class MakerWorldUrlError(MakerWorldError):
1 class MjpegBroadcaster:
1 class MQTTDataSourceConfig:
1 class MQTTLogEntry:
1 class MQTTRelayService:
1 class MQTTSmartPlugService:
1 class NotificationService:
1 class NozzleInfo:
1 class ObicoDetectionService:
1 class OIDCIconError(Exception):
1 class OIDCIconUnavailableError(OIDCIconError):
1 class OIDCIconUrlError(OIDCIconError):
1 class OpenRouterNotConfiguredError(Exception):
1 class OpenRouterUpstreamError(Exception):
1 class OrcaCloudAuthError(OrcaCloudError):
1 class OrcaCloudError(Exception):
1 class OrcaCloudService:
1 class ParsedLine:
1 class ParsedName:
1 class ParsedShipping:
1 class PerPrinterReport:
1 class PlateDetectionResult:
1 class PlateDetector:
1 class PlateProgress:
1 class PrinterDiscoveryService:
1 class PrinterFilesJobStatus:
1 class PrinterFilesZipInsufficientSpaceError(OSError):
1 class PrinterFilesZipResult:
1 class PrinterFilesZipTooLargeError(ValueError):
1 class PrinterInfo:
1 class PrinterManager:
1 class PrinterState:
1 class PrintOptions:
1 class PrintScheduler:
1 class PrintSession:
1 class PrintState:
1 class ProfileMatch:
1 class ProjectPageParser:
1 class ResolvedProfile(NamedTuple):
1 class RESTSmartPlugService:
1 class ScanResult(BaseModel):
1 class SensorReading:
1 class ShippingCatalogueUnavailable(Exception):
1 class ShippingItem:
1 class SliceDispatchService:
1 class SliceJob:
1 class SlicerApiError(Exception):
1 class SlicerApiServerError(SlicerApiError):
1 class SlicerApiService:
1 class SlicerApiUnavailableError(SlicerApiError):
1 class SliceResult(NamedTuple):
1 class SlicerInputError(SlicerApiError):
1 class SlicerTimeoutError(SlicerApiError):
1 class SlotKProfile:
1 class SlotMaterial:
1 class SmartPlugManager:
1 class SmartPlugMQTTData:
1 class SpoolLocationFields:
1 class SpoolmanClient:
1 class SpoolmanClientError(Exception):
1 class SpoolmanFilament:
1 class SpoolmanNotFoundError(Exception):
1 class SpoolmanSpool:
1 class SpoolmanUnavailableError(Exception):
1 class StorageVerdict:
1 class SubnetScanner:
1 class TaskSteps:
1 class TaskSummary:
1 class TasmotaScanner:
1 class TasmotaService:
1 class ThreeMFParser:
1 class TimelapseProcessor:
1 class TimelapseSession:
1 class Trigger:
1 class UploadCancelled(Exception):
1 class ZohoAmbiguousReferenceError(ZohoUpstreamError):
1 class ZohoFilamentMappingError(RuntimeError):
1 class ZohoFilamentRefreshBusyError(RuntimeError):
1 class ZohoNotConfiguredError(Exception):
1 class ZohoNotFound(ZohoUpstreamError):
1 class ZohoRequestRejected(ZohoUpstreamError):
1 class ZohoService:
1 class ZohoUpstreamError(Exception):
1 def a2l_lite_wire_ids(ams_id: int, tray_id: int) -> tuple[int, int, int] | None:
1 def active_broadcaster_keys() -> list[str]:
1 def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
1 def adopt(printer_id: int) -> bool:
1 def ams_is_empty(unit: dict | None) -> bool:
1 def annotate_rack_groups(filaments: list[dict], file_path: Path, plate_id: int | None) -> None:
1 def apply_camera_rotation(image_data: bytes, rotation: int, logger: logging.Logger) -> bytes:
1 def apply_design_overrides(process_json: str, overrides: list[DesignOverride], selected_keys: list[str]) -> str:
1 def apply_filament_cost(content: str, cost_per_kg: float) -> tuple[str, ApplyFilamentCostOutcome]:
1 def apply_process_overrides(process_json: str, overrides: dict[str, object]) -> str:
1 def apply_sync(presets: list[dict[str, str]]) -> dict[str, int]:
1 def apply_tray_exist_bits(
1 def as_float(value) -> float | None:
1 def assign_location_name(location: Location, name: str) -> None:
1 def auth_headers(token: str | None) -> dict[str, str]:
1 def authenticate_ldap_user(config: LDAPConfig, username: str, password: str) -> LDAPUserInfo | None:
1 def bind_printer_file_to_token(result: PrinterFilesZipResult, printer_id: int, token: str) -> PrinterFilesZipResult:
1 def bind_printer_files_zip_to_token(
1 def blocking_reason_codes(unit: dict | None) -> list[int]:
1 def build_ams_tray_lookup(raw_data: dict) -> dict[int, dict]:
1 def build_camera_url(ip_address: str, access_code: str, model: str | None) -> str:
1 def build_description(service: str, task: ExportTask) -> str:
1 def build_line_items(
1 def build_match_index(catalogue: list[FilamentProduct]) -> CatalogueIndex:
1 def build_preview(
1 def build_shipping_description(shipping: ExportShipping) -> str:
1 def cache_3mf_download(printer_id: int, name: str, local_path: Path) -> None:
1 def cancel_session(printer_id: int):
1 def captcha_cooloff_active(base_url: str) -> bool:
1 def capture_in_flight(ip_address: str) -> bool:
1 def check_drying_supported(model: str | None, firmware: str | None, *, require_firmware: bool = True) -> str | None:
1 def classify_backup_dir_error(exc: OSError, backup_dir: Path) -> dict:
1 def classify(score: float, sensitivity: str) -> str:
1 def cleanup_orphaned_timelapse_sessions(min_age_seconds: float = 300) -> int:
1 def clear_3mf_cache(printer_id: int | None = None, delete_files: bool = True) -> None:
1 def clear(printer_id: int) -> None:
1 def collect_base_presets() -> list[dict[str, str]]:
1 def compute_file_md5(file_path: Path) -> str:
1 def compute_sync_stats(
1 def cost_of(task: ExportTask, service: str) -> float | None:
1 def count_plates_in_3mf(zip_bytes: bytes) -> int:
1 def create_password_reset_email(username: str, password: str, login_url: str) -> tuple[str, str, str]:
1 def create_password_reset_link_email(username: str, reset_url: str) -> tuple[str, str, str]:
1 def create_welcome_email(username: str, password: str, login_url: str) -> tuple[str, str, str]:
1 def delete_calibration(printer_id: int, plate_type: str | None = None) -> bool:
1 def describe_state(sensor: PrinterHASensor, reading: SensorReading) -> str:
1 def describe_upload_failure(failure: FtpFailure | None) -> str:
1 def description_of(task: ExportTask, service: str) -> str | None:
1 def detect_current_branch() -> str:
1 def diff_fields(obj: Any, patch: dict) -> list[dict]:
1 def discount_of(task: ExportTask, service: str) -> float | None:
1 def display_temperatures(temperatures: dict | None, model: str | None) -> dict[str, float]:
1 def drying_screen_only(model: str | None) -> bool:
1 def effective_bambu_user_id() -> str:
1 def enabled_services(task: ExportTask) -> tuple[str, ...]:
1 def encode_opentag3d_from_mapped(mapped: MappedSpoolFields) -> bytes:
1 def encode_opentag3d(spool: Spool) -> bytes:
1 def end_gcode_injected(printer_id: int) -> bool:
1 def evaluate(quote_status: str | None, stored_column: str, pending: Collection[str]) -> tuple[str, str | None]:
1 def evaluate(sensor: PrinterHASensor, payload: dict | None) -> SensorReading:
1 def external_storage_present(state: object | None) -> bool:
1 def extract_core_fields(data: dict) -> dict:
1 def extract_design_process_overrides(zip_bytes: bytes) -> list[DesignOverride]:
1 def extract_filament_requirements(file_path: Path, plate_id: int | None = None) -> list[dict]:
1 def extract_printable_objects_from_3mf(
1 def extract_printable_objects_from_archive(
1 def extract_source_printer_model(zip_bytes: bytes) -> str | None:
1 def find_ams_unit(state, ams_id: int) -> dict | None:
1 def find_interface_for_ip(target_ip: str) -> dict | None:
1 def format_time(minutes: int | None) -> str | None:
1 def format_weight(grams: float | None) -> str | None:
1 def ftp_probe_paths(filename: str) -> list[str]:
1 def ftps_handshake_blocked(ip_address: str) -> bool:
1 def generate_secure_password(length: int = 16) -> str:
1 def generate_stl_thumbnail(
1 def get_actions_for_error_code(device: str, error_code: str) -> list[str]:
1 def get_active_sessions() -> dict[int, TimelapseSession]:
1 def get_all_interface_ips() -> list[dict]:
1 def get_bundle_filament_dir() -> Path:
1 def get_cached_3mf(printer_id: int, name: str) -> Path | None:
1 def get_calibration_status(printer_id: int, plate_type: str | None = None) -> dict:
1 def get_camera_port(model: str | None) -> int:
1 def get_camera_profile(model: str | None) -> CameraProfile:
1 def get_derived_status_name(state: PrinterState, model: str | None = None) -> str | None:
1 def get_error_description(error_code: str) -> str | None:
1 def get_fallback_spool_tag_for_slot(printer_serial: str, ams_id: int, tray_id: int) -> str:
2 def get_ffmpeg_path() -> str | None:
1 def get_firmware_service() -> FirmwareCheckService:
1 def get_firmware_update_service() -> FirmwareUpdateService:
1 def get_ftp_profile(model: str | None) -> FTPProfile:
1 def get_gpu_hwaccels() -> list[str]:
1 def get_network_interfaces() -> list[dict]:
1 def get_other_interfaces(exclude_ip: str) -> list[dict]:
1 def get_rtsp_semaphore() -> asyncio.Semaphore:
1 def get_session(printer_id: int) -> TimelapseSession | None:
1 def get_stage_name(stage: int) -> str:
1 def get_subscriber_count(key: str) -> int:
1 def get_upload_state(printer_id: int) -> FirmwareUploadState:
1 def get_user_filament_dirs() -> list[Path]:
1 def group_lines(lines: list[ParsedLine]) -> list[list[ParsedLine]]:
1 def grouped_islands() -> list[tuple[str, list[tuple[str, str]]]]:
1 def has_stg_cur_idle_bug(model: str | None) -> bool:
1 def http_exception_to_job_error(exc) -> _SliceJobError:
1 def inject_plate_thumbnails_if_missing(threemf_bytes: bytes) -> bytes:
1 def invalidate_validation_cache(token: str | None = None) -> None:
1 def is_ams_slot_location(name: str) -> bool:
1 def is_bambu_tag(tag_uid: str, tray_uuid: str, tray_info_idx: str) -> bool:
1 def is_bed_slinger(model: str | None) -> bool:
1 def is_captcha_challenge(response) -> bool:
1 def is_chamber_image_model(model: str | None) -> bool:
1 def is_expiry_401(response: httpx.Response) -> bool:
1 def is_foreign(line: dict, catalogue: Catalogue) -> bool:
1 def is_plate_detection_available() -> bool:
1 def is_preset_defining(key: str) -> bool:
1 def is_printer_coupled(key: str) -> bool:
1 def is_running_in_docker() -> bool:
1 def is_valid_tag(tag_uid: str, tray_uuid: str) -> bool:
1 def island_for_label(label: str | None) -> str | None:
1 def island_label(island: str | None) -> str | None:
1 def kinds_for_depth(depth: str) -> list[str]:
1 def last_print_storage_verdict(state: object | None) -> StorageVerdict:
1 def list_usb_cameras() -> list[dict]:
1 def load_export_shipping(project: AitoProject, catalogue: Catalogue) -> ExportShipping | None:
1 def location_name_key(name: str) -> str:
1 def lookup_ldap_user(config: LDAPConfig, username: str) -> LDAPUserInfo | None:
1 def map_comment(comment: dict) -> dict:
1 def mark_pending(printer_id: int) -> None:
1 def match_ipcam_chunks(
1 def match_profile_indexed(
1 def match_profile(
1 def merge_plate_3mfs(
1 def merge_shipping_catalogue(cached: dict[str, dict], items: list[dict]) -> dict[str, dict]:
1 def missing_start_gcode_message(printer_preset_name: str) -> str:
1 def net_cost(task: Any, service: str) -> float | None:
1 def normalise_process_overrides(overrides: dict[str, object]) -> dict[str, str | list[str]]:
1 def normalize_3mf_name(name: str) -> str:
1 def normalize_am_unit_id(ams_id: int) -> int:
1 def normalize_display_name(first_name: str, last_name: str) -> str:
1 def normalize_location_name(name: str) -> str:
1 def note_captcha_challenge(base_url: str) -> None:
1 def overrides_for_plate(
1 def overrides_from_config(config: Any) -> list[DesignOverride]:
1 def parse_ams_filament_backup_from_cfg(cfg_raw: object) -> bool | None:
1 def parse_base_preset_file(path: Path) -> dict[str, str]:
1 def parse_description(
1 def parse_filament_name(name: str) -> ParsedName:
1 def parse_ldap_config(settings: dict[str, str]) -> LDAPConfig | None:
1 def parse_lines(
1 def parse_log_line(line: str) -> LogEntry | None:
1 def parse_plate_id(gcode_file: str | None) -> int | None:
1 def parse_shipping_line(line: dict, shipping_ids: dict[str, str]) -> ParsedShipping | None:
1 def parse_time_min(value: str | None) -> int | None:
1 def parse_weight_g(value: str | None) -> float | None:
1 def peek_plate_index_in_3mf(file_path: Path) -> int | None:
1 def peek_plate_prediction_in_3mf(file_path: Path, plate_index: int | None = None) -> int | None:
1 def personal_balance_condition(user_id: int):
1 def plate_scoped_run_estimate(
1 def primary_reason_code(codes: list[int]) -> int | None:
1 def print_file_reachable_over_ftp(state: object | None) -> StorageVerdict:
1 def printer_file_path(printer_id: int, token: str) -> Path | None:
1 def printer_files_zip_path(printer_id: int, token: str) -> Path | None:
1 def printer_state_to_dict(
1 def probe_backup_dir(backup_dir: Path) -> dict:
1 def probe_filename_from_url(project_url: str | None) -> str | None:
1 def quantity_of(task: ExportTask, service: str) -> int | None:
1 def rack_position_to_nozzle_id(position: int) -> int | None:
1 def rate_quantity(task: ExportTask, service: str) -> tuple[float, int]:
1 def read_bundle_preset(filename: str) -> str | None:
1 def read_disk_state() -> dict[str, dict[str, str]]:
1 def read_log_entries(
1 def remove_printer_files_zip(zip_path: Path) -> None:
1 def render_labels(template: TemplateName, data_list: list[LabelData], *, monochrome: bool = False) -> bytes:
1 def render_template(template_str: str, variables: dict[str, Any]) -> str:
1 def request_debounced_sync() -> None:
1 def request_immediate_sync() -> None:
1 def reset_cache() -> None:
1 def reset_upload_state(printer_id: int):
1 def resolve_display_stem(filename: str) -> str:
1 def resolve_expected_tray(
1 def resolve_filament(unit: dict | None, filament: str) -> str:
1 def resolve_group_mapping(ldap_groups: list[str], group_mapping: dict[str, str]) -> list[str]:
1 def resolve_plate_id(state) -> int | None:
1 def resolve_rack_nozzle_mapping(
1 def resolve_rack_plan_mapping(
1 def rewrite_rtsp_request_url(data: bytes, proxy_url: bytes, real_url: bytes) -> bytes:
1 def rtsp_socket_timeout_flag() -> str:
1 def sanitize_log_content(content: str, sensitive_strings: dict[str, str] | None = None) -> str:
1 def save_base_presets(files: list[tuple[str, str]]) -> None:
1 def scan_logs(
1 def scan_user_presets() -> list[dict[str, str]]:
1 def score_from_detections(detections: list) -> float:
1 def search_catalogue(catalogue: list[FilamentProduct], query: str, limit: int = 25) -> list[FilamentProduct]:
1 def search_ldap_users(config: LDAPConfig, query: str, limit: int = 25) -> list[LDAPSearchResult]:
1 def send_email(
1 def serialize(spools: list[Spool]) -> bytes:
1 def service_for_island(island: str | None) -> str | None:
1 def service_for_sku(sku: str | None) -> str | None:
4 def set_shared_http_client(client: httpx.AsyncClient | None) -> None:
1 def should_pull_comments(project: AitoProject, estimate: dict, now: datetime) -> bool:
1 def start_aito_quote_sync() -> None:
1 def start_gcode_is_missing(content: bytes, *, export_3mf: bool) -> bool:
1 def start_loop_watchdog() -> None:
1 def start_printer_download_cleanup() -> None:
1 def start_session(
1 def stop_loop_watchdog() -> None:
1 def subscribe_plug_to_mqtt(service: "MQTTSmartPlugService", plug: Any) -> list[str]:
1 def substitute_unused_plate_filaments(source_3mf_bytes: bytes, plate_id: int | None, items: list[str]) -> list[str]:
1 def summarise(tasks: Iterable[Any]) -> TaskSummary:
1 def supports_airduct(model: str | None) -> bool:
1 def supports_chamber_heater(model: str | None) -> bool:
1 def supports_chamber_temp(model: str | None) -> bool:
1 def supports_drying_while_printing(model: str | None, firmware: str | None) -> bool:
1 def supports_drying(model: str | None, firmware: str | None) -> bool:
1 def supports_rtsp(model: str | None) -> bool:
1 def swap_plate_suffix(name: str | None, target_plate: int) -> str | None:
1 def systemd_unit_name() -> str | None:
1 def test_ldap_connection(config: LDAPConfig) -> tuple[bool, str]:
1 def thresholds(sensitivity: str) -> tuple[float, float]:
1 def transaction_affects_personal_balance(
1 def uniform_tray_filament_hint(loaded_types: list[str]) -> str | None:
1 def uploaded_base_presets_dir() -> Path:
1 def url_is_external_storage(project_url: str | None) -> bool | None:
1 def verify_3mf_candidate(
1 def waiting_reason_for_codes(codes: list[int]) -> str:
```

## Frontend exported symbols — utils + hooks
```regen: grep -rhoE "^export (default function|function|const|type|interface|class|enum) [A-Za-z0-9_]+" frontend/src/utils frontend/src/hooks --include="*.ts" --include="*.tsx" | sort```
```
export class GrowingBuffer
export const AITO_CARD_VT_NAME
export const API_KEY_QR_VERSION
export const API_SLICEABLE_FILE_TYPES
export const AWAY_STATUSES
export const BAMBU_COLOR_CODE_FALLBACK
export const BAMBU_FILAMENT_COLORS
export const BED_TEMP_DEFAULTS
export const BUSINESS_FLEET_THRESHOLD
export const CALIBRATION_MODE_ACTIVE
export const CALIBRATION_MODE_INACTIVE
export const CALIBRATION_MODES
export const CHAMBER_TEMP_DEFAULTS
export const checkKey
export const COLOR_FAMILY_ORDER
export const COLUMN_IDS
export const COLUMN_ORDER
export const containsEitherWay
export const COUNTRY_CODES
export const CURVE_DEFAULTS
export const CURVE_QUANTITIES
export const DEFAULT_COUNTRY_CODE
export const DEFAULT_PREHEAT_FILAMENT_TARGETS
export const DEFAULT_STATE
export const DISCOUNT_COLUMNS
export const EMPTY_COMPATIBILITY_INDEX
export const emptyBoard
export const FAN_SPEED_DEFAULTS
export const FILAMENT_BRANDS
export const FILAMENT_MATERIALS
export const filamentLineCost
export const FTS_INLET_SIDE
export const inventoryLocationsQueryKey
export const libraryTagsQueryKey
export const MAX_CHAMBER_TEMP_C
export const MEDIAN_MAX_SAMPLES
export const MEDIAN_MIN_SAMPLES
export const MIN_SAMPLE
export const NOZZLE_TEMP_DEFAULTS
export const num
export const PAGE_TABS
export const PREHEAT_FILAMENT_ORDER
export const PRESET_CATEGORIES
export const printerDepreciationPerHour
export const printerLifetimeHours
export const printerRepairsPerHour
export const RACK_POSITION_BASE
export const RACK_POSITIONS
export const RACK_SIZE
export const RECONNECT_BASE_DELAY_MS
export const RECONNECT_MAX_DELAY_MS
export const SERVICES
export const SHIPPING_PHONE_RE
export const SIDEBAR_HIDDEN_SYSTEM_ITEMS_KEY
export const SIDEBAR_LAYOUT_CHANGED_EVENT
export const SIDEBAR_ORDER_KEY
export const SLICE_MODAL_TIER_ORDER
export const SLICEABLE_FILE_TYPES
export const SOCIAL_NETWORKS
export const STAGES
export const STEP_LABEL_KEY
export const STREAM_DEGRADED_MS
export const STREAM_ERROR_MS
export const STREAM_STALE_MS
export const SUPPORTED_CURRENCIES
export function __resetAitoPresence
export function __resetBoardSync
export function __resetColorCatalogForTests
export function addDays
export function ageAnchor
export function aggregateGroupSpool
export function agingColorCls
export function agingLevel
export function agingTextCls
export function allowedColumns
export function applyClientSocial
export function applyColumnMove
export function applyCreate
export function applyCrossColumnMove
export function applyDelete
export function applyDescription
export function applyQuoteStatus
export function applyRestore
export function applyShipping
export function applySyncState
export function applyTaskSummary
export function applyTimeFormat
export function assignableProjects
export function autoAssignRackPositions
export function autoMatchFilament
export function breakEvenDiscount
export function buildAmsMapping
export function buildApiKeyQrPayload
export function buildBoard
export function buildCompatibilityIndex
export function buildDownloadUrl
export function buildFallbackSummary
export function buildFilamentComparison
export function buildFilamentPresetOptions
export function buildLoadedFilaments
export function buildPresetOptions
export function buildPricingInputs
export function buildQuoteSummary
export function buildWaterfall
export function calculatorPrefillUrl
export function canonicalFilamentType
export function checkPasswordComplexity
export function clearNewProjectDraft
export function clientDraftErrors
export function colorDistance
export function colorFamily
export function colorsAreSimilar
export function colorSortKey
export function compareFwVersions
export function compareSortKeys
export function computeAmsMapping
export function computeBackupGroups
export function computeDeltaRate
export function computeHistoryRate
export function computeImpressionCost
export function computeMoveTarget
export function computePopoverPosition
export function computePricing
export function computeSkuForecasts
export function correctedTimeH
export function defaultClientDraft
export function deriveChamberTargetForTrays
export function detectPlatform
export function diffTaskDraft
export function discountMatrix
export function downloadTextFile
export function draftFromContact
export function effectivePreferLowest
export function elapsedDays
export function eligibleParents
export function emptyShippingDraft
export function emptyTaskDraft
export function estimateArchiveSalePrice
export function estimateFilamentCost
export function evaluate
export function filamentTypesCompatible
export function filterCompatibleQueueItems
export function filterFilamentsByNozzle
export function filterSpoolsByQuery
export function findColumn
export function findNearestSimilar
export function findPreset
export function findPresetByName
export function flagRank
export function flashRevert
export function fleetAudience
export function flightDuration
export function foldSessionOverrides
export function formatDate
export function formatDateInput
export function formatDateOnly
export function formatDateTime
export function formatDisplayName
export function formatDuration
export function formatDurationFromHours
export function formatElapsedTime
export function formatETA
export function formatFileSize
export function formatMediaTime
export function formatMoney
export function formatPct
export function formatPhone
export function formatPhoneDisplay
export function formatPrintName
export function formatRelativeTime
export function formatSlotLabel
export function formatTimeInput
export function formatTimeOnly
export function formatUptime
export function formatWeight
export function genericFilamentIdForMaterial
export function getAmsLabel
export function getBambuColorName
export function getBedTypeInfo
export function getColorCatalogVersion
export function getColorName
export function getCurrencySymbol
export function getDatePlaceholder
export function getFallbackSpoolTag
export function getFillBarColor
export function getGlobalTrayId
export function getHiddenSidebarSystemItemIds
export function getMaintenanceWikiUrl
export function getMinDateTime
export function getPrinterImage
export function getSidebarOrder
export function getSpoolmanFillLevel
export function getSwatchStyle
export function getTimePlaceholder
export function getWifiStrength
export function groupSpoolsBySku
export function hash_fnv1a32
export function hasPricedService
export function hasRealityCheckData
export function hexToColorName
export function installedNozzleDiameters
export function invalidateArchiveAndProjectViews
export function invalidateInventoryLocations
export function invalidateProjectViews
export function invalidateSpoolAndLocationQueries
export function isApiSliceableFilename
export function isApiSliceableFileType
export function isBambuLabSpool
export function isExternalSidebarItemId
export function isExternalSpoolHidden
export function isFinished
export function isGcodeCompatible
export function islandLabel
export function isLightColor
export function isPlaceholder
export function isPlaceholderDate
export function isPrinterCurrentlyDispatchable
export function isRackSlotEligible
export function isShippingComplete
export function isSliceableFilename
export function isSliceableFileType
export function isSocialNetwork
export function joinMinutes
export function latestProjectVersion
export function loadCalculatorState
export function localDateKey
export function maskVisibleErrors
export function matchCalculatorFilament
export function matchCalculatorPrinter
export function matchesPrinterModelSuffix
export function matchesSearch
export function medianUnitCost
export function moneyDecimals
export function needsClientContact
export function netCost
export function nextPlaceholderId
export function normaliseClientDraft
export function normaliseTaskDraft
export function normalizeColor
export function normalizeColorForCompare
export function normalizePreheatFilamentType
export function openArchiveInSlicer
export function openCameraWindow
export function openInSlicer
export function parseDateInput
export function parseFilamentColor
export function parseGridFrames
export function parseLocalDateKey
export function parsePhone
export function parsePreheatFilamentTargets
export function parsePresetTriple
export function parseTimeInput
export function parseUTCDate
export function parseUTCDateStrict
export function persistCalculatorStateNow
export function pickActivePrint
export function pickDefault
export function pickFilamentForSlot
export function pickObjectIdAt
export function pickProcessDefault
export function pickTimeAccuracy
export function placeholderProject
export function plateClickToMaskPoint
export function preferLowestSortKey
export function prefersReducedMotion
export function presetCompatibility
export function presetDisplayName
export function projectHasPricedService
export function projectTotal
export function qtyFactor
export function queueItemDisplayName
export function rackByPosition
export function rackOptionsForGroup
export function rackPositionToNozzleId
export function random_mulberry32
export function rankBySourceColumn
export function readBrandFilter
export function readGridSize
export function readMaterialFilter
export function realityCheckImpact
export function registerPresenceSender
export function resolveDesktopSlicer
export function resolveDryingPresetKey
export function resolveInteropDefault
export function resolveSlotExtruder
export function resolveSlotNozzleDiameter
export function resolveSpoolColorName
export function rewriteMediaSrcWithToken
export function roundUpTo50
export function rowKey
export function saveHiddenSidebarSystemItemIds
export function saveSidebarOrder
export function selectRealityChecks
export function sendAitoPresence
export function serializePreheatFilamentTargets
export function setAitoPresenceState
export function setColorCatalog
export function setExternalSpoolHidden
export function shippingDraftErrors
export function shippingPayload
export function sizeMargin
export function skuKey
export function sortByRecencyDesc
export function splitDecimalHours
export function splitMinutes
export function splitRecipientName
export function sponsorHref
export function spoolColorString
export function spoolMatchesQuery
export function startCountdown
export function subscribeColorCatalog
export function summariseTasks
export function supportsRtsp
export function targetPriceProfit
export function taskCost
export function taskDraftFromAitoTask
export function taskDraftToTaskCreate
export function tasksSignature
export function taskTotal
export function titleCaseSegments
export function toDateTimeLocalValue
export function toOptimisticProjects
export function toTaskLike
export function unitMultiplier
export function unitPriceCurve
export function useAitoPageMutations
export function useAitoViewers
export function useBoardDrag
export function useBoardSync
export function useCalculatorState
export function useCameraControls
export function useCameraStopHint
export function useCameraStreamToken
export function useCancellableTimeout
export function useCardFlight
export function useCardMorph
export function useColorCatalogVersion
export function useColumnMoveMutation
export function useColumnReflow
export function useCombinedGridStats
export function useContactedMutation
export function useCurrency
export function useDismissableDialog
export function useFilamentMapping
export function useFlagMutation
export function useFlipReorder
export function useGridReconnect
export function useGridStream
export function useHoverCard
export function useIdleHide
export function useIsMobile
export function useIsReverting
export function useIsSidebarCompact
export function useIsWideLayout
export function useLatestProjectEvent
export function useLoadedFilaments
export function useLongPress
export function useMjpegStream
export function useMultiPrinterFilamentMapping
export function useNewProjectDraft
export function useOptimisticBoardMutation
export function usePageFileDrop
export function usePrintProgressTitle
export function useProjectEvents
export function useProjectTasks
export function useQuotePendingPoll
export function useQuoteStatusMutation
export function useReducedMotion
export function useSendInvoiceMutation
export function useSendQuoteMutation
export function useSettledValue
export function useSponsorPrompt
export function useSpoolBuddyState
export function useStaggeredEntrance
export function useStreamReconnect
export function useStreamTokenSync
export function useUnknownTagPrompt
export function useWebRTCStream
export function useWebSocket
export function useZoomPan
export function validateEmail
export function validatePhone
export function visibleClientDraftErrors
export function visibleShippingDraftErrors
export function writeBrandFilter
export function writeGridSize
export function writeMaterialFilter
export interface AmsTrayLike
export interface AmsUnitLike
export interface ArchivePriceEstimate
export interface ArchivePricingSource
export interface BackupGroup
export interface CalcConfig
export interface CalcState
export interface CardFlightHandle
export interface CardFlightOptions
export interface CardMorphCloseOptions
export interface ClientDraft
export interface ClientDraftErrors
export interface ComputePopoverPositionOpts
export interface CountryCode
export interface CurvePoint
export interface DiscountColumn
export interface FilamentComparison
export interface FilamentPresetOption
export interface FilamentPresetSources
export interface FilamentRequirement
export interface FilamentRequirementsResponse
export interface GridStreamStats
export interface ImpressionDraft
export interface LoadedFilament
export interface MatchedSpool
export interface Mulberry32Sequence
export interface NamedCalculatorFilament
export interface NamedCalculatorPrinter
export interface OptimisticBoardOptions
export interface ParsedFrame
export interface ParsedPhone
export interface PerPrinterConfig
export interface PersistedDraft
export interface PopoverPosition
export interface PresetCategory
export interface PricingDefaults
export interface PricingFilament
export interface PricingInputs
export interface PricingPrinter
export interface PricingResult
export interface PrinterCompatibilityIndex
export interface PrinterMappingResult
export interface ProgressStatus
export interface RealityCheck
export interface RealityCheckOverrides
export interface ShippingDraft
export interface ShippingDraftErrors
export interface SkuForecast
export interface SkuGroup
export interface SpoolBuddyState
export interface TaskDraft
export interface TaskLike
export interface TaskSteps
export interface TaskSummary
export interface UnitCostSample
export interface UnknownSpoolPrompt
export interface UnknownTagDetail
export interface UseDismissableDialogOptions
export interface UseDismissableDialogResult
export interface UseMultiPrinterFilamentMappingResult
export interface WaterfallStep
export interface WebRTCPrinterStats
export type AgeAnchor
export type AgingLevel
export type Board
export type ColorFamily
export type ColumnId
export type DateFormat
export type DryingPreset
export type FilamentPresetSource
export type FilamentStatus
export type FlightDeparture
export type FlightSuspension
export type MoveLock
export type MoveTarget
export type PageTab
export type PasswordRequirementKey
export type PresetTriple
export type PrinterCompatibility
export type PrinterMatchStatus
export type RealityCheckKind
export type RealityCheckSeverity
export type ServiceId
export type SlicerType
export type Slot
export type SocialNetwork
export type SponsorAudience
export type TimeFormat
```

## Frontend API client methods
```regen: { awk "/^export const api = \\{/{f=1} f&&/^  [a-zA-Z0-9_]+:/{gsub(/:.*/,\"\"); gsub(/ /,\"\"); print} f&&/^\\};?$/{exit}" frontend/src/api/client.ts; grep -oE "^export (const|async function|function) [a-zA-Z0-9_]+" frontend/src/api/client.ts | sed "s/^export [a-z ]*//"; } | sort```
```

addAitoNote
addArchivesToProject
addCatalogEntry
addColorEntry
addLibraryFilesToQueue
addQueueItemsToProject
addToQueue
addToShoppingList
addUserToGroup
addVariantGroupMember
admin2FADisable
Api
Api
Api
Api
applyUpdate
archiveSpool
archiveSpoolmanInventorySpool
assignMaintenanceType
assignSpool
assignSpoolmanSlot
AuthToken
AuthToken
backfillContentHashes
batchGenerateStlThumbnails
bedJog
bulkArchiveSpoolmanInventorySpools
bulkArchiveSpools
bulkAssignLibraryTags
bulkCreateSpoolmanInventorySpools
bulkCreateSpools
bulkDeleteCatalogEntries
bulkDeleteColorEntries
bulkDeleteLibrary
bulkDeleteSpoolmanInventorySpools
bulkDeleteSpools
bulkResetSpoolConsumedCounter
bulkResetSpoolmanInventorySpoolConsumedCounter
bulkRestoreSpoolmanInventorySpools
bulkRestoreSpools
bulkUpdateQueue
bulkUpdateSpoolmanInventorySpools
bulkUpdateSpools
calibratePlateDetection
cancelBatch
cancelPipelineRun
cancelQueueItem
cancelScheduledDrying
changePassword
checkFfmpeg
checkFileDuplicates
checkForUpdates
checkGo2rtc
checkLocalBackupPath
checkPipelineEligibility
checkPlateEmpty
clearGitHubBackupLogs
clearHMSErrors
clearMQTTLogs
clearNotificationLogs
clearPlate
clearPrintLog
clearShoppingList
clearSpoolUsageHistory
clearTerminalPipelineRuns
cloudLogin
cloudLogout
cloudSetToken
cloudVerify
compareArchives
configureAmsSlot
confirmEnableEmailOTP
connectPrinter
connectSpoolman
controlSmartPlug
createAitoProject
createAitoTask
createAPIKey
createArchiveSlicerToken
createBatch
createBOMItem
createCalculatorFilament
createCalculatorPrinter
createCloudSetting
createCostCenter
createExternalFolder
createExternalLink
createFilamentPreset
createGroup
createHASensor
createLibraryFolder
createLibrarySlicerToken
createLibraryTag
createLocalPreset
createLocation
createLongLivedCameraToken
createMaintenanceType
createManualPrint
createNotificationProvider
createOIDCProvider
createPrinter
createProject
createProjectFromTemplate
createScheduledDrying
createSlicerPipeline
createSmartPlug
createSourceSlicerToken
createSpool
createSpoolFromSlot
createSpoolmanInventorySpool
createSpoolmanSpoolFromSlot
createTemplateFromProject
createUser
createVariantGroup
createZohoContact
deleteAitoProject
deleteAitoTask
deleteAmsLabel
deleteAPIKey
deleteArchive
deleteArchivePhoto
deleteArchiveTimelapse
deleteBOMItem
deleteCalculatorFilament
deleteCalculatorPrinter
deleteCatalogEntry
deleteCloudSetting
deleteColorEntry
deleteCostCenter
deleteExternalLink
deleteExternalLinkIcon
deleteF3d
deleteFilamentPreset
deleteGitHubBackupConfig
deleteGroup
deleteHASensor
deleteKProfile
deleteKProfileNote
deleteLibraryFile
deleteLibraryFolder
deleteLibraryTag
deleteLocalBackup
deleteLocalPreset
deleteLocation
deleteMaintenanceType
deleteNotificationProvider
deleteOIDCLink
deleteOIDCProvider
deleteOIDCProviderIcon
deletePlateCalibration
deletePlateReference
deletePrinter
deletePrinterFile
deletePrintLogEntry
deleteProject
deleteProjectAttachment
deleteProjectCoverImage
deleteSlicerPipeline
deleteSlotPreset
deleteSmartPlug
deleteSource3mf
deleteSpool
deleteSpoolmanInventorySpool
deleteTag
deleteTransaction
deleteUser
deleteVariantGroup
depositUserBalance
diagnoseCamera
diagnoseConnection
diagnosePrinter
disableAdvancedAuth
disableAuth
disableEmailOTP
disableMQTTLogging
disableTOTP
disconnectPrinter
disconnectSpoolman
dispatchBatch
downloadArchive
downloadArchiveTimelapse
downloadF3d
downloadLibraryFile
downloadLocalBackup
downloadPrinterFilesAsZip
downloadSource3mf
duplicateFilamentPreset
editTransaction
emptyLibraryTrash
enableAdvancedAuth
enableEmailOTP
enableMQTTLogging
enableTOTP
exchangeOIDCToken
executeArchivePurge
executeHMSAction
executeLibraryPurge
exportArchives
exportBackup
exportProjectJson
exportProjectZip
exportSpoolsCsv
exportStats
extractZipFile
extruderJog
findSimilarArchives
forgotPassword
forgotPasswordConfirm
get2FAStatus
getAdvancedAuthStatus
getAitoEvents
getAitoInvoice
getAitoInvoiceEmail
getAitoInvoicePdf
getAitoProjects
getAitoQuoteEmail
getAitoQuotePdf
getAitoShippingServices
getAitoTasks
getAitoTrash
getAllCloudFields
getAllTransactions
getAllUsageHistory
getAMSHistory
getAmsLabels
getAPIKeys
getArchive
getArchiveCapabilities
getArchiveDeleteImpact
getArchiveDownload
getArchiveDuplicates
getArchiveFilamentRequirements
getArchiveForSlicer
getArchiveGcode
getArchivePhotoUrl
getArchivePlatePreview
getArchivePlates
getArchivePlateThumbnail
getArchivePrinterMedia
getArchiveProjectImageUrl
getArchiveProjectPage
getArchivePurgeSettings
getArchiveQRCodeUrl
getArchiveRuns
getArchives
getArchiveSlicerDownloadUrl
getArchivesSlim
getArchiveStats
getArchiveThumbnail
getArchiveTimelapse
getAssignments
getAuthStatus
getAvailableFilaments
getBaseFilamentPresetContent
getBaseFilamentPresets
getBatch
getBatches
getBindableHAEntities
getBuiltinFilaments
getCalculatorDefaults
getCalculatorFilaments
getCalculatorInsights
getCalculatorPrinters
getCameraSnapshotUrl
getCameraStatus
getCameraStreamToken
getCameraStreamUrl
getCloudDevices
getCloudFields
getCloudFilamentPresets
getCloudSettingDetail
getCloudSettings
getCloudStatus
getColorByMaterial
getColorCatalog
getColorNameMap
getCostCenter
getCurrentPrintUser
getCurrentUser
getDefaultSidebarOrder
getDeveloperModeWarnings
getDiscoveredTasmotaDevices
getEncryptionStatus
getEnergyHistory
getExternalLink
getExternalLinkIconUrl
getExternalLinks
getF3dDownloadUrl
getFailureAnalysis
getFilament
getFilamentIdMap
getFilamentInfo
getFilamentPresets
getFilamentsByType
getGitHubBackupCloudAccounts
getGitHubBackupCommits
getGitHubBackupConfig
getGitHubBackupLogs
getGitHubBackupStatus
getGitHubRestorePreview
getGroup
getGroups
getHAEntities
getHASensorEntities
getHASensorReadings
getHASensors
getInventoryRemain
getKProfileNotes
getKProfiles
getLDAPStatus
getLibraryFile
getLibraryFileDownloadUrl
getLibraryFileFilamentRequirements
getLibraryFileGcodeUrl
getLibraryFileHistory
getLibraryFilePlates
getLibraryFilePlateThumbnail
getLibraryFiles
getLibraryFileThumbnailUrl
getLibraryFolderReadme
getLibraryFolders
getLibraryFoldersByArchive
getLibraryFoldersByProject
getLibrarySlicerDownloadUrl
getLibraryStats
getLibraryTags
getLibraryTrashSettings
getLinkedSpools
getLocalBackups
getLocalBackupStatus
getLocalPresetDetail
getLocalPresets
getLocations
getMaintenanceHistory
getMaintenanceOverview
getMaintenanceSummary
getMaintenanceTypes
getMakerworldRecentImports
getMakerworldStatus
getMQTTLogs
getMQTTStatus
getMyBalance
getMyCostCenters
getMyTransactions
getNetworkInterfaces
getNo3MFWarning
getNotificationLogs
getNotificationLogStats
getNotificationProvider
getNotificationProviders
getNotificationTemplate
getNotificationTemplates
getObicoPrinterStatus
getObicoStatus
getOIDCAuthorizeUrl
getOIDCLinks
getOIDCProviders
getOIDCProvidersAll
getOverlayStatus
getPermissions
getPipelineRun
getPlateDetectionStatus
getPlateReferences
getPlateReferenceThumbnailUrl
getPreviewSliceProgress
getPrintableObjects
getPrinter
getPrinterFileDownloadUrl
getPrinterFileGcodeUrl
getPrinterFilePlates
getPrinterFilePlateThumbnail
getPrinterFiles
getPrinterMaintenance
getPrinters
getPrinterSensorHistory
getPrinterStatus
getPrinterStorage
getPrintLog
getPrintLogThumbnail
getProject
getProjectArchives
getProjectAttachmentUrl
getProjectBOM
getProjectCoverImageUrl
getProjectFileProgress
getProjects
getProjectTimeline
getQueue
getQueueItem
getScriptPlugsByPrinter
getSettings
getShoppingList
getSkuSettings
getSliceJob
getSlicerPipeline
getSlicerPresets
getSlicerPresetValues
getSlicerPrinterModels
getSlotPreset
getSlotPresets
getSmartPlug
getSmartPlugByPrinter
getSmartPlugs
getSmartPlugStatus
getSMTPSettings
getSource3mfDownloadUrl
getSource3mfForSlicer
getSourceSlicerDownloadUrl
getSpool
getSpoolCatalog
getSpoolKProfiles
getSpoolmanFilaments
getSpoolmanInventoryFilaments
getSpoolmanInventorySpool
getSpoolmanInventorySpools
getSpoolmanKProfiles
getSpoolmanSettings
getSpoolmanSlotAssignment
getSpoolmanSlotAssignments
getSpoolmanSpools
getSpoolmanStatus
getSpools
getSpoolUsageHistory
getStorageUsage
getSystemHealth
getSystemInfo
getTags
getTasmotaScanStatus
getTemplates
getTemplateVariables
getTimelapseInfo
getTimelapseThumbnails
getUiPreferences
getUnlinkedSpools
getUpdateStatus
getUser
getUserEmailPreferences
getUserItemsCount
getUsers
getUsersSlim
getVariantGroup
getVariantGroupForFile
getVersion
getWebSocketToken
getZohoQuotePreview
getZohoStatus
hardDeleteLibraryTrash
homeAxes
importAitoProjects
importBackup
importLocalPresets
importMakerworldInstance
importProject
importProjectFile
importSpoolsCsv
importSpoolsCsvPreview
linkSpool
linkTagToSpool
linkTagToSpoolmanSpool
listAllLongLivedCameraTokens
listAllPipelineRuns
listCostCenters
listFilaments
listLibraryTrash
listLongLivedCameraTokensForUser
listMyLongLivedCameraTokens
listPipelineRuns
listScheduledDryings
listSlicerPipelines
loadAmsTray
login
logout
lookupColor
moveAitoProject
moveLibraryFiles
oidcProviderIconUrl
orcaCloudDevicePoll
orcaCloudDeviceStart
orcaCloudGetProfile
orcaCloudListProfiles
orcaCloudLogout
orcaCloudStatus
patchSpoolmanFilament
pausePrint
performMaintenance
previewArchivePurge
previewLibraryPurge
previewTemplate
PrinterApi
printSpoolLabels
printSpoolmanSpoolLabels
processTimelapse
PromptApi
proofreadAitoText
provisionLDAPUser
rebuildBalanceLedger
rebuildSearchIndex
recalculateCosts
refreshAmsSlot
refreshBaseProfileCache
refreshOIDCProviderIcon
refreshPrinterStatus
regenerateBackupCodes
removeArchivesFromProject
removeCostCenterMember
removeFromQueue
removeFromShoppingList
removeMaintenanceItem
removeUserFromGroup
removeVariantGroupMember
renameTag
reorderAitoTasks
reorderExternalLinks
reorderQueue
ReportApi
resetAmsSlot
resetColorCatalog
resetNotificationTemplate
resetSettings
resetSpoolCatalog
resetSpoolConsumedCounter
resetSpoolmanInventorySpoolConsumedCounter
resetUserPassword
resolveMakerworldUrl
restoreAitoProject
restoreDefaultMaintenanceTypes
restoreFromGitHub
restoreLibraryTrash
restoreLocalBackup
restoreSpool
restoreSpoolmanInventorySpool
resumePrint
resumeQueueAfterFailure
retryFailedPipelineRun
revokeLongLivedCameraToken
runPipeline
saveAmsLabel
saveGitHubBackupConfig
saveSlotPreset
saveSMTPSettings
saveSpoolKProfiles
saveSpoolmanKProfiles
scanArchiveTimelapse
scanBambuStudioPresets
scanExternalFolder
searchArchives
searchColors
searchLDAPDirectory
searchZohoContacts
searchZohoEstimates
searchZohoFilaments
selectArchiveTimelapse
selectExtruder
sendAitoInvoiceEmail
sendAitoQuoteEmail
sendEmailOTP
setAirductMode
setAitoProjectContacted
setAitoProjectFlag
setAitoQuoteStatus
setAmsFilamentBackup
setBedTemperature
setChamberLight
setChamberTemperature
setFanSpeed
setKProfile
setKProfileNote
setKProfilesBatch
setNozzleTemperature
setPrinterHours
setPrintSpeed
setupAuth
setupTOTP
skipObjects
sliceArchive
sliceLibraryFile
startDrying
startQueueItem
startTasmotaScan
stopCameraStream
stopDrying
stopPrint
stopQueueItem
stopTasmotaScan
StreamToken
StreamToken
StreamToken
summarizeAitoProject
syncAitoProject
syncAllPrintersAms
syncBaseFilamentPresets
syncCalculatorFilamentsFromZoho
syncFilamentPresetsFromZoho
syncFilamentPresetsToBambu
syncPrinterAms
syncSpoolmanAmsWeights
syncSpoolmanSpoolWeight
syncWeightsFromAms
testAllNotificationProviders
testCameraConnection
testExternalCamera
testGitHubConnection
testGitHubStoredConnection
testHAConnection
testLDAP
testNotificationConfig
testNotificationProvider
testObicoConnection
testRESTConnection
testSmartPlugConnection
testSMTP
toggleFavorite
triggerGitHubBackup
triggerLocalBackup
unassignSpool
unassignSpoolmanSlot
ungroupBatch
unlinkSpool
unloadAms
updateAitoProject
updateAitoTask
updateAPIKey
updateArchive
updateArchiveProjectPage
updateArchivePurgeSettings
updateBatch
updateBOMItem
updateCalculatorDefaults
updateCalculatorFilament
updateCalculatorPrinter
updateCatalogEntry
updateCloudSetting
updateColorEntry
updateCostCenter
updateCostCenterBudgets
updateExternalLink
updateFilamentPreset
updateGitHubBackupConfig
updateGroup
updateHASensor
updateLibraryFile
updateLibraryFolder
updateLibraryTag
updateLibraryTrashSettings
updateLocalPreset
updateLocation
updateMaintenanceItem
updateMaintenanceType
updateNotificationProvider
updateNotificationTemplate
updateOIDCProvider
updatePlateReferenceLabel
updatePrinter
updatePrintLogEntry
updateProject
updateQueueItem
updateSettings
updateShoppingListStatus
updateSlicerPipeline
updateSmartPlug
updateSpool
updateSpoolmanInventorySpool
updateSpoolmanSettings
updateUser
updateUserEmailPreferences
updateVariantGroup
updateZohoContact
uploadArchive
uploadArchivePhoto
uploadArchivesBulk
uploadArchiveTimelapse
uploadBaseFilamentPresets
uploadExternalLinkIcon
uploadF3d
uploadLibraryFile
uploadProjectAttachment
uploadProjectCoverImage
UploadsApi
uploadSource3mf
upsertCostCenterMember
upsertSkuSettings
verify2FA
VirtualPrinterApi
webrtcOffer
withdrawUserBalance
xyJog
```

## Frontend pages
```regen: ls frontend/src/pages/*.tsx | xargs -n1 basename | sort```
```
AitoFxDemoPage.tsx
AitoPage.tsx
ArchivesPage.tsx
CalculatorPage.tsx
CalculatorQuotePage.tsx
CameraPage.tsx
CameraTokensPage.tsx
ExternalLinkPage.tsx
FilamentProfilesPage.tsx
FileManagerPage.tsx
FinancePage.tsx
GCodeViewerPage.tsx
GroupEditPage.tsx
InventoryPage.tsx
LibraryTrashPage.tsx
LoginPage.tsx
MaintenancePage.tsx
MakerworldPage.tsx
NotificationsPage.tsx
PipelineRunsPage.tsx
PrintersPage.tsx
ProfilesPage.tsx
ProjectDetailPage.tsx
ProjectsPage.tsx
QueuePage.tsx
SettingsPage.tsx
SetupPage.tsx
StatsPage.tsx
StreamOverlayPage.tsx
SystemInfoPage.tsx
UsersPage.tsx
```

## Database tables (name, column count)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "import backend.app.main; from backend.app.core.database import Base; [print(n, len(t.columns)) for n, t in sorted(Base.metadata.tables.items())]" 2>/dev/null```
```
aito_events 15
aito_projects 42
aito_tasks 31
ams_labels 6
ams_sensor_history 7
api_keys 20
auth_ephemeral_tokens 10
auth_rate_limit_events 4
budget_reservations 9
bug_reports 9
calculator_defaults 22
calculator_filaments 15
calculator_printers 9
color_catalog 9
cost_center_members 5
cost_centers 10
external_links 9
filament_base_presets 8
filament_presets 10
filaments 16
file_variant_groups 5
github_backup_config 22
github_backup_logs 9
groups 7
kprofile_notes 6
library_file_tags 3
library_files 24
library_folders 12
library_tags 5
local_presets 18
locations 6
long_lived_tokens 10
maintenance_history 5
maintenance_types 10
notification_digest_queue 8
notification_logs 10
notification_providers 47
notification_templates 8
oidc_providers 20
orca_base_profiles 5
pending_uploads 13
pipeline_jobs 9
pipeline_runs 15
print_archives 53
print_batch_plates 6
print_batches 12
print_log_entries 21
print_queue 48
print_queue_variants 14
printer_ha_sensors 19
printer_maintenance 10
printer_sensor_history 6
printers 26
project_bom_items 13
projects 21
scheduled_dryings 15
settings 5
slicer_pipelines 17
slot_preset_mappings 9
smart_plug_energy_snapshots 4
smart_plugs 65
sponsor_toast_state 7
spool 36
spool_assignment 8
spool_catalog 5
spool_k_profile 11
spool_usage_history 10
spoolbuddy_devices 29
spoolman_k_profile 11
spoolman_slot_assignments 6
user_email_preferences 8
user_groups 2
user_oidc_links 6
user_otp_codes 7
user_totp 8
user_wallets 5
users 22
virtual_printers 18
wallet_transactions 13
```

