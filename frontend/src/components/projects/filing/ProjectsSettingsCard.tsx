import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, Loader2 } from 'lucide-react';
import { api } from '../../../api/client';
import type { AppSettings, LegacyMigrationStatus, Permission } from '../../../api/client';
import { Card, CardContent, CardHeader } from '../../Card';
import { Button } from '../../Button';
import { Toggle } from '../../Toggle';
import { useToast } from '../../../contexts/ToastContext';
import { useAuth } from '../../../contexts/AuthContext';

const legacyMigrationStatusKey = ['projects', 'legacy-migration', 'status'] as const;

/** The Projects settings card/tab is for users who may change settings and
 *  projects: the legacy-migration endpoints require both permissions. */
// eslint-disable-next-line react-refresh/only-export-components -- pure gate shared with the Settings tab list
export function canManageProjectsSettings(hasPermission: (permission: Permission) => boolean): boolean {
  return hasPermission('settings:update') && hasPermission('projects:update');
}

/** Settings → Projects: auto-filing by project code and the one-off move of
 *  old project files. Self-contained (own queries and mutations), shown only
 *  to users who may change settings AND projects (the migration endpoints
 *  require both, see canManageProjectsSettings). */
export function ProjectsSettingsCard() {
  const { loading, hasPermission } = useAuth();
  // hasPermission allows everything while auth is still loading, so wait for it
  // before deciding — otherwise a viewer would briefly see (and poll) the card.
  if (loading || !canManageProjectsSettings(hasPermission)) return null;
  return <ProjectsSettingsCardBody />;
}

function ProjectsSettingsCardBody() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const { data: settings, isLoading: settingsLoading } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: api.getSettings,
  });

  const { data: status } = useQuery<LegacyMigrationStatus>({
    queryKey: legacyMigrationStatusKey,
    queryFn: api.getLegacyMigrationStatus,
    refetchInterval: (query) => (query.state.data?.running ? 2000 : false),
  });

  const autoFileMutation = useMutation({
    mutationFn: (value: boolean) => api.updateSettings({ projects_auto_file_by_code: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      showToast(t('settings.toast.settingsSaved'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const startMutation = useMutation({
    mutationFn: api.startLegacyMigration,
    // The 202 body may still say total=0; the polled status is the truth.
    // A 409 means a run is already going — the refetch shows its progress.
    onSettled: () => queryClient.invalidateQueries({ queryKey: legacyMigrationStatusKey }),
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const autoFile = autoFileMutation.isPending
    ? (autoFileMutation.variables ?? true)
    : (settings?.projects_auto_file_by_code ?? true);
  const running = !!status?.running;
  const pending = status?.pending ?? 0;
  const lastRun = !running ? status?.last_run : null;

  return (
    <Card id="card-projects-filing">
      <CardHeader>
        <div className="flex items-center gap-2">
          <FolderKanban className="w-5 h-5 text-gray-400" />
          <h2 className="text-lg font-semibold text-white">{t('projectsPdm.filing.settingsTitle')}</h2>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-white">{t('projectsPdm.filing.autoFileLabel')}</p>
            <p className="text-xs text-bambu-gray mt-0.5">{t('projectsPdm.filing.autoFileHint')}</p>
          </div>
          <Toggle
            checked={autoFile}
            disabled={settingsLoading || autoFileMutation.isPending}
            onChange={(value) => autoFileMutation.mutate(value)}
            aria-label={t('projectsPdm.filing.autoFileLabel')}
          />
        </div>

        <div className="border-t border-bambu-dark-tertiary pt-4 space-y-3">
          <p className="text-sm font-medium text-white">{t('projectsPdm.filing.migrationTitle')}</p>
          {lastRun && (
            <p className="text-sm text-white" data-testid="legacy-migration-last-run">
              {t('projectsPdm.filing.migrationLastRun', {
                files: t('projectsPdm.filing.migrationLastRunFiles', {
                  count: lastRun.files_moved + lastRun.files_copied,
                }),
                projects: t('projectsPdm.filing.migrationLastRunProjects', { count: lastRun.projects }),
              })}
            </p>
          )}
          {!status ? (
            <Loader2 className="w-4 h-4 animate-spin text-bambu-gray" />
          ) : running ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-bambu-gray flex items-center gap-2" role="status">
                <Loader2 className="w-4 h-4 animate-spin text-bambu-green shrink-0" />
                {t('projectsPdm.filing.migrationRunning', {
                  done: status.done,
                  total: status.total,
                  code: status.current?.code ?? '…',
                })}
              </p>
              <Button size="sm" disabled>
                {t('projectsPdm.filing.migrationStart')}
              </Button>
            </div>
          ) : pending > 0 ? (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-bambu-gray">{t('projectsPdm.filing.migrationPending', { count: pending })}</p>
              <Button size="sm" disabled={startMutation.isPending} onClick={() => startMutation.mutate()}>
                {startMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('projectsPdm.filing.migrationStart')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-bambu-gray">{t('projectsPdm.filing.migrationNone')}</p>
          )}

          {status && status.failures.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-red-400">{t('projectsPdm.filing.migrationFailures')}</p>
              <ul className="space-y-1">
                {status.failures.map((f) => (
                  <li key={f.project_id} className="text-xs flex gap-2 min-w-0">
                    <span className="font-mono text-white shrink-0">{f.code ?? `#${f.project_id}`}</span>
                    <span className="text-bambu-gray break-words min-w-0">{f.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
