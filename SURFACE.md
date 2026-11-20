# SURFACE.md — campaign-B1 public contract: THE BACKEND (frozen at setup)

Regenerate every section with `bash tools/gen_surface_backend.sh > SURFACE.md`.
Each section names the exact command that produces it. ANY diff against this
file is a change to the backend's public contract and fails the iteration.

## HTTP routes (path + methods)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\")]" 2>/dev/null```
```
/ ['GET']
/api/v1/aito/ ['GET']
/api/v1/aito/ ['POST']
/api/v1/aito/clients/{client_id}/history ['GET']
/api/v1/aito/clients/{client_id}/quote-rating ['GET']
/api/v1/aito/clients/{client_id}/rating ['GET']
/api/v1/aito/import ['POST']
/api/v1/aito/import-3mf ['POST']
/api/v1/aito/import-3mf/{job_id} ['GET']
/api/v1/aito/import-3mf/{job_id} ['DELETE']
/api/v1/aito/payments/webhook ['POST']
/api/v1/aito/project-codes ['GET']
/api/v1/aito/project-warnings ['GET']
/api/v1/aito/proofread ['POST']
/api/v1/aito/shipping/services ['GET']
/api/v1/aito/stats ['GET']
/api/v1/aito/summarize ['POST']
/api/v1/aito/tasks/{task_id} ['PATCH']
/api/v1/aito/tasks/{task_id} ['DELETE']
/api/v1/aito/tasks/{task_id}/deliveries ['PUT']
/api/v1/aito/tasks/{task_id}/files ['POST']
/api/v1/aito/tasks/{task_id}/project ['PUT']
/api/v1/aito/tasks/{task_id}/project ['POST']
/api/v1/aito/tasks/{task_id}/project-suggestions ['GET']
/api/v1/aito/taxes ['GET']
/api/v1/aito/track/{token} ['GET']
/api/v1/aito/trash ['GET']
/api/v1/aito/{order_id}/project-links ['GET']
/api/v1/aito/{project_id} ['PATCH']
/api/v1/aito/{project_id} ['DELETE']
/api/v1/aito/{project_id}/client ['PUT']
/api/v1/aito/{project_id}/contacted ['PATCH']
/api/v1/aito/{project_id}/due-date ['PATCH']
/api/v1/aito/{project_id}/events ['GET']
/api/v1/aito/{project_id}/events ['POST']
/api/v1/aito/{project_id}/flag ['PATCH']
/api/v1/aito/{project_id}/force-sync ['POST']
/api/v1/aito/{project_id}/invoice ['GET']
/api/v1/aito/{project_id}/invoice ['POST']
/api/v1/aito/{project_id}/invoice-deposits ['GET']
/api/v1/aito/{project_id}/invoice-deposits/apply ['POST']
/api/v1/aito/{project_id}/invoice-email ['GET']
/api/v1/aito/{project_id}/invoice-email ['POST']
/api/v1/aito/{project_id}/invoice-preview ['GET']
/api/v1/aito/{project_id}/invoice.pdf ['GET']
/api/v1/aito/{project_id}/manual-payment ['POST']
/api/v1/aito/{project_id}/merge ['POST']
/api/v1/aito/{project_id}/move ['PATCH']
/api/v1/aito/{project_id}/payment-link ['POST']
/api/v1/aito/{project_id}/payment-link/refresh ['POST']
/api/v1/aito/{project_id}/payment-link/{link_id}/cancel ['POST']
/api/v1/aito/{project_id}/pickup-message ['POST']
/api/v1/aito/{project_id}/pickup-sms ['POST']
/api/v1/aito/{project_id}/priority ['PATCH']
/api/v1/aito/{project_id}/quote-email ['GET']
/api/v1/aito/{project_id}/quote-email ['POST']
/api/v1/aito/{project_id}/quote-extend ['POST']
/api/v1/aito/{project_id}/quote-status ['POST']
/api/v1/aito/{project_id}/quote.pdf ['GET']
/api/v1/aito/{project_id}/restore ['POST']
/api/v1/aito/{project_id}/retainer-email ['GET']
/api/v1/aito/{project_id}/retainer-email ['POST']
/api/v1/aito/{project_id}/retainer.pdf ['GET']
/api/v1/aito/{project_id}/retainers ['GET']
/api/v1/aito/{project_id}/sync ['POST']
/api/v1/aito/{project_id}/tasks ['GET']
/api/v1/aito/{project_id}/tasks ['POST']
/api/v1/aito/{project_id}/tasks/reorder ['PATCH']
/api/v1/aito/{project_id}/tasks/transfer ['POST']
/api/v1/aito/{project_id}/tax ['PUT']
/api/v1/aito/{project_id}/terminal-payment ['POST']
/api/v1/aito/{project_id}/terminal-payment/{payment_id} ['GET']
/api/v1/aito/{project_id}/tracking-link ['GET']
/api/v1/aito/{project_id}/tracking-views ['GET']
/api/v1/aito/{project_id}/transfer-client ['PUT']
/api/v1/aito/{project_id}/unlinked-retainers ['GET']
/api/v1/aito/{project_id}/unlinked-retainers/{retainer_id}/link ['POST']
/api/v1/aito/{project_id}/watch ['GET']
/api/v1/aito/{project_id}/watch ['PUT']
/api/v1/ams-history/{printer_id}/{ams_id} ['GET']
/api/v1/announcements ['GET']
/api/v1/announcements/{public_id}/read ['POST']
/api/v1/api-keys/ ['GET']
/api/v1/api-keys/ ['POST']
/api/v1/api-keys/{key_id} ['GET']
/api/v1/api-keys/{key_id} ['PATCH']
/api/v1/api-keys/{key_id} ['DELETE']
/api/v1/archives/ ['GET']
/api/v1/archives/analysis/failures ['GET']
/api/v1/archives/backfill-hashes ['POST']
/api/v1/archives/compare ['GET']
/api/v1/archives/confirm/{token}/{verdict} ['GET']
/api/v1/archives/confirm/{token}/{verdict} ['POST']
/api/v1/archives/export ['GET']
/api/v1/archives/last-per-printer ['GET']
/api/v1/archives/merge ['POST']
/api/v1/archives/merge-count ['GET']
/api/v1/archives/merge-preview ['GET']
/api/v1/archives/no-3mf-warning ['GET']
/api/v1/archives/prints ['GET']
/api/v1/archives/purge ['POST']
/api/v1/archives/purge/preview ['GET']
/api/v1/archives/purge/settings ['GET']
/api/v1/archives/purge/settings ['PUT']
/api/v1/archives/recalculate-costs ['POST']
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
/api/v1/archives/{archive_id}/runs ['GET']
/api/v1/archives/{archive_id}/runs/{run_id}/timelapse ['GET']
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
/api/v1/archives/{archive_id}/timelapse/job ['GET']
/api/v1/archives/{archive_id}/timelapse/job ['DELETE']
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
/api/v1/auth/media-token ['POST']
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
/api/v1/bulk/ams-labels ['GET']
/api/v1/bulk/archive-folders ['GET']
/api/v1/bulk/card-plugs ['GET']
/api/v1/bulk/firmware-updates ['GET']
/api/v1/bulk/ha-sensor-readings ['GET']
/api/v1/bulk/printer-queues ['GET']
/api/v1/bulk/printer-statuses ['GET']
/api/v1/bulk/slot-presets ['GET']
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
/api/v1/connect/apps ['GET']
/api/v1/connect/apps ['POST']
/api/v1/connect/apps/{app_id} ['PATCH']
/api/v1/connect/apps/{app_id} ['DELETE']
/api/v1/connect/apps/{app_id}/rotate-secret ['POST']
/api/v1/connect/authorize ['POST']
/api/v1/connect/authorize/info ['GET']
/api/v1/connect/token ['POST']
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
/api/v1/external-links/badge ['PUT']
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
/api/v1/filament-trees ['GET']
/api/v1/filament-trees ['POST']
/api/v1/filament-trees/bulk ['POST']
/api/v1/filament-trees/candidates ['POST']
/api/v1/filament-trees/conflicts/resolve ['POST']
/api/v1/filament-trees/export ['POST']
/api/v1/filament-trees/export/confirm ['POST']
/api/v1/filament-trees/migrate ['POST']
/api/v1/filament-trees/orca-cleanup ['GET']
/api/v1/filament-trees/orca-cleanup ['POST']
/api/v1/filament-trees/sync ['GET']
/api/v1/filament-trees/sync ['POST']
/api/v1/filament-trees/sync/last ['GET']
/api/v1/filament-trees/sync/progress ['GET']
/api/v1/filament-trees/sync/stop ['POST']
/api/v1/filament-trees/targets ['GET']
/api/v1/filament-trees/targets ['PUT']
/api/v1/filament-trees/unmanaged ['GET']
/api/v1/filament-trees/{tree_id} ['PATCH']
/api/v1/filament-trees/{tree_id} ['DELETE']
/api/v1/filament-trees/{tree_id}/colors ['POST']
/api/v1/filament-trees/{tree_id}/colors/{color_id} ['PATCH']
/api/v1/filament-trees/{tree_id}/colors/{color_id} ['DELETE']
/api/v1/filament-trees/{tree_id}/duplicate ['POST']
/api/v1/filament-trees/{tree_id}/history ['GET']
/api/v1/filament-trees/{tree_id}/history/{change_id}/revert ['POST']
/api/v1/filament-trees/{tree_id}/node ['GET']
/api/v1/filament-trees/{tree_id}/node ['PUT']
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
/api/v1/heimdall/test ['POST']
/api/v1/inbox ['GET']
/api/v1/inbox/preferences ['GET']
/api/v1/inbox/preferences ['PUT']
/api/v1/inbox/read-all ['POST']
/api/v1/inbox/{notification_id}/read ['POST']
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
/api/v1/inventory/labels/preview ['POST']
/api/v1/inventory/locations ['GET']
/api/v1/inventory/locations ['POST']
/api/v1/inventory/locations/{location_id} ['PATCH']
/api/v1/inventory/locations/{location_id} ['DELETE']
/api/v1/inventory/profile-defaults ['GET']
/api/v1/inventory/profile-defaults ['PUT']
/api/v1/inventory/profile-defaults/resolve ['GET']
/api/v1/inventory/profile-defaults/{default_id} ['DELETE']
/api/v1/inventory/profile-defaults/{default_id}/apply ['POST']
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
/api/v1/inventory/spools/{spool_id}/filament-presets ['GET']
/api/v1/inventory/spools/{spool_id}/filament-presets ['PUT']
/api/v1/inventory/spools/{spool_id}/k-profiles ['GET']
/api/v1/inventory/spools/{spool_id}/k-profiles ['PUT']
/api/v1/inventory/spools/{spool_id}/link-tag ['PATCH']
/api/v1/inventory/spools/{spool_id}/reset-consumed-counter ['POST']
/api/v1/inventory/spools/{spool_id}/restore ['POST']
/api/v1/inventory/spools/{spool_id}/suppliers ['PUT']
/api/v1/inventory/spools/{spool_id}/usage ['GET']
/api/v1/inventory/spools/{spool_id}/usage ['DELETE']
/api/v1/inventory/stats/material-numbers ['GET']
/api/v1/inventory/stats/suppliers ['GET']
/api/v1/inventory/suppliers ['GET']
/api/v1/inventory/suppliers ['POST']
/api/v1/inventory/suppliers/{supplier_id} ['PATCH']
/api/v1/inventory/suppliers/{supplier_id} ['DELETE']
/api/v1/inventory/sync-ams-weights ['POST']
/api/v1/inventory/usage ['GET']
/api/v1/label-templates ['GET']
/api/v1/label-templates ['POST']
/api/v1/label-templates/{template_id} ['PUT']
/api/v1/label-templates/{template_id} ['DELETE']
/api/v1/library/bulk-delete ['POST']
/api/v1/library/files ['GET']
/api/v1/library/files ['POST']
/api/v1/library/files/ ['GET']
/api/v1/library/files/ ['POST']
/api/v1/library/files/add-to-queue ['POST']
/api/v1/library/files/check-duplicates ['POST']
/api/v1/library/files/combine ['POST']
/api/v1/library/files/extract-zip ['POST']
/api/v1/library/files/file-types ['GET']
/api/v1/library/files/move ['POST']
/api/v1/library/files/{file_id} ['GET']
/api/v1/library/files/{file_id} ['PUT']
/api/v1/library/files/{file_id} ['DELETE']
/api/v1/library/files/{file_id}/dl/{token}/{filename} ['GET']
/api/v1/library/files/{file_id}/download ['GET']
/api/v1/library/files/{file_id}/filament-requirements ['GET']
/api/v1/library/files/{file_id}/gcode ['GET']
/api/v1/library/files/{file_id}/history ['GET']
/api/v1/library/files/{file_id}/photos ['POST']
/api/v1/library/files/{file_id}/photos/{filename} ['GET']
/api/v1/library/files/{file_id}/photos/{filename} ['DELETE']
/api/v1/library/files/{file_id}/plate-thumbnail/{plate_index} ['GET']
/api/v1/library/files/{file_id}/plates ['GET']
/api/v1/library/files/{file_id}/preview-thumbnail ['POST']
/api/v1/library/files/{file_id}/print ['POST']
/api/v1/library/files/{file_id}/project-suggestions ['GET']
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
/api/v1/location-ha-sensors/ ['GET']
/api/v1/location-ha-sensors/ ['POST']
/api/v1/location-ha-sensors/by-location/{location_id}/readings ['GET']
/api/v1/location-ha-sensors/entities ['GET']
/api/v1/location-ha-sensors/{sensor_id} ['GET']
/api/v1/location-ha-sensors/{sensor_id} ['PATCH']
/api/v1/location-ha-sensors/{sensor_id} ['DELETE']
/api/v1/maintenance/hours ['GET']
/api/v1/maintenance/hours/events/{event_id} ['DELETE']
/api/v1/maintenance/hours/import ['POST']
/api/v1/maintenance/hours/machines/{machine_id} ['PATCH']
/api/v1/maintenance/hours/machines/{machine_id} ['DELETE']
/api/v1/maintenance/hours/machines/{machine_id}/events ['POST']
/api/v1/maintenance/hours/readings ['POST']
/api/v1/maintenance/hours/readings ['DELETE']
/api/v1/maintenance/hours/settings ['PATCH']
/api/v1/maintenance/items/{item_id} ['PATCH']
/api/v1/maintenance/items/{item_id} ['DELETE']
/api/v1/maintenance/items/{item_id}/history ['GET']
/api/v1/maintenance/items/{item_id}/perform ['POST']
/api/v1/maintenance/log ['DELETE']
/api/v1/maintenance/log/export ['GET']
/api/v1/maintenance/log/{entry_id} ['DELETE']
/api/v1/maintenance/overview ['GET']
/api/v1/maintenance/printers/{printer_id} ['GET']
/api/v1/maintenance/printers/{printer_id}/assign/{type_id} ['POST']
/api/v1/maintenance/printers/{printer_id}/hours ['PATCH']
/api/v1/maintenance/printers/{printer_id}/log ['GET']
/api/v1/maintenance/printers/{printer_id}/log ['DELETE']
/api/v1/maintenance/printers/{printer_id}/log/export ['GET']
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
/api/v1/manyfold/config ['GET']
/api/v1/manyfold/config ['PUT']
/api/v1/manyfold/config ['DELETE']
/api/v1/manyfold/config/test ['POST']
/api/v1/manyfold/import ['POST']
/api/v1/manyfold/models ['GET']
/api/v1/manyfold/models/{model_id} ['GET']
/api/v1/manyfold/models/{model_id}/preview ['GET']
/api/v1/manyfold/status ['GET']
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
/api/v1/notifications/app-message ['POST']
/api/v1/notifications/app-message/channels ['GET']
/api/v1/notifications/logs ['GET']
/api/v1/notifications/logs ['DELETE']
/api/v1/notifications/logs/stats ['GET']
/api/v1/notifications/photos/{filename} ['GET']
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
/api/v1/octoeverywhere/printer-status ['GET']
/api/v1/octoeverywhere/status ['GET']
/api/v1/octoeverywhere/test-connection ['POST']
/api/v1/orca-cloud/device/poll ['POST']
/api/v1/orca-cloud/device/start ['POST']
/api/v1/orca-cloud/logout ['POST']
/api/v1/orca-cloud/profiles ['GET']
/api/v1/orca-cloud/profiles/{profile_id} ['GET']
/api/v1/orca-cloud/status ['GET']
/api/v1/order-board ['GET']
/api/v1/order-board/finished ['GET']
/api/v1/order-board/finished/{salesorder_id} ['GET']
/api/v1/order-board/invoices/{invoice_id}/email ['GET']
/api/v1/order-board/invoices/{invoice_id}/email ['POST']
/api/v1/order-board/invoices/{invoice_id}/pdf ['GET']
/api/v1/order-board/items ['GET']
/api/v1/order-board/orders ['POST']
/api/v1/order-board/orders/{salesorder_id}/cancel ['POST']
/api/v1/order-board/orders/{salesorder_id}/client-rating ['GET']
/api/v1/order-board/orders/{salesorder_id}/contact ['PUT']
/api/v1/order-board/orders/{salesorder_id}/customer-credit ['GET']
/api/v1/order-board/orders/{salesorder_id}/documents/{kind}/{document_id}/email ['GET']
/api/v1/order-board/orders/{salesorder_id}/documents/{kind}/{document_id}/email ['POST']
/api/v1/order-board/orders/{salesorder_id}/documents/{kind}/{document_id}/pdf ['GET']
/api/v1/order-board/orders/{salesorder_id}/events ['GET']
/api/v1/order-board/orders/{salesorder_id}/events ['POST']
/api/v1/order-board/orders/{salesorder_id}/invoice ['GET']
/api/v1/order-board/orders/{salesorder_id}/invoice ['POST']
/api/v1/order-board/orders/{salesorder_id}/invoices/{invoice_id}/apply-credit ['POST']
/api/v1/order-board/orders/{salesorder_id}/lines ['PUT']
/api/v1/order-board/orders/{salesorder_id}/manual-payment ['POST']
/api/v1/order-board/orders/{salesorder_id}/packages ['POST']
/api/v1/order-board/orders/{salesorder_id}/packages/{package_id} ['GET']
/api/v1/order-board/orders/{salesorder_id}/packages/{package_id} ['PUT']
/api/v1/order-board/orders/{salesorder_id}/packages/{package_id}/handover ['GET']
/api/v1/order-board/orders/{salesorder_id}/packages/{package_id}/handover ['POST']
/api/v1/order-board/orders/{salesorder_id}/payment-link ['POST']
/api/v1/order-board/orders/{salesorder_id}/payment-link/cancel ['POST']
/api/v1/order-board/orders/{salesorder_id}/payment-target ['GET']
/api/v1/order-board/orders/{salesorder_id}/picklist ['GET']
/api/v1/order-board/orders/{salesorder_id}/picklists ['POST']
/api/v1/order-board/orders/{salesorder_id}/picklists/{picklist_id} ['GET']
/api/v1/order-board/orders/{salesorder_id}/prep-sheet ['POST']
/api/v1/order-board/orders/{salesorder_id}/sms ['POST']
/api/v1/order-board/orders/{salesorder_id}/sms-draft ['GET']
/api/v1/order-board/orders/{salesorder_id}/sync ['POST']
/api/v1/order-board/orders/{salesorder_id}/terminal-payment ['POST']
/api/v1/order-board/orders/{salesorder_id}/terminal-payment ['GET']
/api/v1/order-board/orders/{salesorder_id}/tracking-link ['GET']
/api/v1/order-board/orders/{salesorder_id}/watch ['GET']
/api/v1/order-board/orders/{salesorder_id}/watch ['PUT']
/api/v1/order-board/orders/{salesorder_id}/watch ['DELETE']
/api/v1/order-board/prep-sheet/batch ['POST']
/api/v1/order-board/refresh ['POST']
/api/v1/order-board/settings ['GET']
/api/v1/order-board/settings ['PUT']
/api/v1/order-board/track/{token} ['GET']
/api/v1/overlay-branding/logo ['GET']
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
/api/v1/printer-locations/ ['GET']
/api/v1/printer-locations/ ['POST']
/api/v1/printer-locations/ ['PATCH']
/api/v1/printer-locations/assign ['POST']
/api/v1/printer-locations/delete ['POST']
/api/v1/printer-sensor-history/{printer_id} ['GET']
/api/v1/printers/ ['GET']
/api/v1/printers/ ['POST']
/api/v1/printers/available-filaments ['GET']
/api/v1/printers/camera/grid-stream ['GET']
/api/v1/printers/camera/hub-status ['GET']
/api/v1/printers/camera/stream-token ['POST']
/api/v1/printers/developer-mode-warnings ['GET']
/api/v1/printers/diagnostic ['POST']
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
/api/v1/printers/{printer_id}/hms/history ['GET']
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
/api/v1/printers/{printer_id}/panda-breath ['POST']
/api/v1/printers/{printer_id}/print-options ['POST']
/api/v1/printers/{printer_id}/print-speed ['POST']
/api/v1/printers/{printer_id}/print/objects ['GET']
/api/v1/printers/{printer_id}/print/pause ['POST']
/api/v1/printers/{printer_id}/print/resume ['POST']
/api/v1/printers/{printer_id}/print/skip-objects ['POST']
/api/v1/printers/{printer_id}/print/stop ['POST']
/api/v1/printers/{printer_id}/refresh-status ['POST']
/api/v1/printers/{printer_id}/select-extruder ['POST']
/api/v1/printers/{printer_id}/slot-presets ['GET']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['GET']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['PUT']
/api/v1/printers/{printer_id}/slot-presets/{ams_id}/{tray_id} ['DELETE']
/api/v1/printers/{printer_id}/slots/{ams_id}/{tray_id}/configure ['POST']
/api/v1/printers/{printer_id}/slots/{ams_id}/{tray_id}/spool-defaults ['GET']
/api/v1/printers/{printer_id}/status ['GET']
/api/v1/printers/{printer_id}/storage ['GET']
/api/v1/printers/{printer_id}/temperature/bed ['POST']
/api/v1/printers/{printer_id}/temperature/chamber ['POST']
/api/v1/printers/{printer_id}/temperature/nozzle ['POST']
/api/v1/printers/{printer_id}/wled/presets ['POST']
/api/v1/printers/{printer_id}/wled/test-connection ['POST']
/api/v1/printers/{printer_id}/wled/test-preset ['POST']
/api/v1/printers/{printer_id}/xy-jog ['POST']
/api/v1/projects ['GET']
/api/v1/projects/ ['GET']
/api/v1/projects/ ['POST']
/api/v1/projects/ai/reformulate ['POST']
/api/v1/projects/ai/suggest-tags ['POST']
/api/v1/projects/catalog ['GET']
/api/v1/projects/folders ['GET']
/api/v1/projects/folders ['POST']
/api/v1/projects/folders/{folder_id} ['PATCH']
/api/v1/projects/folders/{folder_id} ['DELETE']
/api/v1/projects/from-template/{template_id} ['POST']
/api/v1/projects/import ['POST']
/api/v1/projects/import/file ['POST']
/api/v1/projects/items/{item_id} ['PATCH']
/api/v1/projects/items/{item_id} ['DELETE']
/api/v1/projects/items/{item_id}/fork ['POST']
/api/v1/projects/items/{item_id}/revisions ['POST']
/api/v1/projects/legacy-migration/start ['POST']
/api/v1/projects/legacy-migration/status ['GET']
/api/v1/projects/revisions/pins/{pin_id} ['DELETE']
/api/v1/projects/revisions/{revision_id} ['PATCH']
/api/v1/projects/revisions/{revision_id} ['DELETE']
/api/v1/projects/revisions/{revision_id}/download ['GET']
/api/v1/projects/revisions/{revision_id}/files ['POST']
/api/v1/projects/revisions/{revision_id}/files/{file_id} ['DELETE']
/api/v1/projects/revisions/{revision_id}/lineage ['GET']
/api/v1/projects/revisions/{revision_id}/pins ['GET']
/api/v1/projects/revisions/{revision_id}/pins ['POST']
/api/v1/projects/revisions/{revision_id}/reslice ['POST']
/api/v1/projects/revisions/{revision_id}/slice ['POST']
/api/v1/projects/revisions/{revision_id}/sliced-file ['POST']
/api/v1/projects/search ['GET']
/api/v1/projects/tags ['GET']
/api/v1/projects/templates ['GET']
/api/v1/projects/{project_id} ['GET']
/api/v1/projects/{project_id} ['PATCH']
/api/v1/projects/{project_id} ['DELETE']
/api/v1/projects/{project_id}/add-archives ['POST']
/api/v1/projects/{project_id}/add-queue ['POST']
/api/v1/projects/{project_id}/archives ['GET']
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
/api/v1/projects/{project_id}/folder ['PATCH']
/api/v1/projects/{project_id}/import-library-files ['POST']
/api/v1/projects/{project_id}/items ['POST']
/api/v1/projects/{project_id}/orders ['GET']
/api/v1/projects/{project_id}/queue ['GET']
/api/v1/projects/{project_id}/remove-archives ['POST']
/api/v1/projects/{project_id}/timeline ['GET']
/api/v1/projects/{project_id}/tree ['GET']
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
/api/v1/queue/history ['GET']
/api/v1/queue/history/clear ['POST']
/api/v1/queue/model/{model}/resume ['POST']
/api/v1/queue/printer/{printer_id}/resume ['POST']
/api/v1/queue/reorder ['POST']
/api/v1/queue/{item_id} ['GET']
/api/v1/queue/{item_id} ['PATCH']
/api/v1/queue/{item_id} ['DELETE']
/api/v1/queue/{item_id}/cancel ['POST']
/api/v1/queue/{item_id}/retry-slice ['POST']
/api/v1/queue/{item_id}/start ['POST']
/api/v1/queue/{item_id}/stop ['POST']
/api/v1/revenue ['GET']
/api/v1/revenue/analysis ['GET']
/api/v1/revenue/annotations ['GET']
/api/v1/revenue/annotations ['POST']
/api/v1/revenue/annotations/{annotation_id} ['DELETE']
/api/v1/revenue/customers ['GET']
/api/v1/revenue/daily ['GET']
/api/v1/revenue/items ['GET']
/api/v1/revenue/movers ['GET']
/api/v1/revenue/products ['GET']
/api/v1/revenue/review ['GET']
/api/v1/revenue/scope/{item_id} ['PUT']
/api/v1/revenue/scope/{item_id} ['DELETE']
/api/v1/revenue/sync ['GET']
/api/v1/revenue/sync ['POST']
/api/v1/revenue/targets ['GET']
/api/v1/revenue/targets/{month} ['PUT']
/api/v1/revenue/targets/{month} ['DELETE']
/api/v1/revenue/yoy ['GET']
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
/api/v1/settings/overlay-logo ['GET']
/api/v1/settings/overlay-logo ['POST']
/api/v1/settings/overlay-logo ['DELETE']
/api/v1/settings/panda-breath/status ['GET']
/api/v1/settings/reset ['POST']
/api/v1/settings/restore ['POST']
/api/v1/settings/spoolman ['GET']
/api/v1/settings/spoolman ['PUT']
/api/v1/settings/ui-flags ['GET']
/api/v1/settings/ui-preferences ['GET']
/api/v1/settings/virtual-printer ['GET']
/api/v1/settings/virtual-printer ['PUT']
/api/v1/settings/virtual-printer/models ['GET']
/api/v1/showcase/stats ['GET']
/api/v1/slice-jobs/{job_id} ['GET']
/api/v1/slicer-pipelines/ ['GET']
/api/v1/slicer-pipelines/ ['POST']
/api/v1/slicer-pipelines/{pipeline_id} ['GET']
/api/v1/slicer-pipelines/{pipeline_id} ['PUT']
/api/v1/slicer-pipelines/{pipeline_id} ['DELETE']
/api/v1/slicer-pipelines/{pipeline_id}/check-eligibility ['POST']
/api/v1/slicer-pipelines/{pipeline_id}/run ['POST']
/api/v1/slicer-pipelines/{pipeline_id}/runs ['GET']
/api/v1/slicer/loaded-spools ['GET']
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
/api/v1/spoolman/inventory/profile-defaults/{default_id}/apply ['POST']
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
/api/v1/spoolman/inventory/spools/{spool_id}/filament-presets ['GET']
/api/v1/spoolman/inventory/spools/{spool_id}/filament-presets ['PUT']
/api/v1/spoolman/inventory/spools/{spool_id}/k-profiles ['GET']
/api/v1/spoolman/inventory/spools/{spool_id}/k-profiles ['PUT']
/api/v1/spoolman/inventory/spools/{spool_id}/reset-consumed-counter ['POST']
/api/v1/spoolman/inventory/spools/{spool_id}/restore ['POST']
/api/v1/spoolman/inventory/spools/{spool_id}/suppliers ['GET']
/api/v1/spoolman/inventory/spools/{spool_id}/suppliers ['PUT']
/api/v1/spoolman/inventory/spools/{spool_id}/tag ['PATCH']
/api/v1/spoolman/inventory/spools/{spool_id}/usage ['GET']
/api/v1/spoolman/inventory/spools/{spool_id}/usage ['DELETE']
/api/v1/spoolman/inventory/spools/{spool_id}/weight ['PATCH']
/api/v1/spoolman/inventory/sync-ams-weights ['POST']
/api/v1/spoolman/inventory/tags/migrate ['POST']
/api/v1/spoolman/labels ['POST']
/api/v1/spoolman/labels/preview ['POST']
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
/api/v1/users/me/ui-prefs ['GET']
/api/v1/users/me/ui-prefs/{key} ['PUT']
/api/v1/users/slim ['GET']
/api/v1/users/{user_id} ['GET']
/api/v1/users/{user_id} ['PATCH']
/api/v1/users/{user_id} ['DELETE']
/api/v1/users/{user_id}/items-count ['GET']
/api/v1/virtual-printers ['GET']
/api/v1/virtual-printers ['POST']
/api/v1/virtual-printers/ca-certificate ['GET']
/api/v1/virtual-printers/ca-certificate/installer/{platform} ['GET']
/api/v1/virtual-printers/connect-info ['GET']
/api/v1/virtual-printers/my-access-code ['GET']
/api/v1/virtual-printers/my-access-code ['POST']
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
/api/v1/zoho/contacts/{contact_id} ['GET']
/api/v1/zoho/contacts/{contact_id} ['PATCH']
/api/v1/zoho/contacts/{contact_id}/persons ['GET']
/api/v1/zoho/contacts/{contact_id}/persons ['POST']
/api/v1/zoho/estimates ['GET']
/api/v1/zoho/estimates/{estimate_id}/preview ['GET']
/api/v1/zoho/status ['GET']
/docs ['GET', 'HEAD']
/docs/oauth2-redirect ['GET', 'HEAD']
/health ['GET']
/manifest.json ['HEAD']
/manifest.json ['GET']
/openapi.json ['GET', 'HEAD']
/redoc ['GET', 'HEAD']
/sw-register.js ['HEAD']
/sw-register.js ['GET']
/sw.js ['HEAD']
/sw.js ['GET']
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
manyfold:import
manyfold:view
notification_templates:read
notification_templates:update
notifications:create
notifications:delete
notifications:read
notifications:update
notifications:user_email
orca_cloud:auth
orders:read
orders:update
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
queue:start_unreviewed
queue:update_all
queue:update_own
revenue:export
revenue:manage_notes
revenue:manage_scope
revenue:manage_targets
revenue:read
revenue:sync
revenue:view_customers
revenue:view_margin
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

## Settings surface (name = default)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "from backend.app.core.config import settings; [print(n, \"=\", repr(f.default)) for n, f in sorted(type(settings).model_fields.items())]" 2>/dev/null```
```
api_prefix = '/api/v1'
app_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy')
app_name = 'Fenrir'
archive_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy/archive')
bambu_studio_api_url = 'http://localhost:3001'
bambu_studio_bundle_dir = None
bambu_studio_user_dirs = None
bambu_user_id = '1961034787'
base_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy')
database_url = 'sqlite+aiosqlite:////Users/paultheis/Documents/Code/bambuddy/bambuddy.db'
db_max_overflow = None
db_pool_pre_ping = None
db_pool_recycle = None
db_pool_size = None
db_pool_timeout = None
db_pool_use_lifo = None
debug = False
library_max_upload_bytes = 2147483648
library_max_zip_extract_bytes = 4294967296
log_backup_count = 3
log_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy/logs')
log_level = 'INFO'
log_max_bytes = 5242880
log_to_file = True
plate_calibration_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy/data/plate_calibration')
slicer_api_url = 'http://localhost:3003'
static_dir = PosixPath('/Users/paultheis/Documents/Code/bambuddy/static')
```

## Environment variables read
```regen: grep -rhoE "env_get\(\"[A-Z_]+\"|os\.(environ\.get|getenv)\(\"[A-Z_]+\"" backend/app | grep -oE "\"[A-Z_]+\"" | sort -u```
```
"AITO_TRACK_COLLAPSED_PROXY"
"APP_URL"
"BUG_REPORT_RELAY_URL"
"CONTAINER"
"DATA_DIR"
"DATABASE_URL"
"DOCKER_CONTAINER"
"FENRIR_COMPOSE_DIR"
"FENRIR_EXTERNAL_ROOTS"
"FENRIR_OIDC_DEFAULT_GROUP"
"FENRIR_OIDC_EMAIL_CLAIM"
"FENRIR_OIDC_GROUP_CLAIM"
"FENRIR_OIDC_GROUP_MAPPING"
"FENRIR_OIDC_ICON_URL"
"FENRIR_OIDC_SCOPES"
"GIT_BRANCH"
"HA_TOKEN"
"HA_URL"
"INVOCATION_ID"
"JWT_SECRET_KEY"
"LOG_DIR"
"MFA_ENCRYPTION_KEY"
"MPLCONFIGDIR"
"ORCA_CLOUD_API_BASE"
"ORCA_CLOUD_CLIENT_ID"
"ORCA_CLOUD_SCOPE"
"PORT"
"SUPERVISOR_TOKEN"
"TRUSTED_FRAME_ORIGINS"
"TRUSTED_PROXY_IPS"
"TZ"
"VIRTUAL_PRINTER_PASV_ADDRESS"
```

## Backend services + core top-level defs (count per signature)
```regen: grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/*.py backend/app/core/*.py | sort | uniq -c | sed "s/^ *//"```
```
1 async def accept_quote(
1 async def actor_still_exists(db: AsyncSession, actor: User | ApiKeyActor | None) -> bool:
1 async def add_color(db: AsyncSession, tree_id: int, name: str, hex: str) -> int:
1 async def add_revision_from_sources(
1 async def add_revision(
1 async def advance_watermark(
1 async def all_folders(db: AsyncSession) -> list[ProjectFolder]:
1 async def all_time_cost(db: AsyncSession, live_total_kwh: float, price_now: float) -> float:
1 async def announce_queue_jobs_added(db: AsyncSession, item_ids: Sequence[int]) -> None:
1 async def api_key_printer_scope(db: AsyncSession, api_key: APIKey) -> PrinterScope:
1 async def apply_camera_rotation_to_file(path: Path, rotation: int, logger: logging.Logger) -> None:
1 async def apply_deposit(
1 async def apply_env_oidc_provider(db: AsyncSession) -> None:
1 async def apply_material_number_inheritance(db: AsyncSession, payload: dict) -> dict:
1 async def apply_migration(db: AsyncSession, choices: list[dict]) -> list[int]:
1 async def apply_outcome_verdict(
1 async def apply_payload(db: AsyncSession, payload: dict, facts: InstallFacts) -> int:
1 async def apply_print_charge_for_archive(
1 async def apply_project_tag_input(
1 async def apply_pull(db: AsyncSession, plan: PullPlan) -> dict[tuple, set[str]]:
1 async def apply_quote_decision(
1 async def apply_retainers(
1 async def apply_supplier_inheritance_to_batch(db: AsyncSession, spools: list[Spool]) -> None:
1 async def apply_supplier_inheritance(db: AsyncSession, spool: Spool) -> None:
1 async def apply_terminal_state(db: AsyncSession, row: AitoTerminalPayment, view: LinkView, *, now: datetime) -> None:
1 async def apply_to_internal_spools(db: AsyncSession, row: FilamentProfileDefault) -> int:
1 async def attach_recovered_3mf(
1 async def attach_trace_summaries(db: AsyncSession, responses: Iterable[PrintQueueItemResponse]) -> None:
1 async def authenticate_user_by_email(db: AsyncSession, email: str, password: str) -> User | None:
1 async def authenticate_user(db: AsyncSession, username: str, password: str) -> User | None:
1 async def authorize_api_key(
1 async def auto_assign_spool(
1 async def auto_file_by_code(
1 async def auto_file_enabled(db: AsyncSession) -> bool:
1 async def auto_watch(db: AsyncSession, project_id: int, user_id: int | None) -> None:
1 async def backfill_alert_kinds(db: AsyncSession) -> int:
1 async def backfill_batch_statuses(db: AsyncSession) -> int:
1 async def backfill_reminder_kind(db: AsyncSession) -> int:
1 async def balance_state(db: AsyncSession, project: AitoProject) -> AitoTrackingBalance | None:
1 async def bambu_spool_core_weight(db: AsyncSession) -> tuple[int, int | None]:
1 async def base_names(db: AsyncSession) -> set[str]:
1 async def broadcast_orders_changed(order_ids: Iterable[int], actor: str | None) -> None:
1 async def broadcast_pending(db: AsyncSession) -> None:
1 async def build_base_reader(db: AsyncSession) -> BaseValueReader:
1 async def build_export_zip(db: AsyncSession, tree_id: int | None, changed_only: bool = False) -> tuple[bytes, str]:
1 async def build_printer_file(
1 async def build_printer_files_zip(
1 async def build_slot_materials(
1 async def build_tracking_url(db: AsyncSession, project: AitoProject) -> str | None:
1 async def calculate_personal_balance(db: AsyncSession, user_id: int) -> float:
1 async def calibrate_machine(
1 async def calibrate_plate(
1 async def caller_is_api_key(
1 async def camera_light(
1 async def camera_stream_access(token: str) -> tuple[PrinterScope, StreamOpener] | None:
1 async def can_write(svc) -> bool:
1 async def cancel_all() -> None:
1 async def cancel_invoice_link(
1 async def cancel_job(archive_id: int) -> bool:
1 async def cancel_order_link(
1 async def cancel_printer_files_job(job_id: str, printer_id: int) -> bool:
1 async def capture_camera_frame_bytes(
1 async def capture_camera_frame(
1 async def capture_camera_image(
1 async def capture_detection_frame(printer_id: int, *, session_factory=async_session, timeout: int = 20) -> bytes | None:
1 async def capture_finish_photo(
1 async def capture_frame(
1 async def catalog(
1 async def check_all_plugs(db: AsyncSession, monitor: PowerAlertMonitor = power_alert_monitor) -> None:
1 async def check_pipeline_eligibility(
1 async def check_plate_empty(
1 async def check_pool_fits_server() -> None:
1 async def check_webhook_permission(db: AsyncSession, api_key: APIKey, permission: str) -> None:
1 async def claimed_timelapse_stems(
1 async def cleanup_orca(db: AsyncSession, svc, confirmed: list[str]) -> dict:
1 async def cleanup_preview(db: AsyncSession, svc) -> dict:
1 async def cleanup_tracking(
1 async def clear_persisted_session(db: AsyncSession, printer_id: int) -> None:
1 async def clear_task_print_trace(db: AsyncSession, task_id: int) -> None:
1 async def clone_runs(
1 async def close_all_connections():
1 async def close_spoolman_client():
1 async def close_tls_proxy(server: "asyncio.Server") -> None:
1 async def codes_by_order(db: AsyncSession) -> dict[int, list[str]]:
1 async def collect_diagnostic_snapshot(db: AsyncSession) -> dict[str, Any]:
1 async def collect_leaf_states(db: AsyncSession) -> tuple[list[LeafState], set[str]]:
1 async def collect_sensitive_strings(db: AsyncSession) -> dict[str, str]:
1 async def compute_aito_stats(
1 async def compute_client_history(db: AsyncSession, client_id: str, limit: int) -> AitoClientHistoryResponse:
1 async def compute_deficit_for_queue_item(
1 async def compute_tracking(
1 async def compute(db: AsyncSession, now: datetime | None = None) -> dict[str, Any]:
1 async def compute(db: AsyncSession, token: str, now: datetime) -> tuple[str, dict] | None:
1 async def confirm_export(db: AsyncSession, token: str) -> int:
1 async def confirm_outcome_for_new_queue_item(db: AsyncSession, *, started_outside_bambuddy: bool = False) -> bool:
1 async def confirm_token_holder(db: AsyncSession, token: str) -> tuple[PrintArchive, PrintLogEntry | None] | None:
1 async def convert_windows_paths(conn: AsyncConnection, base_dir: Path, *, windows: bool | None = None) -> int:
1 async def count_groups(db: AsyncSession, visible: list) -> int:
1 async def count_internal_spools_at_location(db: AsyncSession, location_id: int) -> int:
1 async def create_budget_reservation(
1 async def create_camera_stream_token(
1 async def create_folder(db: AsyncSession, name: str, parent_id: int | None) -> ProjectFolder:
1 async def create_invoice_link(
1 async def create_item(
1 async def create_media_token(username: str | None) -> str:
1 async def create_order_invoice_link(
1 async def create_password_reset_link_email_from_template(
1 async def create_project_for_task(
1 async def create_slicer_download_token(resource_type: str, resource_id: int) -> str:
1 async def create_spool_from_tray(db: AsyncSession, tray_data: dict) -> Spool:
1 async def create_tls_proxy(target_host: str, target_port: int) -> tuple[int, "asyncio.Server"]:
1 async def create_token(
1 async def create_tree(
1 async def create_websocket_token(
1 async def create_welcome_email_from_template(
1 async def current_api_key_if_present(
1 async def current_link(db: AsyncSession, scope: Scope, *, kind: str | None = "quote") -> AitoPaymentLink | None:
1 async def current_links(db: AsyncSession, project_ids: list[int], *, kind: str = "quote") -> dict[int, AitoPaymentLink]:
1 async def current_price(db: AsyncSession, *, remember: bool = False) -> float:
1 async def current_terminal_payment(db: AsyncSession, scope: Scope) -> AitoTerminalPayment | None:
1 async def current_terminal_payments(db: AsyncSession, project_ids: list[int]) -> dict[int, AitoTerminalPayment]:
1 async def customer_credits(db: AsyncSession, estimate: dict) -> list[RetainerCredit]:
1 async def customer_defaults(db: AsyncSession) -> dict[str, dict]:
1 async def default_cost_per_kg(db: AsyncSession) -> float:
1 async def default_import_folder(db: AsyncSession, name: str, user: User | None) -> LibraryFolder:
1 async def default_print_options(db: AsyncSession) -> DefaultPrintOptions:
1 async def delete_archived_timelapse(
1 async def delete_dependent_variants(db: AsyncSession, file_ids: list[int]) -> None:
1 async def delete_file_async(
1 async def delete_folder(db: AsyncSession, folder: ProjectFolder) -> None:
1 async def delete_item(db: AsyncSession, project: Project, item: ProjectItem) -> None:
1 async def delete_revision(db: AsyncSession, project: Project, item: ProjectItem, revision: ProjectRevision) -> None:
1 async def deposit_pct(db: AsyncSession) -> int:
1 async def derive_today_yesterday(
1 async def detect_gpu_hwaccels() -> list[str]:
1 async def detect_vaapi_support() -> dict:
1 async def diagnose_camera(
1 async def discard_open_runs(db: AsyncSession, printer_id: int) -> list[SimpleNamespace]:
1 async def discard_session(db: AsyncSession, printer_id: int) -> None:
1 async def dismiss(db: AsyncSession, user_id: int | None, milestone: str) -> None:
1 async def dispatch_remaining(
1 async def done_at(db: AsyncSession, project_id: int) -> datetime | None:
1 async def download_file_async(
1 async def download_file_bytes_async(
1 async def download_file_try_paths_async(
1 async def draft(db: AsyncSession, salesorder_id: str) -> dict:
1 async def drop_earlier_plate_videos(db: AsyncSession, run: PrintLogEntry) -> list[str]:
1 async def drop_files_on_task(
1 async def drop_printers_from_api_keys(db, deleted: Iterable[int] | None = None) -> None:
1 async def drop_printers_from_obico(db, deleted: Iterable[int] | None = None) -> None:
1 async def duplicate_tree(db: AsyncSession, tree_id: int, name: str, brand: str) -> int:
1 async def energy_plug_candidates(db: AsyncSession, printer_id: int | None) -> list[SmartPlug]:
1 async def enrich_spool_dicts_with_location_id(db: AsyncSession, spools: list[dict]) -> None:
1 async def ensure_api_key_printer_access(db: AsyncSession, api_key: APIKey, printer_id: int) -> None:
1 async def ensure_hour_machines(db: AsyncSession) -> list[HourMachine]:
1 async def ensure_printers_exist(db: AsyncSession, printer_ids: Iterable[int | None] | None) -> None:
1 async def ensure_token(db: AsyncSession, salesorder_id: str) -> str:
1 async def ensure_tracking_token(db: AsyncSession, project: AitoProject) -> str:
1 async def ensure_user_finance_defaults(db: AsyncSession, user: User) -> bool:
1 async def ensure_whole_archive_in_scope(db: AsyncSession, archive, scope: PrinterScope) -> None:
1 async def estimate_archive_cost_at_start(
1 async def estimate_filament_cost(db: AsyncSession, grams: float | None, filament_type: str | None) -> float | None:
1 async def estimate_queue_source_cost(
1 async def evaluate(db: AsyncSession, user_id: int | None) -> Trigger | None:
2 async def execute_action(
1 async def expire_client_rating(db: AsyncSession, customer_id: str | None, *, now: datetime | None = None) -> None:
1 async def external_url(db: AsyncSession) -> str:
1 async def extract_video_last_frame(video_path: Path, output_path: Path) -> bool:
1 async def fan_out(db: AsyncSession, event: AitoEvent, project: AitoProject | None = None) -> list[int]:
1 async def fetch_and_cache_base_profile(name: str, profile_type: str, db: AsyncSession) -> dict | None:
1 async def fetch_catalogue(db: AsyncSession, *, refresh: bool = True) -> list[FilamentProduct]:
1 async def fetch_icon(url: str) -> tuple[bytes, str, str]:
1 async def filament_stock_kg(db: AsyncSession) -> float | None:
1 async def fill_auto_added_spoolman_spool(spool: dict, client=None, *, include_slicer: bool = False) -> None:
1 async def fill_derived_energy(db: AsyncSession, plug_id: int, energy: dict) -> dict:
1 async def fill_gcode_hashes(session_factory, batch: int = 100) -> int:
1 async def fill_internal_spool(
1 async def fill_plate_estimates(session_factory, batch: int = 100) -> int:
1 async def fill_spoolman_rows(db: AsyncSession, spoolman_spool_id: int, resolved: ResolvedProfiles) -> bool:
1 async def find_default(db: AsyncSession, key: ProductKey) -> FilamentProfileDefault | None:
1 async def find_groups(db: AsyncSession, visible: list) -> list[MergeGroup]:
1 async def find_item_by_key(db: AsyncSession, project_id: int, section: str, key: str) -> ProjectItem | None:
1 async def find_matching_untagged_spool(db: AsyncSession, tray_data: dict) -> Spool | None:
1 async def find_material_number_for_product(
1 async def find_or_create_item(
1 async def find_remote_file_async(
1 async def find_revision_bundle(
1 async def find_slot_kprofile_for_extruder(
1 async def find_supplier_link_templates_for_product(
1 async def flush_and_wait(project_id: int, timeout: float = FLUSH_TIMEOUT_SECONDS, *, request: bool = True) -> bool:
1 async def fork_revision(
1 async def fresh_item(db: AsyncSession, item_id: int) -> ProjectItem:
1 async def generate_chamber_image_stream(
1 async def generate_mjpeg_stream(
1 async def get_api_key(
1 async def get_cache_status(db: AsyncSession) -> dict:
1 async def get_cached_base_profile(name: str, db: AsyncSession) -> dict | None:
1 async def get_cached() -> Snapshot:
1 async def get_cost_center_reserved_map(
1 async def get_current_active_user(current_user: Annotated[User, Depends(get_current_user)]) -> User:
1 async def get_current_user_optional(
1 async def get_current_user(
1 async def get_db() -> AsyncSession:
1 async def get_energy_history(
1 async def get_folder(db: AsyncSession, folder_id: int) -> ProjectFolder:
1 async def get_ftp_retry_settings() -> tuple[bool, int, float, float]:
1 async def get_item_for_project(db: AsyncSession, item_id: int) -> tuple[ProjectItem, Project]:
1 async def get_leaf_preset(db: AsyncSession, link: FilamentTreeLeaf) -> FilamentPreset:
1 async def get_location_by_id(db: AsyncSession, location_id: int) -> Location | None:
1 async def get_location_by_name(db: AsyncSession, name: str) -> Location | None:
1 async def get_locations_by_name_keys(db: AsyncSession, keys: set[str]) -> dict[str, Location]:
1 async def get_media_or_request_printer_scope(
1 async def get_notification_template(db: AsyncSession, event_type: str) -> NotificationTemplate | None:
1 async def get_or_create_broadcaster(key: str, factory: UpstreamFactory) -> MjpegBroadcaster:
1 async def get_or_create_keypair() -> tuple[Path, Path]:
1 async def get_or_create_tags(db: AsyncSession, names: list[str]) -> list[LibraryTag]:
1 async def get_persisted_ams_mapping(db: AsyncSession, printer_id: int) -> list[int] | None:
1 async def get_persisted_print_name(db: AsyncSession, printer_id: int) -> str | None:
1 async def get_persisted_spool_change_log(db: AsyncSession, printer_id: int) -> list[dict]:
1 async def get_plug_energy(plug: SmartPlug, db: AsyncSession) -> dict | None:
1 async def get_preview_filaments(
1 async def get_printer_files_job(job_id: str, printer_id: int) -> PrinterFilesJobStatus | None:
1 async def get_printer_scope_if_auth_enabled(
1 async def get_public_key() -> str:
1 async def get_queue_review_required(
1 async def get_request_actor(
1 async def get_revision_bundle(db: AsyncSession, revision_id: int) -> tuple[ProjectRevision, ProjectItem, Project]:
1 async def get_smtp_settings(db: AsyncSession) -> SMTPSettings | None:
1 async def get_spool_by_tag(db: AsyncSession, tag_uid: str, tray_uuid: str, sak: int | None = None) -> Spool | None:
1 async def get_spoolman_client() -> SpoolmanClient | None:
1 async def get_stall_timeout_seconds(db) -> float:
1 async def get_storage_info_async(
1 async def get_stored_token(db: AsyncSession, user: User | None = None) -> tuple[str | None, str | None, str]:
1 async def get_targets(db: AsyncSession) -> dict:
1 async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
1 async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
1 async def get_visible_folder(db: AsyncSession, folder_id: int, user: User | ApiKeyActor | None) -> LibraryFolder:
1 async def get_writable_folder(db: AsyncSession, folder_id: int, user: User | ApiKeyActor | None) -> LibraryFolder:
1 async def group_location_names(db: AsyncSession, group_id: int) -> list[str]:
1 async def group_printer_ids(db: AsyncSession, group_id: int) -> list[int]:
1 async def groups_printer_ids(db: AsyncSession, group_ids: Iterable[int]) -> frozenset[int]:
1 async def highest_referenced_id(conn, table: str) -> int:
1 async def highest_spool_id_given_out(db: AsyncSession) -> int:
1 async def hoist_shared_colour_values(db: AsyncSession, tree_id: int) -> None:
1 async def hold_unsliced_dispatch(db: AsyncSession, item: PrintQueueItem, library_file: LibraryFile) -> bool:
1 async def import_orca_file(filename: str, content: bytes, db: AsyncSession) -> dict:
1 async def init_db():
1 async def init_printer_connections(db: AsyncSession):
1 async def init_spoolman_client(url: str) -> SpoolmanClient:
1 async def install_facts(db: AsyncSession) -> InstallFacts:
1 async def invalidate_all_sessions(conn) -> None:
1 async def invoice_pay_url(db: AsyncSession, project: AitoProject, now: datetime) -> str | None:
1 async def is_auth_enabled(db: AsyncSession) -> bool:
1 async def is_billing_enabled(db: AsyncSession) -> bool:
1 async def is_cloud_token_invalid(db: AsyncSession, user: User | None = None) -> bool:
1 async def is_enabled(db: AsyncSession) -> bool:
1 async def is_jti_revoked(jti: str, db: AsyncSession | None = None) -> bool:
1 async def is_newest_run(db: AsyncSession, run: PrintLogEntry) -> bool:
1 async def is_personal_transaction(db: AsyncSession, user_id: int, cost_center_id: int | None) -> bool:
1 async def is_printer_kill_switch_enabled(db: AsyncSession) -> bool:
1 async def iter_subscriber(
1 async def join_machines(db: AsyncSession, tree_ids: Iterable[int], old: dict, new: dict) -> None:
1 async def last_activity(db: AsyncSession, project: AitoProject) -> datetime:
1 async def latest_run(db: AsyncSession, archive_id: int) -> PrintLogEntry | None:
1 async def legacy_candidates(db: AsyncSession) -> list[int]:
1 async def legacy_migration_status(db: AsyncSession) -> dict:
1 async def link_tag_to_inventory_spool(db: AsyncSession, spool: Spool, tray_data: dict) -> None:
1 async def link_task(db: AsyncSession, task: AitoTask, project_id: int | None, *, actor: str | None) -> AitoTask:
1 async def list_all_tokens(db: AsyncSession) -> list[LongLivedToken]:
1 async def list_files_async(
1 async def list_files_result_async(
1 async def list_folders(db: AsyncSession) -> list[ProjectFolderOut]:
1 async def list_for(db: AsyncSession, user_id: int | None) -> list[dict]:
1 async def list_project_retainers(db: AsyncSession, project) -> list[dict]:
1 async def list_user_tokens(db: AsyncSession, user_id: int) -> list[LongLivedToken]:
1 async def load_default(db: AsyncSession, default_id: int) -> FilamentProfileDefault | None:
1 async def load_export_priority(
1 async def load_export_tasks(db: AsyncSession, project_id: int) -> list[ExportTask]:
1 async def load_folder_index(db: AsyncSession, *, with_files: bool = True) -> FolderIndex:
1 async def load_notified_hms_faults() -> dict[int, set[str]]:
1 async def load_pipeline(db: AsyncSession, pipeline_id: int) -> SlicerPipeline:
1 async def load_progress(db: AsyncSession, batch: PrintBatch) -> BatchProgress:
1 async def load_tree(db: AsyncSession, project: Project) -> ProjectTreeResponse:
1 async def load_tree(db: AsyncSession, tree_id: int) -> TreeData:
1 async def location_grantees(db: AsyncSession, locations: Iterable[str | None]) -> list[str]:
1 async def lock_queue_positions(db: AsyncSession) -> None:
1 async def lock_revision_rows(
1 async def log_view(db: AsyncSession, project_id: int, now: datetime) -> None:
1 async def log_view(db: AsyncSession, salesorder_id: str, now: datetime) -> None:
1 async def lookup_orca_filament_id(
1 async def machine_for_printer(db: AsyncSession, printer_id: int) -> HourMachine:
1 async def managed_preset_ids(db: AsyncSession) -> set[int]:
1 async def mark_cloud_token_invalid(user_id: int | None) -> None:
1 async def mark_read(db: AsyncSession, public_id: str, user_id: int | None) -> bool:
1 async def max_queue_position(db: AsyncSession) -> int:
1 async def maybe_sync_spoolman_locations(db: AsyncSession, *, client=None) -> bool:
1 async def merge_group(db: AsyncSession, survivor_id: int, merged_ids: list[int]) -> str | None:
1 async def merge(db: AsyncSession, survivor_ids: list[int], visible: list) -> tuple[list[dict], list[dict]]:
1 async def migrate_project_legacy(db: AsyncSession, project: Project) -> LegacyMigrationOutcome:
1 async def mint_unique_token(db: AsyncSession) -> str:
1 async def mirror_archive_cost(
1 async def mirror_comments(db: AsyncSession, project: AitoProject, comments: list[dict]) -> int:
1 async def mirror_energy_start(db: AsyncSession, archive, *, printer_id: int) -> None:
1 async def mirror_latest_run(db: AsyncSession, archive_id: int) -> None:
1 async def move_library_files_to_project(
1 async def move_project(db: AsyncSession, project: Project, folder_id: int | None) -> Project:
1 async def move_task_print_trace(db: AsyncSession, copy_by_source: Mapping[int, int]) -> None:
1 async def new_snapshot(
1 async def newest_run(db: AsyncSession, archive_id: int) -> PrintLogEntry | None:
1 async def next_queue_position(db: AsyncSession) -> int:
1 async def next_service_hours(db: AsyncSession, printer_id: int) -> float | None:
1 async def note(db: AsyncSession, project_id: int, kind: str, actor: str | None, detail: dict | None) -> None:
1 async def notes_with_tracking(db: AsyncSession, project: AitoProject, existing: str | None) -> str | None:
1 async def notify_missing_spool_assignments_on_print_complete(
1 async def notify_missing_spool_assignments_on_print_start(
1 async def notify_pending_uploads_changed() -> None:
1 async def notify_print(
1 async def notify_queue_changed() -> None:
1 async def on_layer_change(printer_id: int, layer_num: int):
1 async def on_print_complete(
1 async def on_print_complete(printer_id: int) -> Path | None:
1 async def on_print_start(
1 async def on_revision_slice_done(
1 async def open_run_on_printer(
1 async def open_run(
1 async def order_links(db: AsyncSession, order_id: int) -> OrderProjectLinks:
1 async def order_of(db: AsyncSession, token: str) -> str | None:
1 async def orders_for_project(db: AsyncSession, project_id: int) -> ProjectOrdersResponse:
1 async def other_runs_of(db: AsyncSession, archive) -> int:
1 async def parse_and_validate(raw_bytes: bytes, db: AsyncSession) -> ImportPreview:
1 async def payment_state(db: AsyncSession, project: AitoProject) -> AitoTrackingPayment | None:
1 async def perform_ssh_update(device_id: str, ip_address: str, install_path: str | None = None) -> None:
1 async def persist_session(
1 async def pickup_message(
1 async def plan_invoice(db: AsyncSession, project: AitoProject) -> InvoicePlan:
1 async def poll_changes(db: AsyncSession) -> Changes:
1 async def poll_contacts(db: AsyncSession) -> int:
1 async def poll_invoices(db: AsyncSession) -> int:
1 async def poll_link(db: AsyncSession, row: AitoPaymentLink, *, now: datetime) -> bool:
1 async def poll_open_terminal_payments(
1 async def pop_frame(nonce: str) -> bytes | None:
1 async def preferences_for(db: AsyncSession, user_id: int) -> UserInboxPreference:
1 async def prepare_internal_spool_payload(db: AsyncSession, data: dict, fields_set: set[str]) -> dict:
1 async def prepare_reslice(db: AsyncSession, revision_id: int, body: ResliceBody, user_id: int | None) -> ResliceRequest:
1 async def principal_holds(
1 async def principal_may_connect(db: AsyncSession, username: str | None, api_key_id: int | None) -> bool:
1 async def principal_printer_scope(db: AsyncSession, username: str | None, api_key_id: int | None) -> PrinterScope:
1 async def print_energy_cost(
1 async def printed_in_scope(db: AsyncSession, archive, scope: PrinterScope) -> bool:
1 async def project_deposits(db: AsyncSession, project: AitoProject) -> tuple[dict | None, list[RetainerCredit]]:
1 async def project_ids_with_tag(db: AsyncSession, tag_id: int) -> list[int]:
1 async def project_tag_refs(db: AsyncSession, project_ids: list[int]) -> dict[int, list[ProjectTagRef]]:
1 async def proofread_text(db: AsyncSession, text: str) -> tuple[str, str]:
1 async def prune_stale_printer_file_bundles() -> None:
1 async def publish_plug_state(
1 async def pull_lines_enabled(db: AsyncSession) -> bool:
1 async def purge_old(db: AsyncSession, now: datetime) -> int:
1 async def purge_tracking_views(db: AsyncSession, older_than: timedelta = timedelta(days=400)) -> int:
1 async def push_leaves(
1 async def push_names(db: AsyncSession, entries: list[dict], skip: set[tuple]) -> list[dict]:
1 async def push_quote_status(db: AsyncSession, project: AitoProject, status: str) -> bool:
1 async def read_chamber_image_frame(
1 async def read_client_quote_rating(
1 async def read_client_rating(
1 async def read_customer_credit(
1 async def read_next_chamber_frame(reader: asyncio.StreamReader, timeout: float = 10.0) -> bytes | None:
1 async def read_plug(plug: SmartPlug, db: AsyncSession) -> tuple[str | None, float | None]:
1 async def read_since(db: AsyncSession, setting: str, backfill_days: int) -> str:
1 async def reading_interval_days(db: AsyncSession) -> int:
1 async def reapply_lost_kprofiles(
1 async def reclassify_presets(db: AsyncSession) -> dict:
1 async def reconcile_payment_links(
1 async def reconcile_project(
1 async def reconcile_quote_status(db: AsyncSession, project: AitoProject, estimate: dict) -> None:
1 async def record_and_broadcast(
1 async def record_archive_wear(db: AsyncSession, archive, entry: PrintLogEntry) -> None:
1 async def record_as(db: AsyncSession, order_id: int, kind: str, actor: str | None, **kwargs) -> AitoEvent | None:
1 async def record_assignment(db, printer_id: int, ams_id: int, tray_id: int, spool_id: int, backend: str) -> None:
1 async def record_deposit_application(
1 async def record_deposit_refusal(
1 async def record_drying_cycle(db: AsyncSession, printer_id: int, cycle: DryingCycleEnd) -> int:
1 async def record_hms_occurrences(printer_id: int, appeared: dict, cleared: dict[str, float]) -> None:
1 async def record_manual_payment(
1 async def record_on_linked_orders(
1 async def record_order_manual_payment(
1 async def record_order_payment(
1 async def record_queued(db: AsyncSession, context: PrintContext, *, copies: int, actor: str | None) -> None:
1 async def record_revision_added(db: AsyncSession, project_id: int, entry: dict, user_id: int | None) -> None:
1 async def record_tray_change(db: AsyncSession, printer_id: int, tray_global: int, layer_num: int) -> None:
1 async def record_verdict(
2 async def record(
1 async def recover_waiting_queue_items() -> int:
1 async def reformulate_project_text(db: AsyncSession, text: str, field: str) -> tuple[str, str]:
1 async def refresh_after_payment(db: AsyncSession, project_id: int, kind: str) -> None:
1 async def refresh_base_cache(db: AsyncSession) -> dict:
1 async def refresh_batch_status_for_item(db: AsyncSession, queue_item_id: int) -> None:
1 async def refresh_batch_status(db: AsyncSession, batch: PrintBatch) -> bool:
1 async def refresh_batches_after(queue_item_ids: list[int]) -> None:
1 async def refresh_batches_for_items(db: AsyncSession, queue_item_ids: list[int]) -> None:
1 async def refresh_gcode_hash_async(archive: PrintArchive) -> None:
1 async def refresh_order_after_payment(db: AsyncSession, salesorder_id: str) -> None:
1 async def refresh_tag_mirrors(db: AsyncSession, project_ids: list[int]) -> None:
1 async def refresh_terminal_payment(
1 async def refresh(db: AsyncSession) -> int | None:
1 async def regenerate_all_trees(session_factory) -> int:
1 async def regenerate_tree(db: AsyncSession, tree_id: int) -> dict:
1 async def reinitialize_database():
1 async def release_archived_slot_rows(printer_id: int) -> None:
1 async def release_budget_reservation(
1 async def release_other_slots(inventory: str, spool_id: int, keep: Slot) -> list[Slot]:
1 async def release_queue_references(db: AsyncSession, file_ids: list[int]) -> int:
1 async def remember_for_customer(db: AsyncSession, customer_id: str, tax: dict | None) -> None:
1 async def remind_if_due(db: AsyncSession, today: date) -> int:
1 async def remote_file_settled(
1 async def remove_color(db: AsyncSession, tree_id: int, color_id: int) -> None:
1 async def remove_file_from_revision(
1 async def remove_strays(db: AsyncSession, svc, entries: list[dict], keep: frozenset[str]) -> dict:
1 async def rename_color(db: AsyncSession, tree_id: int, color_id: int, name: str, hex: str | None = None) -> None:
1 async def rename_item(db: AsyncSession, project: Project, item: ProjectItem, new_name: str) -> ProjectItem:
1 async def rename_location(db: AsyncSession, location: Location, new_name: str) -> Location:
1 async def repair_wallet_ledger_internal(session: AsyncSession):
1 async def report_usage(printer_id: int, archive_id: int):
1 async def reprice_usage(
1 async def require_actor_still_exists(db: AsyncSession, actor: User | ApiKeyActor | None) -> None:
1 async def require_auth_if_enabled(
1 async def resolve_alias(db: AsyncSession, archive_id: int) -> int | None:
1 async def resolve_apikey_owner(db: AsyncSession, api_key: APIKey) -> User | None:
1 async def resolve_bambu_color(db: AsyncSession, rgba: str | None, sub_brand: str | None) -> CatalogColor | None:
1 async def resolve_camera_quality(preset_name: str, stream_count: int = 1) -> str:
1 async def resolve_camera_stream_token_principal(token: str) -> str | None:
1 async def resolve_configured_currency(db: AsyncSession) -> str:
1 async def resolve_conflict(
1 async def resolve_document(db: AsyncSession, project: AitoProject, kind: str, document_id: str) -> PaymentDocument:
1 async def resolve_location_by_name(db: AsyncSession, name: str, *, create: bool = True) -> Location | None:
1 async def resolve_order_document(db: AsyncSession, order_detail: dict, kind: str, document_id: str) -> PaymentDocument:
1 async def resolve_pending_confirmation_as_good(db: AsyncSession, printer_id: int) -> int | None:
1 async def resolve_preset_ref(
1 async def resolve_preset(preset_data: dict, profile_type: str, db: AsyncSession, depth: int = 0) -> dict:
1 async def resolve_print_context(
1 async def resolve_profile_default(
1 async def resolve_request_printer_scope(
1 async def resolve_session_max_minutes(db: AsyncSession) -> int:
1 async def resolve_slicer_filament(
1 async def resolve_spool_location_fields(
1 async def resolve_spool_preset(
1 async def resolve_spoolman_location_string(
1 async def resolve_spoolman_preset_with_own(
1 async def resolve_spoolman_preset(
1 async def resolve_tray_fields(db: AsyncSession, tray_data: dict) -> dict:
1 async def resolve_user_id_filament_scope(db: AsyncSession, user_id: int | None) -> FilamentScope:
1 async def resolve_user_id_printer_scope(db: AsyncSession, user_id: int | None) -> PrinterScope:
1 async def resolve_user_printer_scope(db: AsyncSession, user) -> PrinterScope:
1 async def restore_session(db: AsyncSession, printer_id: int, register_active: bool = True) -> list[list[int]] | None:
1 async def resume_interrupted_slices() -> int:
1 async def retire_broadcasters(prefix: str, *, keep: str) -> None:
1 async def retire_machine_of_printer(db: AsyncSession, printer_id: int) -> None:
1 async def revision_is_used(db: AsyncSession, revision_id: int) -> bool:
1 async def revision_lineage(
1 async def revision_print_counts(db: AsyncSession, revision_ids: Collection[int]) -> dict[int, int]:
1 async def revoke_jti(jti: str, expires_at: datetime, username: str | None = None) -> None:
1 async def revoke_token(db: AsyncSession, token_id: int) -> bool:
1 async def rollback_quietly(db: AsyncSession, log: logging.Logger, level: int, msg: str, *args: object) -> None:
1 async def run_being_ended(
1 async def run_change_pass(db: AsyncSession, *, trickle: bool = True) -> int:
1 async def run_connection_diagnostic(
1 async def run_force_sync(
1 async def run_linked_scripts_after_automatic_switch(printer_id: int | None, plug, plug_state: str) -> None:
1 async def run_linked_scripts(printer_id: int, plug_state: str, db: AsyncSession) -> None:
1 async def run_migrations(conn):
1 async def run_needs_energy_start(db: AsyncSession, archive, *, printer_id: int) -> bool:
1 async def run_of_archive(db: AsyncSession, archive_id: int, run_id: int) -> PrintLogEntry | None:
1 async def run_of(db: AsyncSession, archive_id: int, run_id: int) -> PrintLogEntry | None:
1 async def run_pragma(conn, pragma_sql: str):
1 async def run_reslice(db: AsyncSession, req: ResliceRequest, *, job_id: int | None = None) -> dict:
1 async def run_sync_loop() -> None:
1 async def run_sync_once(
1 async def run_with_retry(fn, *, max_attempts: int = 3, label: str = ""):
1 async def runs_by_archive(db: AsyncSession, archive_ids: list[int]) -> dict[int, list[PrintLogEntry]]:
1 async def runs_with_timelapse(db: AsyncSession, archive_id: int, relpath: str) -> list[PrintLogEntry]:
1 async def sales_taxes(db: AsyncSession) -> tuple[str, list[dict]]:
1 async def save_default(
1 async def save_notified_hms_faults(printer_id: int, current_keys) -> None:
1 async def save_smtp_settings(db: AsyncSession, smtp_settings: SMTPSettings) -> None:
1 async def scoped_view(db: AsyncSession, archive, scope: PrinterScope) -> ScopedView | None:
1 async def scoped_views(db: AsyncSession, archives, scope: PrinterScope) -> dict[int, ScopedView]:
1 async def seed_calculator_defaults():
1 async def seed_color_catalog():
1 async def seed_default_groups():
1 async def seed_notification_templates():
1 async def seed_spool_catalog():
1 async def select_energy_reading(
1 async def send_user_print_notification(
1 async def set_deliveries(
1 async def set_node_values(
1 async def set_project_tags(db: AsyncSession, project: Project, tag_ids: list[int]) -> list[LibraryTag]:
1 async def set_targets(db: AsyncSession, targets: dict, *, commit: bool = True) -> dict:
1 async def settle_archive_cost_estimate(archive_id: int) -> None:
1 async def settle_deposits(
1 async def settle_invoiced_deposits(db: AsyncSession, project: AitoProject) -> None:
1 async def settle_waiting_queue_items_quietly(db: AsyncSession, revision_id: int) -> None:
1 async def settle_waiting_queue_items(db: AsyncSession, revision_id: int) -> None:
1 async def settle_with_deposits(
1 async def shop_opening_hours(db: AsyncSession) -> str | None:
1 async def shutdown_all_broadcasters() -> None:
1 async def shutdown_broadcaster(key: str) -> bool:
1 async def similar_projects(
1 async def slice_source(db, source: bytes, filename: str, job_id: int) -> bytes:
1 async def sliced_file_of(db: AsyncSession, library_file: LibraryFile) -> LibraryFile | None:
1 async def snapshot_cost(
1 async def snapshot_today(db: AsyncSession, today: date | None = None) -> int:
1 async def source_file_of(db: AsyncSession, revision_id: int) -> LibraryFile | None:
1 async def spool_prefill_from_tag(db: AsyncSession, raw_blocks: dict[str, str] | None) -> dict | None:
1 async def spoolman_owns_assignments(db: AsyncSession) -> bool:
1 async def spoolman_spool_own_preset(spoolman_spool_id: int) -> PresetPair:
1 async def start_order_terminal_payment(
1 async def start_printer_files_job(
1 async def start_revision_slice(db: AsyncSession, revision_id: int, *, user_id: int | None) -> int | None:
1 async def start_slice_after_upload(db: AsyncSession, revision_id: int, *, user_id: int | None) -> int | None:
1 async def start_slice_for_waiting_items(db: AsyncSession, revision_id: int, *, user_id: int | None) -> None:
1 async def start_terminal_payment(
1 async def stash_frame(data: bytes) -> str:
1 async def stop_printer_download_cleanup() -> None:
1 async def store_derived_file(
1 async def store_print_data(
1 async def store_uploaded_slice(db: AsyncSession, revision_id: int, upload: UploadFile, *, user_id: int | None) -> dict:
1 async def stored_price(db: AsyncSession) -> float:
1 async def stray_filaments(db: AsyncSession, entries: list[dict], keep: frozenset[str] = frozenset()) -> list[dict]:
1 async def stream_opener_still_allowed(opener: StreamOpener, printer_id: int) -> bool:
1 async def submit_report(
1 async def suggest_project_tag_names(
1 async def suggest_projects_for_filename(
1 async def suggest_projects(db: AsyncSession, task: AitoTask, limit: int = 8) -> list[ProjectSuggestion]:
1 async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]:
1 async def superseded(db: AsyncSession, run: PrintLogEntry) -> bool:
1 async def sweep_inbox(db: AsyncSession, *, force: bool = False) -> None:
1 async def sweep_invoices(
1 async def sweep_orphan_intermediates(db: AsyncSession) -> int:
1 async def sweep_orphans(conn: Any) -> None:
1 async def sync_enabled(db: AsyncSession) -> bool:
1 async def sync_events(db: AsyncSession, machines: list[HourMachine]) -> None:
1 async def sync_interval_seconds(db: AsyncSession) -> int:
1 async def sync_locations_from_spoolman(db: AsyncSession, client) -> bool:
1 async def sync_oidc_user_groups(
1 async def sync_personal_wallet_balance(db: AsyncSession, wallet: UserWallet) -> float:
1 async def sync_project_tags_from_string(db: AsyncSession, project: Project) -> None:
1 async def sync_project(
1 async def tag_belongs_to_archived_spool(db: AsyncSession, tag_uid: str, tray_uuid: str) -> bool:
1 async def task_print_counts(db: AsyncSession, task_ids: Collection[int]) -> dict[int, PrintCounts]:
1 async def test_camera_connection(
1 async def test_connection(url: str, camera_type: str) -> dict:
1 async def token_outlived_its_session(db: AsyncSession, username: str | None, minted_at: datetime | None) -> bool:
1 async def tracking_url(db: AsyncSession, salesorder_id: str) -> str | None:
1 async def tree_write_lock(tree_ids: Iterable[int]) -> AsyncIterator[None]:
1 async def unlinked_retainers(db: AsyncSession, customer_id: str | None) -> list[dict]:
1 async def update_folder(
1 async def update_revision(
1 async def update_tree(
1 async def upload_file_async(
1 async def upsert_reading(
1 async def upsert_setting(db, model, key: str, value: str):
1 async def upsert_slot_preset_for_spool(
1 async def upsert_slot_preset_for_spoolman_spool(
1 async def upsert_slot_preset(
1 async def usable_api_key_prefix(db: AsyncSession, api_key_id: int) -> str | None:
1 async def used_file_ids(db: AsyncSession, file_ids: Select) -> set[int]:
1 async def user_id_holds(
1 async def validate_print_budget(
1 async def validated_api_key_from_request(
1 async def verify_camera_stream_token(token: str) -> PrinterScope | None:
1 async def verify_media_token(token: str) -> str | None:
1 async def verify_overlay_token(token: str) -> PrinterScope | None:
1 async def verify_slicer_download_token(
1 async def verify_token(
1 async def verify_websocket_token_principal(token: str) -> tuple[str, int | None] | None:
1 async def warning_minutes(db) -> int:
1 async def warnings_by_order(db: AsyncSession) -> dict[int, str]:
1 async def with_ftp_retry(
1 async def write_log_entry(
1 async def write_slot_results(
1 class AmountAboveBalance(Exception):
1 class AMSTray:
1 class ApiKeyActor:
1 class ArchiveComparisonService:
1 class ArchivePurgeService:
1 class ArchiveService:
1 class AssetStaticFiles(StaticFiles):
1 class AutoFileResult:
1 class BambuCloudAuthError(BambuCloudError):
1 class BambuCloudError(Exception):
1 class BambuCloudService:
1 class BambuFTPClient:
1 class BambuMQTTClient:
1 class Base(DeclarativeBase):
1 class Baseline(_RollingMean):
1 class BaseValueReader:
1 class BatchDispatchError(Exception):
1 class BatchProgress:
1 class BillingRunIdCollisionError(RuntimeError):
1 class CalculatorInsightsService:
1 class CameraDiagnoseResult:
1 class CameraDiagnoseStage:
1 class CameraProfile:
1 class CancelledPoolNoiseFilter(logging.Filter):
1 class CatalogColor:
1 class Catalogue:
1 class CatalogueIndex:
1 class ChamberConnectionClosed(Exception):
1 class Changes:
1 class ClientRating:
1 class CombinePart:
1 class ConnectionManager:
1 class CreatedToken:
1 class DefaultPrintOptions(TypedDict):
1 class DeleteResult(Enum):
1 class DepositAmountTooHigh(Exception):
1 class DepositAmountTooSmall(Exception):
1 class DepositNotFound(Exception):
1 class DepositOutcomeUnknown(Exception):
1 class DepositSettlement:
1 class DesignOverride(NamedTuple):
1 class DevicePoll:
1 class DiscoveredPrinter:
1 class DocumentMismatch(Exception):
1 class DownloadCancelled(Exception):
1 class DownloadDeadlineExceeded(Exception):
1 class DownloadInsufficientSpace(Exception):
1 class DownloadLimitExceeded(Exception):
1 class DryingCycleEnd:
1 class DryingRecord:
1 class DuplicateManualPayment(Exception):
1 class DuplicateSendGuard:
1 class EligibilityIssue:
1 class EligibilityReport:
1 class Entry:
1 class EnvOIDCConfigError(Exception):
1 class ExportPriority:
1 class ExportService:
1 class ExportShipping:
1 class ExportTask:
1 class ExtruderSlot:
1 class FailureAnalysisService:
1 class FeedRejected(Exception):
1 class FilamentDeficit:
1 class FilamentProduct:
1 class FilamentRule:
1 class FilamentScope:
1 class FilamentScopeHold:
1 class FilaSwitchState:
1 class FileListResult:
1 class FileNotOnPrinterError(Exception):
1 class FirmwareCheckService:
1 class FirmwareUpdateService:
1 class FirmwareUploadState:
1 class FirmwareUploadStatus(StrEnum):
1 class FirmwareVersion:
1 class FolderIndex:
1 class FtpFailure:
1 class FtpFailureKind(Enum):
1 class FtpFailureReport:
1 class FTPProfile:
1 class GitHubBackupService:
1 class GitHubRestoreService:
1 class Go2RTCService:
1 class GroupFilamentPolicy:
1 class HASensorManager:
1 class HeimdallAmbiguous(HeimdallUpstreamError):
1 class HeimdallAuthError(HeimdallUpstreamError):
1 class HeimdallConflict(HeimdallUpstreamError):
1 class HeimdallInvalid(HeimdallUpstreamError):
1 class HeimdallNotConfigured(Exception):
1 class HeimdallNotFound(HeimdallUpstreamError):
1 class HeimdallRateLimited(HeimdallUpstreamError):
1 class HeimdallService:
1 class HeimdallUnreachable(HeimdallUpstreamError):
1 class HeimdallUpstreamError(Exception):
1 class HMSAction(StrEnum):
1 class HMSError:
1 class HomeAssistantService:
1 class HttpStatusError(Exception):
1 class ImplicitFTP_TLS(FTP_TLS):
1 class Import3mfError(HttpStatusError):
1 class ImportPreview(BaseModel):
1 class ImportResult(BaseModel):
1 class ImportRowResult(BaseModel):
1 class InboxKind:
1 class InstallFacts:
1 class InvoiceLinkExists(Exception):
1 class InvoicePlan:
1 class JobAlreadyRunning(Exception):
1 class JsonGZipMiddleware:
1 class KProfile:
1 class KProfileReadError(Exception):
1 class LabelData:
1 class LastUsedThrottle:
1 class LDAPConfig:
1 class LDAPSearchResult:
1 class LDAPStartTLSRefusedError(Exception):
1 class LDAPUserInfo:
1 class LeafState:
1 class LegacyMigrationError(Exception):
1 class LegacyMigrationOutcome:
1 class LibraryTrashService:
1 class LinkError(HttpStatusError):
1 class LinkView:
1 class LocalBackupService:
1 class LocalConfig(TypedDict, total=False):
1 class LocationHASensorManager:
1 class LogEntry(BaseModel):
1 class LogFinding(BaseModel):
1 class LogSignature:
1 class ManualPaymentOutcomeUnknown(Exception):
1 class ManualPaymentPartial(Exception):
1 class ManualPaymentResult:
1 class ManualPaymentUnrecorded(Exception):
1 class MergeGroup:
1 class MeshCombineError(ValueError):
1 class MigrationGroup:
1 class MjpegBroadcaster:
1 class ModifiedSinceRows(list):
1 class MoveToProjectResult:
1 class MQTTDataSourceConfig:
1 class MQTTLogEntry:
1 class MQTTRelayService:
1 class MQTTSmartPlugService:
1 class NotificationService:
1 class NotifyClient:
1 class NotifyError(Exception):
1 class NotifyLiveActivityService(NotifyWorkerLifecycle):
1 class NotifyWidgetService(NotifyWorkerLifecycle):
1 class NotifyWorkerLifecycle:
1 class NozzleInfo:
1 class ObicoDetectionService:
1 class OctoEverywhereDetectionService:
1 class OIDCIconError(Exception):
1 class OIDCIconUnavailableError(OIDCIconError):
1 class OIDCIconUrlError(OIDCIconError):
1 class OpenRouterNotConfiguredError(Exception):
1 class OpenRouterUpstreamError(Exception):
1 class OrcaCloudAuthError(OrcaCloudError):
1 class OrcaCloudConflict(OrcaCloudError):
1 class OrcaCloudError(Exception):
1 class OrcaCloudService:
1 class OrcaFilamentLookup:
1 class PandaBreathDevice:
1 class PandaBreathService:
1 class ParsedLine:
1 class ParsedName:
1 class ParsedShipping:
1 class PatchDidNotConverge(Exception):
1 class PaymentDocument:
1 class Permission(StrEnum):
1 class PerPrinterReport:
1 class PlateDetectionResult:
1 class PlateDetector:
1 class PlateProgress:
1 class PowerAlertMonitor:
1 class PrintContext:
1 class PrintCounts:
1 class PrinterDiscoveryService:
1 class PrinterFileCache:
1 class PrinterFileDownloadError(Exception):
1 class PrinterFilesJobStatus:
1 class PrinterFilesZipInsufficientSpaceError(OSError):
1 class PrinterFilesZipResult:
1 class PrinterFilesZipTooLargeError(ValueError):
1 class PrinterHoursService:
1 class PrinterInfo:
1 class PrinterManager:
1 class PrinterScope:
1 class PrinterState:
1 class PrintOptions:
1 class PrintScheduler:
1 class PrintSession:
2 class PrintSnapshot:
1 class PrintState:
1 class PrintTraceError(HttpStatusError, ValueError):
1 class ProfileMatch:
1 class ProjectCatalogError(HttpStatusError):
1 class ProjectFilesError(HttpStatusError):
1 class ProjectPageParser:
2 class PullPlan:
1 class QueryTokenRedactFilter(logging.Filter):
1 class QuoteLinkManaged(Exception):
1 class QuoteRating:
1 class RatingProfile:
1 class Reading:
1 class RefusedHeaderRedactFilter(logging.Filter):
1 class RefusedHeaderResponseMask:
1 class RepriceResult:
1 class ResliceRequest:
1 class ResolvedProfile(NamedTuple):
1 class ResolvedProfiles:
1 class RESTSmartPlugService:
1 class RetainerApplication:
1 class RetainerCredit:
1 class RevisionSource:
1 class RunEstimate:
1 class ScanResult(BaseModel):
1 class ScopedCaller:
1 class ScopedView:
1 class SecretConfigError(ValueError):
1 class SensorReading:
1 class Settings(BaseSettings):
1 class SheetLayout:
1 class ShippingCatalogueUnavailable(Exception):
1 class ShippingItem:
1 class ShutdownCancelledRequestFilter(logging.Filter):
1 class SkuForecast:
1 class SkuSettings:
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
1 class SlotNozzle:
1 class SlotSpoolIdentity:
1 class SmartPlugManager:
1 class SmartPlugMQTTData:
1 class Snapshot:
1 class SnapshotCost:
1 class Splitter:
1 class SpoolLocationFields:
1 class SpoolmanClient:
1 class SpoolmanClientError(Exception):
1 class SpoolmanNotFoundError(Exception):
1 class SpoolmanUnavailableError(Exception):
1 class StepResult:
1 class StockSpool:
1 class StorageVerdict:
1 class StreamOpener:
1 class SubnetScanner:
1 class TaskSteps:
1 class TaskSummary:
1 class TasmotaScanner:
1 class TasmotaService:
1 class TelegramReactionPoller:
1 class TerminalInProgress(Exception):
1 class ThreeMFParser:
1 class TimelapseJob:
1 class TimelapseProcessor:
1 class TimelapseSession:
1 class TooManyNewTagsError(HTTPException):
1 class TraceIDFilter(logging.Filter):
1 class TreeData:
1 class Trigger:
1 class UnknownTagError(ValueError):
1 class UploadCancelled(Exception):
1 class UsageRecord:
1 class Wanted:
1 class WLEDManager:
1 class WLEDResponseError(ValueError):
1 class WriteRequestsOnlyFilter(logging.Filter):
1 class ZohoAmbiguous(ZohoUpstreamError):
1 class ZohoAmbiguousReferenceError(ZohoUpstreamError):
1 class ZohoFilamentMappingError(RuntimeError):
1 class ZohoFilamentRefreshBusyError(RuntimeError):
1 class ZohoNotConfiguredError(Exception):
1 class ZohoNotFound(ZohoUpstreamError):
1 class ZohoRateLimited(ZohoUpstreamError):
1 class ZohoRequestRejected(ZohoUpstreamError):
1 class ZohoService:
1 class ZohoUnreachable(ZohoUpstreamError):
1 class ZohoUpstreamError(Exception):
1 def a2l_lite_wire_ids(ams_id: int, tray_id: int) -> tuple[int, int, int] | None:
1 def accepts_gzip(accept_encoding: str | None) -> bool:
1 def active_broadcaster_keys() -> list[str]:
1 def active_task_count() -> int:
1 def actor_class(actor: str | None) -> str:
1 def actor_name(user: User | None) -> str | None:
1 def actor_user_id(user: User | None) -> int | None:
1 def add_required_headers(msg: MIMEMultipart, from_email: str) -> None:
1 def add_run_photo(run: PrintLogEntry | None, filename: str, *, first: bool = False) -> None:
1 def add_waiter(project_id: int) -> asyncio.Future[None]:
1 def added_on(machine: HourMachine, first_manual: date | None, printer_created: date | None) -> date | None:
1 def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
1 def adopt(printer_id: int) -> bool:
1 def age_days(day: str, today: date) -> int:
1 def alert_level_from_print_error(error: int) -> int:
1 def allocate_code_number(connection: Connection) -> int:
1 def ams_is_empty(unit: dict | None) -> bool:
1 def ams_units_to_dicts(
1 def ams3h_drying_cooling_temp(filament: str) -> int:
1 def ams3h_drying_zone(zone_info: object) -> dict | None:
1 def ancestor_ids(folders: list[ProjectFolder], folder_id: int | None) -> list[int]:
1 def annotate_rack_groups(filaments: list[dict], file_path: Path, plate_id: int | None) -> None:
1 def any_due(now: float) -> bool:
1 def api_key_own_scope(api_key) -> PrinterScope:
1 def apikey_effective_permissions(api_key: APIKey, owner: User | None = None) -> list[str]:
1 def applies(printer_id: int, setting: bool) -> bool:
1 def apply_camera_rotation(image_data: bytes, rotation: int, logger: logging.Logger) -> bytes:
1 def apply_design_overrides(process_json: str, overrides: list[DesignOverride], selected_keys: list[str]) -> str:
1 def apply_filament_cost(content: str, cost_per_kg: float) -> tuple[str, ApplyFilamentCostOutcome]:
1 def apply_process_overrides(process_json: str, overrides: dict[str, object]) -> str:
1 def apply_rack_ams_zone_fields(ams_list: object, known_types: dict[int, AmsType] | None = None) -> None:
1 def apply_sync(presets: list[dict[str, str]]) -> dict[str, int]:
1 def apply_tax(project: AitoProject, tasks: list[AitoTask], tax: dict, default: dict, *, keep_price_before_tax: bool):
1 def apply_tray_exist_bits(
1 def archive_scope_clause(printer_scope: PrinterScope):
1 def archived_counts(archived_at: datetime, now: datetime) -> bool:
1 def as_float(value) -> float | None:
1 def assign_location_name(location: Location, name: str) -> None:
1 def auth_headers(token: str | None) -> dict[str, str]:
1 def authenticate_ldap_user(config: LDAPConfig, username: str, password: str) -> LDAPUserInfo | None:
1 def base_before_surcharge(total: float, pct: float, min_fee: float) -> float:
1 def begins_with_cascade_level_1(stored_uid: str, uid_start: str) -> bool:
1 def best_product_line_match(
1 def bind_printer_file_to_token(result: PrinterFilesZipResult, printer_id: int, token: str) -> PrinterFilesZipResult:
1 def bind_printer_files_zip_to_token(
1 def blocked_message(entries: Iterable[Mapping]) -> str:
1 def blocking_reason_codes(unit: dict | None) -> list[int]:
1 def board_payments(orders: list[dict], today: date) -> dict[str, dict | None]:
1 def both_names(key: str) -> tuple[str, ...]:
1 def build_ams_tray_lookup(raw_data: dict) -> dict[int, dict]:
1 def build_camera_url(ip_address: str, access_code: str, model: str | None) -> str:
1 def build_description(service: str, task: ExportTask) -> str:
1 def build_invoice_payload(plan: InvoicePlan) -> dict:
1 def build_line_items(
1 def build_line_items(estimate_lines: list[dict]) -> list[dict]:
1 def build_match_index(catalogue: list[FilamentProduct]) -> CatalogueIndex:
1 def build_preview(
1 def build_shipping_description(shipping: ExportShipping) -> str:
1 def cache_3mf_download(printer_id: int, name: str, local_path: Path) -> None:
1 def can_flush() -> bool:
1 def can_rename_folder(folder: LibraryFolder, user: User | ApiKeyActor | None) -> bool:
1 def can_turn_off(plug) -> bool:
1 def can_write_folder(folder: LibraryFolder, user: User | ApiKeyActor | None) -> bool:
1 def cancel_session(printer_id: int):
1 def canonical(payload: dict) -> bytes:
1 def captcha_cooloff_active(base_url: str) -> bool:
1 def capture_in_flight(ip_address: str) -> bool:
1 def cascade_level_1_uid_start(tag_uid: str | None, sak: int | None = None) -> str | None:
1 def cascade_level_1_uid(tag_uid: str | None) -> str | None:
1 def change_filament_wire_ids(tray_id: int, layout: TrayLayout | None = None) -> tuple[int, int, int]:
1 def change_pass_seconds() -> float:
1 def changed_process_keys(before_json: str, after_json: str) -> list[str]:
1 def check_drying_supported(model: str | None, firmware: str | None, *, require_firmware: bool = True) -> str | None:
1 def check_importable(source: bytes) -> None:
1 def check_permission(api_key: APIKey, permission: str) -> None:
1 def check_source_within_caps(model_bytes: bytes) -> None:
1 def claim_unique_file_path(directory: Path, filename: str) -> Path:
1 def classify_backup_dir_error(exc: OSError, backup_dir: Path) -> dict:
1 def classify(reading: Reading, sensitivity: str) -> str:
1 def clean_item_name(name: str) -> tuple[str, str]:
1 def clean_rules(raw: Iterable[Mapping | object] | None) -> list[dict]:
1 def clean_tag_name(name: str) -> str:
1 def cleanup_orphaned_timelapse_sessions(min_age_seconds: float = 300) -> int:
1 def clear_3mf_cache(printer_id: int | None = None, delete_files: bool = True) -> None:
1 def clear(printer_id: int) -> None:
1 def client_snapshot(estimate: dict, contact: dict | None) -> dict:
1 def collect_base_presets() -> list[dict[str, str]]:
1 def combine_parts_to_3mf(parts: list[CombinePart]) -> bytes:
1 def combine_picks(rows: list[dict], brands: Mapping[str, str]) -> list[dict]:
1 def compose(
1 def compute_board(
1 def compute_file_md5(file_path: Path) -> str:
1 def compute_sync_stats(
1 def contact_mark_kind(shipping: bool, *, cleared: bool = False) -> str:
1 def cost_at_average_price(kwh: float, costed_kwh: float, costed: float, fallback_price: float) -> float:
1 def cost_of_readings(readings: list[tuple[float, float | None]], fallback_price: float) -> tuple[float, float]:
1 def cost_of(task: ExportTask, service: str) -> float | None:
1 def count_plates_in_3mf(zip_bytes: bytes) -> int:
1 def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
1 def create_password_reset_link_email(username: str, reset_url: str) -> tuple[str, str, str]:
1 def create_welcome_email(username: str, password: str, login_url: str) -> tuple[str, str, str]:
1 def current_hours(runtime_seconds: int | None, offset_hours: float | None) -> float:
1 def decode_bambu_tag_blocks(raw_blocks: dict[str, str] | None) -> dict | None:
1 def decode_content(content: dict) -> dict:
1 def default_matches(row: FilamentProfileDefault, *, brand, material, subtype, color_name) -> bool:
1 def delta_rate(
1 def derive_tracking(row: dict, handed_days: Collection[str] = ()) -> dict | None:
1 def describe_fault(full_code: str | None, model: str | None = None) -> str | None:
1 def describe_filament(entry: Mapping) -> str:
1 def describe_filaments(entries: Iterable[Mapping]) -> str:
1 def describe_state(sensor: _AlertableSensor, reading: SensorReading) -> str:
1 def describe_upload_failure(failure: FtpFailure | None) -> str:
1 def description_of(task: ExportTask, service: str) -> str | None:
1 def detect_container_runtime() -> str | None:
1 def detect_current_branch() -> str:
1 def diff_fields(obj: Any, patch: dict) -> list[dict]:
1 def discard_waiter(project_id: int, waiter: asyncio.Future[None]) -> None:
1 def discount_issues(estimate: dict, shipping_ids: dict[str, str] | None = None) -> list[dict]:
1 def discount_of(task: ExportTask, service: str) -> float | None:
1 def display_facts(meta: dict | None) -> dict[str, Any]:
1 def display_temperatures(temperatures: dict | None, model: str | None) -> dict[str, float]:
1 def document_numbers_of(project: Any) -> list[str]:
1 def done_completing(printer_id: int) -> None:
1 def drop_due_except(now: float, keep: set[int]) -> None:
1 def drop_printer_resolved(item: Any, keep: Iterable[str] = ()) -> None:
1 def drying_record(cycle: DryingCycleEnd) -> DryingRecord | None:
1 def drying_screen_only(model: str | None) -> bool:
1 def due_machine_ids(machines, readings, interval_days: int, today: date) -> list[int]:
1 def effective_bambu_user_id() -> str:
1 def effective_watch_kinds(watch: AitoWatch, prefs: UserInboxPreference) -> list[str]:
1 def effective_wled_status(
1 def enabled_services(task: ExportTask) -> tuple[str, ...]:
1 def encode_content(content: dict) -> dict[str, str]:
1 def encode_opentag3d_from_mapped(mapped: MappedSpoolFields) -> bytes:
1 def encode_opentag3d_v2_from_mapped(mapped: MappedSpoolFields) -> bytes:
1 def encode_opentag3d_v2(spool: Spool) -> bytes:
1 def encode_opentag3d(spool: Spool) -> bytes:
1 def end_gcode_injected(printer_id: int) -> bool:
1 def energy_start_of(entry: PrintLogEntry | None, archive) -> SimpleNamespace | None:
1 def ensure_model_target_allowed(user, scope: PrinterScope) -> None:
1 def ensure_project_dir(project) -> Path:
1 def ensure_requirements_allowed(scope: FilamentScope, requirements: Iterable[Mapping]) -> None:
1 def entry(backend: str, ams_id: int, tray_id: int, spool_id: int, layer: int, start: bool = False) -> dict:
1 def env_bool(key: str, default: bool, *, strict: bool = True) -> bool:
1 def env_get(key: str, default: str | None = None) -> str | None:
1 def evaluate(quote_status: str | None, stored_column: str, pending: Collection[str]) -> tuple[str, str | None]:
1 def evaluate(sensor: _AlertableSensor, payload: dict | None) -> SensorReading:
1 def expires_in_days(expires_on: str, today: date) -> int:
1 def expiry_for(quote_date: str | None) -> str:
1 def external_storage_present(state: object | None) -> bool:
1 def external_storage_warning(state: object | None, model: str | None) -> str | None:
1 def extra_display_facts(meta: dict | None) -> dict[str, Any]:
1 def extract_core_fields(data: dict) -> dict:
1 def extract_design_process_overrides(zip_bytes: bytes) -> list[DesignOverride]:
1 def extract_filament_requirements(file_path: Path, plate_id: int | None = None) -> list[dict]:
1 def extract_idp_groups(claim_value: object) -> list[str]:
1 def extract_printable_objects_from_3mf(
1 def extract_printable_objects_from_archive(
1 def extract_source_printer_model(zip_bytes: bytes) -> str | None:
1 def filament_policies_for(user) -> list[FilamentPolicyBrief] | None:
1 def file_hold_message(entries: Iterable[Mapping]) -> str:
1 def final_job_status(queue_status: str | None, *, entry_deleted: bool) -> str | None:
1 def find_ams_unit(state, ams_id: int) -> dict | None:
1 def find_interface_for_ip(target_ip: str) -> dict | None:
1 def find_item(tree: ProjectTreeResponse, item_id: int) -> ProjectItemOut | None:
1 def find_local_ipv4_network(local_ip: str) -> ipaddress.IPv4Network | None:
1 def find_revision(tree: ProjectTreeResponse, revision_id: int) -> ProjectRevisionOut | None:
1 def finished_is_core(order: dict | None, items: dict[str, dict], core: set[str]) -> bool | None:
1 def folder_delete_blocker(index: FolderIndex, folder: LibraryFolder, user: User | ApiKeyActor | None) -> str | None:
1 def forecast_all(
1 def forecast_sku(
1 def forget_printer(printer_id: int, *, deleted: bool = False) -> None:
1 def forget_printer(printer_id: int) -> None:
1 def forget_slot(printer_id: int, ams_id: int, tray_id: int) -> None:
1 def forget_spoolman_spool_own_preset(spoolman_spool_id: int) -> None:
1 def format_books_time(moment: datetime) -> str:
1 def format_project_code(number: int) -> str:
1 def format_time(minutes: int | None) -> str | None:
1 def format_weight(grams: float | None) -> str | None:
1 def ftp_probe_paths(filename: str) -> list[str]:
1 def ftps_background_blocked(ip_address: str) -> bool:
1 def ftps_handshake_blocked(ip_address: str) -> bool:
1 def gcode_fingerprint(path: Path) -> str | None:
1 def generate_api_key() -> tuple[str, str, str]:
1 def generate_pdf_thumbnail(pdf_path: Path, thumbnails_dir: Path, size: int = 256) -> str | None:
1 def generate_secure_password(length: int = 16) -> str:
1 def generate_stl_thumbnail(
1 def generate_trace_id() -> str:
1 def get_actions_for_error_code(device: str, error_code: str) -> list[str]:
1 def get_all_interface_ips(include_excluded: bool = False) -> list[dict]:
1 def get_ams_assignment_lock(printer_id: int) -> asyncio.Lock:
1 def get_bundle_filament_dir() -> Path:
1 def get_cached_3mf(printer_id: int, name: str) -> Path | None:
1 def get_calibration_status(printer_id: int, plate_type: str | None = None) -> dict:
1 def get_camera_port(model: str | None) -> int:
1 def get_camera_profile(model: str | None) -> CameraProfile:
1 def get_derived_status_name(state: PrinterState, model: str | None = None) -> str | None:
1 def get_error_description(error_code: str, model: str | None = None) -> str | None:
1 def get_fallback_spool_tag_for_slot(printer_serial: str, ams_id: int, tray_id: int) -> str:
2 def get_ffmpeg_path() -> str | None:
1 def get_firmware_service() -> FirmwareCheckService:
1 def get_firmware_update_service() -> FirmwareUpdateService:
1 def get_ftp_profile(model: str | None) -> FTPProfile:
1 def get_gpu_hwaccels() -> list[str]:
1 def get_job(archive_id: int) -> TimelapseJob | None:
1 def get_key_source() -> _PublicSource | None:
1 def get_migration_error_count() -> int:
1 def get_network_interfaces(include_excluded: bool = False) -> list[dict]:
1 def get_password_hash(password: str) -> str:
1 def get_pool_status() -> dict:
1 def get_rtsp_semaphore() -> asyncio.Semaphore:
1 def get_session(printer_id: int) -> TimelapseSession | None:
1 def get_sheet_capacity(template: Template) -> int | None:
1 def get_spool_move_lock(inventory: str, spool_id: int) -> asyncio.Lock:
1 def get_stage_name(stage: int) -> str:
1 def get_subscriber_count(key: str) -> int:
1 def get_trace_id() -> str:
1 def get_upload_state(printer_id: int) -> FirmwareUploadState:
1 def get_user_filament_dirs() -> list[Path]:
1 def group_lines(lines: list[ParsedLine]) -> list[list[ParsedLine]]:
1 def grouped_islands() -> list[tuple[str, list[tuple[str, str]]]]:
1 def hand_back(printer_id: int) -> None:
1 def has_colour_values(tree: TreeData, machine: str, nozzle: str, color_id: int) -> bool:
1 def has_placeholder(config: dict[str, Any]) -> bool:
1 def has_second_external_holder(raw_data: dict | None) -> bool:
1 def has_stg_cur_idle_bug(model: str | None) -> bool:
1 def has_waiter(project_id: int) -> bool:
1 def held_while(archive_id: int, work):
1 def held(archive_id: int) -> Iterator[None]:
1 def history_rate(records: Sequence[UsageRecord], now: datetime) -> tuple[float, float] | None:
1 def hms_fault_counts(error) -> bool:
1 def hold(archive_id: int) -> None:
1 def hotend_key(printer_id: int, extruder: int | None, nozzle_diameter: str | None) -> tuple[int, int, str]:
1 def http_exception_to_job_error(exc) -> _SliceJobError:
1 def inbox_kind_for(event_kind: str) -> str | None:
1 def inject_plate_thumbnails_if_missing(threemf_bytes: bytes) -> bytes:
1 def install_proactor_reset_filter(loop: asyncio.AbstractEventLoop | None = None) -> bool:
1 def invalidate_auth_enabled_cache() -> None:
1 def invalidate_settings() -> None:
1 def invalidate_validation_cache(token: str | None = None) -> None:
1 def invoice_state(status: str | None) -> str | None:
1 def invoice_total_of(invoice: Mapping[str, Any]) -> float | None:
1 def is_3mf(filename: str) -> bool:
1 def is_abrasive(tree: TreeData) -> bool:
1 def is_ams_slot_location(name: str) -> bool:
1 def is_bambu_tag(tag_uid: str, tray_uuid: str, tray_info_idx: str) -> bool:
1 def is_captcha_challenge(response) -> bool:
1 def is_chamber_image_model(model: str | None) -> bool:
1 def is_completing(printer_id: int) -> bool:
1 def is_due(project_id: int, now: float) -> bool:
1 def is_encryption_active() -> bool:
1 def is_expired(column: str, finished_at: datetime | None, last_active: datetime, now: datetime) -> bool:
1 def is_expired(finished_at: datetime | None, now: datetime) -> bool:
1 def is_expiry_401(response: httpx.Response) -> bool:
1 def is_foreign(line: dict, catalogue: Catalogue) -> bool:
1 def is_held(archive_id: int) -> bool:
1 def is_held(printer_id: int, key: tuple) -> bool:
1 def is_merging(archive_id: int) -> bool:
1 def is_monitor_only(plug) -> bool:
1 def is_one_tap_request(query_params: Mapping[str, str]) -> bool:
1 def is_placeholder_print_file(name: str | None) -> bool:
1 def is_plate_detection_available() -> bool:
1 def is_postgres() -> bool:
1 def is_preset_defining(key: str) -> bool:
1 def is_printable_filename(name: str) -> bool:
1 def is_printer_coupled(key: str) -> bool:
1 def is_printer_status_frame(print_data: dict) -> bool:
1 def is_resliceable(filename: str) -> bool:
1 def is_restorable_setting_key(key: str) -> bool:
1 def is_running_in_docker() -> bool:
1 def is_secret_setting_key(key: str) -> bool:
1 def is_slot_fallback_tag(tag: str, printer_serials) -> bool:
1 def is_sqlite() -> bool:
1 def is_unattended_fetch(method: str, headers: Mapping[str, str]) -> bool:
1 def is_unsliced_project_source(library_file: LibraryFile) -> bool:
1 def is_valid_tag(tag_uid: str, tray_uuid: str) -> bool:
1 def is_wire_format(content: dict) -> bool:
1 def island_for_label(label: str | None) -> str | None:
1 def island_label(island: str | None) -> str | None:
1 def item_dir(project, section: str, item_name: str) -> Path:
1 def item_name_for_filename(name: str) -> str:
1 def jpeg_resolution(frame: bytes) -> str | None:
1 def judged_requirements(requirements: Iterable[Mapping], overrides: Iterable[object] | None) -> list[Mapping]:
1 def k_key(row: dict) -> tuple[int, int, str]:
2 def kinds_for_depth(depth: str) -> list[str]:
1 def label_size_mm(template: Template) -> tuple[float, float]:
1 def last_print_storage_verdict(state: object | None) -> StorageVerdict:
1 def layout_offsets(footprints: list[tuple[float, float]], gap: float = LAYOUT_GAP_MM) -> list[tuple[float, float]]:
1 def leaf_groups(tree: TreeData, targets: dict, base_names: set[str]) -> list[tuple[str, str, int]]:
1 def leaf_name(tree: TreeData, machine: str, nozzle: str, color_id: int) -> str:
1 def leaf_targets(tree: TreeData, targets: dict) -> list[tuple[str, str, int]]:
1 def legacy_name(key: str) -> str | None:
1 def library_file_print_time(library_file: LibraryFile, plate_id: int | None) -> int | None:
1 def link_allowed(url: str) -> bool:
1 def link_view(row: AitoPaymentLink | None) -> "AitoPaymentLinkView | None":
1 def linked_credits(
1 def list_usb_cameras(dev_dir: Path = Path("/dev")) -> list[dict]:
1 def load_all_models():
1 def load_export_shipping(project: AitoProject, catalogue: Catalogue) -> ExportShipping | None:
1 def load_level(avg_hours_per_printer: float) -> str:
1 def load_overrides(rows: dict[int, bool | None]) -> None:
1 def location_name_key(name: str) -> str:
1 def log_project_event(
1 def lookup_fault(full_code: str | None, model: str | None = None) -> str | None:
1 def lookup_ldap_user(config: LDAPConfig, username: str) -> LDAPUserInfo | None:
1 def map_comment(comment: dict) -> dict:
1 def map_retainer(row: dict, fallback_currency: str) -> dict:
1 def mapping_names_no_used_tray(slot_to_tray: list | None, filament_usage: list[dict] | None) -> bool:
1 def mark_completing(printer_id: int) -> None:
1 def mark_pending(printer_id: int) -> None:
1 def mark_stopped_by_user(printer_id: int) -> None:
1 def mask_config(config: dict[str, Any]) -> dict[str, Any]:
1 def mask_fields(values: dict[str, Any], fields: Any) -> dict[str, Any]:
1 def mask_preset(content: Any) -> Any:
1 def match_base(base_family: str, machine: str, nozzle: str, base_names: set[str], fallback: str) -> str:
1 def match_ipcam_chunks(
1 def match_key(key: ProductKey) -> str:
1 def match_profile_indexed(
1 def match_profile(
1 def may_auto_file(actor: User | ApiKeyActor | None) -> bool:
1 def may_reach_row(
1 def may_start_queue_item(user: User | ApiKeyActor | None, can_modify_all: bool, created_by_id: int | None) -> bool:
1 def merge_config(
1 def merge_partial(
1 def merge_plate_3mfs(
1 def merge_scope_clauses(printer_scope: PrinterScope) -> list:
1 def merge_shipping_catalogue(cached: dict[str, dict], items: list[dict]) -> dict[str, dict]:
1 def merging(archive_ids: Iterable[int]) -> Iterator[bool]:
1 def mfa_decrypt(value: str) -> str:
1 def mfa_encrypt(plaintext: str) -> str:
1 def mint_token() -> str:
1 def missing_maindoeuvre_description(tasks: list[ExportTask]) -> bool:
1 def missing_start_gcode_message(printer_preset_name: str) -> str:
1 def move_to_trash(project, path: Path) -> Path | None:
1 def mqtt_has_lifetime_counter(plug: SmartPlug) -> bool:
1 def name_key(name: str) -> str:
1 def needs_action(row: AitoPaymentLink | None, wanted: Wanted | None, today: date) -> bool:
1 def needs_check(printer_id: int, state) -> bool:
1 def net_cost(task: Any, service: str) -> float | None:
1 def next_due(now: float) -> float | None:
1 def next_pause(state) -> dict | None:
1 def normalise_flow(raw: str | None) -> str | None:
1 def normalise_inbound_trace_id(raw: str | None) -> str | None:
1 def normalise_process_overrides(overrides: dict[str, object]) -> dict[str, str | list[str]]:
1 def normalize_3mf_name(name: str) -> str:
1 def normalize_am_unit_id(ams_id: int) -> int:
1 def normalize_display_name(first_name: str, last_name: str) -> str:
1 def normalize_location_name(name: str) -> str:
1 def normalize_token(raw: str) -> str | None:
1 def note_captcha_challenge(base_url: str) -> None:
1 def note_edit(project_id: int, now: float) -> None:
1 def note_immediate(project_id: int, now: float) -> None:
1 def note_slot_configured(printer_id: int, ams_id: int, tray_id: int, cali_idx: int) -> None:
1 def notify_credentials(config: dict) -> tuple[str, str]:
1 def notify_supports_photos(device_id: Any) -> bool:
1 def nozzle_diameter_for_extruder(state, extruder: int | None, model: str | None = None) -> str:
1 def nozzle_flow_for_extruder(state, extruder: int | None, model: str | None = None) -> str | None:
1 def nozzle_print_time_s(value: object) -> int | None:
1 def nozzle_wiring(state: PrinterState) -> dict | None:
1 def object_count_of(meta: dict | None) -> int | None:
1 def observe(printer_id: int, state) -> None:
1 def one_tap_url(url: str) -> str:
1 def order_contact(order: dict) -> dict | None:
1 def order_facts(order: dict) -> dict:
1 def order_payment(order: dict, today: date, credit: float = 0.0) -> dict | None:
1 def order_row(order: dict, items: dict[str, dict], today: date) -> dict:
1 def output_filename(source_filename: str) -> str:
1 def outstanding_amount(required: int, retainer_paid_total: float | None) -> int:
1 def overrides_for_plate(
1 def overrides_from_config(config: Any) -> list[DesignOverride]:
1 def own_records(spool: StockSpool, records: Sequence[UsageRecord]) -> list[UsageRecord]:
1 def owned_row_clauses(
1 def owns_media(run: PrintLogEntry) -> bool:
1 def owns(folder: LibraryFolder, user: User | ApiKeyActor | None) -> bool:
1 def pack(mapping_json: str | None, printer_id: int | None) -> str | None:
1 def parse_ams_filament_backup_from_cfg(cfg_raw: object) -> bool | None:
1 def parse_ams_filament_backup_from_home_flag(home_flag: object) -> bool | None:
1 def parse_base_preset_file(path: Path) -> dict[str, str]:
1 def parse_books_time(value: str | None) -> datetime | None:
1 def parse_credential(token: str) -> tuple[str, str]:
1 def parse_description(
1 def parse_entry(raw: object) -> Entry | None:
1 def parse_filament_name(name: str) -> ParsedName:
1 def parse_inherits(inherits: str) -> tuple[str, str | None, str | None]:
1 def parse_ldap_config(settings: dict[str, str]) -> LDAPConfig | None:
1 def parse_lines(
1 def parse_log_line(line: str) -> LogEntry | None:
1 def parse_plate_id(gcode_file: str | None) -> int | None:
1 def parse_project_code(code: str | None) -> int | None:
1 def parse_shipping_line(line: dict, shipping_ids: dict[str, str]) -> ParsedShipping | None:
1 def parse_tag_lines(answer: str) -> list[str]:
1 def parse_time_min(value: str | None) -> int | None:
1 def parse_weight_g(value: str | None) -> float | None:
1 def pdf_to_pngs(pdf: bytes, dpi: int) -> list[bytes]:
1 def peek_plate_index_in_3mf(file_path: Path) -> int | None:
1 def peek_plate_prediction_in_3mf(file_path: Path, plate_index: int | None = None) -> int | None:
1 def persistable_state(state: str | None, max_length: int) -> str | None:
1 def personal_balance_condition(user_id: int):
1 def picked_waiting(order: dict) -> dict[str, float]:
1 def plan_pull(
1 def plan_pull(orca_entries: list[dict], leaves: list[LeafState], tree_colour_names: set[str]) -> PullPlan:
1 def plan_tree(
1 def plate_facts(source: bytes, sliced: bytes) -> list[dict[str, Any]]:
1 def plate_indexes_in_3mf(file_path: Path) -> list[int | None]:
1 def plate_scoped_run_estimate(
1 def policy_for_group(group) -> GroupFilamentPolicy:
1 def preferred_encoding(accept_encoding: str | None) -> str | None:
1 def prepare_frame(frame: bytes) -> bytes:
1 def preset_key(row: dict) -> tuple[str, str]:
1 def price_from_state(state: dict | None) -> float | None:
1 def price_one_print(
1 def primary_reason_code(codes: list[int]) -> int | None:
1 def print_ams_mapping(state: PrinterState) -> list:
1 def print_anyway_hold_message(unresolved: Iterable[Mapping], blocked: Iterable[Mapping]) -> str:
1 def print_file_reachable_over_ftp(state: object | None) -> StorageVerdict:
1 def print_temp_path(printer_id: int, name: str) -> Path:
1 def printed_on_clause(printer_id: int):
1 def printer_file_path(printer_id: int, token: str) -> Path | None:
1 def printer_files_zip_path(printer_id: int, token: str) -> Path | None:
1 def printer_is_charging(printer_id: int) -> bool:
1 def printer_safe_filament_id(*candidates: str | None) -> str:
1 def printer_state_to_dict(
1 def printer_tray_layout(printer_id: int | None, manager: PrinterManager | None = None) -> TrayLayout:
1 def priority_surcharge(level: str, base: float, defaults: CalculatorDefaults) -> float:
1 def priority_terms(level: str, defaults: CalculatorDefaults) -> tuple[float, float]:
1 def probe_backup_dir(backup_dir: Path) -> dict:
1 def probe_filename_from_url(project_url: str | None) -> str | None:
1 def probe_filenames(probe_filename: str | None, candidates: list[str]) -> list[str]:
1 def probe_permissions_if_auth_enabled(*permissions: str | Permission):
1 def product_key(*, brand: str | None, material: str | None, subtype: str | None, color_name: str | None) -> ProductKey:
1 def product_line_rank(
1 def project_code_from_filename(name: str) -> str | None:
1 def projects_root() -> Path:
1 def prompt_is_live(pending: TelegramPendingVerdict, holder: PrintArchive | PrintLogEntry) -> bool:
1 def propose_groups(
1 def quantity_of(task: ExportTask, service: str) -> int | None:
1 def queue_review_required_for(user: User | ApiKeyActor | None) -> bool:
1 def quote_number_missing(order: dict) -> bool:
1 def quote_snapshot(project: AitoProject) -> dict:
1 def rack_position_to_nozzle_id(position: int) -> int | None:
1 def raise_open_file_limit() -> dict | None:
1 def rank_tag_suggestions(
1 def rate_invoices(rows: list[dict], today: date, *, is_company: bool = False) -> ClientRating:
1 def rate_quantity(task: ExportTask, service: str) -> tuple[float, int]:
1 def rate_quotes(rows: list[dict], today: date) -> QuoteRating:
1 def read_3dmodel_without_meshes(zf: zipfile.ZipFile, model_path: str = "3D/3dmodel.model") -> str:
1 def read_bundle_preset(filename: str) -> str | None:
1 def read_disk_state() -> dict[str, dict[str, str]]:
1 def read_env_oidc_config() -> dict | None:
1 def read_gcode_hash(archive: Any) -> str | None:
1 def read_local_toml(path: Path = DEFAULT_PATH) -> LocalConfig:
1 def read_log_entries(
1 def read_ntp_gate(path: Path = DEFAULT_NTP_GATE_PATH) -> TimeSyncState:
1 def read_plate_estimates(archive: Any) -> dict | None:
1 def read_print_snapshot(path: Path) -> PrintSnapshot | None:
1 def recalibrate_printer(printer: Printer, total_hours: float) -> float:
1 def record_process_changes(zip_bytes: bytes, keys: list[str]) -> bytes:
1 def redact_device_urls(text: str | None) -> str | None:
1 def redact_query_tokens(text: str | None) -> str | None:
1 def redact_refused_headers_json(body: bytes) -> bytes:
1 def redact_refused_headers(text: str | None) -> str | None:
1 def redact_url_credentials(text: str | None) -> str | None:
1 def refresh_gcode_hash(archive: PrintArchive) -> None:
1 def refresh_plate_estimates(archive: PrintArchive) -> None:
1 def reject_placeholder(config: dict[str, Any]) -> None:
1 def release(archive_id: int) -> None:
1 def remember_document_numbers(project: Any, *numbers: object) -> None:
1 def removal_confirmed(printer_id: int, key: tuple) -> bool:
1 def remove_printer_files_zip(zip_path: Path) -> None:
1 def remove_printer_references(printer_id: int) -> None:
1 def render_batch_prep_sheet(
1 def render_label_preview_pdf(
1 def render_labels(
1 def render_mesh_png(mesh, size: int = 256, label: str = "mesh") -> bytes:
1 def render_prep_sheet(
1 def render_template(template_str: str, variables: dict[str, Any]) -> str:
1 def reports_two_nozzles(state) -> bool:
1 def request_debounced_sync(project_id: int) -> None:
1 def request_immediate_sync(project_id: int | None = None) -> None:
1 def require_admin_if_auth_enabled():
1 def require_any_permission_if_auth_enabled(*permissions: str | Permission):
1 def require_api_key_scope(
1 def require_camera_stream_token_if_auth_enabled():
1 def require_enabled_section(section: str) -> None:
1 def require_energy_cost_update():
1 def require_media_token_ownership(
1 def require_media_token_permission(*permissions: str | Permission):
1 def require_media_token_printer_permission(permission: str | Permission):
1 def require_notification_send():
1 def require_one_file(uploads: list[UploadFile]) -> None:
1 def require_overlay_token_any_printer_if_auth_enabled():
1 def require_overlay_token_if_auth_enabled():
1 def require_ownership_permission(
1 def require_permission_if_auth_enabled(*permissions: str | Permission):
1 def require_printable_uploads(uploads: list[UploadFile]) -> None:
1 def require_printer_permission_if_auth_enabled(*permissions: str | Permission):
1 def require_source_names(uploads: list[UploadFile]) -> None:
1 def require_source_uploads(uploads: list[UploadFile]) -> None:
1 def RequireAdminIfAuthEnabled():
1 def RequireAnyPermissionIfAuthEnabled(*permissions: str | Permission):
1 def required_amount(quote_total: float | None, pct: int) -> int | None:
1 def RequirePermissionIfAuthEnabled(*permissions: str | Permission):
1 def RequirePrinterPermissionIfAuthEnabled(*permissions: str | Permission):
1 def rescale(cost: float | None, old_pct: float, new_pct: float) -> float | None:
2 def reset_cache() -> None:
1 def reset_legacy_migration_state() -> None:
1 def reset_upload_state(printer_id: int):
3 def reset() -> None:
1 def reslice_note(source_number: int, pipeline_name: str) -> str:
1 def resolve_data_dir() -> Path:
1 def resolve_display_stem(filename: str) -> str:
1 def resolve_expected_tray(
1 def resolve_external_spools_in_mapping(
1 def resolve_filament(unit: dict | None, filament: str) -> str:
1 def resolve_group_mapping(ldap_groups: list[str], group_mapping: dict[str, str]) -> list[str]:
1 def resolve_in_projects(*parts: str) -> Path:
1 def resolve_leaf(
1 def resolve_oidc_group_mapping(idp_groups: list[str], group_mapping: dict[str, str]) -> list[str]:
1 def resolve_plate_id(state) -> int | None:
1 def resolve_rack_nozzle_mapping(
1 def resolve_rack_plan_mapping(
1 def resolve_slot_nozzle(state, ams_id: int, tray_id: int, model: str | None = None) -> SlotNozzle:
1 def resolve_user_filament_scope(user) -> FilamentScope:
1 def resolve_with_sources(
1 def resolve(project_id: int) -> None:
1 def retire_confirm_token(archive: PrintArchive | PrintLogEntry) -> None:
1 def reusable_slot_filament_id(
1 def revision_added_payload(
1 def revision_dir(project, section: str, item_name: str, number: int) -> Path:
1 def revision_file_path(file_path: str | None) -> Path | None:
1 def revision_folder_name(number: int) -> str:
1 def revision_label(item_name: str, number: int) -> str:
1 def revision_lock_statement(revision_ids: Collection[int], *, share: bool = False) -> Select:
1 def revision_ref(revision: ProjectRevision, item: ProjectItem) -> RevisionRef:
1 def rewrite_rtsp_request_url(data: bytes, proxy_url: bytes, real_url: bytes) -> bytes:
1 def row_dict(row: FilamentPreset) -> dict:
1 def rtsp_socket_timeout_flag() -> str:
1 def run_estimate(archive: Any, plate_id: int | None) -> RunEstimate | None:
1 def run_snapshot(run: PrintLogEntry) -> SimpleNamespace:
1 def running_on_uvloop(loop: asyncio.AbstractEventLoop | None = None) -> bool:
1 def same_value(a: Any, b: Any) -> bool:
1 def sanitize_component(name: str, fallback: str = "sans-nom") -> str:
1 def sanitize_log_content(content: str, sensitive_strings: dict[str, str] | None = None) -> str:
1 def save_base_presets(files: list[tuple[str, str]]) -> None:
1 def scan_logs(
1 def scan_user_presets() -> list[dict[str, str]]:
1 def schedule_archive_cost_estimate(
1 def scope_columns(scope: Scope) -> dict:
1 def scope_where(model, scope: Scope):
1 def score_from_detections(detections: list) -> float:
1 def search_catalogue(catalogue: list[FilamentProduct], query: str, limit: int = 25) -> list[FilamentProduct]:
1 def search_ldap_users(config: LDAPConfig, query: str, limit: int = 25) -> list[LDAPSearchResult]:
1 def section_for_filename(name: str) -> str:
1 def sees_all_folders(user: User | ApiKeyActor | None) -> bool:
1 def segments(log: list | None, backend: str, ams_id: int, tray_id: int) -> list[tuple[int, int]]:
1 def send_email(
1 def serialize(spools: list[Spool]) -> bytes:
1 def service_for_island(island: str | None) -> str | None:
1 def service_for_sku(sku: str | None) -> str | None:
1 def session_dated(username: str | None) -> dict:
1 def set_override(printer_id: int, value: bool | None) -> None:
1 def set_recheck(callback: Callable[[int], Awaitable[None]] | None) -> None:
3 def set_shared_http_client(client: httpx.AsyncClient | None) -> None:
1 def settings_mismatches(file_profile: dict, revision_profile: dict) -> list[dict[str, str]]:
1 def settle(printer_id: int, scope: str, held_keys: set[tuple]) -> None:
1 def share_out(retainers: list[RetainerCredit], balance: float) -> list[tuple[RetainerCredit, list[dict]]]:
1 def sheet_page_count(template: Template, label_count: int, starting_position: int = 1) -> int | None:
1 def should_pull_comments(project: AitoProject, estimate: dict, now: datetime) -> bool:
1 def sign(
1 def sku_key(material: str, subtype: str | None, brand: str | None, color_name: str | None) -> SkuKey:
1 def slice_request_from_pipeline(pipeline: SlicerPipeline) -> SliceRequest:
1 def slugify(title: str, max_chars: int = 40) -> str:
1 def spawn_background_task(
1 def split_gcode_3mf(name: str) -> tuple[str, str]:
1 def split_tag_string(value: str | None) -> list[str]:
1 def split(
1 def spool_hold_message(entries: Iterable[Mapping]) -> str:
1 def spool_present(tray: Mapping[str, Any] | None) -> bool | None:
1 def stamp_verdict(archive: PrintArchive | PrintLogEntry, source: str) -> None:
1 def start_aito_quote_sync() -> None:
1 def start_entries(backend: str, assignments: dict[tuple[int, int], int]) -> list[dict]:
1 def start_gcode_is_missing(content: bytes, *, export_3mf: bool) -> bool:
1 def start_job(archive_id: int, run: JobRunner) -> TimelapseJob:
1 def start_legacy_migration() -> bool:
1 def start_loop_watchdog() -> None:
1 def start_loop_watchdog(threshold: float = 1.0, interval: float = 0.25) -> Callable[[], None]:
1 def start_printer_download_cleanup() -> None:
1 def start_session(
1 def start() -> None:
1 def stop_loop_watchdog() -> None:
1 def stop_print_by_user(printer_id: int, *, mark_when_unsent: bool = False) -> bool:
1 def stop() -> None:
1 def storage_dir_name(code: str, title: str) -> str:
1 def subscribe_plug_to_mqtt(service: "MQTTSmartPlugService", plug: Any) -> list[str]:
1 def substitute_unused_plate_filaments(source_3mf_bytes: bytes, plate_id: int | None, items: list[str]) -> list[str]:
1 def subtree_ids(folders: list[ProjectFolder], root_id: int) -> set[int]:
1 def summarise(tasks: Iterable[Any]) -> TaskSummary:
1 def supports_airduct(model: str | None) -> bool:
1 def supports_chamber_heater(model: str | None) -> bool:
1 def supports_chamber_temp(model: str | None) -> bool:
1 def supports_drying_while_printing(model: str | None, firmware: str | None) -> bool:
1 def supports_drying(model: str | None, firmware: str | None) -> bool:
1 def supports_rtsp(model: str | None) -> bool:
1 def swap_plate_suffix(name: str | None, target_plate: int) -> str | None:
1 def systemd_unit_name() -> str | None:
1 def tag_already_linked(field: TagField, holder_id: int) -> HTTPException:
1 def tag_mirror(names: list[str]) -> str | None:
1 def tag_name_key(name: str) -> str:
1 def take(project_id: int) -> None:
1 def target_machine(machine: str, machines: list[str]) -> str | None:
1 def targets(entry: dict, facts: InstallFacts) -> bool:
1 def task_quantity(task: AitoTask) -> int | None:
1 def task_search_text(tasks: Iterable[Any]) -> str:
1 def telegram_markdown_escape(message: str) -> str:
1 def terminal_view(row: AitoTerminalPayment | None):
1 def test_ldap_connection(config: LDAPConfig) -> tuple[bool, str]:
1 def thresholds(sensitivity: str) -> tuple[float, float]:
1 def thumbnail_faces_per_copy(total_copies: int) -> int:
1 def tls_failure(exc: BaseException) -> str | None:
1 def tracking_balance(
1 def tracking_notes(url: str, token: str) -> str:
1 def tracking_url_for(base: str, token: str | None) -> str | None:
1 def tracking_url_for(base: str, token: str) -> str | None:
1 def transaction_affects_personal_balance(
1 def triggers_action(verdict: str, action: str) -> bool:
1 def trust_state(
1 def uniform_tray_filament_hint(loaded_types: list[str]) -> str | None:
1 def unique_clean_names(raw_names: Iterable[str], seen: set[str] | None = None) -> list[tuple[str, str]]:
1 def unique_file_path(directory: Path, filename: str) -> Path:
1 def unit_reported_absent(ams_id, ams_list: list, ams_exist_bits) -> bool:
1 def units_to_invoice(
1 def unlisted_file_hold_message(blocked: Iterable[Mapping]) -> str:
1 def unpack(raw: str | None) -> tuple[list[int], int] | None:
1 def unresolved_filament_message(slots: list[int], preset_names: list[str]) -> str:
1 def unresolved_filament_slots(content: bytes, *, export_3mf: bool) -> list[int]:
1 def unused_credit_total(payments: list[dict]) -> float:
1 def upload_basename(upload: UploadFile) -> str:
1 def upload_in_progress(printer_id: int) -> bool:
1 def uploaded_base_presets_dir() -> Path:
1 def url_host_only(url: str | None) -> str:
1 def url_is_external_storage(project_url: str | None) -> bool | None:
1 def utc_now_naive() -> datetime:
1 def validate_targets(targets: dict) -> dict:
1 def verdict_from_reaction(new_reaction: list) -> str | None:
1 def verify_3mf_candidate(
1 def verify_feed(content: bytes, trusted_keys: dict[str, str] | None = None) -> dict:
1 def verify_password(plain_password: str, hashed_password: str) -> bool:
1 def view_of(archive, runs: list[PrintLogEntry], scope: PrinterScope) -> ScopedView | None:
1 def visible_folder_ids(index: FolderIndex, user: User | ApiKeyActor | None) -> set[int] | None:
1 def visible_row_clauses(
1 def vt_trays_to_dicts(raw: object, resolve_slot_k: Callable) -> list[dict]:
1 def waiting_ids() -> list[int]:
1 def waiting_reason_for_codes(codes: list[int]) -> str:
1 def wanted_link(project: AitoProject, *, pct: int, today: date) -> Wanted | None:
1 def warn_cascade_level_1_ambiguous(tag_uid: str, spool_ids: list) -> None:
1 def warn_if_running_on_uvloop(loop: asyncio.AbstractEventLoop | None = None) -> bool:
1 def warned_layers_of(archive, state) -> set[int]:
1 def wear_cost_for_run(duration_seconds: int | None, wear_cost_per_hour: float | None) -> float | None:
1 def whole_archive_scope_clause(printer_scope: PrinterScope):
1 def widget_content(printer_name: str, state) -> dict:
1 def wire_tray_color(tray_color: str | None) -> str:
1 def with_opening_hours_sms(message: str, hours: str | None) -> str:
1 def with_tracking_notes(existing: str | None, url: str, token: str) -> str:
1 def with_tracking_sms(message: str, url: str) -> str:
```

## Database tables (name, column count)
```regen: PYTHONHASHSEED=0 ./venv/bin/python3 -c "import backend.app.main; from backend.app.core.database import Base; [print(n, len(t.columns)) for n, t in sorted(Base.metadata.tables.items())]" 2>/dev/null```
```
aito_client_quote_ratings 8
aito_client_ratings 11
aito_events 15
aito_payment_links 21
aito_projects 63
aito_task_deliveries 4
aito_tasks 35
aito_terminal_payments 22
aito_tracking_views 3
aito_watches 5
ams_labels 6
ams_sensor_history 7
announcement_reads 4
announcements 8
api_keys 21
archive_aliases 3
auth_ephemeral_tokens 11
auth_rate_limit_events 4
budget_reservations 9
bug_reports 9
calculator_defaults 28
calculator_filaments 15
calculator_printers 9
color_catalog 9
connected_app_grants 4
connected_apps 9
cost_center_members 5
cost_centers 10
external_link_badges 3
external_links 9
filament_base_presets 8
filament_presets 10
filament_profile_default 10
filament_profile_default_k_profile 10
filament_profile_default_preset 6
filament_tree_changes 10
filament_tree_colors 7
filament_tree_leaves 11
filament_tree_overrides 8
filament_tree_snapshots 5
filament_trees 14
filaments 16
file_variant_groups 5
github_backup_config 22
github_backup_logs 9
group_locations 2
group_printers 2
groups 11
hour_events 7
hour_machines 12
hour_readings 8
kprofile_notes 6
label_templates 14
library_file_tags 3
library_files 28
library_folders 14
library_tags 5
local_presets 18
location_ha_sensors 18
locations 6
long_lived_tokens 10
maintenance_history 5
maintenance_log_entries 11
maintenance_types 10
notification_digest_queue 8
notification_live_activities 18
notification_lock_screen_widgets 11
notification_logs 10
notification_providers 56
notification_templates 8
notifications 11
oidc_providers 22
orca_base_profiles 5
order_board_docs 6
order_board_events 10
order_board_watches 4
pending_uploads 15
pipeline_jobs 9
pipeline_runs 15
print_archives 69
print_batch_plates 6
print_batches 14
print_log_entries 46
print_queue 53
print_queue_variants 14
printer_ha_sensors 19
printer_locations 6
printer_maintenance 10
printer_sensor_history 6
printers 31
project_bom_items 13
project_events 7
project_folders 4
project_items 11
project_revision_pins 8
project_revisions 21
project_tags 3
projects 25
revenue_annotations 4
revenue_customers 6
revenue_day_lines 7
revenue_days 4
revenue_items 11
revenue_scope_decisions 3
revenue_targets 3
scheduled_dryings 16
settings 5
slicer_pipelines 17
slot_preset_mappings 10
smart_plug_energy_snapshots 7
smart_plugs 69
sponsor_toast_state 7
spool 40
spool_assignment 9
spool_catalog 5
spool_filament_preset 7
spool_k_profile 11
spool_suppliers 7
spool_usage_history 11
spoolbuddy_devices 29
spoolman_filament_preset 7
spoolman_k_profile 11
spoolman_slot_assignments 6
spoolman_spool_suppliers 7
suppliers 8
telegram_pending_verdicts 9
user_email_preferences 8
user_groups 2
user_inbox_preferences 7
user_oidc_links 6
user_otp_codes 7
user_totp 8
user_wallets 4
users 24
virtual_printers 20
wallet_transactions 13
```

