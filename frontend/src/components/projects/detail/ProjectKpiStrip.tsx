import type { ElementType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, FolderTree, Package, Printer, Wallet } from 'lucide-react';
import type { Project } from '../../../api/client';
import { formatDurationFromHours } from '../../../utils/date';
import { formatFilament, projectCost } from './format';

const DONE_COLOUR = '#22c55e';

function Kpi({ icon: Icon, label, testId, children }: { icon: ElementType; label: string; testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark/60 p-3">
      <p className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-bambu-gray">
        <Icon className="h-3 w-3" aria-hidden="true" />
        {label}
      </p>
      {children}
    </div>
  );
}

function Bar({ percent, colour, thick }: { percent: number; colour: string; thick?: boolean }) {
  return (
    <div className={`${thick ? 'h-1.5' : 'h-1'} overflow-hidden rounded-full bg-bambu-dark`}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, backgroundColor: percent >= 100 ? DONE_COLOUR : colour }}
      />
    </div>
  );
}

/** Header KPI strip (prints, print time, filament, cost), then the plates /
 *  complete-sets targets and, with sub-projects, the whole programme's
 *  roll-up as a secondary line (#1264). */
export function ProjectKpiStrip({
  project,
  completeSets,
  currency,
}: {
  project: Project;
  completeSets: number | null;
  currency: string;
}) {
  const { t } = useTranslation();
  const stats = project.stats;
  const colour = project.color || '#6b7280';
  const money = (value: number) => `${currency}${value.toFixed(2)}`;

  const tiles = stats
    ? (() => {
        const partsPercent = stats.parts_progress_percent ?? 0;
        const total = projectCost(stats);
        const remaining = project.budget !== null ? project.budget - total : null;
        const exceeded = remaining !== null && remaining < 0;
        return (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi icon={Package} label={t('projectDetail.stats.printJobs')} testId="kpi-prints">
              {project.target_parts_count ? (
                <>
                  <p className="mt-0.5 text-xl font-semibold text-white">
                    {stats.completed_prints}
                    <span className="text-xs font-normal text-bambu-gray">
                      {` / ${project.target_parts_count} ${t('projectDetail.progress.parts')}`}
                    </span>
                  </p>
                  <div className="mt-2" title={t('projectDetail.progress.partsProgress')}>
                    <Bar percent={partsPercent} colour={colour} />
                  </div>
                  <p className="mt-1 text-[11px] text-bambu-gray/70">
                    {t('projectDetail.progress.percentComplete', { percent: partsPercent.toFixed(0) })}
                    {stats.remaining_parts != null && stats.remaining_parts > 0 && (
                      <> · {t('projectDetail.progress.remaining', { count: stats.remaining_parts })}</>
                    )}
                  </p>
                  <p className="text-[11px] text-bambu-gray/70">
                    {`${stats.total_archives} ${t('projectDetail.progress.printJobs')}`}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-0.5 text-xl font-semibold text-white">
                    {stats.total_archives}{' '}
                    <span className="text-xs font-normal text-bambu-gray">{t('projectDetail.stats.total')}</span>
                  </p>
                  <p className="mt-1 text-[11px] text-bambu-gray/70">
                    {t('projectDetail.stats.partsPrinted', { count: stats.completed_prints })}
                  </p>
                </>
              )}
              {stats.failed_prints > 0 && (
                <p className="text-[11px] text-status-error">{t('projectDetail.stats.failed', { count: stats.failed_prints })}</p>
              )}
            </Kpi>

            <Kpi icon={Clock} label={t('projectDetail.stats.printTime')} testId="kpi-time">
              <p className="mt-0.5 text-xl font-semibold text-white">{formatDurationFromHours(stats.total_print_time_hours)}</p>
              {stats.in_progress_prints > 0 && (
                <p className="mt-1 text-[11px] text-yellow-700 dark:text-yellow-400">
                  {t('projectDetail.queue.printing', { count: stats.in_progress_prints })}
                </p>
              )}
            </Kpi>

            <Kpi icon={Printer} label={t('projectDetail.stats.filamentUsed')} testId="kpi-filament">
              <p className="mt-0.5 text-xl font-semibold text-white">{formatFilament(stats.total_filament_grams)}</p>
            </Kpi>

            <Kpi icon={Wallet} label={t('projectDetail.cost.totalCost')} testId="kpi-cost">
              <p
                data-testid="kpi-cost-total"
                className={`mt-0.5 text-xl font-semibold ${exceeded ? 'text-red-700 dark:text-red-400' : 'text-bambu-green'}`}
              >
                {money(total)}
              </p>
              {project.budget !== null && remaining !== null && (
                <div className="mt-1 space-y-0.5 text-[11px] text-bambu-gray">
                  <p>
                    {t('projectDetail.cost.budget')}: <span className="font-semibold text-white">{money(project.budget)}</span>
                  </p>
                  <p data-testid="kpi-cost-remaining" className={exceeded ? 'text-red-700 dark:text-red-400' : 'text-bambu-green'}>
                    {t('projectDetail.cost.remaining')}: <span className="font-semibold">{money(remaining)}</span>
                    {exceeded && <> · {t('projectDetail.cost.overBudget')}</>}
                  </p>
                </div>
              )}
              <ul className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-bambu-gray/70">
                <li>
                  {t('projectDetail.cost.filamentCost')} <span>{money(stats.estimated_cost)}</span>
                </li>
                {stats.total_energy_kwh > 0 && (
                  <li>
                    {t('projectDetail.cost.energy')} <span>{stats.total_energy_kwh.toFixed(3)} kWh</span>
                    {stats.total_energy_cost > 0 && <span className="ml-1">({money(stats.total_energy_cost)})</span>}
                  </li>
                )}
                {(stats.total_wear_cost ?? 0) > 0 && (
                  <li>
                    <span>{t('projectDetail.cost.wear')}</span> <span>{money(stats.total_wear_cost)}</span>
                  </li>
                )}
              </ul>
            </Kpi>
          </div>
        );
      })()
    : null;

  const platesPercent = stats?.progress_percent ?? 0;
  const sets = completeSets ?? 0;
  const targets =
    project.target_count || project.target_sets ? (
      <div className="grid gap-3 sm:grid-cols-2" data-testid="project-targets">
        {project.target_count ? (
          <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-bambu-gray">{t('projectDetail.progress.platesProgress')}</span>
              <span className="font-medium text-white">
                {`${stats?.total_archives || 0} / ${project.target_count} ${t('projectDetail.progress.printJobs')}`}
              </span>
            </div>
            <Bar percent={platesPercent} colour={colour} thick />
            <div className="mt-1 flex justify-between text-[11px] text-bambu-gray/70">
              <span>{t('projectDetail.progress.percentComplete', { percent: platesPercent.toFixed(0) })}</span>
              {stats?.remaining_prints != null && stats.remaining_prints > 0 && (
                <span>{t('projectDetail.progress.remaining', { count: stats.remaining_prints })}</span>
              )}
            </div>
          </div>
        ) : null}
        {project.target_sets ? (
          <div className="min-w-0">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
              <span className="text-bambu-gray">{t('projectDetail.progress.setsProgress')}</span>
              <span className="font-medium text-white">
                {`${sets} / ${project.target_sets} ${t('projectDetail.progress.sets')}`}
              </span>
            </div>
            <Bar percent={(sets / project.target_sets) * 100} colour={colour} thick />
            <p className="mt-1 text-[11px] text-bambu-gray/70">{t('projectDetail.progress.setsHint')}</p>
          </div>
        ) : null}
      </div>
    ) : null;

  const rollup = project.rollup_stats;
  const rollupCost = rollup ? projectCost(rollup) : 0;
  const rollupRow = rollup ? (
    <div
      data-testid="project-rollup"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-dashed border-bambu-dark-tertiary px-3 py-2 text-xs text-bambu-gray"
    >
      <span className="flex items-center gap-1.5 font-medium text-white">
        <FolderTree className="h-3.5 w-3.5" aria-hidden="true" />
        {t('projectDetail.rollup.title', { count: project.descendant_count })}
      </span>
      <span>
        {t('projectDetail.stats.printJobs')} <span className="font-semibold text-white">{rollup.total_archives}</span>
      </span>
      <span>{t('projectDetail.stats.partsPrinted', { count: rollup.completed_prints })}</span>
      <span>
        {t('projectDetail.stats.printTime')}{' '}
        <span className="font-semibold text-white">{formatDurationFromHours(rollup.total_print_time_hours)}</span>
      </span>
      <span>
        {t('projectDetail.stats.filamentUsed')}{' '}
        <span className="font-semibold text-white">{formatFilament(rollup.total_filament_grams)}</span>
      </span>
      {rollupCost > 0 && (
        <span>
          {t('projectDetail.cost.totalCost')} <span className="font-semibold text-bambu-green">{money(rollupCost)}</span>
        </span>
      )}
      {rollup.progress_percent !== null && (
        <span className="flex items-center gap-2">
          {t('projectDetail.rollup.progress')}:{' '}
          {t('projectDetail.rollup.percentComplete', { percent: rollup.progress_percent.toFixed(0) })}
          <span className="block w-20">
            <Bar percent={rollup.progress_percent} colour={colour} />
          </span>
        </span>
      )}
    </div>
  ) : null;

  if (!tiles && !targets && !rollupRow) return null;
  return (
    <div className="mt-4 space-y-3" data-testid="project-kpis">
      {tiles}
      {targets}
      {rollupRow}
    </div>
  );
}
